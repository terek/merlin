// The Moments timeline's arithmetic (docs/moments.md, "The page"): the time axis, one row per moment, the intensity
// strip, the month labels and the squares of a row's activity. Pure, so it is tested.

import type { MomentActivityDay, MomentDay, MomentHit, MomentView } from '../../api/types'
import { dayStart, localDay } from '../../lib/time'

/** The edge of the plot, left and right. */
export const PAD_X = 12
/** The room a state glyph takes in the label column: its radius, and the space before the label. */
export const GLYPH_R = 4.5
export const LABEL_GAP = 5
export const LABEL_SIZE = 12
const CHAR_W = 6.3

/** The width of a label at LABEL_SIZE, estimated from its length (the fallback when there is no canvas). */
export function labelWidth(text: string): number {
  return Math.ceil(text.length * CHAR_W)
}

const DAY_MS = 86_400_000

/** A moment that was seen at least once and says where. */
export function isSeen(m: MomentView): boolean {
  return m.status !== 'unseen' && !!m.first
}

/** The seen moments by first hit, then title: the order of the rows. */
export function seenMoments(moments: MomentView[]): MomentView[] {
  return moments
    .filter(isSeen)
    .sort((a, b) => Date.parse(a.first ?? '') - Date.parse(b.first ?? '') || a.title.localeCompare(b.title))
}

/** A suggestion as the page shows it. */
export interface SuggestionLike {
  moment: string
}

/**
 * One row per moment: a suggestion for a seen moment adds no row (the seen row carries it, as "try again"); only
 * suggestions for unseen moments become rows after the seen ones.
 */
export function placeSuggestions<S extends SuggestionLike>(
  moments: MomentView[],
  suggestions: S[],
): { again: Map<string, S>; rows: { s: S; m: MomentView }[] } {
  const byId = new Map(moments.map((m) => [m.id, m]))
  const again = new Map<string, S>()
  const rows: { s: S; m: MomentView }[] = []
  for (const s of suggestions) {
    const m = byId.get(s.moment)
    if (!m) continue
    if (isSeen(m)) again.set(m.id, s)
    else rows.push({ s, m })
  }
  return { again, rows }
}

/** The axis never covers more than a year: its start is the first session, or a year before `now` if that is later. */
export const MAX_DAYS = 365

/** The start of the plot as an ISO time: `since`, but no earlier than MAX_DAYS before `now`. */
export function plotStart(since: string, now: string): string {
  return new Date(Math.max(Date.parse(since), Date.parse(now) - MAX_DAYS * DAY_MS)).toISOString()
}

export interface TimelineLayout {
  /** Left end of the time axis, as epoch ms; the right end is `now`. */
  from: number
  to: number
  width: number
  /** The plot's left and right edges in px: the table's columns are left of it. */
  left: number
  right: number
  /** The table's columns, in px from the left edge: the title starts at ROW_GLYPH_W. */
  cols: { category: number; countRight: number }
  /** One row per seen moment. */
  rows: MomentView[]
}

/** The x of a time, clamped to the axis. */
export function xOf(l: Pick<TimelineLayout, 'from' | 'to' | 'left' | 'right'>, t: number): number {
  const span = Math.max(1, l.to - l.from)
  const f = Math.min(1, Math.max(0, (t - l.from) / span))
  return l.left + PAD_X + f * Math.max(1, l.right - l.left - 2 * PAD_X)
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
    if (idx < 0) continue // before the plot starts
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

/** The text size of a row label: the page's body size. */
export const ROW_LABEL_SIZE = 13
/** The height of a moment's row. */
export const ROWS_PITCH = 20
/** The title column never gets narrower or wider than this. */
export const TITLE_MIN = 120
export const TITLE_MAX = 240
/** The width of the category and count columns, and the room the "try again" tag needs. */
export const CATEGORY_W = 88
export const COUNT_W = 40
export const TAG_W = 62

/** Where a row's label starts, from the left edge. */
export const ROW_GLYPH_W = PAD_X + 2 * GLYPH_R + LABEL_GAP

/** `text` cut with an ellipsis so that it is at most `max` wide by `measure`. */
export function fitText(text: string, max: number, measure: (t: string) => number): string {
  if (measure(text) <= max) return text
  let n = text.length
  while (n > 1 && measure(`${text.slice(0, n).trimEnd()}…`) > max) n--
  return `${text.slice(0, n).trimEnd()}…`
}

/**
 * The timeline: one row per seen moment, ordered by first hit, with the label column sized to the longest label.
 * The plot runs from the first session to `now`.
 */
export function layoutRows(
  moments: MomentView[],
  since: string,
  now: string,
  width: number,
  measure: (text: string, weight?: number, size?: number) => number = (t) => labelWidth(t),
  /** Whether any row carries the "try again" tag. */
  tagged = false,
): TimelineLayout {
  const from = Date.parse(plotStart(since, now))
  const to = Math.max(Date.parse(now), from + DAY_MS)
  const rows = seenMoments(moments)
  let widest = 0
  for (const m of rows) widest = Math.max(widest, measure(m.title, 400, ROW_LABEL_SIZE))
  const title = Math.min(TITLE_MAX, Math.max(TITLE_MIN, Math.ceil(widest + (tagged ? TAG_W : 0) + 8)))
  const category = ROW_GLYPH_W + title
  const countRight = category + CATEGORY_W + COUNT_W
  return { from, to, width, left: countRight + 12, right: width, cols: { category, countRight }, rows }
}

/** What the table can be sorted by. */
export type SortKey = 'moment' | 'category' | 'count' | 'start' | 'end'
export interface Sort {
  key: SortKey
  dir: 'asc' | 'desc'
}
export const DEFAULT_SORT: Sort = { key: 'start', dir: 'asc' }
const KEYS: SortKey[] = ['moment', 'category', 'count', 'start', 'end']

/** The direction a column starts with when it is first picked. */
export function firstDir(key: SortKey): 'asc' | 'desc' {
  return key === 'count' || key === 'end' ? 'desc' : 'asc'
}

/** `?sort=` as a Sort: "count", "-count"; anything else is the default. */
export function parseSort(s: string | null): Sort {
  if (!s) return DEFAULT_SORT
  const desc = s.startsWith('-')
  const key = (desc ? s.slice(1) : s) as SortKey
  return KEYS.includes(key) ? { key, dir: desc ? 'desc' : 'asc' } : DEFAULT_SORT
}

/** The `?sort=` value of a Sort; null for the default, so that the parameter is dropped. */
export function formatSort(s: Sort): string | null {
  if (s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir) return null
  return (s.dir === 'desc' ? '-' : '') + s.key
}

/** The sort a click on a header gives: the same column flips, another starts in its natural direction. */
export function clickSort(cur: Sort, key: SortKey): Sort {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: firstDir(key) }
}

const time = (s: string | undefined) => Date.parse(s ?? '') || 0

/** The moments in the order of a Sort; ties fall back to the start, then the title. Does not change its input. */
export function sortMoments(moments: MomentView[], sort: Sort): MomentView[] {
  const by = (m: MomentView): number | string => {
    switch (sort.key) {
      case 'moment':
        return m.title.toLowerCase()
      case 'category':
        return m.category ?? ''
      case 'count':
        return m.hits
      case 'end':
        return time(m.last)
      default:
        return time(m.first)
    }
  }
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...moments].sort((a, b) => {
    const x = by(a)
    const y = by(b)
    const c = x < y ? -1 : x > y ? 1 : 0
    return sign * c || time(a.first) - time(b.first) || a.title.localeCompare(b.title)
  })
}
