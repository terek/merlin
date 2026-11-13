// The Overview page's pure logic: the linear time axis, the slot a plot asks for, held and idle context,
// the shared token scale, sorting, the spine lane of a row and what the pointer is near.
// OverviewPage.tsx draws what this returns (docs/ui.md section 10b).

import type { GroupDim, OverviewGroup, OverviewLane, OverviewSlot, OverviewSpan } from '../../api/types'
import { formatMoney } from '../../lib/format'
import { homeOf } from '../../lib/places'
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

/** Organise by: the key that decides what the groups are and how the sidebar tree is laid out. */
export type By = GroupDim
export const BYS: readonly By[] = ['dir', 'checkout', 'repo', 'remote']
/**
 * Show: the level of the table. `sessions` one flat row per session, `grouped` each group row with its
 * sessions under it, `groups` the group rows alone.
 */
export type Show = 'sessions' | 'grouped' | 'groups'
export const SHOWS: readonly Show[] = ['sessions', 'grouped', 'groups']

/** The column a table is sorted by. */
export type SortKey = 'start' | 'last' | 'active' | 'turns' | 'agents' | 'spend' | 'key'
export const SORT_KEYS: readonly SortKey[] = ['start', 'last', 'active', 'turns', 'agents', 'spend', 'key']
export interface Sort {
  key: SortKey
  desc: boolean
}
export const DEFAULT_SORT: Sort = { key: 'spend', desc: true }

const oneOf = <T extends string>(v: string | null, allowed: readonly T[], def: T): T =>
  allowed.includes(v as T) ? (v as T) : def

export const parseBy = (v: string | null): By => oneOf(v, BYS, 'dir')
export const parseShow = (v: string | null): Show => oneOf(v, SHOWS, 'grouped')

/**
 * `by` and `show` from the URL. An old link with `by=none` (the flat table) is the folder key shown as
 * sessions; a `show` the table does not know reads as grouped.
 */
export function parseView(by: string | null, show: string | null): { by: By; show: Show } {
  if (by === 'none') return { by: 'dir', show: 'sessions' }
  return { by: parseBy(by), show: parseShow(show) }
}

/** The URL params of a view; undefined where the default holds. */
export function formatView(by: By, show: Show): { by?: string; show?: string } {
  return { by: by === 'dir' ? undefined : by, show: show === 'grouped' ? undefined : show }
}

/** The direction a column starts in: the figures and times descending, the key (a path) ascending, A to Z. */
export const startsDesc = (key: SortKey): boolean => key !== 'key'

/** `sort=<column>` (default spend) and `dir=asc` / `dir=desc` (absent: the column's own start, see `startsDesc`). */
export function parseSort(sort: string | null, dir: string | null): Sort {
  // an old link's `session` is the start time
  const key = oneOf(sort === 'session' ? 'start' : sort, SORT_KEYS, DEFAULT_SORT.key)
  return { key, desc: dir === 'asc' ? false : dir === 'desc' ? true : startsDesc(key) }
}

/** The URL params of a sort; undefined where the default holds. */
export function formatSort(s: Sort): { sort?: string; dir?: string } {
  return {
    sort: s.key === DEFAULT_SORT.key ? undefined : s.key,
    dir: s.desc === startsDesc(s.key) ? undefined : s.desc ? 'desc' : 'asc',
  }
}

/** A click on a column header: the same column flips its direction, another starts in its own. */
export const nextSort = (cur: Sort, key: SortKey): Sort =>
  cur.key === key ? { key, desc: !cur.desc } : { key, desc: startsDesc(key) }

const cmp = <T extends number | string>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Where a place sorts: the file explorer's order. Segment by segment, case-insensitive (so `~/work/merlin` sits
 * right after `~/work` and before `~/work/yimple`); a path comes before the paths under it.
 */
export function comparePlace(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const c = a[i].toLowerCase().localeCompare(b[i].toLowerCase())
    if (c) return c
  }
  return a.length - b.length
}

/** The segments a group's key sorts by (see `placeSegs`); null for the group with no value, which sorts last. */
export type PlaceOf = (groupKey: string) => string[] | null

const splitKey: PlaceOf = (k) => (k ? splitPath(k) : null)

/** What the sorts need besides the rows themselves. */
export interface SortOpts {
  /** The place of a group key, for the key column (default: the key's path segments). */
  placeOf?: PlaceOf
  /** The place of a session, for the key column: where it ran (default: its group's place). */
  lanePlaceOf?: (l: OverviewLane) => string[] | null
  /** The sessions of each group, for a group's start time. */
  lanes?: Map<string, OverviewLane[]>
}

/** Slots with at least one call running. */
export const activeSlots = (active: readonly number[]): number => active.reduce((n, v) => (v > 0 ? n + 1 : n), 0)

/**
 * Time actually working in the range: the slots with at least one call running, times the slot. A session's
 * array is trimmed, a group's dense (the union of its sessions' running time); both count the same way.
 */
export const activeMs = (active: readonly number[], slotMs: number): number => activeSlots(active) * slotMs

/** The earliest start of some sessions ('' when none has one). */
export const earliestStart = (lanes: readonly OverviewLane[] | undefined): string =>
  (lanes ?? []).reduce((m, l) => (l.startedAt && (!m || l.startedAt < m) ? l.startedAt : m), '')

/** The order of the key column: (none) last whichever way, then the place. */
function byPlace(a: string[] | null, b: string[] | null, desc: boolean): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0
  return (desc ? -1 : 1) * comparePlace(a, b)
}

/**
 * Groups by the sort's column on their aggregates (start: the earliest start of their sessions; last: the
 * latest activity; active: the union of their running time; key: the place); ties by spend, then key.
 */
export function sortGroups(groups: OverviewGroup[], s: Sort, opts: SortOpts = {}): OverviewGroup[] {
  const placeOf = opts.placeOf ?? splitKey
  const val = (g: OverviewGroup): number | string =>
    s.key === 'start'
      ? earliestStart(opts.lanes?.get(g.key))
      : s.key === 'last'
        ? (g.lastActivityAt ?? '')
        : s.key === 'active'
          ? activeSlots(g.active)
          : s.key === 'turns'
            ? g.turns
            : s.key === 'agents'
              ? g.agents
              : g.usd
  return [...groups].sort((a, b) =>
    s.key === 'key'
      ? byPlace(placeOf(a.key), placeOf(b.key), s.desc) || cmp(b.usd, a.usd) || cmp(a.key, b.key)
      : (s.desc ? -1 : 1) * cmp(val(a), val(b)) || cmp(b.usd, a.usd) || cmp(a.key, b.key),
  )
}

/** Sessions by the sort's column (key: where they ran); ties by spend, then id. */
export function sortLanes(lanes: OverviewLane[], s: Sort, opts: SortOpts = {}): OverviewLane[] {
  const placeOf = opts.placeOf ?? splitKey
  const lanePlace = opts.lanePlaceOf ?? ((l: OverviewLane) => placeOf(l.group))
  const val = (l: OverviewLane): number | string =>
    s.key === 'start'
      ? (l.startedAt ?? '')
      : s.key === 'last'
        ? (l.lastActivityAt ?? '')
        : s.key === 'active'
          ? activeSlots(l.active)
          : s.key === 'turns'
            ? l.turns
            : s.key === 'agents'
              ? l.agents
              : l.usd
  return [...lanes].sort((a, b) =>
    s.key === 'key'
      ? byPlace(lanePlace(a), lanePlace(b), s.desc) || cmp(b.usd, a.usd) || cmp(a.id, b.id)
      : (s.desc ? -1 : 1) * cmp(val(a), val(b)) || cmp(b.usd, a.usd) || cmp(a.id, b.id),
  )
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
 * The table's rows. `sessions`: every session, flat, with its group's name for the first column. `grouped`:
 * each group row, then all its sessions; `groups`: the group rows alone. The sort orders the groups and, by
 * the same column, the sessions inside each (by the key they all share, so by spend then).
 */
export function buildRows(
  o: { groups: OverviewGroup[]; lanes: OverviewLane[] },
  show: Show,
  sort: Sort,
  opts: SortOpts = {},
): Row[] {
  const name = new Map(o.groups.map((g) => [g.key, g.name]))
  const lane = (l: OverviewLane, nested: boolean): Row => ({
    kind: 'session',
    key: `l:${l.group}\u0000${l.harness}/${l.id}`,
    l,
    nested,
    groupName: name.get(l.group) ?? l.group,
  })
  if (show === 'sessions') return sortLanes(o.lanes, sort, opts).map((l) => lane(l, false))
  const rows: Row[] = []
  const lanes = lanesByGroup(o.lanes)
  const inner: Sort = sort.key === 'key' ? DEFAULT_SORT : sort
  for (const g of sortGroups(o.groups, sort, { ...opts, lanes })) {
    rows.push({ kind: 'group', key: `g:${g.key}`, g })
    if (show === 'grouped') for (const l of sortLanes(lanes.get(g.key) ?? [], inner, opts)) rows.push(lane(l, true))
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

// ---- the selection: the sidebar filters the table ------------------------------------------

/** The `in` of the group with no value. */
export const NONE_SEL = '-'

const splitPath = (p: string): string[] => p.split(/[\\/]+/).filter(Boolean)

/** The segments a group's key stands for: a repository's without `.git` / `.bare`. */
export const groupSegments = (key: string, by: By): string[] => (by === 'repo' ? homeOf(key) : splitPath(key))

/** `in` from the URL: the selected node's real path prefix, `-` for (none); null for no selection. */
export const parseIn = (v: string | null): string | null => (v ? v : null)

/** The URL param of a selection. */
export const formatIn = (sel: string | null): string | undefined => sel ?? undefined

/** Whether a group sits at or under the selected path (segment-wise); `-` is the group with no value. */
export function underPath(g: { key: string }, sel: string | null, by: By): boolean {
  if (sel === null) return true
  if (sel === NONE_SEL) return g.key === ''
  if (!g.key) return false
  const want = splitPath(sel)
  const have = groupSegments(g.key, by)
  return want.length <= have.length && want.every((s, i) => have[i] === s)
}

/** The search's result narrowed to the groups at or under the selection (and their sessions). */
export function selectOverview(f: Filtered, sel: string | null, by: By): Filtered {
  if (sel === null) return f
  const groups = f.groups.filter((g) => underPath(g, sel, by))
  const keep = new Set(groups.map((g) => g.key))
  const shown = new Map([...f.shown].filter(([k]) => keep.has(k)))
  return { groups, lanes: f.lanes.filter((l) => keep.has(l.group)), shown }
}

/** The selection after the key changed: kept when some group sits under it in the new key, else dropped. */
export const keepSelection = (sel: string | null, groups: readonly { key: string }[], by: By): string | null =>
  sel !== null && groups.some((g) => underPath(g, sel, by)) ? sel : null

/** The figures of the "All" item: the sessions shown and the spend of everything the items list. */
export const totalOf = (items: readonly IndexItem[]): { count: number; usd: number } => ({
  count: items.reduce((n, i) => n + i.count, 0),
  usd: items.reduce((n, i) => n + i.usd, 0),
})

/** The selection as shown: the home as `~`, `-` as (none). */
export function displayPath(sel: string, home: string | undefined): string {
  if (sel === NONE_SEL) return '(none)'
  if (home && sel === home) return '~'
  if (home && sel.startsWith(`${home}/`)) return `~${sel.slice(home.length)}`
  return sel
}

/** The node that stands for `path` (a folder inside a compacted chain is its node), if the tree has one. */
export function nodeForPath(nodes: readonly PlaceNode[], path: string): PlaceNode | null {
  for (const n of nodes) {
    if (n.chain.includes(path)) return n
    const r = nodeForPath(n.children, path)
    if (r) return r
  }
  return null
}

/** The ids of the folders above the node that stands for `path`, outermost first; empty when the tree has no such node. */
export function ancestorIds(nodes: readonly PlaceNode[], path: string): string[] {
  const walk = (ns: readonly PlaceNode[], trail: string[]): string[] | null => {
    for (const n of ns) {
      if (n.chain.includes(path)) return trail
      const r = walk(n.children, [...trail, n.id])
      if (r) return r
    }
    return null
  }
  return walk(nodes, []) ?? []
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

/** The widths the columns are laid out with (OverviewPage.tsx). */
export interface Layout {
  /** The harness column: the first of the structured block. */
  harness: number
  /** The padding inside the block, left and right (the block's left border is 1 px more). */
  pad: number
  turns: number
  agents: number
  spend: number
  /** The gap between the block's columns. */
  gap: number
}

/** The width of the structured block: its left rule, the padding and the four columns with their gaps. */
export const blockWidth = (L: Layout): number => 1 + 2 * L.pad + L.harness + L.turns + L.agents + L.spend + 3 * L.gap

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

// ---- the index as a file tree -------------------------------------------------------------

/** What the index lists: a group of the table, its sessions shown and its spend. */
export interface IndexItem {
  key: string
  name: string
  count: number
  usd: number
}

/** One line of the tree: a group of the table, a folder, or both. */
export interface PlaceNode {
  /** Where it sits, as shown (`~/work/app`, `github.com/acme`): unique in a tree, and what the open state is keyed by. */
  id: string
  /** The segments it stands for, joined (compact folders: `work/merlin`). */
  label: string
  /** The real path prefix it stands for (what `in` holds): the home spelled out, remotes as host/owner/repo. */
  path: string
  /** Every path the node stands for: a compacted chain of folders is one node (`path` is its deepest). */
  chain: string[]
  /** The group this node is, when it is one. */
  group?: IndexItem
  /** A host at the top of a remote tree. */
  host?: boolean
  children: PlaceNode[]
  /** Sessions shown and spend, summed over the groups at or under it. */
  count: number
  usd: number
}

export interface PlaceTree {
  nodes: PlaceNode[]
  /** The home directory the tree shows as `~`. */
  home?: string
  /** The group of the sessions with no value, listed apart below the tree. */
  none?: IndexItem
}

const HOME = /^\/(?:Users|home)\/[^/]+/

/** The home directory the paths share, if they do: the most common `/Users/<u>` or `/home/<u>` prefix. */
export function inferHome(paths: readonly string[]): string | undefined {
  const n = new Map<string, number>()
  for (const p of paths) {
    const m = HOME.exec(p)
    if (m && (p.length === m[0].length || p[m[0].length] === '/')) n.set(m[0], (n.get(m[0]) ?? 0) + 1)
  }
  let best: string | undefined
  for (const [h, c] of [...n].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (c > (n.get(best ?? '') ?? 0)) best = h
  return best
}

interface Trie {
  seg: string
  path: string
  children: Map<string, Trie>
  group?: IndexItem
  host?: boolean
}

/** Where a group sits on the disk, for finding the home: a repository stands at its directory, not its `.git`. */
const whereOf = (key: string, by: By): string => (by === 'repo' ? `/${homeOf(key).join('/')}` : key)

/** The home directory the groups share, if they do (see `inferHome`). */
export const groupsHome = (keys: readonly string[], by: By): string | undefined =>
  inferHome(keys.filter((k) => k.startsWith('/')).map((k) => whereOf(k, by)))

/**
 * The segments of a group's place, as shown (`~` for the home, a leading `/` on the first segment of an
 * absolute path) and the real path prefix each one stands for.
 */
function placeSegments(
  key: string,
  by: By,
  home: string | undefined,
): { segs: string[]; paths: string[]; host: boolean } {
  const isPath = key.startsWith('/') || /^[A-Za-z]:[\\/]/.test(key)
  const parts = groupSegments(key, by)
  const abs = key.startsWith('/') ? '/' : ''
  const real = parts.map((_, j) => abs + parts.slice(0, j + 1).join('/'))
  if (by === 'remote' && !isPath) return { segs: parts, paths: real, host: true }
  if (home && (key === home || key.startsWith(`${home}/`))) {
    const rest = parts.slice(home.split('/').filter(Boolean).length)
    return {
      segs: ['~', ...rest],
      paths: [home, ...rest.map((_, j) => `${home}/${rest.slice(0, j + 1).join('/')}`)],
      host: false,
    }
  }
  return {
    segs: parts.length ? [key.startsWith('/') ? `/${parts[0]}` : parts[0], ...parts.slice(1)] : [],
    paths: real,
    host: false,
  }
}

/**
 * The segments a group sits at in the tree (`~`, `work`, `merlin`; a remote's host, owner, name); the order the
 * key column sorts by. Null for the group with no value.
 */
export const placeSegs = (key: string, by: By, home: string | undefined): string[] | null =>
  key ? placeSegments(key, by, home).segs : null

/** The key cell's text: the place as the tree shows it (`~/work/merlin`; a repository without its `.bare`), `(none)` for no value. */
export const keyText = (key: string, by: By, home: string | undefined): string =>
  key ? placeSegments(key, by, home).segs.join('/') : '(none)'

/**
 * `text` cut at the start so that it fits, keeping its end: `…/work/merlin/web`. `fits` says whether a string
 * fits the cell. The cut falls on a `/` when the tail still has one; a last segment too long for the cell
 * is cut inside (`…rge-name`).
 */
export function fitTail(text: string, fits: (s: string) => boolean): string {
  if (fits(text)) return text
  const at = (i: number) => `…${text.slice(i)}`
  let lo = 1
  let hi = text.length
  // the least cut that fits: `fits` only gets truer as more is cut
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (fits(at(mid))) hi = mid
    else lo = mid + 1
  }
  const slash = text.indexOf('/', lo)
  return slash > 0 && slash < text.length - 1 ? at(slash) : at(lo)
}

/**
 * The groups of the table laid out as the filesystem the user knows (docs/ui.md section 10b): a repository
 * at its working directory, a remote as host / owner / name, the home as `~`. A folder that is no group and
 * has one child is merged into it (`~/work`, `work/merlin`); children are ordered by name, like Finder.
 * Counts and spend are summed up the tree. The group with no value is returned apart. `fixed` names the
 * home to use instead of the one the items share.
 */
export function buildPlaceTree(items: readonly IndexItem[], by: By, fixed?: { home: string | undefined }): PlaceTree {
  const root: Trie = { seg: '', path: '', children: new Map() }
  let none: IndexItem | undefined
  const home = fixed
    ? fixed.home
    : groupsHome(
        items.map((i) => i.key),
        by,
      )
  for (const it of items) {
    if (!it.key) {
      none = it
      continue
    }
    const { segs, paths, host } = placeSegments(it.key, by, home)
    let at = root
    segs.forEach((seg, d) => {
      let next = at.children.get(seg)
      if (!next) {
        next = { seg, path: paths[d], children: new Map(), host: host && d === 0 ? true : undefined }
        at.children.set(seg, next)
      }
      at = next
    })
    if (segs.length) at.group = it
  }
  const make = (t: Trie, trail: string[]): PlaceNode => {
    const path = [...trail, t.seg]
    const kids = [...t.children.values()].map((c) => make(c, path))
    const own = t.group
    const node: PlaceNode = {
      id: path.join('/'),
      label: t.seg,
      path: t.path,
      chain: [t.path],
      group: own,
      host: t.host,
      children: kids,
      count: (own?.count ?? 0) + kids.reduce((n, k) => n + k.count, 0),
      usd: (own?.usd ?? 0) + kids.reduce((n, k) => n + k.usd, 0),
    }
    // compact: a folder that is no group and has one child is that child, its label the joined segments
    if (!own && kids.length === 1) {
      const [only] = kids
      return { ...only, label: `${t.seg}/${only.label}`, chain: [t.path, ...only.chain], host: t.host || undefined }
    }
    return node
  }
  const byName = (a: PlaceNode, b: PlaceNode) =>
    comparePlace(a.label.split('/'), b.label.split('/')) || (a.id < b.id ? -1 : 1)
  const sortTree = (ns: PlaceNode[]): PlaceNode[] => {
    for (const n of ns) sortTree(n.children)
    return ns.sort(byName)
  }
  return { nodes: sortTree([...root.children.values()].map((c) => make(c, []))), home, none }
}

/** A node of the tree as drawn: how deep it sits. */
export interface TreeRow {
  node: PlaceNode
  depth: number
}

/** The lines to draw: every node whose ancestors are all open (`closed` holds the ids of the closed folders). */
export function visibleRows(nodes: readonly PlaceNode[], closed: ReadonlySet<string>, depth = 0): TreeRow[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(closed.has(node.id) ? [] : visibleRows(node.children, closed, depth + 1)),
  ])
}

/** The id of the line that stands for a group: its own, or when a closed folder hides it, the outermost closed one. */
export function markedNode(nodes: readonly PlaceNode[], key: string, closed: ReadonlySet<string>): string | null {
  const walk = (ns: readonly PlaceNode[], hidden: string | null): string | null => {
    for (const n of ns) {
      const at = hidden ?? (closed.has(n.id) ? n.id : null)
      if (n.group?.key === key) return hidden ?? n.id
      const r = walk(n.children, at)
      if (r) return r
    }
    return null
  }
  return walk(nodes, null)
}
