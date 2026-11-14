// What the Cost page adds to the scope it shares with the Overview: the migration of its old links.

import type { CostRow } from '../../api/types'
import { formatMoney } from '../../lib/format'
import { dayStart, daysBefore, localDay } from '../../lib/time'
import { type CustomRange, daysBetween } from '../overview/model'

const OLD_KEYS = ['project', 'repocut', 'beadcut']

/**
 * An old Cost address in the Overview's terms: `project=X` is `by=dir&in=X`; `range=90d` is `from` and `to` for
 * the 90 days up to today; `range=all` is `from` the first day with spend (`firstDay`, null while not known:
 * the result is then 'wait') to today; `repocut` and `beadcut` go. A lone `from` is one day. null when the
 * address is already in the new terms.
 */
export function migrateCostSearch(
  search: URLSearchParams,
  today: Date,
  firstDay: string | null,
): URLSearchParams | 'wait' | null {
  const range = search.get('range')
  const old = OLD_KEYS.some((k) => search.has(k)) || range === '90d' || range === 'all'
  const lone = search.has('from') !== search.has('to')
  if (!old && !lone) return null
  const next = new URLSearchParams(search)
  const project = next.get('project')
  if (project && !next.has('in')) {
    next.set('by', 'dir')
    next.set('in', project)
  }
  for (const k of OLD_KEYS) next.delete(k)
  if (lone) {
    const day = next.get('from') ?? next.get('to') ?? ''
    next.set('from', day)
    next.set('to', day)
  }
  if (range === '90d' || range === 'all') {
    if (range === 'all' && !firstDay) return 'wait'
    next.delete('range')
    next.set('from', range === '90d' ? localDay(daysBefore(today, 89)) : (firstDay ?? ''))
    next.set('to', localDay(today))
  }
  return next
}

/** The days just before a window, as many as it has: the period a change is measured against. */
export function previousWindow(w: CustomRange): CustomRange {
  const from = dayStart(w.from)
  const n = daysBetween(from.getTime(), dayStart(w.to).getTime()) + 1
  return { from: localDay(daysBefore(from, n)), to: localDay(daysBefore(from, 1)) }
}

/** The number of days in a window. */
export const windowDays = (w: CustomRange): number =>
  daysBetween(dayStart(w.from).getTime(), dayStart(w.to).getTime()) + 1

/**
 * The change of a total against the period before, as a percentage (the clearer for a headline; the dollars are in
 * the title). null when the period before spent nothing: there is nothing to compare to.
 */
export function changeAgainst(
  cur: number,
  prev: number,
  days: number,
): { pct: number; text: string; title: string; up: boolean } | null {
  if (!(prev > 0)) return null
  const delta = cur - prev
  const pct = (delta / prev) * 100
  const period = days === 1 ? 'the day before' : `the ${days} days before`
  const sign = delta < 0 ? '−' : '+'
  const rounded = Math.round(Math.abs(pct))
  return {
    pct,
    up: delta > 0,
    text: rounded === 0 ? `the same as ${period}` : `${sign}${rounded}% on ${period}`,
    title: `${sign}${formatMoney(Math.abs(delta))} against ${formatMoney(prev)} in ${period}`,
  }
}

const sum = (rows: readonly CostRow[]) => rows.reduce((n, r) => n + r.totalUSD, 0)
const pctOf = (part: number, whole: number) => Math.round((part / whole) * 100)

/** What the price classes say, from the dollars alone: the cache, the output, the uncached input. */
export function classSentence(rows: readonly CostRow[]): string | null {
  const total = sum(rows)
  if (!(total > 0)) return null
  const by = (k: string) => rows.find((r) => r.key === k)?.totalUSD ?? 0
  const w = by('cacheWrite')
  const r = by('cacheRead')
  const o = by('output')
  const i = by('input')
  if (w + r + o + i <= 0) return null
  return `Writing caches cost ${formatMoney(w)} (${pctOf(w, total)}%) and reading them ${formatMoney(r)} (${pctOf(r, total)}%); output is ${pctOf(o, total)}% and uncached input ${pctOf(i, total)}%.`
}

/** What the split between the main thread and the agents says. null when no spend has an agent id. */
export function agentSentence(rows: readonly CostRow[]): string | null {
  const total = sum(rows)
  const a = rows.find((x) => x.key === 'agents')?.totalUSD ?? 0
  if (!(total > 0) || !(a > 0)) return null
  return `Sub-agents spent ${pctOf(a, total)}% of it (${formatMoney(a)}).`
}

/**
 * The smallest number of sessions whose spend makes at least half of the scope's message spend (`usd` of the
 * lanes), and how many sessions there are. null with fewer than 5 sessions, or no spend.
 */
export function concentration(usds: readonly number[]): { n: number; of: number } | null {
  const sorted = [...usds].filter((u) => u > 0).sort((a, b) => b - a)
  const total = sorted.reduce((n, u) => n + u, 0)
  if (sorted.length < 5 || !(total > 0)) return null
  let acc = 0
  for (const [i, u] of sorted.entries()) {
    acc += u
    if (acc * 2 >= total) return { n: i + 1, of: sorted.length }
  }
  return { n: sorted.length, of: sorted.length }
}

/**
 * The cascade of a table's share bars: row i spans from where the row above ended to its own end, as fractions of
 * the total, so reading down the table the segments walk once across the width. A segment is at least `min` wide (a
 * fraction) so a tiny share is still seen; the next one still starts where the true cumulative share does.
 */
export function cascade(values: readonly number[], total: number, min = 0): { from: number; width: number }[] {
  let acc = 0
  return values.map((v) => {
    const from = total > 0 ? acc / total : 0
    const width = total > 0 ? Math.max(v / total, v > 0 ? min : 0) : 0
    acc += v
    return { from: Math.min(from, Math.max(0, 1 - width)), width }
  })
}

/** One extra line under the sidebar's tree. */
export interface ExtraLine {
  id: string
  label: string
  title: string
  count?: number
  usd: number
}

/**
 * What the sidebar's tree leaves out of the total: scripted runs (when nothing is selected: they are out under a
 * selection, as on the Overview) and the reported spend no message explains (the scope's own `(overhead)`). With
 * the tree's rows these add up to the headline total.
 */
export function sidebarExtras(opts: {
  selected: boolean
  scriptedUsd: number
  scriptedRuns: number
  overheadUsd: number
}): ExtraLine[] {
  const out: ExtraLine[] = []
  if (!opts.selected && opts.scriptedUsd > 0)
    out.push({
      id: 'scripted',
      label: 'Scripted runs',
      title: 'Runs started by a script or the SDK: they are in no place, and the Overview lists them beside its total.',
      count: opts.scriptedRuns,
      usd: opts.scriptedUsd,
    })
  if (opts.overheadUsd > 0)
    out.push({
      id: 'overhead',
      label: 'Not in any session',
      title: 'Spend the harness reported that no transcript message explains, so it is in no session’s figure.',
      usd: opts.overheadUsd,
    })
  return out
}

/** The sidebar's figures against the headline total: what the places hold plus the extra lines; the gap is 0. */
export function sidebarGap(total: number, placesUsd: number, extras: readonly ExtraLine[]): number {
  return total - placesUsd - extras.reduce((n, e) => n + e.usd, 0)
}
