// The Overview page's pure logic: the linear time axis, the slot a plot asks for, held and idle context,
// the token scales, the scope's summary, sorting, search, the place tree and its selection, the spine lane of
// a row and what the pointer is near. OverviewPage.tsx draws what this returns (docs/ui.md section 10b).

import type { GroupDim, OverviewBead, OverviewLane, OverviewSlot, OverviewSpan } from '../../api/types'
import { sessionPath } from '../../lib/paths'
import { homeOf } from '../../lib/places'
import { dayStart, daysBefore, localDay } from '../../lib/time'
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

// ---- the token scales and the summary --------------------------------------------------

/** The context area's greatest height, in px. */
export const CTX_MAX = 15

export interface TokenScale {
  maxTok: number
  pxPerTok: number
}

/** The scale on which the largest value of the arrays reaches `CTX_MAX` px. */
export function tokenScale(arrays: readonly (readonly number[])[]): TokenScale {
  let maxTok = 0
  for (const a of arrays) for (const v of a) if (v > maxTok) maxTok = v
  return { maxTok, pxPerTok: maxTok > 0 ? CTX_MAX / maxTok : 0 }
}

/** The scale of the session rows: the largest context (or idle context) of any session. */
export const laneScale = (lanes: readonly OverviewLane[]): TokenScale =>
  tokenScale(lanes.flatMap((l) => [l.context, l.idle]))

/** The scope's aggregate graph: the lanes' context and idle context summed per slot, dense (`slots` long). */
export function sumLanes(lanes: readonly OverviewLane[], slots: number): { context: number[]; idle: number[] } {
  const context = new Array<number>(slots).fill(0)
  const idle = new Array<number>(slots).fill(0)
  const add = (out: number[], a: readonly number[], slot0: number) =>
    a.forEach((v, k) => {
      if (slot0 + k < slots) out[slot0 + k] += v
    })
  for (const l of lanes) {
    add(context, l.context, l.slot0)
    add(idle, l.idle, l.slot0)
  }
  return { context, idle }
}

export interface Totals {
  sessions: number
  turns: number
  agents: number
  usd: number
}

/** The scope's figures: its sessions and the sums of their turns, agents and spend. */
export const totalsOf = (lanes: readonly OverviewLane[]): Totals =>
  lanes.reduce(
    (t, l) => ({ sessions: t.sessions + 1, turns: t.turns + l.turns, agents: t.agents + l.agents, usd: t.usd + l.usd }),
    {
      sessions: 0,
      turns: 0,
      agents: 0,
      usd: 0,
    },
  )

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

// ---- the key and sorting -----------------------------------------------------------------

/** Organise by: the location key the sidebar tree is laid out by. */
export type By = GroupDim | 'bead'
export const BYS: readonly By[] = ['dir', 'checkout', 'repo', 'remote', 'bead']

/** The beads of a response (`Overview.beads`), by id. */
export type Beads = Readonly<Record<string, OverviewBead>>

/** The column a table is sorted by. */
export type SortKey = 'start' | 'last' | 'active' | 'turns' | 'agents' | 'spend' | 'key'
export const SORT_KEYS: readonly SortKey[] = ['start', 'last', 'active', 'turns', 'agents', 'spend', 'key']
export interface Sort {
  key: SortKey
  desc: boolean
}
export const DEFAULT_SORT: Sort = { key: 'last', desc: true }

const oneOf = <T extends string>(v: string | null, allowed: readonly T[], def: T): T =>
  allowed.includes(v as T) ? (v as T) : def

/** `by` from the URL: the folder unless it names another key. */
export const parseBy = (v: string | null): By => oneOf(v, BYS, 'dir')

/** The direction a column starts in: the figures and times descending, the key (a path) ascending, A to Z. */
export const startsDesc = (key: SortKey): boolean => key !== 'key'

/** `sort=<column>` (default last activity) and `dir=asc` / `dir=desc` (absent: the column's own start, see `startsDesc`). */
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

/** The order of paths segment by segment under `less` on a segment; a path comes before the paths under it. */
export const comparePath =
  (less: (a: string, b: string) => boolean) =>
  (a: readonly string[], b: readonly string[]): number => {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (a[i] === b[i]) continue
      return less(a[i], b[i]) ? -1 : 1
    }
    return a.length - b.length
  }

/** Bead ids with their dotted numbers compared as numbers (`x.2` before `x.10`): the catalog's `idLess`. */
export function idLess(a: string, b: string): boolean {
  const as = a.split('.')
  const bs = b.split('.')
  for (let i = 0; i < as.length && i < bs.length; i++) {
    if (as[i] === bs[i]) continue
    const x = /^\d+$/.test(as[i]) ? Number(as[i]) : Number.NaN
    const y = /^\d+$/.test(bs[i]) ? Number(bs[i]) : Number.NaN
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x < y
    return as[i] < bs[i]
  }
  return as.length < bs.length
}

/** Slots with at least one call running. */
export const activeSlots = (active: readonly number[]): number => active.reduce((n, v) => (v > 0 ? n + 1 : n), 0)

/** Time actually working in the range: the slots with at least one call running, times the slot. */
export const activeMs = (active: readonly number[], slotMs: number): number => activeSlots(active) * slotMs

/** The order of the key column: (none) last whichever way, then the place. */
function byPlace(
  a: string[] | null,
  b: string[] | null,
  desc: boolean,
  compare: (a: readonly string[], b: readonly string[]) => number,
): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0
  return (desc ? -1 : 1) * compare(a, b)
}

/**
 * Sessions by the sort's column (key: the folder they ran in, as shown with `home` as `~`, in the tree's order);
 * ties by spend, then id.
 */
export function sortLanes(
  lanes: readonly OverviewLane[],
  s: Sort,
  home?: string,
  /** With `by: 'bead'` the key column orders the sessions by their bead's place in the tree. */
  tree?: { by: By; beads?: Beads },
): OverviewLane[] {
  const byBead = tree?.by === 'bead'
  const lanePlace = (l: OverviewLane) =>
    byBead ? (l.bead ? beadPath(l.bead, tree?.beads) : null) : l.dir ? displayPath(l.dir, home).split('/') : null
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
      ? byPlace(lanePlace(a), lanePlace(b), s.desc, byBead ? comparePath(idLess) : comparePlace) ||
        cmp(b.usd, a.usd) ||
        cmp(a.id, b.id)
      : (s.desc ? -1 : 1) * cmp(val(a), val(b)) || cmp(b.usd, a.usd) || cmp(a.id, b.id),
  )
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

/** The folder line of a row: the session's directory as shown, `(none)` when it has none. */
export const folderText = (dir: string | undefined, home: string | undefined): string =>
  dir ? displayPath(dir, home) : '(none)'

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

// ---- search ------------------------------------------------------------------------------

/** The key of a session in a set of search hits. */
export const sessionKey = (harness: string, id: string): string => `${harness}/${id}`

/**
 * Whether a session matches a search term (trimmed, lowercased by the caller; empty matches all): the term is in
 * its head (name, title, id) or its description texts, or (term of 2+ characters) the session is among the
 * server's full-text `hits`.
 */
export function laneMatches(l: OverviewLane, term: string, hits?: ReadonlySet<string>): boolean {
  if (!term) return true
  const hay = [l.name, l.title, l.id, l.recap?.text, l.firstPrompt?.text, l.lastPrompt?.text]
  if (hay.some((t) => t?.toLowerCase().includes(term))) return true
  return term.length >= 2 && !!hits?.has(sessionKey(l.harness, l.id))
}

/** The sessions that match a search; an empty term keeps them all. */
export function searchLanes(lanes: OverviewLane[], rawTerm: string, hits?: ReadonlySet<string>): OverviewLane[] {
  const term = rawTerm.trim().toLowerCase()
  return term ? lanes.filter((l) => laneMatches(l, term, hits)) : lanes
}

// ---- the selection: the sidebar is the scope ------------------------------------------------

/** The `in` of the sessions with no value for the key. */
export const NONE_SEL = '-'

const splitPath = (p: string): string[] => p.split(/[\\/]+/).filter(Boolean)

/** A session's value of the key ('' for none). */
export function placeOf(l: OverviewLane, by: By, beads?: Beads): string {
  if (by !== 'bead') return l[by] ?? ''
  return l.bead ? beadPath(l.bead, beads).join('/') : ''
}

/** A bead id's prefix: what precedes the last dash of its root (`merlin` for `merlin-t8s.48.1`). */
export function beadPrefix(id: string): string {
  const root = id.split('.')[0]
  const i = root.lastIndexOf('-')
  return i > 0 ? root.slice(0, i) : ''
}

/**
 * Where a bead sits in the tree: its prefix, then its family root and the ancestors down to the bead itself.
 * The chain follows the parent links of `beads` and stops where a parent is not known (or loops).
 */
export function beadPath(id: string, beads?: Beads): string[] {
  const chain = [id]
  for (let b = beads?.[id]?.parent; b && beads?.[b] && !chain.includes(b); b = beads[b].parent) chain.push(b)
  chain.reverse()
  const prefix = beadPrefix(id)
  return prefix ? [prefix, ...chain] : chain
}

/**
 * What a bead node of the tree shows: the title with the id apart (`merlin-lce`); the id alone for a bead
 * without a title and for a prefix heading (which is no bead). `closed` beads are drawn muted.
 */
export function beadLabel(
  segment: string,
  beads?: Beads,
): { text: string; id?: string; title?: string; closed: boolean } {
  const b = beads?.[segment]
  if (!b) return { text: segment, closed: false }
  return { text: b.title || segment, id: b.title ? segment : undefined, title: b.title, closed: b.status === 'closed' }
}

/** The segments a place stands for: a repository's without `.git` / `.bare`. */
const placeParts = (key: string, by: By): string[] => (by === 'repo' ? homeOf(key) : splitPath(key))

/** `in` from the URL: the selected node's real path prefix, `-` for (none); null for no selection. */
export const parseIn = (v: string | null): string | null => (v ? v : null)

/** Whether a place sits at or under the selected path (segment-wise); `-` is the empty place. */
export function underPath(key: string, sel: string | null, by: By): boolean {
  if (sel === null) return true
  if (sel === NONE_SEL) return key === ''
  if (!key) return false
  const want = splitPath(sel)
  const have = placeParts(key, by)
  return want.length <= have.length && want.every((s, i) => have[i] === s)
}

/** The sessions whose place sits at or under the selection. */
export const selectLanes = (lanes: OverviewLane[], sel: string | null, by: By, beads?: Beads): OverviewLane[] =>
  sel === null ? lanes : lanes.filter((l) => underPath(placeOf(l, by, beads), sel, by))

/** The selection on another key: kept when some session sits under it there, else dropped. */
export const keepSelection = (
  sel: string | null,
  lanes: readonly OverviewLane[],
  by: By,
  beads?: Beads,
): string | null => (sel !== null && lanes.some((l) => underPath(placeOf(l, by, beads), sel, by)) ? sel : null)

/** The selection as shown: the home as `~`, `-` as (none). */
export function displayPath(sel: string, home: string | undefined, by?: By): string {
  if (sel === NONE_SEL) return '(none)'
  // a bead path is shown as the id of its last segment
  if (by === 'bead') return sel.split('/').pop() ?? sel
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

// ---- what the pointer is over ------------------------------------------------------------

/** The widths the columns are laid out with (OverviewPage.tsx). */
export interface Layout {
  /** The padding inside the block, left and right (the block's left border is 1 px more). */
  pad: number
  turns: number
  agents: number
  spend: number
  /** The gap between the block's columns. */
  gap: number
}

/** The width of the structured block: its left rule, the padding and the three columns with their gaps. */
export const blockWidth = (L: Layout): number => 1 + 2 * L.pad + L.turns + L.agents + L.spend + 2 * L.gap

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

// ---- the sidebar: a file tree of the places -------------------------------------------------------------

/** What the tree lists: a place, the sessions in it and their spend. */
export interface PlaceItem {
  key: string
  count: number
  usd: number
}

/** The places of some sessions under a key, with their counts and spend (the empty place too), in first-seen order. */
export function placeItems(lanes: readonly OverviewLane[], by: By, beads?: Beads): PlaceItem[] {
  const m = new Map<string, PlaceItem>()
  for (const l of lanes) {
    const key = placeOf(l, by, beads)
    const it = m.get(key)
    if (it) {
      it.count++
      it.usd += l.usd
    } else m.set(key, { key, count: 1, usd: l.usd })
  }
  return [...m.values()]
}

/** One line of the tree: a place, a folder, or both. */
export interface PlaceNode {
  /** Where it sits, as shown (`~/work/app`, `github.com/acme`): unique in a tree, and what the open state is keyed by. */
  id: string
  /** The segments it stands for, joined (compact folders: `work/merlin`). */
  label: string
  /** The real path prefix it stands for (what `in` holds): the home spelled out, remotes as host/owner/repo. */
  path: string
  /** Every path the node stands for: a compacted chain of folders is one node (`path` is its deepest). */
  chain: string[]
  /** The place this node is, when it is one. */
  place?: PlaceItem
  /** A host at the top of a remote tree. */
  host?: boolean
  children: PlaceNode[]
  /** Sessions and spend, summed over the places at or under it. */
  count: number
  usd: number
}

export interface PlaceTree {
  nodes: PlaceNode[]
  /** The sessions with no value, listed apart below the tree. */
  none?: PlaceItem
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
  place?: PlaceItem
  host?: boolean
}

/**
 * The segments of a place, as shown (`~` for the home, a leading `/` on the first segment of an
 * absolute path) and the real path prefix each one stands for.
 */
function placeSegments(
  key: string,
  by: By,
  home: string | undefined,
): { segs: string[]; paths: string[]; host: boolean } {
  const isPath = key.startsWith('/') || /^[A-Za-z]:[\\/]/.test(key)
  const parts = placeParts(key, by)
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
 * The places laid out as the filesystem the user knows (docs/ui.md section 10b): a repository at its working
 * directory, a remote as host / owner / name, `home` as `~`. A folder that is no place and has one child is
 * merged into it (`~/work`, `work/merlin`); children are ordered by name, like Finder. Counts and spend are
 * summed up the tree. The empty place is returned apart.
 */
export function buildPlaceTree(items: readonly PlaceItem[], by: By, home: string | undefined): PlaceTree {
  const root: Trie = { seg: '', path: '', children: new Map() }
  let none: PlaceItem | undefined
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
    if (segs.length) at.place = it
  }
  const make = (t: Trie, trail: string[]): PlaceNode => {
    const path = [...trail, t.seg]
    const kids = [...t.children.values()].map((c) => make(c, path))
    const own = t.place
    const node: PlaceNode = {
      id: path.join('/'),
      label: t.seg,
      path: t.path,
      chain: [t.path],
      place: own,
      host: t.host,
      children: kids,
      count: (own?.count ?? 0) + kids.reduce((n, k) => n + k.count, 0),
      usd: (own?.usd ?? 0) + kids.reduce((n, k) => n + k.usd, 0),
    }
    // compact: a folder that is no place and has one child is that child, its label the joined segments
    // (not in the bead tree: a prefix is a heading of its own, and a bead is one node)
    if (by !== 'bead' && !own && kids.length === 1) {
      const [only] = kids
      return { ...only, label: `${t.seg}/${only.label}`, chain: [t.path, ...only.chain], host: t.host || undefined }
    }
    return node
  }
  // beads in id order (`x.2` before `x.10`), the places in a file explorer's order
  const byName = (a: PlaceNode, b: PlaceNode) =>
    (by === 'bead'
      ? idLess(a.label, b.label)
        ? -1
        : idLess(b.label, a.label)
          ? 1
          : 0
      : comparePlace(a.label.split('/'), b.label.split('/'))) || (a.id < b.id ? -1 : 1)
  const sortTree = (ns: PlaceNode[]): PlaceNode[] => {
    for (const n of ns) sortTree(n.children)
    return ns.sort(byName)
  }
  return { nodes: sortTree([...root.children.values()].map((c) => make(c, []))), none }
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

/** The id of the line that stands for a place: its own, or when a closed folder hides it, the outermost closed one. */
export function markedNode(nodes: readonly PlaceNode[], key: string, closed: ReadonlySet<string>): string | null {
  const walk = (ns: readonly PlaceNode[], hidden: string | null): string | null => {
    for (const n of ns) {
      const at = hidden ?? (closed.has(n.id) ? n.id : null)
      if (n.place?.key === key) return hidden ?? n.id
      const r = walk(n.children, at)
      if (r) return r
    }
    return null
  }
  return walk(nodes, null)
}

// ---- the custom range and its locator ------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The days of a custom range: local days, `YYYY-MM-DD`, both inclusive. */
export interface CustomRange {
  from: string
  to: string
}

/** The local calendar day `n` days after the local midnight `ms`, as a local midnight (DST-proof). */
export const addDays = (ms: number, n: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime()
}

/** The whole local days from the midnight `a` to the midnight `b`. */
export const daysBetween = (a: number, b: number): number => Math.round((b - a) / DAY)

/** A real calendar day written `YYYY-MM-DD`, else null. */
export function parseDay(v: string | null): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  return localDay(dayStart(v)) === v ? v : null
}

/** `from` and `to` of the URL: a custom range when both are real days and `from` is not after `to`. */
export function parseCustom(from: string | null, to: string | null): CustomRange | null {
  const a = parseDay(from)
  const b = parseDay(to)
  return a && b && a <= b ? { from: a, to: b } : null
}

/** The URL params of a custom range, and of none (the presets drop them). */
export const formatCustom = (r: CustomRange | null): { from?: string; to?: string } =>
  r ? { from: r.from, to: r.to } : { from: undefined, to: undefined }

/** The days a range covers. */
export const customDays = (r: CustomRange): number =>
  daysBetween(dayStart(r.from).getTime(), dayStart(r.to).getTime()) + 1

/** `May 20` (with the year when it is not `now`'s: `May 20, 2025`). */
export function dayText(day: string, now: Date): string {
  const d = dayStart(day)
  const y = d.getFullYear() === now.getFullYear() ? '' : `, ${d.getFullYear()}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${y}`
}

/** The Custom control's label: `May 20 → 10d` (start day, then the length in days). */
export const customLabel = (r: CustomRange, now: Date): string => `${dayText(r.from, now)} → ${customDays(r)}d`

/** "between May 20 and May 29", "on May 20": for the empty state. */
export const customPhrase = (r: CustomRange, now: Date): string =>
  r.from === r.to ? `on ${dayText(r.from, now)}` : `between ${dayText(r.from, now)} and ${dayText(r.to, now)}`

/**
 * What a custom range asks the API for: from local midnight of its first day to the next local midnight after
 * its last, capped at `nowMs`.
 */
export function customWindow(r: CustomRange, nowMs: number): { fromMs: number; toMs: number } {
  const fromMs = dayStart(r.from).getTime()
  const toMs = Math.min(addDays(dayStart(r.to).getTime(), 1), nowMs)
  return { fromMs, toMs: Math.max(toMs, fromMs + MIN) }
}

/** The remembered custom range as stored (`{from, to}` JSON): null when absent or not a custom range. */
export function parseStoredCustom(raw: string | null): CustomRange | null {
  try {
    const v: unknown = JSON.parse(raw ?? 'null')
    if (typeof v !== 'object' || v === null) return null
    const { from, to } = v as Record<string, unknown>
    return parseCustom(typeof from === 'string' ? from : null, typeof to === 'string' ? to : null)
  } catch {
    return null
  }
}

/**
 * What a click on the Custom segment does: `apply` the remembered range (a preset is active and one is
 * remembered), else `toggle` the locator (Custom is already active, or there is nothing to apply).
 */
export const customAction = (pressed: boolean, remembered: CustomRange | null): 'apply' | 'toggle' =>
  !pressed && remembered ? 'apply' : 'toggle'

/** The days a preset covers, ending today: `1d` is today, `7d` today and the six days before. */
export function presetRange(range: Range, today: Date): CustomRange {
  const n = Math.round(RANGES[range].ms / DAY)
  return { from: localDay(daysBefore(today, n - 1)), to: localDay(today) }
}

/** The locator's strip: whole local days, `first` being the local midnight of the first. */
export interface Strip {
  first: number
  days: number
}

/** The strip: from the first day with spend (or the range's, if earlier) to today (or the range's last day, if later). */
export function stripOf(firstSpendDay: string | undefined, today: Date, r: CustomRange | null): Strip {
  const t = dayStart(localDay(today)).getTime()
  const times = [firstSpendDay ? dayStart(firstSpendDay).getTime() : t, t]
  if (r) times.push(dayStart(r.from).getTime(), dayStart(r.to).getTime())
  const first = Math.min(...times)
  return { first, days: daysBetween(first, Math.max(...times)) + 1 }
}

/** The days a brush covers, as indices into the strip, both inclusive. */
export interface Brush {
  lo: number
  hi: number
}

const clampTo = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** The index of the day under x (px from the strip's left edge) on a strip drawn `width` px wide. */
export const dayIndexAt = (s: Strip, width: number, x: number): number =>
  clampTo(Math.floor((x / Math.max(1, width)) * s.days), 0, s.days - 1)

/** The brush's range: its days as local days. */
export function brushRange(s: Strip, b: Brush): CustomRange {
  const day = (i: number) => localDay(new Date(addDays(s.first, i)))
  return { from: day(b.lo), to: day(b.hi) }
}

/** The range as a brush on the strip (clipped to it). */
export function rangeBrush(s: Strip, r: CustomRange): Brush {
  const at = (day: string) => clampTo(daysBetween(s.first, dayStart(day).getTime()), 0, s.days - 1)
  return { lo: at(r.from), hi: at(r.to) }
}

/** A brush drawn from one day to another (either way round); a day at least. */
export const drawBrush = (a: number, b: number): Brush => ({ lo: Math.min(a, b), hi: Math.max(a, b) })

/** The brush moved by the days the pointer went from `grab` to `to`, its length kept, inside the strip. */
export function moveBrush(b: Brush, grab: number, to: number, days: number): Brush {
  const shift = clampTo(to - grab, -b.lo, days - 1 - b.hi)
  return { lo: b.lo + shift, hi: b.hi + shift }
}

/** An edge of the brush dragged to a day; the edges cannot cross (a day at least). */
export const resizeBrush = (b: Brush, edge: 'lo' | 'hi', day: number): Brush =>
  edge === 'lo' ? { lo: Math.min(day, b.hi), hi: b.hi } : { lo: b.lo, hi: Math.max(day, b.lo) }

/** What was spent on each day of the strip, from the rows of `GET /api/cost?by=day` (key: the local day). */
export function dailySpend(rows: readonly { key: string; totalUSD: number }[], s: Strip): number[] {
  const out = new Array<number>(s.days).fill(0)
  for (const r of rows) {
    const day = parseDay(r.key)
    if (!day) continue
    const i = daysBetween(s.first, dayStart(day).getTime())
    if (i >= 0 && i < s.days) out[i] += r.totalUSD
  }
  return out
}

/** The first day of a day-cost table that has spend, if any (rows come in day order). */
export const firstSpendDay = (rows: readonly { key: string; totalUSD: number }[]): string | undefined =>
  rows.filter((r) => r.totalUSD > 0 && parseDay(r.key)).sort((a, b) => (a.key < b.key ? -1 : 1))[0]?.key

// ---- a click on a row's graph ---------------------------------------------------------------

/** The stretch under x as times: the day (the hour in a range of two days or less); null outside the plot. */
export function bandTimes(axis: Axis, x: number): { fromMs: number; toMs: number } | null {
  const b = bandAt(axis, x)
  return b ? { fromMs: Math.round(timeAt(axis, b.x0)), toMs: Math.round(timeAt(axis, b.x1)) } : null
}

/** `Mon, May 18` (`May 18, 14:00` when the stretch is an hour): what a click on the graph opens. */
export function bandLabel(axis: Axis, x: number): string {
  const t = bandTimes(axis, x)
  if (!t) return ''
  const d = new Date(t.fromMs)
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  if (axis.toMs - axis.fromMs <= 2 * DAY) return `${date}, ${String(d.getHours()).padStart(2, '0')}:00`
  return `${DAYS[d.getDay()]}, ${date}`
}

/**
 * The window `[a, b]` cut to the session's own activity in it (slots with a call running or context held);
 * the window itself when the session did nothing there.
 */
export function clipToActivity(l: OverviewLane, axis: Axis, a: number, b: number): [number, number] {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  const n = Math.max(l.active.length, l.context.length)
  for (let k = 0; k < n; k++) {
    if (!(l.active[k] > 0 || l.context[k] > 0)) continue
    const s = axis.fromMs + (l.slot0 + k) * axis.slotMs
    const e = s + axis.slotMs
    if (e <= a || s >= b) continue
    lo = Math.min(lo, Math.max(s, a))
    hi = Math.max(hi, Math.min(e, b))
  }
  return lo <= hi ? [lo, hi] : [a, b]
}

/**
 * Where a click at x on a session's graph goes: the Session page with the stretch under the pointer as its
 * window (`from`, `to`), cut to the session's activity in it; the plain session path outside the plot.
 */
export function sessionStretchUrl(l: OverviewLane, axis: Axis, x: number): string {
  const base = sessionPath({ harness: l.harness, id: l.id })
  const t = bandTimes(axis, x)
  if (!t) return base
  const [a, b] = clipToActivity(l, axis, t.fromMs, t.toMs)
  return `${base}?${new URLSearchParams({ from: new Date(a).toISOString(), to: new Date(b).toISOString() })}`
}

/** A mark under the locator's strip: its x, label and whether it is a month's first day. */
export interface StripTick {
  x: number
  label: string
  month: boolean
}

/**
 * The light axis under the strip: each month's first day with the month's name (the year at January), and
 * when a day is 16 px wide or more the day numbers between, at the step that keeps the labels apart. Labels that
 * would run into the previous one or past the right edge are left out.
 */
export function stripTicks(s: Strip, width: number, charW = 6): StripTick[] {
  const dw = width / s.days
  const step = dw >= 16 ? 1 : Math.ceil(26 / dw / 7)
  const out: StripTick[] = []
  let end = -Infinity
  for (let i = 0; i < s.days; i++) {
    const d = new Date(addDays(s.first, i))
    const first = d.getDate() === 1
    if (!first && !(dw >= 16 && (d.getDate() - 1) % step === 0)) continue
    const label = first
      ? `${MONTHS[d.getMonth()]}${d.getMonth() === 0 ? ` ${d.getFullYear()}` : ''}`
      : String(d.getDate())
    const x = i * dw
    if (x < end + 4 || x + 2 + label.length * charW > width) continue
    end = x + 2 + label.length * charW
    out.push({ x, label, month: first })
  }
  return out
}
