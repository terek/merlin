// The Overview page's pure logic: the linear time axis, the slot a plot asks for, held and idle context,
// the shared token scale, sorting, the spine lane of a row and what the pointer is near.
// OverviewPage.tsx draws what this returns (docs/ui.md section 10b).

import type { OverviewGroup, OverviewLane, OverviewSlot, OverviewSpan } from '../../api/types'
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

/** The slot under pixel x, or -1 outside the plot. */
export function slotAt(axis: Axis, px: number): number {
  if (!(px >= 0) || px >= axis.width || axis.slots <= 0) return -1
  return Math.min(axis.slots - 1, Math.floor(px / axis.slotW))
}

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

/** The value of slot `i` in a lane's trimmed array (0 outside it). */
export const laneAt = (arr: number[], slot0: number, i: number): number => arr[i - slot0] ?? 0

// ---- the token scale ---------------------------------------------------------------------

export type CtxMode = 'sum' | 'peak'

/** The context area's greatest height, in px. */
export const CTX_MAX = 15

export const contextOf = (g: OverviewGroup, mode: CtxMode): number[] => (mode === 'sum' ? g.contextSum : g.contextPeak)
export const idleOf = (g: OverviewGroup, mode: CtxMode): number[] => (mode === 'sum' ? g.idleSum : g.idlePeak)

const peakOf = (a: number[]): number => a.reduce((m, v) => (v > m ? v : m), 0)

/**
 * One token scale for every row, groups and sessions alike: the largest context (or idle context) of any
 * group in the mode reaches `CTX_MAX` px. A session never exceeds its group's, so the groups are enough.
 */
export function tokenScale(groups: OverviewGroup[], mode: CtxMode): { maxTok: number; pxPerTok: number } {
  let maxTok = 0
  for (const g of groups) maxTok = Math.max(maxTok, peakOf(contextOf(g, mode)), peakOf(idleOf(g, mode)))
  return { maxTok, pxPerTok: maxTok > 0 ? CTX_MAX / maxTok : 0 }
}

// ---- sorting -----------------------------------------------------------------------------

export type SortKey = 'spend' | 'sessions' | 'priciest' | 'recent'

export function sortGroups(groups: OverviewGroup[], by: SortKey): OverviewGroup[] {
  const val = (g: OverviewGroup): number | string =>
    by === 'spend'
      ? g.usd
      : by === 'sessions'
        ? g.sessions
        : by === 'priciest'
          ? (g.priciest?.usd ?? 0)
          : (g.lastActivityAt ?? '')
  return [...groups].sort((a, b) => {
    const x = val(a)
    const y = val(b)
    if (x !== y) return x < y ? 1 : -1
    return a.usd !== b.usd ? b.usd - a.usd : a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

/** Sessions inside a group: by last activity for sort=recent, otherwise by spend; ties by id. */
export function sortLanes(lanes: OverviewLane[], by: SortKey): OverviewLane[] {
  return [...lanes].sort((a, b) => {
    if (by === 'recent') {
      const x = a.lastActivityAt ?? ''
      const y = b.lastActivityAt ?? ''
      if (x !== y) return x < y ? 1 : -1
    }
    if (a.usd !== b.usd) return b.usd - a.usd
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
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

/** Sessions an open group shows before "k more". */
export const SHOWN = 5

/** The first `SHOWN` sessions of a sorted list, or all; `more` is how many are left out. */
export function visibleLanes<T>(sorted: T[], all: boolean, limit = SHOWN): { shown: T[]; more: number } {
  if (all || sorted.length <= limit) return { shown: sorted, more: 0 }
  return { shown: sorted.slice(0, limit), more: sorted.length - limit }
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

/** The words for a span's kind, singular and plural. */
export const SPAN_LABEL: Record<Kind, [string, string]> = {
  subagent: ['sub-agent', 'sub-agents'],
  teammate: ['teammate', 'teammates'],
  fork: ['fork', 'forks'],
  workflow: ['workflow', 'workflows'],
  'session-fork': ['forked session', 'forked sessions'],
  continuation: ['continued session', 'continued sessions'],
}

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

export interface SpawnsNear {
  total: number
  /** Counts by kind, in draw order. */
  kinds: { kind: Kind; n: number }[]
  /** Titles of the first few, by start. */
  titles: string[]
}

/** The spawns whose start is within `tol` px of `x`; null when none. */
export function spawnsNear(spans: OverviewSpan[] | undefined, axis: Axis, x: number, tol = 4): SpawnsNear | null {
  const hits = (spans ?? [])
    .map((s) => ({ s, t: Date.parse(s.start) }))
    .filter(({ t }) => Math.abs(xOf(axis, t) - x) <= tol)
    .sort((a, b) => a.t - b.t)
  if (hits.length === 0) return null
  const kinds = KIND_ORDER.map((kind) => ({ kind, n: hits.filter((h) => h.s.kind === kind).length })).filter(
    (k) => k.n > 0,
  )
  const titles = hits.map((h) => h.s.title ?? '').filter((t) => t !== '')
  return { total: hits.length, kinds, titles: titles.slice(0, 3) }
}

/** "3 sub-agents, 1 fork". */
export function describeSpawns(k: SpawnsNear): string {
  return k.kinds.map(({ kind, n }) => `${n} ${SPAN_LABEL[kind][n === 1 ? 0 : 1]}`).join(', ')
}

// ---- URL state: closed groups, groups shown whole ----------------------------------------

/** Group keys in the URL as a comma-separated list of escaped keys; the empty key is `-`. */
export function parseKeys(v: string | null): string[] {
  if (!v) return []
  return v.split(',').map((k) => (k === '-' ? '' : decodeURIComponent(k)))
}

export function formatKeys(keys: string[]): string {
  return keys.map((k) => (k === '' ? '-' : k === '-' ? '%2D' : encodeURIComponent(k))).join(',')
}

export function toggleKey(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** "Tue 4 Nov 14:00-15:00" for slot i; a day slot is just the date. */
export function slotLabel(fromMs: number, slotMs: number, first: number, last = first): string {
  const a = new Date(fromMs + first * slotMs)
  const b = new Date(fromMs + (last + 1) * slotMs)
  const day = `${DAYS[a.getDay()]} ${a.getDate()} ${MONTHS[a.getMonth()]}`
  if (slotMs >= DAY && last === first) return day
  const sameDay = a.toDateString() === new Date(b.getTime() - 1).toDateString()
  const end = sameDay
    ? hm(b)
    : `${DAYS[new Date(b.getTime() - 1).getDay()]} ${new Date(b.getTime() - 1).getDate()} ${hm(b)}`
  return `${day} ${hm(a)}–${end}`
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
