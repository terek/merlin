// The numbers behind the spend graph. The question it answers is "which decision cost what", so
// nothing is accumulated and the main session is kept apart from the agents:
//
//   - a step is one turn of the main session, with what the main agent spent in it;
//   - a unit is one piece of work handed to an agent: from its launch (or from a later message
//     sent to it) to the report that came back, with everything it spent, its own sub-agents
//     included. A unit belongs to the turn that launched it and ends on the turn its result
//     arrived in;
//   - a decision is a prompt a person typed, with every step and unit that followed until the
//     next one.
//
// Everything is summed from the billed messages (`?messages=1`). Pure; SpendGraph.tsx only draws
// what this returns.

import type {
  Agent,
  Compaction,
  CompactionTally,
  InboxMessage,
  Message,
  SessionDetail,
  Turn,
  WorkflowRun,
} from '../../api/types'
import { turnPrompt } from '../../lib/inbox'

/** What the dollars bought. `reread` is a cache miss: context that had been cached and was written again. */
export type ClassKey = 'output' | 'read' | 'write' | 'reread' | 'input'
/** Who spent them. `reread` is taken out of whoever paid it. */
export type KindKey = 'main' | 'reread' | 'compact' | 'subagent' | 'teammate' | 'fork'
export type Split = 'kind' | 'class'
export type Tone = 'series-1' | 'series-2' | 'series-3' | 'series-4' | 'series-5' | 'series-other'

export interface SeriesDef<K extends string = string> {
  key: K
  label: string
  /** A CSS colour (a token). */
  color: string
  tone: Tone
}

// The cache miss keeps its colour in both splits.
export const KIND_SERIES: SeriesDef<KindKey>[] = [
  { key: 'main', label: 'Main agent', color: 'var(--series-1)', tone: 'series-1' },
  { key: 'reread', label: 'Cache miss', color: 'var(--series-5)', tone: 'series-5' },
  { key: 'compact', label: 'Compaction', color: 'var(--series-other)', tone: 'series-other' },
  { key: 'subagent', label: 'Sub-agents', color: 'var(--series-2)', tone: 'series-2' },
  { key: 'teammate', label: 'Teammates', color: 'var(--series-3)', tone: 'series-3' },
  { key: 'fork', label: 'Forks', color: 'var(--series-4)', tone: 'series-4' },
]

export const CLASS_SERIES: SeriesDef<ClassKey>[] = [
  { key: 'output', label: 'Output', color: 'var(--series-4)', tone: 'series-4' },
  { key: 'read', label: 'Cache read', color: 'var(--series-3)', tone: 'series-3' },
  { key: 'write', label: 'Cache write', color: 'var(--series-2)', tone: 'series-2' },
  { key: 'reread', label: 'Cache miss', color: 'var(--series-5)', tone: 'series-5' },
  { key: 'input', label: 'Uncached input', color: 'var(--series-other)', tone: 'series-other' },
]

const KIND_BY_KEY = new Map<string, SeriesDef>(KIND_SERIES.map((s) => [s.key, s]))
const CLASS_BY_KEY = new Map<string, SeriesDef>(CLASS_SERIES.map((s) => [s.key, s]))
const zeroClass = (): Record<ClassKey, number> => ({ output: 0, read: 0, write: 0, reread: 0, input: 0 })

// ---- prices ---------------------------------------------------------------------------

/** Dollars per token of one model: uncached input and cache read. The rest follows from input. */
export interface Fit {
  input: number
  read: number
}

const OUT = 5
const W5M = 1.25
const W1H = 2

const weighted = (m: Message) =>
  (m.input ?? 0) + OUT * (m.output ?? 0) + W5M * (m.cacheWrite5m ?? 0) + W1H * (m.cacheWrite1h ?? 0)

/**
 * The two prices of each model, fitted to its messages by least squares: usd = input * A + read * B,
 * where A is the tokens billed at a multiple of the input price and B the tokens read from the
 * cache. The web side has no price table; the fit recovers what the daemon priced with. When the
 * messages cannot separate the two (one message, or no cache reads), a read costs a tenth of input.
 */
export function fitPrices(messages: readonly Message[]): Map<string, Fit> {
  const sums = new Map<string, { aa: number; ab: number; bb: number; au: number; bu: number }>()
  for (const m of messages) {
    const a = weighted(m)
    const b = m.cacheRead ?? 0
    const s = sums.get(m.model) ?? { aa: 0, ab: 0, bb: 0, au: 0, bu: 0 }
    s.aa += a * a
    s.ab += a * b
    s.bb += b * b
    s.au += a * m.usd
    s.bu += b * m.usd
    sums.set(m.model, s)
  }
  const out = new Map<string, Fit>()
  for (const [model, s] of sums) {
    const det = s.aa * s.bb - s.ab * s.ab
    let input = 0
    let read = 0
    if (det > 1e-9 * s.aa * s.bb) {
      input = (s.au * s.bb - s.bu * s.ab) / det
      read = (s.bu * s.aa - s.au * s.ab) / det
    }
    if (!(input > 0) || !(read >= 0) || read > input) {
      // usd = input * (A + 0.1 B), least squares in one unknown
      const cc = s.aa + 0.2 * s.ab + 0.01 * s.bb
      input = cc > 0 ? (s.au + 0.1 * s.bu) / cc : 0
      read = 0.1 * input
    }
    out.set(model, { input, read })
  }
  return out
}

// ---- cache misses ---------------------------------------------------------------------

const TTL_5M = 5 * 60_000
const TTL_1H = 60 * 60_000

/** A miss counts only from this many tokens, and only when it is at least half of what was cached. */
export const REREAD_MIN_TOKENS = 5000

/** One message that wrote again what the previous message of the same agent had left in the cache. */
export interface Reread {
  /** Omitted for the main agent. */
  agentId?: string
  model: string
  at: string
  /** Tokens written again. */
  tokens: number
  /** What writing them cost. */
  usd: number
  /** What reading them from the cache would have cost. */
  cachedUSD: number
  /** Time since the agent's previous message on this model. */
  gapMs?: number
  /** The gap is longer than the cache keeps an entry (5 minutes, or an hour for 1-hour writes). */
  expired: boolean
}

const promptTokens = (m: Message) => (m.input ?? 0) + (m.cacheRead ?? 0) + (m.cacheWrite5m ?? 0) + (m.cacheWrite1h ?? 0)

/**
 * Tokens of `m` that were in the cache after `prev` (the same agent's previous message on the
 * same model) and were written again instead of read. 0 unless it is a real miss: a normal message
 * reads the whole previous prompt and writes only what is new.
 */
export function rereadTokens(prev: Message | undefined, m: Message): number {
  if (!prev) return 0
  const cached = promptTokens(prev)
  const written = (m.cacheWrite5m ?? 0) + (m.cacheWrite1h ?? 0)
  const again = Math.min(written, Math.max(0, cached - (m.cacheRead ?? 0)))
  return again >= REREAD_MIN_TOKENS && again >= 0.5 * cached ? again : 0
}

// ---- buckets --------------------------------------------------------------------------

/** A sum of messages: the dollars, split by token class, and the cache misses among them. */
export interface Bucket {
  usd: number
  /** Dollars of the cache misses (also in `byClass.reread`). */
  reread: number
  byClass: Record<ClassKey, number>
  tokens: Record<ClassKey, number>
  rereads: Reread[]
  messages: number
}

const newBucket = (): Bucket => ({
  usd: 0,
  reread: 0,
  byClass: zeroClass(),
  tokens: zeroClass(),
  rereads: [],
  messages: 0,
})

const ms = (s: string | undefined) => (s ? Date.parse(s) : Number.NaN)

function addMessage(b: Bucket, m: Message, fit: Fit, prev: Message | undefined): void {
  const written = (m.cacheWrite5m ?? 0) + (m.cacheWrite1h ?? 0)
  const raw = {
    input: fit.input * (m.input ?? 0),
    output: fit.input * OUT * (m.output ?? 0),
    write: fit.input * (W5M * (m.cacheWrite5m ?? 0) + W1H * (m.cacheWrite1h ?? 0)),
    read: fit.read * (m.cacheRead ?? 0),
  }
  const sum = raw.input + raw.output + raw.write + raw.read
  // the message's own figure is the truth (fast mode doubles it): the fit only splits it
  const k = sum > 0 ? m.usd / sum : 0
  const again = rereadTokens(prev, m)
  const rereadUSD = written > 0 ? raw.write * k * (again / written) : 0
  b.usd += m.usd
  b.messages++
  b.reread += rereadUSD
  b.byClass.input += raw.input * k
  // a message the fit cannot split (no tokens, or an unpriced model) is all "output"
  b.byClass.output += sum > 0 ? raw.output * k : m.usd
  b.byClass.read += raw.read * k
  b.byClass.write += raw.write * k - rereadUSD
  b.byClass.reread += rereadUSD
  b.tokens.input += m.input ?? 0
  b.tokens.output += m.output ?? 0
  b.tokens.read += m.cacheRead ?? 0
  b.tokens.write += written - again
  b.tokens.reread += again
  if (again > 0) {
    const gap = prev ? ms(m.at) - ms(prev.at) : Number.NaN
    b.rereads.push({
      agentId: m.agentId,
      model: m.model,
      at: m.at,
      tokens: again,
      usd: rereadUSD,
      cachedUSD: fit.read * again * k,
      gapMs: Number.isFinite(gap) ? gap : undefined,
      expired: Number.isFinite(gap) && gap >= ((m.cacheWrite1h ?? 0) > 0 ? TTL_1H : TTL_5M),
    })
  }
}

/** One coloured piece of a bar. */
export interface Part {
  key: string
  label: string
  color: string
  tone: Tone
  usd: number
}

const kindPart = (key: string, usd: number): Part => ({
  ...(KIND_BY_KEY.get(key === 'workflow' ? 'subagent' : key) ?? KIND_SERIES[0]),
  usd,
})
const classPart = (key: string, usd: number): Part => ({ ...(CLASS_BY_KEY.get(key) ?? CLASS_SERIES[0]), usd })

// ---- the model ------------------------------------------------------------------------

/** A compaction of an agent's own conversation: which agent, and the turn of the main session it fell in. */
export interface AgentCompaction {
  agent: Agent
  compaction: Compaction
  turn: number
}

/** One piece of work handed to an agent, from the message that started it to its report. */
export interface Unit {
  id: string
  /** The agent the main session launched; its own sub-agents are inside the unit. */
  agent: Agent
  /** 1 for the launch, 2 for the first later message it was sent, ... */
  ordinal: number
  /** How many units the agent has. */
  of: number
  /** Turn in which it was launched or sent the message. */
  launch: number
  /** Turn in which its result arrived (>= launch). */
  ret: number
  /** False when no report is known: the agent was still open, or was killed. */
  returned: boolean
  startMs: number
  endMs: number
  /** What it was asked: the agent's prompt, or the later message. */
  asked: string
  /** Who sent the later message, when known. */
  from?: string
  bucket: Bucket
  /** Its own sub-agents: their dollars (inside `bucket.usd`) and who they were. */
  nestedUSD: number
  nested: Agent[]
  /** Compactions of its agent's (or its sub-agents') conversations while it ran, in time order. */
  compactions: AgentCompaction[]
}

/** One turn of the main session. */
export interface Col {
  index: number
  turn: Turn
  /** Copied from the parent session: drawn, but not this session's spend. */
  inherited: boolean
  /** A person typed it: the start of a decision. */
  human: boolean
  /** What it asked, in one line. */
  prompt: string
  /** What the main agent spent in this turn. */
  step: Bucket
  /** Compaction calls made in this turn. */
  compact: Bucket
  /** step + compact. */
  usd: number
  /** Units this turn launched. */
  launched: Unit[]
  /** Units whose result arrived in this turn. */
  arrived: Unit[]
  /** Tokens the main agent wrote again in this turn (the bar on the context track). */
  mainRereadTokens: number
  /** Time between the end of the previous turn and the start of this one. */
  idleMs?: number
  /** Index of the decision it belongs to. */
  decision: number
  /** The compactions that followed this turn (before the next one started). */
  compactions: Compaction[]
  /** Prompts a person typed while the turn ran: they start no turn, but they steer this one. */
  typedWhileRunning: number
}

/** A prompt a person typed, with everything that followed until the next one. */
export interface Decision {
  index: number
  /** First and last turn, inclusive. */
  start: number
  end: number
  prompt: string
  /** The main agent's steps (compaction included). */
  stepsUSD: number
  /** The units launched in its turns. */
  unitsUSD: number
  /** Cache misses, main agent and units (inside the two figures above). */
  rereadUSD: number
  usd: number
  units: number
  /** Dollars per kind, for a bar. */
  parts: Part[]
  /** The compactions after its turns; their cost is an estimate and in no figure above. */
  compactions: Compaction[]
  /** The compactions inside the agent work launched in its turns. */
  agentCompactions: Compaction[]
}

/** An agent the main session launched: a row under the main line. */
export interface Row {
  agent: Agent
  /** Row number, from 0. Agents that do not overlap share a row. */
  lane: number
  first: number
  last: number
  units: Unit[]
  usd: number
}

export interface SpendModel {
  cols: Col[]
  units: Unit[]
  rows: Row[]
  laneCount: number
  decisions: Decision[]
  /** This session's own spend: steps plus units, inherited turns left out. */
  total: number
  /** The compactions after its own turns. */
  compactions: Compaction[]
  /** The compactions inside its own agent work. */
  agentCompactions: Compaction[]
  stepsUSD: number
  unitsUSD: number
  /** Legend totals for the two splits (only the parts that are not zero). */
  byKind: Part[]
  byClass: Part[]
  rereads: Reread[]
  inheritedUSD: number
  /** The largest step and the largest unit: the scale. */
  maxStep: number
  maxUnit: number
  /** False when the daemon sent no messages: no token classes, no cache misses, one unit per agent. */
  fromMessages: boolean
  agentsById: Map<string, Agent>
}

/** Index of the last turn that started at or before `at`; 0 when none did. */
export function turnAt(starts: readonly number[], at: number): number {
  let lo = 0
  let hi = starts.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= at) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}

const PEER_TAG = /<(?:teammate|cross-session)-message\s([^>]*)>/
const PEER_IDS = /<teammate-message\s[^>]*?teammate_id="([^"]+)"/g

/**
 * What a turn asked, in one line. A first line that only introduces what follows ("... sent a
 * message:") is joined with the next one, which is where the request is.
 */
export function promptLine(t: Pick<Turn, 'userText' | 'command' | 'inbox'>): string {
  const u = turnPrompt(t)
  // a peer message the shared unwrapper does not take (text after the closing tag): sender and summary
  const tag = u.label ? null : PEER_TAG.exec(t.userText ?? '')
  if (tag) {
    const from = /(?:teammate_id|from)="([^"]*)"/.exec(tag[1])?.[1]
    const summary = /summary="([^"]*)"/.exec(tag[1])?.[1]
    if (from && summary) return `from ${from}: ${summary}`
  }
  const lines = ((u.label && u.summary) || u.body || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const head = lines[0] ?? ''
  const line = head.endsWith(':') && lines[1] ? `${head} ${lines[1]}` : head
  return (u.label ? (line ? `${u.label}: ${line}` : u.label) : line) || t.command || ''
}

/** A person typed this turn. Anything else (a report, a notification, a schedule) follows from an earlier one. */
export const isDecision = (t: Pick<Turn, 'origin'>) => t.origin === 'human' || t.origin === 'command'

/** The pieces of a step's bar, from the main line outwards. */
export function stepParts(c: Col, split: Split): Part[] {
  if (c.inherited) return []
  if (split === 'class')
    return CLASS_SERIES.map((s) => classPart(s.key, c.step.byClass[s.key] + c.compact.byClass[s.key]))
  return [
    kindPart('main', c.step.usd - c.step.reread),
    kindPart('reread', c.step.reread + c.compact.reread),
    kindPart('compact', c.compact.usd - c.compact.reread),
  ]
}

/** The pieces of a unit's bar, from the main line outwards. */
export function unitParts(u: Unit, split: Split): Part[] {
  if (split === 'class') return CLASS_SERIES.map((s) => classPart(s.key, u.bucket.byClass[s.key]))
  return [kindPart(u.agent.kind, u.bucket.usd - u.bucket.reread), kindPart('reread', u.bucket.reread)]
}

/**
 * Gives each agent a row: the first row that is free from its first turn on, earlier agents
 * first, so that a row reads left to right. Returns the number of rows.
 */
export function packRows(rows: Row[]): number {
  const ends: number[] = []
  const order = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.first - b.r.first || a.i - b.i)
  for (const { r } of order) {
    let lane = ends.findIndex((end) => end < r.first)
    if (lane < 0) lane = ends.length
    ends[lane] = r.last
    r.lane = lane
  }
  return ends.length
}

const runAgentId = (runId: string) => `run:${runId}`

/** A workflow run as the agent the session launched: its agents hang under it. */
function runAgent(r: WorkflowRun): Agent {
  return {
    id: runAgentId(r.id),
    kind: 'workflow',
    runId: r.id,
    name: r.name ? `workflow ${r.name}` : 'workflow',
    description: r.summary,
    prompt: r.summary,
    parentAgentId: r.agentId ?? null,
    spawnToolUseId: r.toolUseId,
    spawnTurn: r.turn,
    depth: 1,
    background: true,
    linkage: 'run',
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    status: r.status === 'completed' ? 'completed' : r.status === 'open' ? 'open' : 'killed',
    assistantMessages: 0,
    toolCalls: 0,
    cost: { usd: 0 },
    subtreeUSD: r.usd,
  }
}

/** What a set of compactions adds up to, as estimated: only those that carry a call. */
export function compactionTally(list: readonly Compaction[]): CompactionTally & { unknown: number } {
  const t = { calls: 0, cold: 0, usd: 0, warmUSD: 0, uncoveredUSD: 0, unknown: 0 }
  for (const c of list) {
    if (!c.call) {
      t.unknown++
      continue
    }
    t.calls++
    if (c.call.cache === 'cold') t.cold++
    t.usd += c.call.usd
    t.warmUSD += c.call.warmUSD
  }
  return t
}

export function buildSpend(detail: SessionDetail): SpendModel {
  const d = detail.digest
  const turns = d.turns ?? []
  const messages = d.messages ?? []
  // a workflow run is one piece of work: the main agent launched a script, not each of its agents
  const runs = new Map((d.workflows ?? []).map((r) => [r.id, r]))
  const agents: Agent[] = [
    ...(d.agents ?? []).map((a) =>
      a.runId && runs.has(a.runId) && a.parentAgentId === null ? { ...a, parentAgentId: runAgentId(a.runId) } : a,
    ),
    ...[...runs.values()].map(runAgent),
  ]
  const inherited = new Set(detail.lineage.inheritedTurns ?? [])
  const agentsById = new Map(agents.map((a) => [a.id, a]))
  const fromMessages = messages.length > 0
  const n = turns.length

  const cols: Col[] = turns.map((turn, i) => ({
    index: i,
    turn,
    inherited: inherited.has(turn.index),
    human: isDecision(turn),
    prompt: promptLine(turn),
    step: newBucket(),
    compact: newBucket(),
    usd: 0,
    launched: [],
    arrived: [],
    mainRereadTokens: 0,
    decision: 0,
    compactions: (d.compactions ?? []).filter((c) => c.turn === i),
    typedWhileRunning: (turn.queued ?? []).filter((q) => q.origin === 'human' || q.origin === 'command').length,
  }))
  const starts = turns.map((t) => ms(t.startedAt))
  // a turn without a time takes the one before it, so that the search stays monotonic
  for (let i = 0; i < n; i++) if (!Number.isFinite(starts[i])) starts[i] = i ? starts[i - 1] : 0
  const place = (turn: number | undefined, at: number) =>
    turn !== undefined && turn >= 0 && turn < n ? turn : Number.isFinite(at) ? turnAt(starts, at) : 0

  // ---- who launched whom: every agent belongs to the one the main session launched
  const rootOf = (a: Agent): Agent => {
    const seen = new Set<string>()
    let cur = a
    while (cur.parentAgentId !== null && !seen.has(cur.id)) {
      seen.add(cur.id)
      const p = agentsById.get(cur.parentAgentId)
      if (!p) break
      cur = p
    }
    return cur
  }
  const firstBilled = new Map<string, number>()
  for (const m of messages) if (m.agentId && !firstBilled.has(m.agentId)) firstBilled.set(m.agentId, ms(m.at))
  const bornAt = (a: Agent, fallback: number) =>
    Number.isFinite(ms(a.startedAt)) ? ms(a.startedAt) : (firstBilled.get(a.id) ?? fallback)

  // ---- units: one per message an agent was sent
  const unitsOf = new Map<string, Unit[]>()
  const rootAgents = agents.filter((a) => rootOf(a) === a && a.kind !== 'compact')
  for (const a of rootAgents) {
    const inbox: InboxMessage[] = fromMessages
      ? [...(a.inbox ?? [])].filter((x) => Number.isFinite(ms(x.at))).sort((x, y) => ms(x.at) - ms(y.at))
      : []
    const mk = (k: number, startMs: number, asked: string, from?: string): Unit => ({
      id: `${a.id}#${k}`,
      agent: a,
      ordinal: k + 1,
      of: 1,
      launch: 0,
      ret: 0,
      returned: false,
      startMs,
      endMs: startMs,
      asked,
      from,
      bucket: newBucket(),
      nestedUSD: 0,
      nested: [],
      compactions: [],
    })
    unitsOf.set(a.id, [
      mk(0, bornAt(a, Number.NaN), a.prompt ?? ''),
      ...inbox.map((x, k) => mk(k + 1, ms(x.at), x.text || x.summary || '', x.from)),
    ])
  }
  const unitAt = (root: Agent, at: number): Unit | undefined => {
    const list = unitsOf.get(root.id)
    if (!list) return undefined
    let u = list[0]
    for (const x of list) if (x.startMs <= at) u = x
    return u
  }

  // ---- the messages
  if (fromMessages && n > 0) {
    const fits = fitPrices(messages)
    const last = new Map<string, Message>()
    for (const m of messages) {
      const fit = fits.get(m.model) ?? { input: 0, read: 0 }
      const key = `${m.agentId ?? ''}|${m.model}`
      const prev = last.get(key)
      last.set(key, m)
      const at = ms(m.at)
      const a = m.agentId ? agentsById.get(m.agentId) : undefined
      const root = a ? rootOf(a) : undefined
      if (!a || !root || (root === a && a.kind === 'compact')) {
        // the main agent, a compaction call, or an agent the digest does not list
        const c = cols[place(a ? (a.spawnTurn ?? m.turn) : m.turn, at)]
        const before = c.step.tokens.reread
        addMessage(a ? c.compact : c.step, m, fit, prev)
        if (!m.agentId) c.mainRereadTokens += c.step.tokens.reread - before
        continue
      }
      // an agent's own sub-agent counts where it was spawned: the unit is atomic
      const u = unitAt(root, a === root ? at : bornAt(a, at))
      if (!u) continue
      addMessage(u.bucket, m, fit, prev)
      u.endMs = Number.isFinite(u.endMs) ? Math.max(u.endMs, at) : at
      if (a !== root) {
        u.nestedUSD += m.usd
        if (!u.nested.includes(a)) u.nested.push(a)
      }
    }
  } else if (n > 0) {
    // An older daemon, or a page that did not ask for messages: dollars only.
    for (const c of cols) {
      c.step.usd = c.turn.cost.usd
      c.step.byClass.output = c.turn.cost.usd
    }
    for (const a of agents) {
      const root = rootOf(a)
      if (root === a && a.kind === 'compact') {
        const c = cols[place(a.spawnTurn, ms(a.startedAt))]
        c.compact.usd += a.cost.usd
        c.compact.byClass.output += a.cost.usd
        continue
      }
      const u = unitsOf.get(root.id)?.[0]
      if (!u) continue
      u.bucket.usd += a.cost.usd
      u.bucket.byClass.output += a.cost.usd
      if (a === root) u.endMs = Number.isFinite(ms(a.endedAt)) ? ms(a.endedAt) : u.endMs
      else {
        u.nestedUSD += a.cost.usd
        u.nested.push(a)
      }
    }
  }

  // ---- where each unit branches off and where its result arrives
  // turns that carry an agent's report: by agent id where the API resolved the sender, else by name
  const reports = new Map<string, number[]>()
  const reportsById = new Map<string, number[]>()
  const runByTask = new Map([...runs.values()].flatMap((r) => (r.taskId ? [[r.taskId, runAgentId(r.id)]] : [])))
  for (const c of cols) {
    for (const m of c.turn.inbox ?? []) {
      const id = m.agentId ?? (m.taskId ? runByTask.get(m.taskId) : undefined)
      if (!id) continue
      const list = reportsById.get(id) ?? []
      if (list[list.length - 1] !== c.index) list.push(c.index)
      reportsById.set(id, list)
    }
    if (c.turn.origin !== 'peer') continue
    // the senders the API names; for a digest written before it did, the ones in the wrapper
    const senders = c.turn.inbox?.length
      ? c.turn.inbox.flatMap((m) => (m.from ? [m.from] : []))
      : Array.from((c.turn.userText ?? '').matchAll(PEER_IDS), (m) => m[1])
    for (const name of senders) {
      const list = reports.get(name) ?? []
      if (list[list.length - 1] !== c.index) list.push(c.index)
      reports.set(name, list)
    }
  }
  const units: Unit[] = []
  const rows: Row[] = []
  if (n > 0) {
    for (const a of rootAgents) {
      // a later message that started no work of its own is not a unit
      const kept = (unitsOf.get(a.id) ?? []).filter((u, k) => k === 0 || u.bucket.messages > 0)
      const named = [...new Set([...(reportsById.get(a.id) ?? []), ...((a.name && reports.get(a.name)) || [])])].sort(
        (x, y) => x - y,
      )
      // an agent's compactions (its sub-agents' too) belong to the piece of work that was running
      for (const x of agents) {
        if (x.kind === 'compact' || rootOf(x) !== a) continue
        for (const cp of x.compactions ?? []) {
          const at = ms(cp.at)
          let u = kept[0]
          for (const v of kept) if (v.startMs <= at) u = v
          u?.compactions.push({ agent: x, compaction: cp, turn: place(undefined, at) })
        }
      }
      for (const u of kept) u.compactions.sort((x, y) => ms(x.compaction.at) - ms(y.compaction.at))
      kept.forEach((u, k) => {
        const next = kept[k + 1]
        u.ordinal = k + 1
        u.of = kept.length
        u.launch = k === 0 ? place(a.spawnTurn, u.startMs) : place(undefined, u.startMs)
        const until = next ? next.startMs : Number.POSITIVE_INFINITY
        const arrivals = named.filter((i) => i >= u.launch && starts[i] >= u.startMs && starts[i] < until)
        let ret = arrivals.length ? arrivals[arrivals.length - 1] : place(undefined, u.endMs)
        u.returned = arrivals.length > 0 || !!next || a.status === 'completed'
        // a background agent's result comes in with the notification that follows
        if (!arrivals.length && a.background && cols[ret + 1]?.turn.origin === 'task-notification') ret++
        u.ret = Math.max(u.launch, ret)
        cols[u.launch].launched.push(u)
        // work launched in a turn copied from the parent session is the parent's
        if (cols[u.launch].inherited) return
        units.push(u)
        if (u.returned) cols[u.ret].arrived.push(u)
      })
      const mine = kept.filter((u) => !cols[u.launch].inherited)
      if (mine.length === 0) continue
      rows.push({
        agent: a,
        lane: 0,
        first: Math.min(...mine.map((u) => u.launch)),
        last: Math.max(...mine.map((u) => u.ret)),
        units: mine,
        usd: mine.reduce((s, u) => s + u.bucket.usd, 0),
      })
    }
  }
  const laneCount = packRows(rows)

  // ---- decisions and totals
  const decisions: Decision[] = []
  const kinds: Record<string, number> = {}
  const classes = zeroClass()
  const rereads: Reread[] = []
  let inheritedUSD = 0
  let maxStep = 0
  for (const c of cols) {
    c.usd = c.step.usd + c.compact.usd
    if (c.index > 0) {
      const gap = ms(c.turn.startedAt) - ms(cols[c.index - 1].turn.endedAt)
      if (Number.isFinite(gap) && gap >= 0) c.idleMs = gap
    }
    // a new decision at every typed prompt, and where the session's own turns begin
    const firstOwn = !c.inherited && c.index > 0 && cols[c.index - 1].inherited
    if (decisions.length === 0 || (c.human && !c.inherited) || firstOwn) {
      decisions.push({
        index: decisions.length,
        start: c.index,
        end: c.index,
        prompt: c.prompt,
        stepsUSD: 0,
        unitsUSD: 0,
        rereadUSD: 0,
        usd: 0,
        units: 0,
        parts: [],
        compactions: [],
        agentCompactions: [],
      })
    }
    const dec = decisions[decisions.length - 1]
    dec.end = c.index
    c.decision = dec.index
    const launchedUSD = c.launched.reduce((s, u) => s + u.bucket.usd, 0)
    if (!c.inherited) {
      dec.compactions.push(...c.compactions)
      for (const u of c.launched) dec.agentCompactions.push(...u.compactions.map((x) => x.compaction))
    }
    if (c.inherited) {
      inheritedUSD += c.usd + launchedUSD
      continue
    }
    maxStep = Math.max(maxStep, c.usd)
    dec.stepsUSD += c.usd
    dec.unitsUSD += launchedUSD
    dec.units += c.launched.length
    const mine: Record<string, number> = {}
    for (const p of stepParts(c, 'kind')) mine[p.key] = (mine[p.key] ?? 0) + p.usd
    for (const u of c.launched) for (const p of unitParts(u, 'kind')) mine[p.key] = (mine[p.key] ?? 0) + p.usd
    dec.rereadUSD += mine.reread ?? 0
    for (const [k, v] of Object.entries(mine)) {
      kinds[k] = (kinds[k] ?? 0) + v
      const p = dec.parts.find((x) => x.key === k)
      if (p) p.usd += v
      else dec.parts.push(kindPart(k, v))
    }
    for (const b of [c.step, c.compact, ...c.launched.map((u) => u.bucket)]) {
      for (const s of CLASS_SERIES) classes[s.key] += b.byClass[s.key]
      rereads.push(...b.rereads)
    }
  }
  const order = (key: string) => KIND_SERIES.findIndex((s) => s.key === key)
  for (const dec of decisions) {
    dec.usd = dec.stepsUSD + dec.unitsUSD
    dec.parts.sort((a, b) => order(a.key) - order(b.key))
  }
  const stepsUSD = decisions.reduce((s, x) => s + x.stepsUSD, 0)
  const unitsUSD = decisions.reduce((s, x) => s + x.unitsUSD, 0)

  return {
    cols,
    units,
    rows,
    laneCount,
    decisions,
    total: stepsUSD + unitsUSD,
    compactions: cols.flatMap((c) => (c.inherited ? [] : c.compactions)),
    agentCompactions: units.flatMap((u) => u.compactions.map((x) => x.compaction)),
    stepsUSD,
    unitsUSD,
    byKind: KIND_SERIES.map((s) => kindPart(s.key, kinds[s.key] ?? 0)).filter((p) => p.usd > 0),
    byClass: CLASS_SERIES.map((s) => classPart(s.key, classes[s.key])).filter((p) => p.usd > 0),
    rereads,
    inheritedUSD,
    maxStep,
    maxUnit: units.reduce((m, u) => Math.max(m, u.bucket.usd), 0),
    fromMessages,
    agentsById,
  }
}

/** One thing a decision paid for: a step of the main agent, or a piece of agent work. */
export type DecisionItem = { kind: 'step'; col: Col; usd: number } | { kind: 'unit'; unit: Unit; usd: number }

/** What a decision paid for, most expensive first: the steps of its turns and the units launched in them. */
export function decisionItems(model: SpendModel, dec: Decision): DecisionItem[] {
  const out: DecisionItem[] = []
  for (let i = dec.start; i <= dec.end; i++) {
    const c = model.cols[i]
    if (!c || c.inherited) continue
    if (c.usd > 0) out.push({ kind: 'step', col: c, usd: c.usd })
    for (const u of c.launched) out.push({ kind: 'unit', unit: u, usd: u.bucket.usd })
  }
  return out.sort((a, b) => b.usd - a.usd)
}

/** The `n` most expensive decisions, most expensive first. */
export function topDecisions(model: SpendModel, n: number): Decision[] {
  return model.decisions
    .filter((x) => x.usd > 0)
    .sort((a, b) => b.usd - a.usd || a.index - b.index)
    .slice(0, n)
}
