// The Overview page's pure logic: the linear time axis, the slot a plot asks for, held and idle context,
// the shared token scale, sorting, the spine lane of a row and what the pointer is near.
// OverviewPage.tsx draws what this returns (docs/ui.md section 10b).

import type { GroupDim, OverviewGroup, OverviewLane, OverviewSlot, OverviewSpan } from '../../api/types'
import { formatMoney } from '../../lib/format'
import { HOLD_MS } from '../spend/timeline'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

export type Range = '1d' | '7d' | '30d'

export const RANGES: Record<Range, { ms: number }> = {
  '1d': { ms: DAY },
  '7d': { ms: 7 * DAY },
  '30d': { ms: 30 * DAY },
}

// ---- slots -------------------------------------------------------------------------------

/** The slots the API knows, finest first. */
export const SLOTS: { name: OverviewSlot; ms: number }[] = [
  { name: '1m', ms: MIN },
  { name: '2m', ms: 2 * MIN },
  { name: '5m', ms: 5 * MIN },
  { name: '10m', ms: 10 * MIN },
  { name: '15m', ms: 15 * MIN },
  { name: '30m', ms: 30 * MIN },
  { name: '1h', ms: HOUR },
  { name: '2h', ms: 2 * HOUR },
  { name: '3h', ms: 3 * HOUR },
  { name: '6h', ms: 6 * HOUR },
  { name: '12h', ms: 12 * HOUR },
  { name: '1d', ms: DAY },
]

/** The most slots the API answers with. */
export const MAX_SLOTS = 2000

/** The smallest slot that gives at most one slot per pixel of the plot (the coarsest when none does). */
export function chooseSlot(rangeMs: number, plotWidth: number): OverviewSlot {
  const want = rangeMs / Math.max(1, plotWidth)
  const hit = SLOTS.find((s) => s.ms >= want && rangeMs / s.ms <= MAX_SLOTS)
  return (hit ?? SLOTS[SLOTS.length - 1]).name
}

export const slotMsOf = (slot: OverviewSlot): number => SLOTS.find((s) => s.name === slot)?.ms ?? HOUR

// ---- the axis: linear in time ------------------------------------------------------------

export interface Axis {
  fromMs: number
  toMs: number
  slotMs: number
  slots: number
  width: number
  pxPerMs: number
  /** Width of one slot, in px (not an integer). */
  slotW: number
}

/** Time maps linearly to x over the whole range: nights and empty days take their real width. */
export function makeAxis(fromMs: number, toMs: number, slotMs: number, width: number): Axis {
  const pxPerMs = width / Math.max(1, toMs - fromMs)
  return {
    fromMs,
    toMs,
    slotMs,
    slots: Math.round((toMs - fromMs) / slotMs),
    width,
    pxPerMs,
    slotW: slotMs * pxPerMs,
  }
}

export const xOf = (axis: Axis, ms: number): number => (ms - axis.fromMs) * axis.pxPerMs

/** The time at pixel x. */
export const timeAt = (axis: Axis, x: number): number => axis.fromMs + x / axis.pxPerMs

/** Left edge of slot i. */
export const slotX = (axis: Axis, i: number): number => i * axis.slotW

export interface Tick {
  x: number
  label: string
  /** A midnight (the others are the hours inside a day). */
  day: boolean
  /** Whether the tick carries its label (the others are bare marks). */
  labelled: boolean
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Local midnights inside the range, as times. */
export function midnights(fromMs: number, toMs: number): number[] {
  const out: number[] = []
  const d = new Date(fromMs)
  d.setHours(0, 0, 0, 0)
  while (d.getTime() < toMs) {
    if (d.getTime() >= fromMs) out.push(d.getTime())
    d.setDate(d.getDate() + 1)
  }
  return out
}

/**
 * Midnight ticks with day labels, thinned to `minGap` px; in a range of two days or less also the hours
 * (every hour, labelled at the step that keeps the labels `minGap` px apart).
 */
export function axisTicks(axis: Axis, minGap = 54): Tick[] {
  const out: Tick[] = []
  const mid = midnights(axis.fromMs, axis.toMs)
  if (axis.toMs - axis.fromMs <= 2 * DAY) {
    const step = [1, 2, 3, 6, 12].find((h) => h * HOUR * axis.pxPerMs >= minGap) ?? 12
    const d = new Date(axis.fromMs)
    d.setMinutes(0, 0, 0)
    for (; d.getTime() < axis.toMs; d.setHours(d.getHours() + 1)) {
      const t = d.getTime()
      if (t < axis.fromMs) continue
      const h = d.getHours()
      const day = h === 0
      const labelled = day || h % step === 0
      out.push({
        x: xOf(axis, t),
        day,
        labelled,
        label: day ? `${DAYS[d.getDay()]} ${d.getDate()}` : `${String(h).padStart(2, '0')}:00`,
      })
    }
    // a midnight's label takes the place of the hour labels beside it
    for (const t of out) {
      if (t.labelled && !t.day && out.some((o) => o.day && Math.abs(o.x - t.x) < minGap * 0.7)) t.labelled = false
    }
    return out
  }
  let lastX = -Infinity
  for (const t of mid) {
    const x = xOf(axis, t)
    const d = new Date(t)
    const labelled = x - lastX >= minGap
    if (labelled) lastX = x
    out.push({ x, day: true, labelled, label: `${DAYS[d.getDay()]} ${d.getDate()}` })
  }
  return out
}

/** Midnight x positions, for the faint day lines (not thinned). */
export const midnightXs = (axis: Axis): number[] => midnights(axis.fromMs, axis.toMs).map((t) => xOf(axis, t))

// ---- held and idle context ---------------------------------------------------------------

export interface HeldCall {
  at: number
  /** Prompt tokens of the call. */
  ctx: number
}

/** A pause up to this long after a call is "idle": the call's context is still held, but nothing runs. */
export const IDLE_MAX_MS = HOUR

/**
 * A session's context per slot as the Session page holds it: a call's context lasts until the next call,
 * unless that comes more than `holdMs` later, when it ends at the call (`context`). When the next call comes
 * after `holdMs` but within `idleMs`, the context is held as `idle` from the call to the next call; a longer
 * pause and the time after the last call hold nothing. A slot gets the largest value it held at any moment;
 * `idle` is 0 in a slot where `context` is not. `calls` are the main agent's, in any order.
 */
export function heldContext(
  calls: HeldCall[],
  fromMs: number,
  slotMs: number,
  slots: number,
  holdMs = HOLD_MS,
  idleMs = IDLE_MAX_MS,
): { context: number[]; idle: number[] } {
  const context = new Array<number>(slots).fill(0)
  const idle = new Array<number>(slots).fill(0)
  const sorted = [...calls].sort((a, b) => a.at - b.at)
  const fill = (out: number[], from: number, to: number, v: number) => {
    const a = Math.max(0, Math.floor((from - fromMs) / slotMs))
    // the end is exclusive: a hold up to the very start of a slot does not reach into it
    const b = Math.min(slots - 1, to > from ? Math.ceil((to - fromMs) / slotMs) - 1 : a)
    for (let i = a; i <= b; i++) if (v > out[i]) out[i] = v
  }
  sorted.forEach((c, k) => {
    const next = sorted[k + 1]
    const gap = next ? next.at - c.at : Infinity
    fill(context, c.at, gap <= holdMs ? (next as HeldCall).at : c.at, c.ctx)
    if (gap > holdMs && gap <= idleMs) fill(idle, c.at, (next as HeldCall).at, c.ctx)
  })
  for (let i = 0; i < slots; i++) if (context[i] > 0) idle[i] = 0
  return { context, idle }
}

// ---- lanes: trimmed arrays ---------------------------------------------------------------

// ---- the token scales --------------------------------------------------------------------

/** The context area's greatest height, in px. */
export const CTX_MAX = 15

export interface TokenScale {
  maxTok: number
  pxPerTok: number
}

const peakOf = (a: number[]): number => a.reduce((m, v) => (v > m ? v : m), 0)

const scaleOf = (maxTok: number): TokenScale => ({ maxTok, pxPerTok: maxTok > 0 ? CTX_MAX / maxTok : 0 })

/** The scale of the group rows: their largest total context (or idle context) reaches `CTX_MAX` px. */
export function groupScale(groups: OverviewGroup[]): TokenScale {
  let max = 0
  for (const g of groups) max = Math.max(max, peakOf(g.contextSum), peakOf(g.idleSum))
  return scaleOf(max)
}

/** The scale of the session rows, their own: the largest context (or idle context) of any session. */
export function laneScale(lanes: OverviewLane[]): TokenScale {
  let max = 0
  for (const l of lanes) max = Math.max(max, peakOf(l.context), peakOf(l.idle))
  return scaleOf(max)
}

/**
 * Where a session lived on the plot: from its start to its last activity, clipped to the axis, as x
 * positions; null when it lived wholly outside the range or has no times.
 */
export function lifeSpan(
  startedAt: string | undefined,
  lastAt: string | undefined,
  axis: Axis,
): [number, number] | null {
  const a = startedAt ? Date.parse(startedAt) : Number.NaN
  const b = lastAt ? Date.parse(lastAt) : a
  if (Number.isNaN(a) || Number.isNaN(b) || b < axis.fromMs || a > axis.toMs) return null
  return [Math.max(0, xOf(axis, a)), Math.min(axis.width, xOf(axis, b))]
}

// ---- modes, sorting and the rows ---------------------------------------------------------

/** Group by: a dimension, or `none` for a flat table of sessions. */
export type By = GroupDim | 'none'
export const BYS: readonly By[] = ['none', 'dir', 'checkout', 'repo', 'remote']
/** What a grouped table shows: every session under its group row, or the group rows alone. */
export type Show = 'sessions' | 'groups'
export const SHOWS: readonly Show[] = ['sessions', 'groups']

/** The column a table is sorted by. */
export type SortKey = 'session' | 'turns' | 'agents' | 'spend' | 'last'
export const SORT_KEYS: readonly SortKey[] = ['session', 'turns', 'agents', 'spend', 'last']
export interface Sort {
  key: SortKey
  desc: boolean
}
export const DEFAULT_SORT: Sort = { key: 'spend', desc: true }

const oneOf = <T extends string>(v: string | null, allowed: readonly T[], def: T): T =>
  allowed.includes(v as T) ? (v as T) : def

export const parseBy = (v: string | null): By => oneOf(v, BYS, 'dir')
export const parseShow = (v: string | null): Show => oneOf(v, SHOWS, 'sessions')

/** `sort=<column>` (default spend) and `dir=asc` (default descending). */
export function parseSort(sort: string | null, dir: string | null): Sort {
  return { key: oneOf(sort, SORT_KEYS, DEFAULT_SORT.key), desc: dir !== 'asc' }
}

/** The URL params of a sort; undefined where the default holds. */
export function formatSort(s: Sort): { sort?: string; dir?: string } {
  return { sort: s.key === DEFAULT_SORT.key ? undefined : s.key, dir: s.desc ? undefined : 'asc' }
}

/** A click on a column header: the same column flips its direction, another starts descending. */
export const nextSort = (cur: Sort, key: SortKey): Sort =>
  cur.key === key ? { key, desc: !cur.desc } : { key, desc: true }

/** The dimension the API is asked for: a flat table still needs the project of each session. */
export const apiBy = (by: By): GroupDim => (by === 'none' ? 'dir' : by)

const cmp = <T extends number | string>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0)

/** Groups by the sort's column on their aggregates (session: the count); ties by spend, then key. */
export function sortGroups(groups: OverviewGroup[], s: Sort): OverviewGroup[] {
  const val = (g: OverviewGroup): number | string =>
    s.key === 'session'
      ? g.sessions
      : s.key === 'turns'
        ? g.turns
        : s.key === 'agents'
          ? g.agents
          : s.key === 'spend'
            ? g.usd
            : (g.lastActivityAt ?? '')
  return [...groups].sort((a, b) => (s.desc ? -1 : 1) * cmp(val(a), val(b)) || cmp(b.usd, a.usd) || cmp(a.key, b.key))
}

/** Sessions by the sort's column (session: start time); ties by spend, then id. */
export function sortLanes(lanes: OverviewLane[], s: Sort): OverviewLane[] {
  const val = (l: OverviewLane): number | string =>
    s.key === 'session'
      ? (l.startedAt ?? '')
      : s.key === 'turns'
        ? l.turns
        : s.key === 'agents'
          ? l.agents
          : s.key === 'spend'
            ? l.usd
            : (l.lastActivityAt ?? '')
  return [...lanes].sort((a, b) => (s.desc ? -1 : 1) * cmp(val(a), val(b)) || cmp(b.usd, a.usd) || cmp(a.id, b.id))
}

/** The lanes of each group, by the lane's group key. */
export function lanesByGroup(lanes: OverviewLane[]): Map<string, OverviewLane[]> {
  const out = new Map<string, OverviewLane[]>()
  for (const l of lanes) {
    const list = out.get(l.group)
    if (list) list.push(l)
    else out.set(l.group, [l])
  }
  return out
}

export type Row =
  | { kind: 'group'; key: string; g: OverviewGroup }
  | { kind: 'session'; key: string; l: OverviewLane /** Under a group row. */; nested: boolean; groupName: string }

/**
 * The table's rows. `none`: every session, flat, with its group's name for the first column. Grouped with
 * `sessions`: each group row, then all its sessions; with `groups`: the group rows alone. The sort orders
 * the groups and, by the same column, the sessions inside each.
 */
export function buildRows(
  o: { groups: OverviewGroup[]; lanes: OverviewLane[] },
  by: By,
  show: Show,
  sort: Sort,
): Row[] {
  const name = new Map(o.groups.map((g) => [g.key, g.name]))
  const lane = (l: OverviewLane, nested: boolean): Row => ({
    kind: 'session',
    key: `l:${l.group}\u0000${l.harness}/${l.id}`,
    l,
    nested,
    groupName: name.get(l.group) ?? l.group,
  })
  if (by === 'none') return sortLanes(o.lanes, sort).map((l) => lane(l, false))
  const rows: Row[] = []
  const lanes = lanesByGroup(o.lanes)
  for (const g of sortGroups(o.groups, sort)) {
    rows.push({ kind: 'group', key: `g:${g.key}`, g })
    if (show === 'sessions') for (const l of sortLanes(lanes.get(g.key) ?? [], sort)) rows.push(lane(l, true))
  }
  return rows
}

// ---- row text ----------------------------------------------------------------------------

/** The session's short name: the user's own, else the title, else the id's first 8 characters. */
export const laneHead = (l: { name?: string; title?: string; id: string }): string =>
  l.name || l.title || l.id.slice(0, 8)

/** What follows the head: the latest recap, else the first prompt, else the last prompt, else nothing. */
export const laneDescription = (l: OverviewLane): string =>
  l.recap?.text || l.firstPrompt?.text || l.lastPrompt?.text || ''

/** Whitespace folded to single spaces. */
export const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim()

/**
 * The group row's description: "18 sessions · priciest: <head> $96". `head` resolves the priciest's lane;
 * `shown` (under a search) is the number of the group's sessions that match: "3 of 18 sessions match · ...".
 */
export function groupDescription(g: OverviewGroup, head?: string, shown?: number): string {
  const n =
    shown !== undefined && shown < g.sessions
      ? `${shown} of ${g.sessions} sessions match`
      : `${g.sessions} ${g.sessions === 1 ? 'session' : 'sessions'}`
  if (!g.priciest) return n
  const h = head || g.priciest.title || g.priciest.id.slice(0, 8)
  return `${n} · priciest: ${oneLine(h)} ${formatMoney(g.priciest.usd)}`
}

// ---- row marks ---------------------------------------------------------------------------

export interface ActivityRun {
  from: number
  to: number
  /** 1, 2 or 3 (three or more). */
  weight: 1 | 2 | 3
}

/** Contiguous slots with the same activity weight, for the session line; `offset` is the slot of index 0. */
export function activityRuns(active: number[], offset = 0): ActivityRun[] {
  const out: ActivityRun[] = []
  for (let i = 0; i < active.length; i++) {
    if (!(active[i] > 0)) continue
    const w = Math.min(3, active[i]) as 1 | 2 | 3
    const last = out[out.length - 1]
    if (last && last.to === offset + i && last.weight === w) last.to = offset + i + 1
    else out.push({ from: offset + i, to: offset + i + 1, weight: w })
  }
  return out
}

/** Stroke widths of the session line by weight. */
export const ACTIVE_W: Record<1 | 2 | 3, number> = { 1: 1, 2: 2, 3: 3.5 }

const r1 = (v: number) => Math.round(v * 10) / 10

/**
 * A step area: one closed shape per run of slots above zero, standing on `base`, growing upward at `scale`
 * px per unit. `offset` is the slot of index 0 (a lane's arrays are trimmed).
 */
export function stepAreaPath(values: number[], axis: Axis, base: number, scale: number, offset = 0): string {
  let area = ''
  const n = values.length
  let i = 0
  while (i < n) {
    if (!(values[i] > 0)) {
      i++
      continue
    }
    let j = i
    while (j < n && values[j] > 0) j++
    let d = `M${r1(slotX(axis, offset + i))},${r1(base)}`
    let prev = base
    let k = i
    while (k < j) {
      let m = k
      while (m < j && values[m] === values[k]) m++
      const y = r1(base - values[k] * scale)
      if (y !== prev) d += `V${y}`
      d += `H${r1(slotX(axis, offset + m))}`
      prev = y
      k = m
    }
    area += `${d}V${r1(base)}Z`
    i = j
  }
  return area
}

// ---- the spine lane ----------------------------------------------------------------------

/** A spawn's life is drawn at least this long (px), so that the shape reads at any zoom. */
export const MIN_SPINE = 10
/** Lives of one kind closer than this (px) are one run. */
export const MERGE_GAP = 4
/** The lane's depth below the baseline. */
export const LANE_DEPTH = 7

type Kind = OverviewSpan['kind']

/** Draw order: later kinds draw on top. */
export const KIND_ORDER: Kind[] = ['subagent', 'teammate', 'fork', 'workflow', 'session-fork', 'continuation']

export const isBranch = (k: Kind): boolean => k === 'session-fork' || k === 'continuation'

export interface SpineRun {
  x0: number
  x1: number
  /** Spawns merged into the run. */
  n: number
  /** The first spawn began before the range: no elbow, the run starts at the left edge. */
  clipped: boolean
}

export interface KindSpine {
  kind: Kind
  /** Verticals of the spawns that do not start a run (the run's elbow is its first spawn's), x in px. */
  ticks: number[]
  runs: SpineRun[]
}

/**
 * The spine lane of a row at the axis's scale: per kind (in draw order), every spawn's vertical, and the
 * lives `[start, max(end, start + MIN_SPINE px)]` merged into runs while they overlap or lie under
 * `MERGE_GAP` px apart. Branched sessions (fork, continuation) have ticks only, no runs.
 */
export function spineLanes(spans: OverviewSpan[] | undefined, axis: Axis): KindSpine[] {
  const out: KindSpine[] = []
  for (const kind of KIND_ORDER) {
    const lives = (spans ?? [])
      .filter((s) => s.kind === kind)
      .map((s) => {
        const start = Date.parse(s.start)
        const clipped = start < axis.fromMs
        const x0 = Math.max(0, xOf(axis, start))
        const x1 = Math.min(axis.width, Math.max(xOf(axis, Date.parse(s.end)), x0 + MIN_SPINE))
        return { x0, x1, clipped }
      })
      .filter((l) => l.x0 < axis.width && l.x1 >= 0)
      .sort((a, b) => a.x0 - b.x0 || b.x1 - a.x1)
    if (lives.length === 0) continue
    if (isBranch(kind)) {
      // a branched session is its own row: only where it began, a vertical (and the page's node)
      const xs = [...new Set(lives.filter((l) => !l.clipped).map((l) => r1(l.x0)))]
      if (xs.length > 0) out.push({ kind, ticks: xs, runs: [] })
      continue
    }
    const runs: SpineRun[] = []
    const starts: { x: number; run: number }[] = []
    for (const l of lives) {
      const cur = runs[runs.length - 1]
      if (cur && l.x0 <= cur.x1 + MERGE_GAP) {
        cur.x1 = Math.max(cur.x1, l.x1)
        cur.n++
      } else runs.push({ x0: l.x0, x1: l.x1, n: 1, clipped: l.clipped })
      if (!l.clipped) starts.push({ x: l.x0, run: runs.length - 1 })
    }
    // one tick per half pixel; the first spawn of a run is its elbow
    const ticks: number[] = []
    const seen = new Set<number>()
    for (const r of runs) if (!r.clipped) seen.add(Math.round(r.x0 * 2))
    for (const s of starts) {
      const k = Math.round(s.x * 2)
      if (seen.has(k)) continue
      seen.add(k)
      ticks.push(r1(s.x))
    }
    out.push({ kind, ticks, runs })
  }
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Drops the labels that would run into the previous one or past the right edge of the plot (greedy, left to right). */
export function fitLabels(ticks: Tick[], width: number, charW = 6.2, gap = 6): Tick[] {
  let end = -Infinity
  return ticks.map((t) => {
    if (!t.labelled) return t
    const w = t.label.length * charW
    if (t.x + 3 < end + gap || t.x + 3 + w > width) return { ...t, labelled: false }
    end = t.x + 3 + w
    return t
  })
}

/** A compact "last activity": "now", "5 min", "15 h", "yesterday", "9 Nov". */
export function lastLabel(iso: string | undefined, nowMs: number): string {
  const t = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(t)) return '–'
  const d = nowMs - t
  if (d < MIN) return 'now'
  if (d < HOUR) return `${Math.floor(d / MIN)} min`
  const day = (ms: number) => new Date(ms).setHours(0, 0, 0, 0)
  const days = Math.round((day(nowMs) - day(t)) / DAY)
  if (days === 0) return `${Math.floor(d / HOUR)} h`
  if (days === 1) return 'yesterday'
  const a = new Date(t)
  return `${a.getDate()} ${MONTHS[a.getMonth()]}`
}

// ---- search ------------------------------------------------------------------------------

/** The key of a session in a set of search hits. */
export const sessionKey = (harness: string, id: string): string => `${harness}/${id}`

/**
 * Whether a session matches a search term (trimmed, lowercased by the caller; empty matches all): the
 * term is in its head (name, title, id), its description texts or its group's name, or (term of 2+
 * characters) the session is among the server's full-text `hits`.
 */
export function laneMatches(l: OverviewLane, groupName: string, term: string, hits?: ReadonlySet<string>): boolean {
  if (!term) return true
  const hay = [l.name, l.title, l.id, l.recap?.text, l.firstPrompt?.text, l.lastPrompt?.text, groupName]
  if (hay.some((t) => t?.toLowerCase().includes(term))) return true
  return term.length >= 2 && !!hits?.has(sessionKey(l.harness, l.id))
}

export interface Filtered {
  groups: OverviewGroup[]
  lanes: OverviewLane[]
  /** Per group key, the number of its sessions that match. */
  shown: Map<string, number>
}

/**
 * The groups with at least one matching session and the matching sessions. A group whose own name
 * matches counts all its sessions as matching. An empty term returns everything.
 */
export function filterOverview(
  o: { groups: OverviewGroup[]; lanes: OverviewLane[] },
  rawTerm: string,
  hits?: ReadonlySet<string>,
): Filtered {
  const term = rawTerm.trim().toLowerCase()
  const shown = new Map<string, number>()
  if (!term) {
    for (const g of o.groups) shown.set(g.key, g.sessions)
    return { groups: o.groups, lanes: o.lanes, shown }
  }
  const byName = new Map(o.groups.map((g) => [g.key, g.name]))
  const lanes = o.lanes.filter((l) => laneMatches(l, byName.get(l.group) ?? l.group, term, hits))
  for (const l of lanes) shown.set(l.group, (shown.get(l.group) ?? 0) + 1)
  return { groups: o.groups.filter((g) => shown.has(g.key)), lanes, shown }
}

/** The distinct harnesses of some sessions, most sessions first (ties by name). */
export function groupHarnesses(lanes: readonly { harness: string }[], max = 3): string[] {
  const n = new Map<string, number>()
  for (const l of lanes) n.set(l.harness, (n.get(l.harness) ?? 0) + 1)
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, max)
    .map(([h]) => h)
}

// ---- what the pointer is over ------------------------------------------------------------

/** A column of the table the pointer can be over. */
export type Column = 'harness' | 'first' | SortKey

export interface ColumnBox {
  col: Column
  /** Left edge and width, in px from the left of the rows. */
  x: number
  w: number
}

/** The widths the columns are laid out with (OverviewPage.tsx). */
export interface Layout {
  harness: number
  gutter: number
  pad: number
  turns: number
  agents: number
  spend: number
  last: number
  /** The gap between the text line's columns. */
  gap: number
}

/**
 * The columns' boxes for rows `width` px wide: the harness column, the first column (flat table), then
 * Session (the rest), Turns, Agents, Spend and Last against the right edge. The boxes meet in the middle
 * of the gap between two columns, and the last reaches the right edge.
 */
export function columnBoxes(width: number, L: Layout): ColumnBox[] {
  const right = width - L.pad
  const lastX = right - L.last
  const spendX = lastX - L.gap - L.spend
  const agentsX = spendX - L.gap - L.agents
  const turnsX = agentsX - L.gap - L.turns
  const half = L.gap / 2
  const boxes: ColumnBox[] = [{ col: 'harness', x: 0, w: L.harness }]
  if (L.gutter > 0) boxes.push({ col: 'first', x: L.harness, w: L.gutter })
  const cell = (col: Column, x: number, end: number): ColumnBox => ({ col, x, w: Math.max(0, end - x) })
  boxes.push(
    cell('session', L.harness + L.gutter, turnsX - half),
    cell('turns', turnsX - half, agentsX - half),
    cell('agents', agentsX - half, spendX - half),
    cell('spend', spendX - half, lastX - half),
    cell('last', lastX - half, width),
  )
  return boxes
}

/** The column under x (px from the left of the rows), or null outside them. */
export function columnAt(boxes: ColumnBox[], x: number): Column | null {
  const b = boxes.find((c) => x >= c.x && x < c.x + c.w)
  return b ? b.col : null
}

export interface Band {
  x0: number
  x1: number
}

/**
 * The stretch of the axis under x (px from the left of the plot): the local day, or in a range of two days
 * or less the hour; clipped to the plot. Null when x is outside the plot.
 */
export function bandAt(axis: Axis, x: number): Band | null {
  if (!(x >= 0 && x <= axis.width)) return null
  const t = timeAt(axis, x)
  const d = new Date(t)
  const hourly = axis.toMs - axis.fromMs <= 2 * DAY
  if (hourly) d.setMinutes(0, 0, 0)
  else d.setHours(0, 0, 0, 0)
  const a = d.getTime()
  const e = new Date(a)
  if (hourly) e.setHours(e.getHours() + 1)
  else e.setDate(e.getDate() + 1)
  return { x0: Math.max(0, xOf(axis, a)), x1: Math.min(axis.width, xOf(axis, e.getTime())) }
}
