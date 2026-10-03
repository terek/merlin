// Pure logic of the Cost page: the window a URL stands for, one bar per day (or week) with the
// empty ones filled in, the top five models, nice axis ticks, and the check that every cut of the
// same range adds up to the same total. No React in here, so all of it is tested.

import type { CompactionTally, CostRow, CostSplitEntry } from '../../api/types'
import { daysBefore, localDay } from '../../lib/time'

export type Range = '7d' | '30d' | '90d' | 'all'
export const RANGES: Range[] = ['7d', '30d', '90d', 'all']
export const DEFAULT_RANGE: Range = '7d'
/** With range "all", more days than this are bucketed by week. */
export const WEEKLY_AFTER_DAYS = 120
export const OVERHEAD = '(overhead)'

export function parseRange(s: string | null): Range {
  return RANGES.includes(s as Range) ? (s as Range) : DEFAULT_RANGE
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** A valid "2026-09-16", else undefined. */
export function parseDay(s: string | null | undefined): string | undefined {
  if (!s || !DAY.test(s)) return undefined
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(y, m - 1, d)
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d ? s : undefined
}

export interface Window {
  /** First local day; undefined for "all" (from the first day with spend). */
  since?: string
  /** Last local day, included. */
  until: string
}

/** The window of a range: the last N local days, today included. */
export function rangeWindow(range: Range, now: Date = new Date()): Window {
  const days = { '7d': 7, '30d': 30, '90d': 90, all: 0 }[range]
  return { since: days ? localDay(daysBefore(now, days - 1)) : undefined, until: localDay(now) }
}

/** The window a selected bar narrows the page to, if any (`from` and `to` are in the URL). */
export function selectedWindow(from: string | undefined, to: string | undefined): Window | undefined {
  if (!from) return undefined
  const end = to && to >= from ? to : from
  return { since: from, until: end }
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
  total: number
  reported: number
  attributed: number
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

/** Whether a window of this many days is drawn by week: only for "all", and only when long. */
export function isWeekly(range: Range, days: number): boolean {
  return range === 'all' && days > WEEKLY_AFTER_DAYS
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
    if (!row) continue
    e.b.total += row.totalUSD
    e.b.reported += row.reportedUSD
    e.b.attributed += row.attributedUSD
    if (row.compactions) e.b.compactions = addTally(e.b.compactions, row.compactions)
    addParts(e.parts, row.split)
  }
  return [...buckets.values()].map(({ b, parts }) => ({ ...b, parts: [...parts.values()].sort(bySize) }))
}

/** The models that get a colour: the five with the most spend over the buckets, (overhead) apart. */
export function topModels(buckets: Bucket[], n = 5): string[] {
  const sum = new Map<string, number>()
  for (const b of buckets)
    for (const p of b.parts) if (p.key !== OVERHEAD) sum.set(p.key, (sum.get(p.key) ?? 0) + p.totalUSD)
  return [...sum.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([k]) => k)
}

export type Tone =
  | 'series-1'
  | 'series-2'
  | 'series-3'
  | 'series-4'
  | 'series-5'
  | 'series-other'
  | 'overhead'
  | 'reported'
  | 'attributed'
  | 'faint'
  | 'bad'

export interface Segment {
  key: string
  tone: Tone
  usd: number
}

const SERIES: Tone[] = ['series-1', 'series-2', 'series-3', 'series-4', 'series-5']

/** By model, by source (reported or attributed), or the estimated compaction calls on their own. */
export type Stack = 'model' | 'source' | 'compaction'

export function parseStack(s: string | null): Stack {
  return s === 'source' || s === 'compaction' ? s : 'model'
}

/**
 * The height of a bar: its spend, or for the compaction stack what its compaction calls cost. That
 * estimate is not part of the spend (format notes §6a), so it gets a chart of its own.
 */
export function barTotal(b: Bucket, stack: Stack): number {
  return stack === 'compaction' ? (b.compactions?.usd ?? 0) : b.total
}

/** The colour of a model in the legend and the bars. */
export function modelTone(key: string, top: string[]): Tone {
  if (key === OVERHEAD) return 'overhead'
  const i = top.indexOf(key)
  return i >= 0 ? SERIES[i] : 'series-other'
}

/**
 * The stack of one bar, bottom first. By model: the top models in rank order, "other" (every
 * other model) and (overhead) on top. By source: reported, then attributed. The segments add up
 * to the bucket's total. By compaction: the warm-cache cost of the calls, then the extra the cold
 * ones cost; they add up to the estimate.
 */
export function stackOf(b: Bucket, stack: Stack, top: string[]): Segment[] {
  if (stack === 'compaction') {
    // what the calls would have cost with a warm cache, then what the cold ones cost on top
    const c = b.compactions
    if (!c) return []
    return [
      { key: 'compaction-warm', tone: 'faint' as const, usd: c.warmUSD },
      { key: 'compaction-cold', tone: 'bad' as const, usd: Math.max(0, c.usd - c.warmUSD) },
    ].filter((s) => s.usd > 0)
  }
  if (stack === 'source') {
    return [
      { key: 'reported', tone: 'reported' as const, usd: b.reported },
      { key: 'attributed', tone: 'attributed' as const, usd: b.attributed },
    ].filter((s) => s.usd > 0)
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
    .map((k) => ({ key: k, tone: modelTone(k, top), usd: named.get(k) ?? 0 }))
  if (other > 0) out.push({ key: 'other', tone: 'series-other', usd: other })
  if (overhead > 0) out.push({ key: OVERHEAD, tone: 'overhead', usd: overhead })
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

/** The buckets of a `by=day&split=model` response for a range: by week when "all" spans > 120 days. */
export function bucketsFor(rows: CostRow[], window: Window, range: Range): Bucket[] {
  const first = window.since ?? rows.map((r) => r.key).sort()[0]
  if (!first) return []
  return makeBuckets(rows, window, isWeekly(range, listDays(first, window.until).length))
}

/** "Last 7 days", "All time", "Wed 16 Sep": what the headline says the figures cover. */
export function windowCaption(range: Range, sel: Window | undefined, label: (day: string) => string): string {
  if (sel) return sel.since === sel.until ? label(sel.since ?? '') : `${label(sel.since ?? '')} – ${label(sel.until)}`
  return { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', all: 'All time' }[range]
}
