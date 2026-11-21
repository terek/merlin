// The Moments timeline's arithmetic (docs/moments.md, "The page"): where a marker goes, which lane it
// takes, what the edge stack holds, the soft activity area, the month labels. Pure, so it is tested.

import type { MomentActivityDay, MomentHit, MomentView } from '../../api/types'
import { dayStart, localDay } from '../../lib/time'

/** Moments whose first hit is this close to the start of the history are not placed one by one. */
export const EDGE_DAYS = 7
/** The prefix of the hover id of a suggestion in the future zone. */
export const NEXT_PREFIX = '@next:'
/** The width of the column that lists the moments already there when the history starts. */
export const EDGE_COL = 190
/** The width of the zone after "now" that holds what is next for you. */
export const FUTURE_W = 200
/** The height of one lane of markers. */
export const MARKER_GAP = 16
export const PAD_X = 12
/** The marker's radius, and the space between a marker and its label. */
export const MARKER_R = 4.5
export const LABEL_GAP = 5
/** Two labels in one lane end at least this far before the next marker. */
export const LABEL_SPACE = 8
export const LABEL_SIZE = 12
const CHAR_W = 6.3

/** The width of a label at LABEL_SIZE, estimated from its length (no canvas: the layout stays pure). */
export function labelWidth(text: string): number {
  return Math.ceil(text.length * CHAR_W)
}

const DAY_MS = 86_400_000

/** A moment that was seen at least once and says where. */
export function isSeen(m: MomentView): boolean {
  return m.status !== 'unseen' && !!m.first
}

/** The seen moments by first hit, then title. */
export function seenMoments(moments: MomentView[]): MomentView[] {
  return moments
    .filter(isSeen)
    .sort((a, b) => Date.parse(a.first ?? '') - Date.parse(b.first ?? '') || a.title.localeCompare(b.title))
}

export interface Marker {
  moment: MomentView
  x: number
  lane: number
  /** The label sits to the left of the circle (near the right edge) instead of to its right. */
  flip: boolean
  /** Where the label's text starts (or ends, when flipped). */
  labelX: number
  labelW: number
}

export interface TimelineLayout {
  /** Left end of the time axis, as epoch ms; the right end is `now`. */
  from: number
  to: number
  width: number
  /** The plot's left and right edges in px (the edge column is left of it, the future zone right of it). */
  left: number
  right: number
  /** Markers placed one by one, with their lanes. */
  markers: Marker[]
  lanes: number
  /** Moments already there when the history starts: one stack at the left edge. */
  edge: MomentView[]
}

/** The x of a time, clamped to the axis. */
export function xOf(l: Pick<TimelineLayout, 'from' | 'to' | 'left' | 'right'>, t: number): number {
  const span = Math.max(1, l.to - l.from)
  const f = Math.min(1, Math.max(0, (t - l.from) / span))
  return l.left + PAD_X + f * Math.max(1, l.right - l.left - 2 * PAD_X)
}

/**
 * Lays the seen moments out over `width` px. Markers that would sit closer than MARKER_GAP take the first lane
 * (counted from the area upwards) whose last marker is far enough to the left; the edge stack holds lane 0's start.
 */
export function layoutTimeline(
  moments: MomentView[],
  since: string,
  now: string,
  width: number,
  future = false,
): TimelineLayout {
  const from = Date.parse(since)
  const to = Math.max(Date.parse(now), from + DAY_MS)
  const seen = seenMoments(moments)
  const edge = seen.filter((m) => Date.parse(m.first ?? '') - from < EDGE_DAYS * DAY_MS)
  const left = edge.length > 0 ? EDGE_COL : 0
  const right = future ? width - FUTURE_W : width
  const l: TimelineLayout = { from, to, width, left, right, markers: [], lanes: 1, edge }
  // the spans [from, to] taken in each lane
  const taken: [number, number][][] = [[]]
  for (const m of seen) {
    const t = Date.parse(m.first ?? '')
    if (t - from < EDGE_DAYS * DAY_MS) continue
    const x = xOf(l, t)
    const w = labelWidth(m.title)
    const flip = x + MARKER_R + LABEL_GAP + w > right - PAD_X
    const a = flip ? x - MARKER_R - LABEL_GAP - w : x - MARKER_R
    const b = flip ? x + MARKER_R : x + MARKER_R + LABEL_GAP + w
    let lane = taken.findIndex((spans) => spans.every(([s, e]) => a - e >= LABEL_SPACE || s - b >= LABEL_SPACE))
    if (lane < 0) lane = taken.push([]) - 1
    taken[lane].push([a, b])
    l.markers.push({
      moment: m,
      x,
      lane,
      flip,
      labelX: flip ? x - MARKER_R - LABEL_GAP : x + MARKER_R + LABEL_GAP,
      labelW: w,
    })
  }
  l.lanes = Math.max(1, taken.length)
  return l
}

export interface AreaPoint {
  x: number
  /** 0..1 of the busiest day (smoothed). */
  v: number
}

/** The local days from `since` to `now`, as "2026-08-24" keys. */
export function daysBetween(since: string, now: string): string[] {
  const out: string[] = []
  const end = localDay(new Date(now))
  for (let d = dayStart(localDay(new Date(since))); ; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const k = localDay(d)
    out.push(k)
    if (k >= end || out.length > 20_000) break
  }
  return out
}

/**
 * The activity as points of a soft area: prompts per day, averaged over `window` days (a week by default, so
 * weekends do not cut the ground into teeth), scaled to the busiest day.
 */
export function activityArea(
  activity: MomentActivityDay[],
  l: TimelineLayout,
  since: string,
  now: string,
  window = 7,
): AreaPoint[] {
  const n = new Map(activity.map((a) => [a.day, a.prompts]))
  const days = daysBetween(since, now)
  const raw = days.map((d) => n.get(d) ?? 0)
  const half = Math.floor(window / 2)
  const smooth = raw.map((_, i) => {
    const a = Math.max(0, i - half)
    const b = Math.min(raw.length - 1, i + half)
    let sum = 0
    for (let k = a; k <= b; k++) sum += raw[k]
    return sum / (b - a + 1)
  })
  const max = Math.max(...smooth, 0)
  if (max === 0) return []
  return days.map((d, i) => ({ x: xOf(l, dayStart(d).getTime() + DAY_MS / 2), v: smooth[i] / max }))
}

export interface MonthTick {
  x: number
  label: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** One label at the start of every month inside the axis; the year on January and on the first label. */
export function monthTicks(l: TimelineLayout): MonthTick[] {
  const out: MonthTick[] = []
  const a = new Date(l.from)
  for (let d = new Date(a.getFullYear(), a.getMonth() + 1, 1); d.getTime() < l.to; ) {
    const first = out.length === 0
    out.push({
      x: xOf(l, d.getTime()),
      label: MONTHS[d.getMonth()] + (first || d.getMonth() === 0 ? ` ${d.getFullYear()}` : ''),
    })
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1)
  }
  return out
}

export interface DayTick {
  day: string
  x: number
  /** 0..1 of the moment's busiest day. */
  h: number
  hits: number
  example?: MomentHit
  /** The tick's hit area: where the pointer picks this day (at least 8 px wide, never over a neighbour's). */
  x0: number
  x1: number
}

/** The least width of a tick's hit area. */
export const TICK_HIT = 8

/** Hits per day of a moment as ticks: position, height (0..1 of its busiest day) and hit area. */
export function dayTicks(m: MomentView, l: TimelineLayout): DayTick[] {
  const days = m.days ?? []
  const max = Math.max(...days.map((d) => d.hits), 1)
  const ticks = days.map((d) => ({
    day: d.day,
    x: xOf(l, dayStart(d.day).getTime() + DAY_MS / 2),
    h: d.hits / max,
    hits: d.hits,
    example: d.example,
    x0: 0,
    x1: 0,
  }))
  // the nearest day wins: an area reaches half way to a neighbour at most
  ticks.forEach((t, i) => {
    const prev = ticks[i - 1]
    const next = ticks[i + 1]
    t.x0 = prev ? Math.max(t.x - TICK_HIT / 2, (prev.x + t.x) / 2) : t.x - TICK_HIT / 2
    t.x1 = next ? Math.min(t.x + TICK_HIT / 2, (next.x + t.x) / 2) : t.x + TICK_HIT / 2
  })
  return ticks
}
