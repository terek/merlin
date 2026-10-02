// Deterministic generator of the mock data set: about 500 sessions over 90 days in twelve
// projects, families, every state and cost flag, scripted runs, one session of 600 turns with
// compactions and a deep agent tree, prompts of 100 kB and long unbroken strings. Everything
// in it is invented text. Typed by src/api/types.ts, so it cannot drift from what the views read.

import type {
  Agent,
  Compaction,
  Cost,
  CostFlag,
  EndState,
  Link,
  Message,
  ModelCost,
  ScriptedLine,
  SessionCost,
  SessionDetail,
  SessionDigest,
  SessionFamily,
  SessionKey,
  SessionKind,
  SessionLineage,
  SessionSummary,
  State,
  Turn,
  TurnOrigin,
} from '../src/api/types'

// ---- random ---------------------------------------------------------------------------

export function makeRng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1))
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]
  const chance = (p: number) => next() < p
  const hex = (n: number) => Array.from({ length: n }, () => int(0, 15).toString(16)).join('')
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`
  return { next, int, pick, chance, uuid, hex }
}
export type Rng = ReturnType<typeof makeRng>

// ---- vocabulary (invented) ------------------------------------------------------------

export const PROJECTS = [
  '/home/dev/acme/web',
  '/home/dev/acme/api',
  '/home/dev/acme/infra',
  '/home/dev/merlin',
  '/home/dev/notes',
  '/home/dev/labs/ray-tracer',
  '/home/dev/labs/compiler',
  '/home/dev/oss/parser',
  '/home/dev/oss/cli-kit',
  '/home/dev/client/portal',
  '/home/dev/client/billing',
  '/home/dev/scratch',
]

const VERBS = [
  'add',
  'fix',
  'refactor',
  'plan',
  'review',
  'rename',
  'document',
  'speed up',
  'test',
  'split',
  'simplify',
  'migrate',
]
const NOUNS = [
  'the retry loop',
  'pagination on the orders table',
  'the login form',
  'the cache layer',
  'config loading',
  'the billing totals',
  'error messages',
  'the nightly job',
  'the parser benchmarks',
  'the footer',
  'date handling',
  'the upload endpoint',
  'tokenizer edge cases',
  'the settings page',
  'a changelog',
  'the release script',
  'input validation',
  'the search index',
]
const BRANCHES = ['main', 'main', 'main', 'feat/search', 'fix/dates', 'chore/deps', 'feat/export', 'wip']
const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Glob', 'Write']
const FILES = [
  'src/index.ts',
  'src/server/routes.ts',
  'src/ui/Table.tsx',
  'src/lib/dates.ts',
  'README.md',
  'tests/parser.test.ts',
  'docs/notes.md',
  'Makefile',
  'src/config.ts',
  'src/billing/totals.ts',
]
const AGENT_TYPES = ['general-purpose', 'Explore', 'Plan', 'code-reviewer']
const SENTENCES = [
  'The handler reads the settings once and keeps them in a module-level cache.',
  'I looked at the three call sites and they all pass the same options object.',
  'Retries now back off exponentially with a cap of thirty seconds.',
  'The failing test depended on the order in which the files were listed.',
  'Nothing else in the package imports this helper, so it can go.',
  'The totals are rounded once, at the end, instead of per line.',
  'This keeps the public signature and only changes what happens inside.',
  'The migration is idempotent, so running it twice is harmless.',
  'I left the old name as an alias for one release.',
  'Both branches end in the same state; the second is just shorter.',
]
const SPAWN_REASONS = [
  'Check how the cache is invalidated',
  'Survey the test layout',
  'Review the diff for races',
  'Find every caller of the helper',
  'Draft the migration plan',
]

export const MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'] as const
const PRICE: Record<string, { in: number; out: number; cr: number; cw: number }> = {
  'claude-fable-5-1': { in: 10, out: 50, cr: 1, cw: 12.5 },
  'claude-opus-5-5': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  'claude-sonnet-5-5': { in: 3, out: 15, cr: 0.3, cw: 3.75 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, cr: 0.1, cw: 1.25 },
}
const ALIAS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}

const DAY = 86_400_000
const MIN = 60_000

// ---- internal records -----------------------------------------------------------------

/** A dollar amount on a day, for the cost rollups. */
export interface Spend {
  at: number
  model: string
  usd: number
  /** Inside a reported window: reported; otherwise attributed. */
  reported: boolean
}

export interface Sess {
  summary: SessionSummary
  detail: SessionDetail
  spend: Spend[]
  /** Live sessions get events. */
  live?: boolean
  parent?: { key: SessionKey; kind: 'fork' | 'continuation'; atTurn: number }
}

export interface Dataset {
  now: number
  sessions: Sess[]
  byId: Map<string, Sess>
  scripted: ScriptedLine[]
  bigId: string
}

const keyOf = (id: string): SessionKey => ({ harness: 'claude', id })
const iso = (ms: number) => new Date(ms).toISOString()

function addModel(c: Cost, model: string, mc: ModelCost) {
  c.usd += mc.usd
  c.byModel ??= {}
  const cur = c.byModel[model] ?? { usd: 0 }
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const) {
    const v = (cur[k] ?? 0) + (mc[k] ?? 0)
    if (v) cur[k] = v
  }
  cur.usd += mc.usd
  c.byModel[model] = cur
}

function priced(
  model: string,
  t: { input: number; output: number; cacheRead: number; cacheWrite1h: number },
): ModelCost {
  const p = PRICE[model]
  const usd = (t.input * p.in + t.output * p.out + t.cacheRead * p.cr + t.cacheWrite1h * p.cw) / 1_000_000
  return { ...t, usd }
}

// ---- texts ----------------------------------------------------------------------------

function sentence(r: Rng) {
  return r.pick(SENTENCES)
}

function paragraph(r: Rng, n = r.int(2, 4)) {
  return Array.from({ length: n }, () => sentence(r)).join(' ')
}

function promptText(r: Rng): string {
  const base = `${r.pick(VERBS)} ${r.pick(NOUNS)}`
  const k = r.next()
  if (k < 0.55) return base
  if (k < 0.85) return `${base}. ${sentence(r)}`
  return `${base}\n\n${paragraph(r, 2)}\n\n- ${r.pick(NOUNS)}\n- ${r.pick(NOUNS)}`
}

function finalText(r: Rng): string {
  const parts = [paragraph(r)]
  if (r.chance(0.5)) parts.push(`${r.pick(['Changes', 'Notes', 'Next'])}:\n\n- ${sentence(r)}\n- ${sentence(r)}`)
  if (r.chance(0.3))
    parts.push(
      `\`\`\`ts\nexport function ${r.pick(['retry', 'total', 'load', 'parse'])}(input: string): string {\n  return input.trim()\n}\n\`\`\``,
    )
  if (r.chance(0.12)) parts.push('| file | lines |\n|---|---:|\n| src/index.ts | 12 |\n| src/config.ts | 40 |')
  return parts.join('\n\n')
}

function title(r: Rng) {
  return `${r.pick(VERBS)} ${r.pick(NOUNS)}`
}

// ---- one session ----------------------------------------------------------------------

export interface Spec {
  id: string
  project: string
  kind: SessionKind
  start: number
  turns: number
  flag: CostFlag
  endState: EndState
  state?: State
  title?: string | null
  agents?: number
  deepAgents?: boolean
  /** Reshape the agents into the zoo of the Agents card: long runs of siblings, a deep chain, an orphan, ... */
  zoo?: boolean
  compactEvery?: number
  recap?: boolean
  sourceMissing?: boolean
  special?: 'huge' | 'abandoned' | 'strings'
  gapMin?: [number, number]
}

/** A teammate's first prompt arrives as a message from the lead, wrapped like Claude Code wraps it. */
function wrapPrompt(kind: string, text: string): string {
  return kind === 'teammate'
    ? `<teammate-message teammate_id="lead" summary="Your assignment">\n${text}\n</teammate-message>`
    : text
}

function makeTurn(r: Rng, i: number, t: number, ctx: number, epoch: number, spec: Spec): Turn {
  const origin: TurnOrigin =
    i === 0 || r.chance(0.82)
      ? 'human'
      : r.pick(['command', 'task-notification', 'peer', 'scheduled', 'continuation'] as const)
  const model = r.chance(0.5) ? 'claude-sonnet-5-5' : r.pick(MODELS)
  const am = r.int(1, 8)
  const usage = priced(model, {
    input: r.int(100, 1200) * am,
    output: r.int(150, 1500) * am,
    cacheRead: Math.round(ctx * am * (0.6 + r.next() * 0.4)),
    cacheWrite1h: r.int(0, 4000),
  })
  const cost: Cost = { usd: 0 }
  addModel(cost, model, usage)
  const dur = r.int(4, 300) * 1000
  const tools: Record<string, number> = {}
  const calls = r.chance(0.2) ? 0 : r.int(1, 14)
  for (let k = 0; k < calls; k++) {
    const tool = r.pick(TOOLS)
    tools[tool] = (tools[tool] ?? 0) + 1
  }
  const nTools = Object.values(tools).reduce((a, b) => a + b, 0)
  const cmd = r.pick(['compact', 'review', 'init', 'cost'] as const)
  // wrapper shapes of machine-authored prompts; all texts are invented
  const task = `<task-notification>
<task-id>b${i}x7</task-id>
<status>${i % 3 === 0 ? 'failed' : 'completed'}</status>
<summary>Background command "run the test suite" ${i % 3 === 0 ? 'failed with exit code 1' : 'completed (exit code 0)'}</summary>
<result>${i % 3 === 0 ? '3 tests failed in sync_test.go' : 'All 214 tests passed in 41 s.'}</result>
</task-notification>`
  const peer = [
    `<teammate-message teammate_id="reviewer" summary="Two issues in the patch">\nThe retry loop never backs off (line 41).\nThe error is swallowed in flush().\n</teammate-message>`,
    `Another Claude session sent a message:\n<teammate-message teammate_id="docs-session">{"result": "The schema change is merged; rebase before you continue."}</teammate-message>`,
    `<cross-session-message from="build-watcher">Main is red again: sync_test.go times out.\nNot yet bisected.</cross-session-message>`,
  ][i % 3]
  let userText =
    origin === 'human'
      ? promptText(r)
      : origin === 'command'
        ? `/${cmd}${cmd === 'review' ? ' the login page and the session store' : cmd === 'compact' ? ' keep the schema decisions' : ''}`
        : origin === 'task-notification'
          ? task
          : origin === 'scheduled'
            ? 'Scheduled check: look at the build status.'
            : origin === 'peer'
              ? peer
              : 'Continue.'
  if (spec.special === 'huge' && i === 1)
    userText = Array.from({ length: 1300 }, () => `${sentence(r)}\n`)
      .join('')
      .repeat(1)
      .slice(0, 100_000)
  if (spec.special === 'strings' && i === 1)
    userText = `${'0123456789abcdef'.repeat(400)}\n\nAnd a path: /${'very-long-directory-name/'.repeat(40)}file.ts`
  const files = Array.from({ length: Math.min(calls, r.int(0, 5)) }, () => r.pick(FILES))
  return {
    index: i,
    epoch,
    uuid: r.uuid(),
    startedAt: iso(t),
    endedAt: iso(t + dur),
    durationMs: dur,
    origin,
    userText,
    images: origin === 'human' && r.chance(0.04) ? r.int(1, 3) : undefined,
    command: origin === 'command' ? userText.slice(1).split(' ')[0] : undefined,
    finalText: r.chance(0.97)
      ? spec.special === 'strings' && i === 1
        ? `${'x'.repeat(4000)}\n\n${finalText(r)}`
        : finalText(r)
      : undefined,
    assistantMessages: am,
    toolCalls: nTools,
    toolsByName: nTools ? tools : undefined,
    filesTouched: files.length ? [...new Set(files)] : undefined,
    contextTokens: Math.round(ctx),
    cost,
    costWithAgents: cost.usd,
    abandoned: spec.special === 'abandoned' && i % 7 === 3 ? true : undefined,
    interrupted: undefined,
  }
}

function makeAgents(r: Rng, turns: Turn[], n: number, deep: boolean, shape?: (agents: Agent[]) => void): Agent[] {
  const agents: Agent[] = []
  const human = turns.filter((t) => t.origin === 'human')
  for (let k = 0; k < n; k++) {
    const spawn = r.pick(human.length ? human : turns)
    const parentPool = agents.filter((a) => (a.spawnTurn ?? 0) <= spawn.index)
    const parent = parentPool.length && r.chance(deep ? 0.75 : 0.25) ? r.pick(parentPool) : null
    const alias = r.pick(['haiku', 'sonnet', 'opus'])
    const model = ALIAS[alias]
    const u = priced(model, {
      input: r.int(200, 3000),
      output: r.int(200, 4000),
      cacheRead: r.int(5000, 90000),
      cacheWrite1h: r.int(0, 3000),
    })
    const cost: Cost = { usd: 0 }
    addModel(cost, model, u)
    const started = Date.parse(spawn.startedAt ?? '') + r.int(1, 20) * 1000
    const dur = r.int(10, 400) * 1000
    const status = r.pick([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
      'open',
      'killed',
    ] as const)
    const unresolved = !deep && r.chance(0.06)
    const calls = r.int(0, 25)
    const kind = r.chance(0.1) ? 'teammate' : r.chance(0.08) ? 'fork' : 'subagent'
    agents.push({
      id: `a${r.hex(15)}`,
      kind,
      name: r.chance(0.15) ? r.pick(['scout', 'reviewer', 'tester']) : undefined,
      agentType: r.pick(AGENT_TYPES),
      description: r.pick(SPAWN_REASONS),
      model: alias,
      parentAgentId: unresolved ? null : (parent?.id ?? null),
      spawnToolUseId: `toolu_${r.hex(12)}`,
      spawnTurn: unresolved ? undefined : spawn.index,
      depth: unresolved ? 1 : (parent?.depth ?? 0) + 1,
      background: r.chance(0.2) || undefined,
      linkage: unresolved ? 'unresolved' : r.chance(0.85) ? 'meta' : r.pick(['tool-result', 'name', 'prompt'] as const),
      startedAt: iso(started),
      endedAt: iso(started + dur),
      status,
      prompt: wrapPrompt(kind, `${r.pick(SPAWN_REASONS)}. ${paragraph(r, 2)}`),
      finalText: status === 'killed' ? undefined : finalText(r),
      inbox: r.chance(0.1) ? [{ at: iso(started + dur / 2), from: 'main', text: sentence(r) }] : undefined,
      assistantMessages: r.int(1, 12),
      toolCalls: calls,
      toolsByName: calls ? { [r.pick(TOOLS)]: calls } : undefined,
      cost,
      subtreeUSD: cost.usd,
    })
  }
  shape?.(agents)
  // subtree sums, children before parents (an agent's parent was created earlier)
  const byId = new Map(agents.map((a) => [a.id, a]))
  for (let k = agents.length - 1; k >= 0; k--) {
    const a = agents[k]
    const p = a.parentAgentId ? byId.get(a.parentAgentId) : undefined
    if (p) p.subtreeUSD += a.subtreeUSD
  }
  // spawned ids and costWithAgents
  for (const a of agents) {
    if (a.spawnTurn === undefined) continue
    const t = turns[a.spawnTurn]
    t.spawned = [...(t.spawned ?? []), a.id]
    if (!a.parentAgentId) t.costWithAgents += a.subtreeUSD
  }
  return agents
}

/**
 * For the Agents card (spec.zoo): 12 consecutive Explore agents, an orchestrator with 10 Plan
 * children and a chain five levels deep, a teammate, a fork, a killed and an open agent, an
 * orphan (its parent is not in the list), an unresolved agent with a child. Start times follow
 * the order of the list, parents come before their children.
 */
function shapeZoo(agents: Agent[]) {
  const at = (i: number) => agents[i]
  const set = (i: number, parent: number | string | null, extra: Partial<Agent> = {}) => {
    const a = at(i)
    if (!a) return
    a.parentAgentId = typeof parent === 'number' ? at(parent).id : parent
    a.depth = typeof parent === 'number' ? at(parent).depth + 1 : 1
    a.linkage = 'meta'
    a.kind = 'subagent'
    a.name = undefined
    a.status = 'completed'
    a.background = undefined
    Object.assign(a, extra)
  }
  const base = Date.parse(at(0).startedAt ?? '')
  agents.forEach((a, i) => {
    const start = base + i * 15_000
    a.startedAt = new Date(start).toISOString()
    a.endedAt = new Date(start + 60_000 + (i % 7) * 20_000).toISOString()
  })
  for (let i = 0; i < 12; i++) set(i, null, { agentType: 'Explore', description: `Look into module ${i + 1}` })
  set(12, null, {
    agentType: 'general-purpose',
    description: 'Orchestrate the migration of the sync engine',
    background: true,
  })
  for (let i = 13; i < 23; i++) set(i, 12, { agentType: 'Plan', description: `Plan step ${i - 12} of the migration` })
  set(23, 12, { agentType: 'code-reviewer', description: 'Review the whole migration' })
  set(24, 23, { agentType: 'general-purpose', description: 'Check the changed callers' })
  set(25, 24, { agentType: 'Explore', description: 'Find every caller of the helper' })
  set(26, 25, { agentType: 'Explore', description: 'Read the generated code', status: 'killed', finalText: undefined })
  set(27, null, { kind: 'teammate', name: 'scout', agentType: 'Explore', description: 'Keeps an eye on the CI runs' })
  set(28, null, { kind: 'fork', agentType: 'general-purpose', description: 'Try the other approach in parallel' })
  set(29, null, { agentType: 'Plan', description: 'Design the cache layout', status: 'killed', finalText: undefined })
  set(30, null, { agentType: 'Plan', description: 'Never wrote a final answer', status: 'open', finalText: undefined })
  set(31, 'a0000000000orphan', { agentType: 'Explore', description: 'Its parent is not in the list' })
  set(32, null, {
    agentType: 'general-purpose',
    description: 'Spawn could not be found',
    linkage: 'unresolved',
    spawnTurn: undefined,
  })
  set(33, 32, { agentType: 'Explore', description: 'Child of the unresolved one' })
}

export function makeSession(r: Rng, spec: Spec, now: number): Sess {
  const turns: Turn[] = []
  const compactions: Compaction[] = []
  let t = spec.start
  let ctx = 12_000
  let epoch = 0
  for (let i = 0; i < spec.turns; i++) {
    if (spec.compactEvery && i > 0 && i % spec.compactEvery === 0) {
      const pre = Math.round(ctx)
      ctx = r.int(18_000, 30_000)
      compactions.push({
        at: iso(t - 5000),
        turn: i - 1,
        trigger: r.chance(0.8) ? 'auto' : 'manual',
        preTokens: pre,
        postTokens: Math.round(ctx),
        durationMs: r.int(20, 90) * 1000,
        summary: `## Summary\n\n${paragraph(r, 4)}\n\n- ${sentence(r)}\n- ${sentence(r)}`,
      })
      epoch++
    }
    turns.push(makeTurn(r, i, t, ctx, epoch, spec))
    ctx = Math.min(195_000, ctx + r.int(500, spec.compactEvery ? 3000 : 12_000))
    const [g0, g1] = spec.gapMin ?? [1, 40]
    t = Date.parse(turns[i].endedAt ?? '') + r.int(g0, g1) * MIN
  }
  const nAgents = spec.agents ?? (spec.turns > 3 && r.chance(0.4) ? r.int(1, 4) : 0)
  const agents = makeAgents(r, turns, nAgents, !!spec.deepAgents, spec.zoo ? shapeZoo : undefined)
  for (const c of compactions) {
    const model = 'claude-haiku-4-5-20251001'
    const cost: Cost = { usd: 0 }
    addModel(cost, model, priced(model, { input: c.preTokens ?? 100000, output: 2000, cacheRead: 0, cacheWrite1h: 0 }))
    agents.push({
      id: `acompact${r.hex(9)}`,
      kind: 'compact',
      model: 'haiku',
      parentAgentId: null,
      depth: 1,
      linkage: 'meta',
      startedAt: c.at,
      endedAt: c.at,
      status: 'completed',
      assistantMessages: 1,
      toolCalls: 0,
      cost,
      subtreeUSD: cost.usd,
    })
  }

  const last = turns[turns.length - 1]
  const lastAt = Date.parse(last.endedAt ?? '')
  // digest cost
  const dcost: Cost = { usd: 0 }
  for (const x of turns) for (const [m, mc] of Object.entries(x.cost.byModel ?? {})) addModel(dcost, m, mc)
  for (const a of agents) for (const [m, mc] of Object.entries(a.cost.byModel ?? {})) addModel(dcost, m, mc)

  return finishSession(r, spec, { turns, agents, compactions, dcost, lastAt, now })
}

interface Parts {
  turns: Turn[]
  agents: Agent[]
  compactions: Compaction[]
  dcost: Cost
  lastAt: number
  now: number
}

/** Everything that depends on the final turns and agents: spend, reported windows, summary, detail. */
export function finishSession(r: Rng, spec: Spec, p: Parts, inherited?: { turns: number; from: SessionKey }): Sess {
  const { turns, agents, compactions, dcost, lastAt } = p
  const startedAt = Date.parse(turns[0].startedAt ?? '')
  const inheritedN = inherited?.turns ?? 0
  // Own spend: events of own turns and of agents spawned in own turns.
  const spend: Spend[] = []
  for (const x of turns.slice(inheritedN)) {
    for (const [m, mc] of Object.entries(x.cost.byModel ?? {}))
      spend.push({ at: Date.parse(x.endedAt ?? ''), model: m, usd: mc.usd, reported: false })
  }
  for (const a of agents) {
    if (a.spawnTurn !== undefined && a.spawnTurn < inheritedN) continue
    for (const [m, mc] of Object.entries(a.cost.byModel ?? {}))
      spend.push({ at: Date.parse(a.startedAt ?? ''), model: m, usd: mc.usd, reported: false })
  }
  const own = spend.reduce((a, s) => a + s.usd, 0)
  let windowEnd = 0
  if (spec.flag === 'exact') windowEnd = lastAt + 1000
  else if (spec.flag === 'partial') windowEnd = startedAt + (lastAt - startedAt) * 0.6
  let covered = 0
  if (windowEnd)
    for (const s of spend)
      if (s.at <= windowEnd) {
        s.reported = true
        covered += s.usd
      }
  const overhead = windowEnd ? covered * (0.01 + r.next() * 0.04) : 0
  if (overhead > 0) spend.push({ at: Math.min(windowEnd, lastAt), model: '(overhead)', usd: overhead, reported: true })
  const reported = covered + overhead
  const uncovered = own - covered
  const best = reported + uncovered
  const inheritedUSD = turns.slice(0, inheritedN).reduce((a, x) => a + x.costWithAgents, 0)
  const flag: CostFlag = spec.flag

  const cost: SessionCost = {
    bestUSD: best,
    flag,
    reportedUSD: reported,
    windows: windowEnd
      ? [
          {
            from: iso(startedAt),
            to: iso(windowEnd),
            totalUSD: reported,
            byModel: Object.fromEntries(
              Object.entries(dcost.byModel ?? {}).map(([m, mc]) => [
                m,
                {
                  inputTokens: mc.input,
                  outputTokens: mc.output,
                  cacheReadTokens: mc.cacheRead,
                  cacheCreationTokens: mc.cacheWrite1h,
                  usd: mc.usd * (windowEnd ? covered / Math.max(own, 1e-9) : 0),
                },
              ]),
            ),
          },
        ]
      : undefined,
    ownUSD: own,
    coveredUSD: covered,
    uncoveredUSD: uncovered,
    overheadUSD: overhead,
    inheritedUSD,
    inheritedFrom:
      inherited && inheritedUSD > 0
        ? [{ from: inherited.from, usd: inheritedUSD, messages: inheritedN * 3 }]
        : undefined,
    ownMessages: turns.slice(inheritedN).reduce((a, x) => a + x.assistantMessages, 0),
    inheritedMessages: turns.slice(0, inheritedN).reduce((a, x) => a + x.assistantMessages, 0),
  }

  const humanTurns = turns.filter((x) => x.origin === 'human')
  const lastHuman = humanTurns[humanTurns.length - 1]
  const ttl = spec.title === null ? undefined : (spec.title ?? title(r))
  const recaps = spec.recap ? [{ at: iso(lastAt - 60_000), text: `Where things stand: ${paragraph(r, 3)}` }] : undefined
  const branch = r.pick(BRANCHES)
  const digest: SessionDigest = {
    schemaVersion: 1,
    parserVersion: 1,
    source: [{ path: `projects/${spec.project.replace(/\//g, '-')}/${spec.id}.jsonl`, size: 120_000, mtimeNs: 0 }],
    sourceMissing: spec.sourceMissing || undefined,
    harness: 'claude',
    id: spec.id,
    projectKey: spec.project.replace(/\//g, '-'),
    project: spec.project,
    cwd: spec.project,
    cwds: [spec.project],
    gitBranches: [branch],
    harnessVersions: ['2.1.280'],
    kind: spec.kind,
    title: ttl,
    startedAt: iso(startedAt),
    lastActivityAt: iso(lastAt),
    endState: spec.endState,
    recaps,
    lineage: {},
    stats: {
      humanTurns: humanTurns.length,
      turns: turns.length,
      assistantMessages: turns.reduce((a, x) => a + x.assistantMessages, 0),
      toolCalls: turns.reduce((a, x) => a + x.toolCalls, 0),
      toolsByName: turns.reduce<Record<string, number>>((acc, x) => {
        for (const [k, v] of Object.entries(x.toolsByName ?? {})) acc[k] = (acc[k] ?? 0) + v
        return acc
      }, {}),
      linesAdded: r.int(0, 900),
      linesRemoved: r.int(0, 400),
    },
    cost: dcost,
    reported: windowEnd ? { totalUSD: reported, windows: cost.windows, byModel: cost.windows?.[0].byModel } : undefined,
    compactions: compactions.length ? compactions : undefined,
    turns,
    agents: agents.length ? agents : undefined,
    diagnostics: spec.special ? { badLines: 2, unknownTypes: { 'x-progress': 14 } } : {},
  }
  if (spec.endState === 'interrupted') turns[turns.length - 1].interrupted = true

  const summary: SessionSummary = {
    key: keyOf(spec.id),
    project: spec.project,
    projectKey: digest.projectKey,
    cwd: spec.project,
    branch,
    title: ttl,
    kind: spec.kind,
    startedAt: iso(startedAt),
    lastActivityAt: iso(lastAt),
    endState: spec.endState,
    sourceMissing: spec.sourceMissing || undefined,
    state: spec.state ?? 'ended',
    turns: turns.length,
    agents: agents.filter((a) => a.kind !== 'compact').length,
    cost: { bestUSD: best, flag, reportedUSD: reported, uncoveredUSD: uncovered, overheadUSD: overhead, inheritedUSD },
    lineage: {
      children: 0,
      root: keyOf(spec.id),
      leaf: true,
      inheritedTurns: inheritedN,
      firstOwnTurn: inheritedN >= turns.length ? -1 : inheritedN,
    },
    humanTurns: humanTurns.length,
    lastPrompt: lastHuman
      ? {
          turn: lastHuman.index,
          at: lastHuman.startedAt ?? iso(startedAt),
          text: lastHuman.userText.slice(0, 300),
          truncated: lastHuman.userText.length > 300,
        }
      : undefined,
    recap: recaps
      ? { at: recaps[0].at, text: recaps[0].text.slice(0, 300), truncated: recaps[0].text.length > 300 }
      : undefined,
  }
  const lineage: SessionLineage = {
    children: [],
    root: keyOf(spec.id),
    leaf: true,
    inheritedTurns: [],
    firstOwnTurn: summary.lineage.firstOwnTurn,
  }
  const family: SessionFamily = { root: keyOf(spec.id), members: [], leaves: [] }
  return {
    summary,
    detail: { summary, cost, lineage, family, messageCount: cost.ownMessages + cost.inheritedMessages, digest },
    spend,
    live: !!spec.state && spec.state !== 'ended' && spec.state !== 'recent',
  }
}

/** One billed message per assistant message of every turn (the `?messages=1` payload). */
export function messagesOf(d: SessionDigest): Message[] {
  const out: Message[] = []
  for (const t of d.turns ?? []) {
    const n = Math.max(1, t.assistantMessages)
    const [model, mc] = Object.entries(t.cost.byModel ?? {})[0] ?? ['claude-sonnet-5-5', { usd: 0 }]
    for (let k = 0; k < n; k++) {
      out.push({
        id: `msg_${t.index}_${k}`,
        at: iso(Date.parse(t.startedAt ?? '') + ((k + 1) * (t.durationMs ?? 0)) / (n + 1)),
        model,
        turn: t.index,
        usd: mc.usd / n,
        input: Math.round((mc.input ?? 0) / n),
        output: Math.round((mc.output ?? 0) / n),
        cacheRead: Math.round((mc.cacheRead ?? 0) / n),
      })
    }
  }
  return out
}

// ---- the data set ---------------------------------------------------------------------

export function buildDataset(now: number, seed = 20260915): Dataset {
  const r = makeRng(seed)
  const sessions: Sess[] = []
  const flagOf = (): CostFlag => {
    const x = r.next()
    return x < 0.35 ? 'exact' : x < 0.5 ? 'partial' : 'estimated'
  }
  const endOf = (): EndState => {
    const x = r.next()
    return x < 0.82 ? 'clean' : x < 0.9 ? 'interrupted' : x < 0.96 ? 'mid-turn' : 'unknown'
  }

  // 1. independent sessions, spread over 90 days with a bias to recent ones
  for (let i = 0; i < 424; i++) {
    const ageDays = r.next() ** 1.6 * 90
    const start = now - ageDays * DAY - r.int(0, 20 * 60) * MIN - 6 * 3600_000
    const turns = r.chance(0.08) ? r.int(1, 2) : r.chance(0.8) ? r.int(2, 14) : r.int(15, 60)
    const kind: SessionKind = r.chance(0.15) ? 'background' : 'interactive'
    const s = makeSession(
      r,
      {
        id: r.uuid(),
        project: r.pick(PROJECTS),
        kind,
        start,
        turns,
        flag: flagOf(),
        endState: endOf(),
        title: r.chance(0.06) ? null : undefined,
        recap: r.chance(0.12),
        sourceMissing: r.chance(0.02),
        compactEvery: turns > 45 ? 25 : undefined,
      },
      now,
    )
    clampPast(s, now)
    sessions.push(s)
  }

  // 2. special sessions
  const special = (spec: Spec) => {
    const s = makeSession(r, spec, now)
    if (!spec.state) clampPast(s, now)
    sessions.push(s)
    return s
  }
  const big = special({
    id: r.uuid(),
    project: '/home/dev/merlin',
    kind: 'interactive',
    start: now - 5 * DAY,
    turns: 600,
    flag: 'partial',
    endState: 'clean',
    state: 'busy',
    title: 'long refactor of the sync engine (600 turns)',
    agents: 40,
    deepAgents: true,
    compactEvery: 80,
    recap: true,
    gapMin: [1, 12],
  })
  special({
    id: r.uuid(),
    project: '/home/dev/acme/web',
    kind: 'interactive',
    start: now - 2 * DAY,
    turns: 6,
    flag: 'exact',
    endState: 'clean',
    title: 'a prompt of one hundred kilobytes',
    special: 'huge',
  })
  special({
    id: r.uuid(),
    project: '/home/dev/acme/api',
    kind: 'interactive',
    start: now - 3 * DAY,
    turns: 5,
    flag: 'estimated',
    endState: 'mid-turn',
    title: `unbroken-${'abcdef0123456789'.repeat(16)}`,
    special: 'strings',
  })
  special({
    id: r.uuid(),
    project: '/home/dev/acme/web',
    kind: 'interactive',
    start: now - 4 * DAY,
    turns: 24,
    flag: 'partial',
    endState: 'interrupted',
    title: 'rewound a few times',
    special: 'abandoned',
  })
  special({
    id: r.uuid(),
    project: '/home/dev/acme/web',
    kind: 'interactive',
    start: now - 50 * MIN - 6 * 3600_000,
    turns: 9,
    flag: 'exact',
    endState: 'clean',
    state: 'idle',
    title: 'waiting for your answer',
    gapMin: [1, 3],
  })
  special({
    id: r.uuid(),
    project: '/home/dev/oss/parser',
    kind: 'interactive',
    start: now - 30 * MIN,
    turns: 4,
    flag: 'estimated',
    endState: 'clean',
    state: 'busy',
    title: 'speed up the tokenizer',
    gapMin: [1, 2],
  })
  for (const title of ['quick fix for the date test', 'rename the config keys']) {
    const s = special({
      id: r.uuid(),
      project: r.pick(PROJECTS),
      kind: 'interactive',
      start: now - 40 * MIN,
      turns: 3,
      flag: 'exact',
      endState: 'clean',
      state: 'recent',
      title,
      gapMin: [1, 2],
    })
    // a recent session ended a few minutes ago
    s.summary.lastActivityAt = iso(now - r.int(2, 8) * MIN)
    s.detail.digest.lastActivityAt = s.summary.lastActivityAt
  }
  // Live sessions end at "now": move their last turns to the present.
  for (const s of sessions.filter((x) => x.summary.state === 'busy' || x.summary.state === 'idle')) {
    const shift = now - Date.parse(s.summary.lastActivityAt ?? '') - (s.summary.state === 'idle' ? 4 * MIN : 20_000)
    shiftSession(s, shift)
  }

  // 3. families: continuations and forks of existing sessions
  const eligible = () =>
    sessions.filter(
      (s) =>
        s.summary.kind === 'interactive' &&
        s.summary.turns >= 4 &&
        !s.live &&
        Date.parse(s.summary.lastActivityAt ?? '') < now - 6 * 3600_000 &&
        !s.summary.sourceMissing,
    )
  for (let i = 0; i < 70; i++) {
    const pool = eligible()
    const parent = r.pick(pool)
    const pd = parent.detail.digest
    const kind: 'fork' | 'continuation' = r.chance(0.35) ? 'fork' : 'continuation'
    const k = kind === 'continuation' ? pd.turns!.length : r.int(2, pd.turns!.length - 1)
    const startAt =
      kind === 'continuation'
        ? Date.parse(parent.summary.lastActivityAt ?? '') + r.int(30, 600) * MIN
        : Date.parse(pd.turns![k - 1].endedAt ?? '') + r.int(5, 90) * MIN
    if (startAt > now - 30 * MIN) continue
    if (kind === 'continuation' && !parent.summary.lineage.leaf) continue
    const own = r.int(1, 14)
    const copied = pd.turns!.slice(0, k).map((t) => structuredClone(t))
    const child = makeSession(
      r,
      {
        id: r.uuid(),
        project: parent.summary.project,
        kind: 'interactive',
        start: startAt,
        turns: own,
        flag: flagOf(),
        endState: endOf(),
        recap: r.chance(0.1),
      },
      now,
    )
    const cd = child.detail.digest
    const ownTurns = (cd.turns ?? []).map((t, j) => ({ ...t, index: k + j }))
    const ownAgents = (cd.agents ?? []).map((a) => ({
      ...a,
      spawnTurn: a.spawnTurn === undefined ? undefined : a.spawnTurn + k,
    }))
    const dcost: Cost = { usd: 0 }
    for (const x of [...copied, ...ownTurns])
      for (const [m, mc] of Object.entries(x.cost.byModel ?? {})) addModel(dcost, m, mc)
    for (const a of ownAgents) for (const [m, mc] of Object.entries(a.cost.byModel ?? {})) addModel(dcost, m, mc)
    const spec: Spec = {
      id: cd.id,
      project: cd.project,
      kind: 'interactive',
      start: startAt,
      turns: copied.length + ownTurns.length,
      flag: child.summary.cost.flag,
      endState: cd.endState ?? 'clean',
      title: cd.title,
      recap: !!cd.recaps,
    }
    const all = [...copied, ...ownTurns]
    const rebuilt = finishSession(
      r,
      spec,
      { turns: all, agents: ownAgents, compactions: [], dcost, lastAt: Date.parse(cd.lastActivityAt ?? ''), now },
      { turns: k, from: parent.summary.key },
    )
    rebuilt.parent = { key: parent.summary.key, kind, atTurn: k - 1 }
    sessions.push(rebuilt)
    if (kind === 'continuation') parent.summary.lineage.leaf = false
    parent.detail.lineage.leaf = parent.summary.lineage.leaf
  }

  linkFamilies(sessions)

  // 4. scripted runs: per project and day, about 3,100 in all
  const scripted: ScriptedLine[] = []
  for (let d = 0; d < 90; d++) {
    const day = new Date(now - d * DAY)
    const label = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    for (const p of PROJECTS.filter(() => r.chance(0.3))) {
      const count = r.int(5, 60)
      const usd = count * (0.002 + r.next() * 0.01)
      scripted.push({ project: p, day: label, count, totalUSD: usd, reportedUSD: usd * 0.7, attributedUSD: usd * 0.3 })
    }
  }

  // 5. one more session for the Agents card (own random stream: nothing above changes)
  const zr = makeRng(4242)
  const zooSession = makeSession(
    zr,
    {
      id: zr.uuid(),
      project: '/home/dev/merlin',
      kind: 'interactive',
      start: now - 36 * 3600_000,
      turns: 20,
      flag: 'exact',
      endState: 'clean',
      title: 'agent zoo: long runs, deep chain, orphan, unresolved',
      agents: 34,
      zoo: true,
    },
    now,
  )
  clampPast(zooSession, now)
  sessions.push(zooSession)

  sessions.sort(order)
  return {
    now,
    sessions,
    byId: new Map(sessions.map((s) => [s.summary.key.id, s])),
    scripted,
    bigId: big.summary.key.id,
  }
}

export function order(a: Sess, b: Sess): number {
  const x = a.summary.lastActivityAt ?? ''
  const y = b.summary.lastActivityAt ?? ''
  return x < y ? 1 : x > y ? -1 : a.summary.key.id < b.summary.key.id ? -1 : 1
}

/** Moves a session that ends in the future back so that it ended at least ten minutes ago. */
function clampPast(s: Sess, now: number) {
  const over = Date.parse(s.summary.lastActivityAt ?? '') - (now - 10 * MIN)
  if (over > 0) shiftSession(s, -over - (Date.parse(s.summary.lastActivityAt ?? '') % 3_600_000))
}

function shiftSession(s: Sess, ms: number) {
  const sh = (v: string | undefined) => (v ? iso(Date.parse(v) + ms) : v)
  const d = s.detail.digest
  d.startedAt = sh(d.startedAt)
  d.lastActivityAt = sh(d.lastActivityAt)
  s.summary.startedAt = d.startedAt
  s.summary.lastActivityAt = d.lastActivityAt
  for (const t of d.turns ?? []) {
    t.startedAt = sh(t.startedAt)
    t.endedAt = sh(t.endedAt)
  }
  for (const a of d.agents ?? []) {
    a.startedAt = sh(a.startedAt)
    a.endedAt = sh(a.endedAt)
  }
  for (const c of d.compactions ?? []) c.at = sh(c.at) ?? c.at
  for (const w of s.detail.cost.windows ?? []) {
    w.from = sh(w.from) ?? w.from
    w.to = sh(w.to) ?? w.to
  }
  for (const e of s.spend) e.at += ms
}

/** Fills lineage, family and the summary's brief lineage from the parent links. */
function linkFamilies(sessions: Sess[]) {
  const byId = new Map(sessions.map((s) => [s.summary.key.id, s]))
  const kids = new Map<string, Sess[]>()
  for (const s of sessions) if (s.parent) kids.set(s.parent.key.id, [...(kids.get(s.parent.key.id) ?? []), s])
  const rootOf = (s: Sess): Sess => (s.parent ? rootOf(byId.get(s.parent.key.id) as Sess) : s)
  const linkOf = (c: Sess): Link => {
    const inherited = c.summary.lineage.inheritedTurns
    return {
      parent: c.parent!.key,
      child: c.summary.key,
      sharedMessages: inherited * 3,
      sharedTurns: inherited,
      atTurn: c.parent!.atTurn,
      explicit: c.parent!.kind === 'fork',
      kind: c.parent!.kind,
    }
  }
  for (const s of sessions) {
    const children = (kids.get(s.summary.key.id) ?? []).sort((a, b) =>
      (a.summary.startedAt ?? '') < (b.summary.startedAt ?? '') ? -1 : 1,
    )
    const root = rootOf(s).summary.key
    const inheritedN = s.summary.lineage.inheritedTurns
    const leaf = !children.some((c) => c.parent!.kind === 'continuation')
    s.summary.lineage = {
      parent: s.parent?.key,
      parentKind: s.parent?.kind,
      children: children.length,
      root,
      leaf,
      inheritedTurns: inheritedN,
      firstOwnTurn: s.summary.lineage.firstOwnTurn,
    }
    s.detail.lineage = {
      parent: s.parent ? linkOf(s) : undefined,
      children: children.map(linkOf),
      root,
      leaf,
      inheritedTurns: Array.from({ length: inheritedN }, (_, i) => i),
      firstOwnTurn: s.summary.lineage.firstOwnTurn,
    }
  }
  // family per root, in tree order
  const treeOrder = (s: Sess): Sess[] => [
    s,
    ...(kids.get(s.summary.key.id) ?? [])
      .sort((a, b) => ((a.summary.startedAt ?? '') < (b.summary.startedAt ?? '') ? -1 : 1))
      .flatMap(treeOrder),
  ]
  const families = new Map<string, SessionFamily>()
  for (const s of sessions) {
    if (s.parent) continue
    const members = treeOrder(s)
    if (members.length < 2) continue
    const fam: SessionFamily = {
      root: s.summary.key,
      members: members.map((m) => ({
        key: m.summary.key,
        title: m.summary.title,
        kind: m.summary.kind,
        startedAt: m.summary.startedAt,
        lastActivityAt: m.summary.lastActivityAt,
        state: m.summary.state,
        parent: m.parent?.key,
        leaf: m.summary.lineage.leaf,
        turns: m.summary.turns,
        bestUSD: m.summary.cost.bestUSD,
      })),
      leaves: members
        .filter((m) => m.summary.lineage.leaf)
        .sort(order)
        .map((m) => m.summary.key),
    }
    families.set(s.summary.key.id, fam)
  }
  for (const s of sessions) {
    const fam = families.get(s.summary.lineage.root.id)
    s.detail.family = fam ?? { root: s.summary.key, members: [], leaves: [s.summary.key] }
    if (!fam)
      s.detail.family.members = [
        {
          key: s.summary.key,
          title: s.summary.title,
          kind: s.summary.kind,
          startedAt: s.summary.startedAt,
          lastActivityAt: s.summary.lastActivityAt,
          state: s.summary.state,
          leaf: true,
          turns: s.summary.turns,
          bestUSD: s.summary.cost.bestUSD,
        },
      ]
  }
}
