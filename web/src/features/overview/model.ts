// The Overview page's pure logic: the linear time axis, the slot a plot asks for, the shared scales,
// held context, the packing of spines into sub-lanes, sorting and which sessions a click lists.
// OverviewPage.tsx draws what this returns (docs/ui.md section 10b).

import type { Overview, OverviewGroup, OverviewLane, OverviewSlot, OverviewSpan } from '../../api/types'
import { HOLD_MS } from '../spend/timeline'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

export type Range = '1d' | '7d' | '30d'
export type SortKey = 'spend' | 'sessions' | 'priciest' | 'recent'
export type CtxMode = 'sum' | 'peak'

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

// ---- held context ------------------------------------------------------------------------

export interface HeldCall {
  at: number
  /** Prompt tokens of the call. */
  ctx: number
}

/**
 * A session's context per slot as the Session page holds it: a call's context lasts until the next call,
 * unless that comes more than `holdMs` later, when it ends at the call. A slot gets the largest context it
 * held at any moment. `calls` are the main agent's, in any order.
 */
export function heldContext(
  calls: HeldCall[],
  fromMs: number,
  slotMs: number,
  slots: number,
  holdMs = HOLD_MS,
): number[] {
  const out = new Array<number>(slots).fill(0)
  const sorted = [...calls].sort((a, b) => a.at - b.at)
  sorted.forEach((c, k) => {
    const next = sorted[k + 1]
    const end = next && next.at - c.at <= holdMs ? next.at : c.at
    const a = Math.max(0, Math.floor((c.at - fromMs) / slotMs))
    // the end is exclusive: a call held up to the very start of a slot does not reach into it
    const b = Math.min(slots - 1, end > c.at ? Math.ceil((end - fromMs) / slotMs) - 1 : a)
    for (let i = a; i <= b; i++) if (c.ctx > out[i]) out[i] = c.ctx
  })
  return out
}

// ---- scales and heights ------------------------------------------------------------------

export interface Scales {
  /** px per token and px per dollar, the same for every row. */
  pxPerTok: number
  pxPerUsd: number
  maxTok: number
  maxUsd: number
}

export interface Heights {
  up: number
  down: number
}

export const MAX_UP = 60
export const MAX_DOWN = 36
export const MIN_SIDE = 5

export const contextOf = (g: OverviewGroup, mode: CtxMode): number[] => (mode === 'sum' ? g.contextSum : g.contextPeak)

const peakOf = (a: number[]): number => a.reduce((m, v) => (v > m ? v : m), 0)

/** One token scale and one dollar scale for all the rows: the largest value anywhere reaches the limit. */
export function scalesFor(groups: OverviewGroup[], mode: CtxMode, scripted?: number[]): Scales {
  let maxTok = 0
  let maxUsd = peakOf(scripted ?? [])
  for (const g of groups) {
    maxTok = Math.max(maxTok, peakOf(contextOf(g, mode)))
    maxUsd = Math.max(maxUsd, peakOf(g.usdSlots))
  }
  return { maxTok, maxUsd, pxPerTok: maxTok > 0 ? MAX_UP / maxTok : 0, pxPerUsd: maxUsd > 0 ? MAX_DOWN / maxUsd : 0 }
}

/** A row is as tall as its own peaks need on the shared scales; a minimum keeps a quiet row readable. */
export function rowHeights(ctx: number[], usd: number[], s: Scales, minSide = MIN_SIDE): Heights {
  return {
    up: Math.max(minSide, Math.round(peakOf(ctx) * s.pxPerTok)),
    down: Math.max(minSide, Math.round(peakOf(usd) * s.pxPerUsd)),
  }
}

/** Pixel height of the sub-lane block under a row's spend, for `lanes` sub-lanes. */
export const LANE_H = 7
export const LANES_GAP = 5
export const laneBlock = (lanes: number): number => (lanes > 0 ? LANES_GAP + lanes * LANE_H : 0)

/** The largest 1, 2 or 5 times a power of ten not above v (0 for v <= 0). */
export function niceFloor(v: number): number {
  if (!(v > 0)) return 0
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p
}

// ---- sorting -----------------------------------------------------------------------------

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

// ---- row marks ---------------------------------------------------------------------------

export interface ActivityRun {
  from: number
  to: number
  /** 1, 2 or 3 (three or more). */
  weight: 1 | 2 | 3
}

/** Contiguous slots with the same activity weight, for the session line on the baseline. */
export function activityRuns(active: number[]): ActivityRun[] {
  const out: ActivityRun[] = []
  for (let i = 0; i < active.length; i++) {
    if (!(active[i] > 0)) continue
    const w = Math.min(3, active[i]) as 1 | 2 | 3
    const last = out[out.length - 1]
    if (last && last.to === i && last.weight === w) last.to = i + 1
    else out.push({ from: i, to: i + 1, weight: w })
  }
  return out
}

/** Stroke widths of the session line by weight. */
export const ACTIVE_W: Record<1 | 2 | 3, number> = { 1: 1, 2: 2, 3: 3.5 }

const r1 = (v: number) => Math.round(v * 10) / 10

/**
 * The context as a step area: `area` is one closed shape per run of slots above zero (standing on `base`,
 * growing upward at `scale` px per unit), `line` its outline without the baseline.
 */
export function stepAreaPath(
  values: number[],
  axis: Axis,
  base: number,
  scale: number,
): { area: string; line: string } {
  let area = ''
  let line = ''
  const n = values.length
  let i = 0
  while (i < n) {
    if (!(values[i] > 0)) {
      i++
      continue
    }
    let j = i
    while (j < n && values[j] > 0) j++
    const x0 = r1(slotX(axis, i))
    let d = `M${x0},${r1(base)}`
    let prev = base
    let k = i
    while (k < j) {
      let m = k
      while (m < j && values[m] === values[k]) m++
      const y = r1(base - values[k] * scale)
      if (y !== prev) d += `V${y}`
      d += `H${r1(slotX(axis, m))}`
      prev = y
      k = m
    }
    line += `${d}V${r1(base)}`
    area += `${d}V${r1(base)}Z`
    i = j
  }
  return { area, line }
}

// ---- spines ------------------------------------------------------------------------------

/** A spine is at least this long from its vertical (the 6 px elbow and 10 px along), so the shape reads at any zoom. */
export const MIN_SPINE = 16
/** The most sub-lanes a row grows; more spines share the last one. */
export const MAX_SUBLANES = 8
/** Room kept between two spines of a sub-lane, in px. */
export const SPINE_GAP = 3
/** Width reserved for the "x4" label after a spine. */
export const labelWidth = (n: number): number => 7 + 5 * String(n).length

export interface SpineItem {
  span: OverviewSpan
  x0: number
  x1: number
  lane: number
  /** The span began before the range: no vertical, no elbow. */
  clipped: boolean
}

/**
 * Greedy interval packing: each [x0, x1] goes to the first lane whose last end is `gap` px left of x0.
 * Returns the lane of each input, in input order.
 */
export function packIntervals(boxes: { x0: number; x1: number }[], gap = SPINE_GAP, maxLanes = Infinity): number[] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].x0 - boxes[b].x0 || boxes[b].x1 - boxes[a].x1 || a - b)
  const ends: number[] = []
  const lane = new Array<number>(boxes.length).fill(0)
  for (const i of order) {
    let k = ends.findIndex((e) => e + gap <= boxes[i].x0)
    if (k < 0) k = ends.length < maxLanes ? ends.length : ends.indexOf(Math.min(...ends))
    ends[k] = Math.max(ends[k] ?? -Infinity, boxes[i].x1)
    lane[i] = k
  }
  return lane
}

/** The spines of a row: pixel extents (with the minimum length and the label's room) packed into sub-lanes. */
export function layoutSpans(spans: OverviewSpan[] | undefined, axis: Axis): { items: SpineItem[]; lanes: number } {
  const raw = (spans ?? []).map((span) => {
    const s = Date.parse(span.start)
    const clipped = s < axis.fromMs
    const x0 = Math.max(0, xOf(axis, s))
    const x1 = Math.min(axis.width, Math.max(xOf(axis, Date.parse(span.end)), x0 + MIN_SPINE))
    return { span, x0, x1, clipped }
  })
  const lane = packIntervals(
    raw.map((r) => ({ x0: r.x0, x1: r.x1 + (r.span.n > 1 ? labelWidth(r.span.n) : 0) })),
    SPINE_GAP,
    MAX_SUBLANES,
  )
  const items = raw.map((r, i) => ({ ...r, lane: lane[i] }))
  return { items, lanes: items.reduce((m, it) => Math.max(m, it.lane + 1), 0) }
}

/** The words for a span's kind. */
export const SPAN_LABEL: Record<OverviewSpan['kind'], string> = {
  subagent: 'sub-agent',
  teammate: 'teammate',
  fork: 'fork',
  workflow: 'workflow',
  'session-fork': 'forked session',
  continuation: 'continued session',
}

/** Compactions of a row folded into one record per slot. */
export interface CompactMarks {
  cold: number
  warm: number
  other: number
}

export function compactionsBySlot(events: Overview['groups'][number]['events']): Map<number, CompactMarks> {
  const out = new Map<number, CompactMarks>()
  for (const e of events ?? []) {
    if (e.type !== 'compaction') continue
    const m = out.get(e.slot) ?? { cold: 0, warm: 0, other: 0 }
    if (e.kind === 'cold') m.cold += e.n
    else if (e.kind === 'warm') m.warm += e.n
    else m.other += e.n
    out.set(e.slot, m)
  }
  return out
}

/** A slot's compactions in words ("2 cold compactions"); '' when none. */
export function describeCompactions(m: CompactMarks | undefined): string {
  if (!m) return ''
  const out: string[] = []
  if (m.cold) out.push(`${m.cold > 1 ? `${m.cold} ` : ''}cold compaction${m.cold > 1 ? 's' : ''}`)
  if (m.warm) out.push(`${m.warm > 1 ? `${m.warm} ` : ''}warm compaction${m.warm > 1 ? 's' : ''}`)
  if (m.other) out.push(`${m.other > 1 ? `${m.other} ` : ''}compaction${m.other > 1 ? 's' : ''}`)
  return out.join(', ')
}

// ---- clicking a slot ---------------------------------------------------------------------

export interface SlotRange {
  from: number
  /** Inclusive. */
  to: number
}

/** The slots between two clicks (in either order), clamped to the plot. */
export function slotRange(a: number, b: number, slots: number): SlotRange {
  const lo = Math.max(0, Math.min(a, b))
  const hi = Math.min(slots - 1, Math.max(a, b))
  return { from: lo, to: hi }
}

export interface LaneHit {
  lane: OverviewLane
  /** Spend within the range. */
  usdIn: number
  /** The session's last activity, from the lane. */
  last?: string
}

/** The lanes with something in the slot range (spend or context), the priciest in the range first. */
export function lanesIn(lanes: OverviewLane[], r: SlotRange): LaneHit[] {
  const out: LaneHit[] = []
  for (const lane of lanes) {
    let usdIn = 0
    let live = false
    for (let i = r.from; i <= r.to; i++) {
      usdIn += lane.usdSlots[i] ?? 0
      if ((lane.usdSlots[i] ?? 0) > 0 || (lane.context[i] ?? 0) > 0) live = true
    }
    if (live) out.push({ lane, usdIn, last: lane.lastActivityAt })
  }
  return out.sort((a, b) => b.usdIn - a.usdIn || (a.lane.id < b.lane.id ? -1 : 1))
}

/** "Tue 4 Nov 14:00-15:00" for the time range from t0 to t1. */
export const rangeLabel = (t0: number, t1: number): string => slotLabel(t0, t1 - t0, 0, 0)

/** Time of the start of slot i. */
export const slotStart = (fromMs: number, slotMs: number, i: number): number => fromMs + i * slotMs

/** Opened groups live in the URL as a comma-separated list of escaped keys; the empty key is `-`. */
export function parseOpen(v: string | null): string[] {
  if (!v) return []
  return v.split(',').map((k) => (k === '-' ? '' : decodeURIComponent(k)))
}

export function formatOpen(keys: string[]): string {
  return keys.map((k) => (k === '' ? '-' : k === '-' ? '%2D' : encodeURIComponent(k))).join(',')
}

export function toggleOpen(keys: string[], key: string): string[] {
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
