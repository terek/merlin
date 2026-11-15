// Pure logic of the Cost page: the window a URL stands for, one bar per day (or week) with the
// empty ones filled in, the models that get a segment, nice axis ticks, and the check that every cut of the
// same range adds up to the same total. No React in here, so all of it is tested.

import type { CompactionTally, CostRow, CostSplitEntry } from '../../api/types'
import {
  COMPACTION_COLD,
  COMPACTION_WARM,
  classColor,
  compareModels,
  depthColor,
  HATCH,
  modelColor,
  OTHER,
  tierColor,
  whoColor,
} from '../../lib/palette'
import { type Prices, TIERS, tierOf } from '../../lib/tiers'
import { daysBefore, localDay } from '../../lib/time'

/** More days than this are drawn by week. */
export const WEEKLY_AFTER_DAYS = 120
export const OVERHEAD = '(overhead)'

/** What one bar stands for: 1, 3 or 6 hours, a day, or a Monday-to-Sunday week. */
export type Grain = 1 | 3 | 6 | 'day' | 'week'

/**
 * The bar width of a window of this many days: up to 2 days 1-hour bars, up to 7 days 3-hour bars, up to 14 days
 * 6-hour bars, up to 120 days days, beyond that weeks. The hours need `by=hour`, which answers at most 14 days.
 */
export function grainFor(days: number): Grain {
  if (days <= 2) return 1
  if (days <= 7) return 3
  if (days <= 14) return 6
  return days > WEEKLY_AFTER_DAYS ? 'week' : 'day'
}

export const isHourly = (g: Grain): g is 1 | 3 | 6 => typeof g === 'number'

const pad2 = (n: number) => String(n).padStart(2, '0')

export interface Window {
  /** First local day; undefined for "all" (from the first day with spend). */
  since?: string
  /** Last local day, included. */
  until: string
  /** A limit window shorter than two days: the chart keeps only its clock hours (`hourSpan`). */
  clock?: { fromMs: number; toMs: number }
}

const hourKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}`
}

/** A window's clock hours as local hour keys, both included: the hour holding `fromMs` to the one holding `toMs - 1`. */
export function hourSpan(fromMs: number, toMs: number): { first: string; last: string } {
  return { first: hourKey(fromMs), last: hourKey(Math.max(fromMs, toMs - 1)) }
}

function dayAt(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(day: string, n: number): string {
  return localDay(daysBefore(dayAt(day), -n))
}

/** Every local day from `since` to `until`, both included. */
export function listDays(since: string, until: string): string[] {
  const out: string[] = []
  if (since > until) return out
  for (let d = since, i = 0; d <= until && i < 20000; d = addDays(d, 1), i++) out.push(d)
  return out
}

/** The Monday of the week of `day`. */
export function weekStart(day: string): string {
  const dow = (dayAt(day).getDay() + 6) % 7
  return addDays(day, -dow)
}

export interface Bucket {
  /** First day of the bucket: the key. */
  key: string
  /** Last day, included (a week is cut at the window). */
  to: string
  weekly: boolean
  /** Hourly bars: the hours one bar stands for. Its `key` is then its first local hour, "2026-11-13T14", and `to` its day. */
  hours?: 1 | 3 | 6
  total: number
  reported: number
  attributed: number
  /** The harness's own per-call figures (Pi); absent when none. */
  recorded?: number
  /** The part of `recorded` the provider billed. */
  billed?: number
  /** Agent runs with no record of their spend in the sessions of the bucket's days: the total is "at least". */
  unrecorded?: number
  /** Spend by model, largest first. */
  parts: CostSplitEntry[]
  /** The compaction calls of the bucket, estimated. */
  compactions?: CompactionTally
}

function emptyBucket(key: string, to: string, weekly: boolean): Bucket {
  return { key, to, weekly, total: 0, reported: 0, attributed: 0, parts: [] }
}

function addParts(into: Map<string, CostSplitEntry>, parts: CostSplitEntry[] | undefined) {
  for (const p of parts ?? []) {
    const cur = into.get(p.key) ?? { key: p.key, totalUSD: 0, reportedUSD: 0, attributedUSD: 0 }
    cur.totalUSD += p.totalUSD
    cur.reportedUSD += p.reportedUSD
    cur.attributedUSD += p.attributedUSD
    if (p.recordedUSD) cur.recordedUSD = (cur.recordedUSD ?? 0) + p.recordedUSD
    if (p.billedUSD) cur.billedUSD = (cur.billedUSD ?? 0) + p.billedUSD
    into.set(p.key, cur)
  }
}

function addTally(a: CompactionTally | undefined, b: CompactionTally): CompactionTally {
  if (!a) return { ...b }
  return {
    calls: a.calls + b.calls,
    cold: a.cold + b.cold,
    usd: a.usd + b.usd,
    warmUSD: a.warmUSD + b.warmUSD,
    uncoveredUSD: a.uncoveredUSD + b.uncoveredUSD,
  }
}

const bySize = (a: CostSplitEntry, b: CostSplitEntry) => b.totalUSD - a.totalUSD || (a.key < b.key ? -1 : 1)

/** Whether a window of this many days is drawn by week: only when long. */
export function isWeekly(days: number): boolean {
  return days > WEEKLY_AFTER_DAYS
}

/**
 * One bucket per local day of [since, until] (per Monday-to-Sunday week when `weekly`), including
 * those with no spend. `since` defaults to the first day with spend. Rows outside the window are
 * ignored. A `by=day&split=model` response is the input; without `split` the parts are empty.
 */
export function makeBuckets(rows: CostRow[], window: Window, weekly: boolean): Bucket[] {
  const first = window.since ?? rows.map((r) => r.key).sort()[0]
  if (!first) return []
  const days = listDays(first, window.until)
  const byDay = new Map(rows.map((r) => [r.key, r]))
  const buckets = new Map<string, { b: Bucket; parts: Map<string, CostSplitEntry> }>()
  for (const day of days) {
    const key = weekly ? weekStart(day) : day
    let e = buckets.get(key)
    if (!e) {
      e = { b: emptyBucket(day, day, weekly), parts: new Map() }
      buckets.set(key, e)
    }
    e.b.to = day
    const row = byDay.get(day)
    if (row) addRow(e.b, e.parts, row)
  }
  return [...buckets.values()].map(({ b, parts }) => ({ ...b, parts: [...parts.values()].sort(bySize) }))
}

/** The local day an hour key, a day or a week's key falls on. */
export const bucketDay = (b: Bucket): string => b.key.slice(0, 10)

function addRow(b: Bucket, parts: Map<string, CostSplitEntry>, row: CostRow) {
  b.total += row.totalUSD
  b.reported += row.reportedUSD
  b.attributed += row.attributedUSD
  if (row.recordedUSD) b.recorded = (b.recorded ?? 0) + row.recordedUSD
  if (row.billedUSD) b.billed = (b.billed ?? 0) + row.billedUSD
  if (row.unrecordedAgents) b.unrecorded = (b.unrecorded ?? 0) + row.unrecordedAgents
  if (row.compactions) b.compactions = addTally(b.compactions, row.compactions)
  addParts(parts, row.split)
}

/**
 * One bucket per `hours` local hours of every day of [since, until], empty ones included, from a `by=hour` response
 * (keys "2026-11-13T14"). The buckets are aligned to the clock (0, 3, 6, ...), so a day's buckets are the same on a
 * 23- or 25-hour day: the hour that does not exist is an empty bar, the repeated one one row.
 */
export function makeHourBuckets(rows: CostRow[], window: Window, hours: 1 | 3 | 6): Bucket[] {
  const first = window.since ?? rows.map((r) => r.key.slice(0, 10)).sort()[0]
  if (!first) return []
  const out = new Map<string, { b: Bucket; parts: Map<string, CostSplitEntry> }>()
  for (const day of listDays(first, window.until))
    for (let h = 0; h < 24; h += hours) {
      const key = `${day}T${pad2(h)}`
      out.set(key, { b: { ...emptyBucket(key, day, false), hours }, parts: new Map() })
    }
  for (const row of rows) {
    const hour = Number(row.key.slice(11, 13))
    const e = out.get(`${row.key.slice(0, 10)}T${pad2(hour - (hour % hours))}`)
    if (e && Number.isFinite(hour)) addRow(e.b, e.parts, row)
  }
  const span = window.clock && hourSpan(window.clock.fromMs, window.clock.toMs)
  return [...out.values()]
    .filter(({ b }) => {
      if (!span) return true
      const last = `${b.key.slice(0, 11)}${pad2(Number(b.key.slice(11, 13)) + hours - 1)}`
      return last >= span.first && b.key <= span.last
    })
    .map(({ b, parts }) => ({ ...b, parts: [...parts.values()].sort(bySize) }))
}

/** The models that get a segment of their own: the eight with the most spend over the buckets, (overhead) apart. */
export function topModels(buckets: Bucket[], n = 8): string[] {
  const sum = new Map<string, number>()
  for (const b of buckets)
    for (const p of b.parts) if (p.key !== OVERHEAD) sum.set(p.key, (sum.get(p.key) ?? 0) + p.totalUSD)
  return [...sum.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([k]) => k)
    .sort(compareModels)
}

export interface Segment {
  key: string
  /** A CSS colour from `lib/palette.ts`, or `HATCH` for (overhead). */
  color: string
  usd: number
}

/** The price classes in stack order (bottom first). Their colours are `classColor`'s. */
export const CLASS_STACK: string[] = ['cacheRead', 'cacheWrite', 'output', 'input', '(unsplit)']

/**
 * By model, by who (main thread or agents), by price class, by model tier, or the estimated compaction calls on
 * their own. The URL's `stack` is the same word.
 */
export type Stack = 'model' | 'who' | 'class' | 'tier' | 'depth' | 'compaction'

export function parseStack(s: string | null): Stack {
  return s === 'compaction' || s === 'class' || s === 'who' || s === 'tier' || s === 'depth' ? s : 'model'
}

/** The `split` a stack's bars are read from: tiers and models both come from the models. */
export function splitOf(stack: Stack): 'model' | 'class' | 'agent' | 'depth' {
  return stack === 'class' ? 'class' : stack === 'who' ? 'agent' : stack === 'depth' ? 'depth' : 'model'
}

/** The context bands of `split=depth`, shallow first (the bottom of a stack). */
export const DEPTH_STACK: string[] = ['0-100k', '100k-200k', '200k-500k', '500k+']

/** How a band is written: `<100k`, `100–200k`, `200–500k`, `500k+`. */
export const depthLabel = (key: string): string =>
  key === '0-100k' ? '<100k' : key.replace(/^(\d+)k-(\d+k)$/, '$1–$2')

/** Main thread first (bottom), then the agents, then what no message explains. */
export const WHO_STACK: string[] = ['main', 'agents', '(unsplit)']

/**
 * The height of a bar: the day's spend, whatever the stack. The compaction stack keeps the axis and the bars of
 * the others: it only colours the part of the day that compactions cost.
 */
export function barTotal(b: Bucket): number {
  return b.total
}

/**
 * The stack of one bar, bottom first. By model: the top models, heavy to light (`compareModels`), "other" (every
 * other model) and (overhead) on top. By class: cache reads, cache writes, output, input. The segments add up
 * to the bucket's total. By compaction (drawn inside the day's full bar): the warm-cache cost of the calls, then the extra the cold
 * ones cost; they add up to the estimate.
 */
export function stackOf(b: Bucket, stack: Stack, top: string[], prices?: Prices): Segment[] {
  if (stack === 'compaction') {
    // what the calls would have cost with a warm cache, then what the cold ones cost on top
    const c = b.compactions
    if (!c) return []
    return [
      { key: 'compaction-warm', color: COMPACTION_WARM, usd: c.warmUSD },
      { key: 'compaction-cold', color: COMPACTION_COLD, usd: Math.max(0, c.usd - c.warmUSD) },
    ].filter((s) => s.usd > 0)
  }
  if (stack === 'class') {
    // the price classes, bottom first; the parts of a `by=day&split=class` response
    const usd = new Map(b.parts.map((p) => [p.key, p.totalUSD]))
    return CLASS_STACK.map((key) => ({ key, color: classColor(key), usd: usd.get(key) ?? 0 })).filter((s) => s.usd > 0)
  }
  if (stack === 'who') {
    const usd = new Map(b.parts.map((p) => [p.key, p.totalUSD]))
    return WHO_STACK.map((key) => ({ key, color: whoColor(key), usd: usd.get(key) ?? 0 })).filter((s) => s.usd > 0)
  }
  if (stack === 'depth') {
    // shallow at the bottom, the deepest on top; the reported spend no call explains stays the hatch
    const usd = new Map(b.parts.map((p) => [p.key, p.totalUSD]))
    return [...DEPTH_STACK, OVERHEAD]
      .map((key) => ({ key, color: key === OVERHEAD ? HATCH : depthColor(key), usd: usd.get(key) ?? 0 }))
      .filter((s) => s.usd > 0)
  }
  if (stack === 'tier') {
    // heavy at the bottom; the reported spend no model explains stays the hatch, as in the model stack
    const usd = new Map<string, number>()
    for (const p of b.parts) {
      const k = p.key === OVERHEAD ? OVERHEAD : tierOf(p.key, prices)
      usd.set(k, (usd.get(k) ?? 0) + p.totalUSD)
    }
    return [...TIERS, OVERHEAD]
      .map((key) => ({ key, color: key === OVERHEAD ? HATCH : tierColor(key), usd: usd.get(key) ?? 0 }))
      .filter((s) => s.usd > 0)
  }
  let other = 0
  let overhead = 0
  const named = new Map<string, number>()
  for (const p of b.parts) {
    if (p.key === OVERHEAD) overhead += p.totalUSD
    else if (top.includes(p.key)) named.set(p.key, p.totalUSD)
    else other += p.totalUSD
  }
  const out: Segment[] = top
    .filter((k) => named.has(k))
    .map((k) => ({ key: k, color: modelColor(k), usd: named.get(k) ?? 0 }))
  if (other > 0) out.push({ key: 'other', color: OTHER, usd: other })
  if (overhead > 0) out.push({ key: OVERHEAD, color: HATCH, usd: overhead })
  return out.filter((s) => s.usd > 0)
}

/** Axis ticks from 0 up to a round number at or above `max`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(max: number, target = 4): { ticks: number[]; top: number } {
  if (!(max > 0)) return { ticks: [0, 1], top: 1 }
  const raw = max / target
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow
  const n = Math.ceil(max / step - 1e-9)
  const ticks: number[] = []
  for (let i = 0; i <= n; i++) ticks.push(Math.round(i * step * 1e9) / 1e9)
  return { ticks, top: ticks[ticks.length - 1] }
}

/** An axis label: "$0", "$20", "$1,200", "$2.50". */
export function tickLabel(v: number): string {
  if (v === 0) return '$0'
  if (v >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`
}

/** Index step between x labels so that they are at least `minPx` apart. */
export function labelEvery(bars: number, width: number, minPx = 64): number {
  if (bars <= 0) return 1
  return Math.max(1, Math.ceil(minPx / (width / bars)))
}

/**
 * Index step between x labels for hourly bars: as `labelEvery`, but one that divides a day's bars, so a label always
 * falls on midnight, where the day's name is.
 */
export function hourLabelEvery(bars: number, width: number, hours: 1 | 3 | 6, minPx = 64): number {
  const perDay = 24 / hours
  const want = labelEvery(bars, width, minPx)
  for (let n = want; n < perDay; n++) if (perDay % n === 0) return n
  return perDay
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Fri 13": a day as the Overview's timeline writes it. */
export function dayName(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${DOW[new Date(y, m - 1, d).getDay()]} ${d}`
}

/** The label under an hourly bar: "14:00", and at midnight the day's name ("Fri 13"). */
export function hourTick(b: Bucket): string {
  const h = Number(b.key.slice(11, 13))
  return h === 0 ? dayName(bucketDay(b)) : `${pad2(h)}:00`
}

/** "Fri 13, 14:00–17:00" (the last bar of a day ends at 24:00). */
export function hourTitle(b: Bucket): string {
  const h = Number(b.key.slice(11, 13))
  return `${dayName(bucketDay(b))}, ${pad2(h)}:00–${pad2(h + (b.hours ?? 1))}:00`
}

export function sumRows(rows: { totalUSD: number }[]): number {
  let s = 0
  for (const r of rows) s += r.totalUSD
  return s
}

export interface Cut {
  name: string
  total: number
  /** The rows were cut to a limit: the rows need not add up to the total. */
  truncated?: boolean
  rows?: { totalUSD: number }[]
}

/**
 * Every cut of one range must show the same total (they are different cuts of the same sum). Returns
 * a sentence for each cut that is off by more than a tenth of a cent, or whose rows do not add up
 * to its own total; empty when everything agrees. The first cut is the reference.
 */
export function disagreements(cuts: Cut[], eps = 1e-6): string[] {
  const out: string[] = []
  const ref = cuts[0]
  if (!ref) return out
  for (const c of cuts) {
    if (Math.abs(c.total - ref.total) > eps)
      out.push(`${c.name} total ${c.total} differs from ${ref.name} ${ref.total}`)
    if (c.rows && !c.truncated) {
      const s = sumRows(c.rows)
      if (Math.abs(s - c.total) > eps) out.push(`${c.name} rows add up to ${s}, not ${c.total}`)
    }
  }
  return out
}

/** The buckets of a `by=hour` (up to 14 days) or `by=day` response, with the split, for a window: see `grainFor`. */
export function bucketsFor(rows: CostRow[], window: Window): Bucket[] {
  const first = window.since ?? rows.map((r) => r.key).sort()[0]
  if (!first) return []
  const days = listDays(first, window.until).length
  const grain = grainFor(days)
  // the rows are by hour for the hourly grains (`by=hour`) and by day otherwise
  return isHourly(grain) ? makeHourBuckets(rows, window, grain) : makeBuckets(rows, window, grain === 'week')
}
