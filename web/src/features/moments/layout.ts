// The Moments timeline's arithmetic (docs/moments.md, "The page"): where a marker goes, which lane it
// takes, what the edge stack holds, the soft activity area, the month labels. Pure, so it is tested.

import type { MomentActivityDay, MomentDay, MomentHit, MomentView } from '../../api/types'
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
  measure: (text: string) => number = labelWidth,
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
    const w = measure(m.title)
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

/** A stretch of k days of a moment, drawn as one square on the event strip. */
export interface Bucket {
  /** First day of the bucket, YYYY-MM-DD: its key. */
  day: string
  /** Last day of the bucket. */
  end: string
  hits: number
  /** 0..1 of the moment's busiest bucket. */
  h: number
  /** The example of the bucket's busiest day (the latest on a tie). */
  example?: MomentHit
}

export interface BucketTick extends Bucket {
  /** Left edge of the square, in chart pixels. */
  x: number
  /** The bucket's hit area: at least 8 px wide, never over a neighbour's. */
  x0: number
  x1: number
}

/** The side of a square on the event strip, and the height of a row. */
export const STRIP_PX = 4

/** The least width of a bucket's hit area. */
export const TICK_HIT = 8

/** Days per bucket: enough that a bucket is at least one square wide. */
export function daysPerBucket(l: Pick<TimelineLayout, 'from' | 'to' | 'left' | 'right'>): number {
  const days = Math.max(1, (l.to - l.from) / DAY_MS)
  const dayWidth = Math.max(1, l.right - l.left - 2 * PAD_X) / days
  return Math.max(1, Math.ceil(STRIP_PX / dayWidth))
}

/** The days of a moment in buckets of k days, aligned to the first day of the range. Only active buckets are returned. */
export function bucketDays(days: MomentDay[], since: string, k: number): Bucket[] {
  const origin = dayStart(localDay(new Date(since)))
  const by = new Map<number, { hits: number; best: MomentDay }>()
  for (const d of days) {
    const idx = Math.round((dayStart(d.day).getTime() - origin.getTime()) / DAY_MS)
    const b = Math.floor(idx / Math.max(1, k))
    const cur = by.get(b)
    if (!cur) by.set(b, { hits: d.hits, best: d })
    else {
      cur.hits += d.hits
      if (d.hits >= cur.best.hits) cur.best = d
    }
  }
  const out = [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, v]) => ({
      day: localDay(new Date(origin.getFullYear(), origin.getMonth(), origin.getDate() + b * k)),
      end: localDay(new Date(origin.getFullYear(), origin.getMonth(), origin.getDate() + b * k + k - 1)),
      hits: v.hits,
      h: 0,
      example: v.best.example,
    }))
  const max = Math.max(...out.map((o) => o.hits), 1)
  for (const o of out) o.h = o.hits / max
  return out
}

/** A moment's buckets placed on the event strip: one square each, at the bucket's start. */
export function bucketTicks(m: MomentView, l: TimelineLayout, since: string): BucketTick[] {
  const k = daysPerBucket(l)
  const dayWidth = Math.max(1, l.right - l.left - 2 * PAD_X) / Math.max(1, (l.to - l.from) / DAY_MS)
  const ticks: BucketTick[] = bucketDays(m.days ?? [], since, k).map((b) => ({
    ...b,
    // a day wider than the square: the square sits in the middle of it
    x: xOf(l, dayStart(b.day).getTime()) + (k === 1 && dayWidth > STRIP_PX ? (dayWidth - STRIP_PX) / 2 : 0),
    x0: 0,
    x1: 0,
  }))
  // the nearest bucket wins: an area reaches half way to a neighbour at most
  ticks.forEach((t, i) => {
    const c = t.x + STRIP_PX / 2
    const prev = ticks[i - 1]
    const next = ticks[i + 1]
    t.x0 = prev ? Math.max(c - TICK_HIT / 2, (prev.x + STRIP_PX / 2 + c) / 2) : c - TICK_HIT / 2
    t.x1 = next ? Math.min(c + TICK_HIT / 2, (next.x + STRIP_PX / 2 + c) / 2) : c + TICK_HIT / 2
  })
  return ticks
}

/** The text size of a row label in the rows layout: the page's body size. */
export const ROW_LABEL_SIZE = 13
/** The height of a moment's row, and of a subheading row, in the rows layout. */
export const ROWS_PITCH = 20
export const ROWS_HEAD = 24
/** The gutter of the rows layout never gets narrower or wider than this. */
export const GUTTER_MIN = 160
export const GUTTER_MAX = 280

/** One line of the rows layout: a quiet subheading, or a moment (seen: has a track; next: a suggestion). */
export type RowItem =
  | { kind: 'head'; text: string }
  | { kind: 'moment'; moment: MomentView; edge: boolean }
  | { kind: 'next'; moment: MomentView }

/**
 * The rows of the rows layout: the moments already there in the first week under their subheading, then the rest
 * by first hit (a staircase), then the suggested moments under "Next for you". Pure and ordered.
 */
export function timelineRows(moments: MomentView[], since: string, nextIds: string[]): RowItem[] {
  const from = Date.parse(since)
  const seen = seenMoments(moments)
  const isEdge = (m: MomentView) => Date.parse(m.first ?? '') - from < EDGE_DAYS * DAY_MS
  const out: RowItem[] = []
  const edge = seen.filter(isEdge)
  if (edge.length > 0) out.push({ kind: 'head', text: 'Already doing when your history starts' })
  for (const m of edge) out.push({ kind: 'moment', moment: m, edge: true })
  for (const m of seen.filter((x) => !isEdge(x))) out.push({ kind: 'moment', moment: m, edge: false })
  const nexts = nextIds.map((id) => moments.find((m) => m.id === id)).filter((m): m is MomentView => m !== undefined)
  if (nexts.length > 0) out.push({ kind: 'head', text: 'Next for you' })
  for (const m of nexts) out.push({ kind: 'next', moment: m })
  return out
}

/** The y of each row (its top) and the total height, for a list of rows. */
export function rowsY(rows: RowItem[]): { tops: number[]; height: number } {
  const tops: number[] = []
  let y = 0
  for (const r of rows) {
    tops.push(y)
    y += r.kind === 'head' ? ROWS_HEAD : ROWS_PITCH
  }
  return { tops, height: y }
}

/** The room a row label has to the right of its glyph. */
export const ROW_GLYPH_W = PAD_X + 2 * MARKER_R + LABEL_GAP

/** `text` cut with an ellipsis so that it is at most `max` wide by `measure`. */
export function fitText(text: string, max: number, measure: (t: string) => number): string {
  if (measure(text) <= max) return text
  let n = text.length
  while (n > 1 && measure(`${text.slice(0, n).trimEnd()}…`) > max) n--
  return `${text.slice(0, n).trimEnd()}…`
}

/**
 * The timeline of the rows layout: the same time axis as the floating one, but the left gutter holds the row
 * labels, sized to the longest of them, and nothing floats.
 */
export function layoutRows(
  rows: RowItem[],
  since: string,
  now: string,
  width: number,
  future: boolean,
  measure: (text: string, weight?: number, size?: number) => number,
): TimelineLayout & { rows: RowItem[] } {
  const from = Date.parse(since)
  const to = Math.max(Date.parse(now), from + DAY_MS)
  let widest = 0
  for (const r of rows) if (r.kind !== 'head') widest = Math.max(widest, measure(r.moment.title, 400, ROW_LABEL_SIZE))
  const left = Math.min(GUTTER_MAX, Math.max(GUTTER_MIN, Math.ceil(ROW_GLYPH_W + widest + 16)))
  const right = future ? width - FUTURE_W : width
  return { from, to, width, left, right, markers: [], lanes: 1, edge: [], rows }
}
