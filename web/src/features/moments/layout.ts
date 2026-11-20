// The Moments timeline's arithmetic (docs/moments.md, "The page"): where a marker goes, which lane it
// takes, what the edge stack holds, the soft activity area, the month labels. Pure, so it is tested.

import type { MomentActivityDay, MomentView } from '../../api/types'
import { dayStart, localDay } from '../../lib/time'

/** Moments whose first hit is this close to the start of the history are not placed one by one. */
export const EDGE_DAYS = 7
/** The id the edge stack goes by, as a hover or a pin. */
export const EDGE_ID = '@edge'
/** Centres of two markers in one lane are at least this far apart. */
export const MARKER_GAP = 14
export const PAD_X = 12

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
}

export interface TimelineLayout {
  /** Left end of the time axis, as epoch ms; the right end is `now`. */
  from: number
  to: number
  width: number
  /** Markers placed one by one, with their lanes. */
  markers: Marker[]
  lanes: number
  /** Moments already there when the history starts: one stack at the left edge. */
  edge: MomentView[]
  edgeX: number
}

/** The x of a time, clamped to the axis. */
export function xOf(l: Pick<TimelineLayout, 'from' | 'to' | 'width'>, t: number): number {
  const span = Math.max(1, l.to - l.from)
  const f = Math.min(1, Math.max(0, (t - l.from) / span))
  return PAD_X + f * Math.max(1, l.width - 2 * PAD_X)
}

/**
 * Lays the seen moments out over `width` px. Markers that would sit closer than MARKER_GAP take the first lane
 * (counted from the area upwards) whose last marker is far enough to the left; the edge stack holds lane 0's start.
 */
export function layoutTimeline(moments: MomentView[], since: string, now: string, width: number): TimelineLayout {
  const from = Date.parse(since)
  const to = Math.max(Date.parse(now), from + DAY_MS)
  const l: TimelineLayout = { from, to, width, markers: [], lanes: 1, edge: [], edgeX: PAD_X + 10 }
  const lastX: number[] = []
  for (const m of seenMoments(moments)) {
    const t = Date.parse(m.first ?? '')
    if (t - from < EDGE_DAYS * DAY_MS) {
      l.edge.push(m)
      continue
    }
    const x = xOf(l, t)
    let lane = lastX.findIndex((last) => x - last >= MARKER_GAP)
    if (lane < 0) lane = lastX.push(x) - 1
    else lastX[lane] = x
    l.markers.push({ moment: m, x, lane })
  }
  l.lanes = Math.max(1, lastX.length)
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

/** Hits per day of a moment as tick positions and heights (0..1 of its busiest day). */
export function dayTicks(m: MomentView, l: TimelineLayout): { x: number; h: number; hits: number }[] {
  const days = m.days ?? []
  const max = Math.max(...days.map((d) => d.hits), 1)
  return days.map((d) => ({ x: xOf(l, dayStart(d.day).getTime() + DAY_MS / 2), h: d.hits / max, hits: d.hits }))
}
