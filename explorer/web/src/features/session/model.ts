// The logic behind the Session page, as pure functions: which turns are inherited, where the
// compactions sit, what "prompts only" hides, what a URL hash points at, the resume command and
// the family tree.

import type {
  Agent,
  Compaction,
  Diagnostics,
  FamilyMember,
  ModelCost,
  SessionCost,
  SessionDetail,
  SessionKey,
  Turn,
} from '../../api/types'
import { formatMoney } from '../../lib/format'
import { firstLine, resumeCommand } from '../../lib/paths'
import { sameKey } from '../../lib/session'
import { unwrapMachineText } from '../../lib/wrapper'

// ---- hash addressing --------------------------------------------------------------------

export type Target =
  | { kind: 'turn'; index: number }
  | { kind: 'agent'; id: string }
  | { kind: 'compaction'; index: number }

/** `#t12` -> turn 12, `#a<id>` -> an agent, `#c0` -> the first compaction. Anything else: null. */
export function parseHash(hash: string): Target | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  const num = /^(\d+)$/
  if (h.startsWith('t') && num.test(h.slice(1))) return { kind: 'turn', index: Number(h.slice(1)) }
  if (h.startsWith('c') && num.test(h.slice(1))) return { kind: 'compaction', index: Number(h.slice(1)) }
  if (h.startsWith('a') && h.length > 1) return { kind: 'agent', id: decodeURIComponent(h.slice(1)) }
  return null
}

export const turnDomId = (index: number) => `t${index}`
export const compactionDomId = (index: number) => `c${index}`

export function targetDomId(t: Target | null): string | null {
  if (!t) return null
  if (t.kind === 'turn') return turnDomId(t.index)
  if (t.kind === 'compaction') return compactionDomId(t.index)
  return null
}

// ---- the timeline -----------------------------------------------------------------------

export interface TurnEntry {
  type: 'turn'
  turn: Turn
  inherited: boolean
}
export interface CompactionEntry {
  type: 'compaction'
  compaction: Compaction
  /** Position in `digest.compactions`: its address (`#c<index>`). */
  index: number
  inherited: boolean
}
export type Entry = TurnEntry | CompactionEntry

export interface InheritedGroup {
  type: 'inherited'
  entries: Entry[]
  /** Number of turns in the group (compactions are not counted). */
  turns: number
}
/** A run of turns that "prompts only" hides. */
export interface HiddenRun {
  type: 'hidden'
  turns: Turn[]
}
export type Item = TurnEntry | CompactionEntry | InheritedGroup | HiddenRun

/**
 * Turns and compactions in one ordered list. A compaction sits after the turn whose index is
 * `compaction.turn` (-1: before the first turn); several after one turn keep their order.
 * A compaction is inherited when the turns on both sides of it are (a leading one: when the
 * first turn is), so a boundary at the seam between copied and own turns stays visible.
 */
export function mergeEntries(turns: Turn[], compactions: Compaction[], inheritedTurns: number[]): Entry[] {
  const inherited = new Set(inheritedTurns)
  const positionOf = new Map<number, number>()
  turns.forEach((t, i) => {
    positionOf.set(t.index, i)
  })
  // slot k = before turns[k]; slot turns.length = after the last turn
  const slots: { compaction: Compaction; index: number }[][] = Array.from({ length: turns.length + 1 }, () => [])
  compactions.forEach((compaction, index) => {
    let slot: number
    if (compaction.turn < 0) slot = 0
    else {
      const pos = positionOf.get(compaction.turn)
      slot = pos === undefined ? turns.length : pos + 1
    }
    slots[slot].push({ compaction, index })
  })
  const out: Entry[] = []
  for (let k = 0; k <= turns.length; k++) {
    const before = k > 0 ? inherited.has(turns[k - 1].index) : undefined
    const after = k < turns.length ? inherited.has(turns[k].index) : undefined
    const copied = (before ?? after ?? false) && (after ?? before ?? false)
    for (const c of slots[k])
      out.push({ type: 'compaction', compaction: c.compaction, index: c.index, inherited: copied })
    if (k < turns.length) out.push({ type: 'turn', turn: turns[k], inherited: inherited.has(turns[k].index) })
  }
  return out
}

/** Consecutive inherited entries become one group (a group holds at least one turn). */
export function groupInherited(entries: Entry[]): (Entry | InheritedGroup)[] {
  const out: (Entry | InheritedGroup)[] = []
  let run: Entry[] = []
  const flush = () => {
    if (run.length === 0) return
    const turns = run.filter((e) => e.type === 'turn').length
    if (turns > 0) out.push({ type: 'inherited', entries: run, turns })
    else out.push(...run)
    run = []
  }
  for (const e of entries) {
    if (e.inherited) run.push(e)
    else {
      flush()
      out.push(e)
    }
  }
  flush()
  return out
}

/** A turn a person typed. Everything else (commands included) is a compact line. */
export const isHumanTurn = (t: Pick<Turn, 'origin'>) => t.origin === 'human'

/** With `promptsOnly`, every run of turns nobody typed collapses into one `hidden` marker. */
export function applyPromptsOnly(items: (Entry | InheritedGroup)[]): Item[] {
  const out: Item[] = []
  for (const it of items) {
    if (it.type === 'turn' && !isHumanTurn(it.turn)) {
      const last = out[out.length - 1]
      if (last && last.type === 'hidden') last.turns.push(it.turn)
      else out.push({ type: 'hidden', turns: [it.turn] })
    } else if (it.type === 'inherited') {
      // inside the group the machine turns are dropped from view (they stay counted)
      out.push({ ...it, entries: it.entries.filter((e) => e.type !== 'turn' || isHumanTurn(e.turn)) })
    } else out.push(it)
  }
  return out
}

export interface Timeline {
  items: Item[]
  /** The index of the first turn that is not inherited, or null when none is. */
  firstOwnTurn: number | null
  inheritedTurns: number
}

export function buildTimeline(detail: SessionDetail, promptsOnly: boolean): Timeline {
  const turns = detail.digest.turns ?? []
  const entries = mergeEntries(turns, detail.digest.compactions ?? [], detail.lineage.inheritedTurns)
  const grouped = groupInherited(entries)
  const items: Item[] = promptsOnly ? applyPromptsOnly(grouped) : grouped
  const own = turns.find((t) => !detail.lineage.inheritedTurns.includes(t.index))
  return { items, firstOwnTurn: own ? own.index : null, inheritedTurns: detail.lineage.inheritedTurns.length }
}

/** What a turn hash needs from the page: the inherited group opened, "prompts only" off. */
export function turnNeeds(detail: SessionDetail, index: number): { inherited: boolean; machine: boolean } {
  const t = detail.digest.turns?.find((x) => x.index === index)
  return {
    inherited: detail.lineage.inheritedTurns.includes(index),
    machine: !!t && !isHumanTurn(t),
  }
}

export function compactionIsInherited(detail: SessionDetail, index: number): boolean {
  const entries = mergeEntries(
    detail.digest.turns ?? [],
    detail.digest.compactions ?? [],
    detail.lineage.inheritedTurns,
  )
  return entries.some((e) => e.type === 'compaction' && e.index === index && e.inherited)
}

// ---- turns ------------------------------------------------------------------------------

/**
 * The line a compact machine turn shows: a command (its text already starts with the command as
 * typed), a task notification or peer message by label and summary, else the first line of its text.
 */
export function machineLine(t: Pick<Turn, 'origin' | 'command' | 'userText'>): string {
  const first = firstLine(t.userText)
  if (t.origin === 'command' && t.command) {
    const name = t.command.startsWith('/') ? t.command : `/${t.command}`
    if (!first) return name
    return first === name || first.startsWith(`${name} `) ? first : `${name} ${first}`
  }
  const u = unwrapMachineText(t.userText)
  if (u.label) return u.summary ? `${u.label}: ${u.summary}` : u.label
  return first || '(empty)'
}

export interface ToolCount {
  name: string
  count: number
}

/** The `n` most used tools (ties by name) and how many calls the rest made. */
export function topTools(toolsByName: Record<string, number> | undefined, n = 3): { top: ToolCount[]; rest: number } {
  const all = Object.entries(toolsByName ?? {})
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
  const top = all.slice(0, n)
  return { top, rest: all.slice(n).reduce((s, t) => s + t.count, 0) }
}

/** Whether a turn spawned agents whose cost `costWithAgents` adds to its own. */
export const hasAgentCost = (t: Pick<Turn, 'cost' | 'costWithAgents' | 'spawned'>) =>
  (t.spawned?.length ?? 0) > 0 && t.costWithAgents - t.cost.usd > 1e-9

/** The agents a turn spawned, in the order of `turn.spawned`; ids that are not in the digest are skipped. */
export function spawnedAgents(turn: Pick<Turn, 'spawned'>, byId: Map<string, Agent>): Agent[] {
  const out: Agent[] = []
  for (const id of turn.spawned ?? []) {
    const a = byId.get(id)
    if (a) out.push(a)
  }
  return out
}

/** The head of a text for a clamped view: at most `max` characters, cut at a paragraph or line end when one is near. */
export function textHead(text: string, max: number): { head: string; cut: boolean } {
  if (text.length <= max) return { head: text, cut: false }
  let end = text.lastIndexOf('\n\n', max)
  if (end < max * 0.6) end = text.lastIndexOf('\n', max)
  if (end < max * 0.6) end = max
  return { head: text.slice(0, end), cut: true }
}

// ---- resume -----------------------------------------------------------------------------

export interface ResumeInfo {
  /** `cd <cwd> && claude --resume <id>` for this session (cwd where it ended, full id). */
  command: string
  leaf: boolean
  /** The family's leaves other than this session, newest first, with what is known about them. */
  leaves: FamilyMember[]
}

export function resumeInfo(d: SessionDetail): ResumeInfo {
  const cwd = d.summary.cwd ?? d.digest.cwd
  const leaves = d.family.leaves
    .filter((k) => !sameKey(k, d.summary.key))
    .map((k) => d.family.members.find((m) => sameKey(m.key, k)))
    .filter((m): m is FamilyMember => !!m)
  return { command: resumeCommand(cwd, d.summary.key.id), leaf: d.lineage.leaf, leaves }
}

// ---- family -----------------------------------------------------------------------------

export interface FamilyRow {
  member: FamilyMember
  depth: number
  current: boolean
  /** How this member relates to its parent, when the detail says so (only links of the current session are given). */
  relation?: 'fork' | 'continuation'
}

export function familyRows(d: SessionDetail): FamilyRow[] {
  const depthOf = new Map<string, number>()
  const id = (k: SessionKey) => `${k.harness}/${k.id}`
  const relations = new Map<string, 'fork' | 'continuation'>()
  if (d.lineage.parent) relations.set(id(d.lineage.parent.child), d.lineage.parent.kind)
  for (const c of d.lineage.children) relations.set(id(c.child), c.kind)
  return d.family.members.map((member) => {
    const depth = member.parent ? (depthOf.get(id(member.parent)) ?? 0) + 1 : 0
    depthOf.set(id(member.key), depth)
    return {
      member,
      depth,
      current: sameKey(member.key, d.summary.key),
      relation: relations.get(id(member.key)),
    }
  })
}

// ---- diagnostics ------------------------------------------------------------------------

export function diagnosticsLines(dg: Diagnostics): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  const unknown = Object.entries(dg.unknownTypes ?? {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  if (unknown.length)
    out.push({ label: 'Unknown record types', value: unknown.map(([k, n]) => `${k} ×${n}`).join(', ') })
  if (dg.badLines) out.push({ label: 'Lines that could not be parsed', value: String(dg.badLines) })
  if (dg.unpricedModels?.length) out.push({ label: 'Models without a price', value: dg.unpricedModels.join(', ') })
  if (dg.unresolvedAgents) out.push({ label: 'Agents not tied to a spawn', value: String(dg.unresolvedAgents) })
  return out
}

// ---- cost -------------------------------------------------------------------------------

/** The flag in words, for the line under the big figure. */
export function costSentence(c: Pick<SessionCost, 'flag' | 'reportedUSD' | 'uncoveredUSD'>): string {
  switch (c.flag) {
    case 'exact':
      return 'Reported by Claude Code for the whole session.'
    case 'partial':
      return `Partly reported: ${formatMoney(c.reportedUSD)} reported, the ${formatMoney(c.uncoveredUSD)} outside the reported windows recomputed from token counts.`
    default:
      return 'Recomputed from token counts; Claude Code reported nothing for this session.'
  }
}

export interface ModelRow {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
}

/** `digest.cost.byModel` as rows, the dearest first (ties by name). Attributed figures. */
export function modelRows(byModel: Record<string, ModelCost> | undefined): ModelRow[] {
  return Object.entries(byModel ?? {})
    .map(([model, m]) => ({
      model,
      input: m.input ?? 0,
      output: m.output ?? 0,
      cacheRead: m.cacheRead ?? 0,
      cacheWrite: (m.cacheWrite5m ?? 0) + (m.cacheWrite1h ?? 0),
      usd: m.usd,
    }))
    .sort((a, b) => b.usd - a.usd || (a.model < b.model ? -1 : 1))
}
