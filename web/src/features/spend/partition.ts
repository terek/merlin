// The numbers behind the Spend card's breakdown (Breakdown.tsx): what a range of time spent, in the three
// partitions of the same dollars (by who, by token class, by model tier), and how long a bar of that
// much is. Pure.
//
// A range is summed from the calls of the timeline, the same calls the plot draws its spend from, so
// the widget and the plot agree. Overhead (what the harness reported that no message explains) is in no
// call and so in no partition: it is added to each bar as a tail of its own (`segmentsOf`).

import { modelLabel } from '../../lib/models'
import type { Tier } from '../../lib/tiers'
import { CLASS_SERIES, type ClassKey, KIND_SERIES, type KindKey, type SeriesDef, TIER_SERIES } from './model'
import { type TierSpend, type Timeline, tierSpend } from './timeline'
import type { Overhead } from './tree'

/**
 * How fast a bar's length saturates: its share of the track is log10(1+s) / (log10(1+s) + K).
 * With 1.5, $1 is 17% of the track, $10 42%, $100 57%, $1000 67%.
 */
export const LENGTH_K = 1.5

/** The share of the track (0 to 1) a bar of `usd` dollars takes: logarithmic, and an infinite spend takes all of it. */
export function lengthShare(usd: number): number {
  if (!(usd > 0)) return 0
  if (!Number.isFinite(usd)) return 1
  const l = Math.log10(1 + usd)
  return l / (l + LENGTH_K)
}

/** What a range spent, in the three partitions (each adds up to `usd`). */
export interface RangeSpend {
  usd: number
  kind: Record<KindKey, number>
  class: Record<ClassKey, number>
  tier: Record<Tier, number>
  /** The tiers with their models, for the hover of the tier rows. */
  tiers: TierSpend[]
}

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>

/**
 * What the calls of the timeline from `lo` up to (not including) `hi` spent, as the plot counts it: a
 * call is in the range when its time is. A cache miss is its own part of the split by who and by token
 * class and in the tier of its call in the split by tier. The output of a token class is what is left
 * of the call after the other classes, so that the three partitions add up exactly to the same dollars.
 */
export function sumRange(tl: Timeline, lo = Number.NEGATIVE_INFINITY, hi = Number.POSITIVE_INFINITY): RangeSpend {
  const out: RangeSpend = {
    usd: 0,
    kind: zero(KIND_SERIES.map((s) => s.key)),
    class: zero(CLASS_SERIES.map((s) => s.key)),
    tier: zero(TIER_SERIES.map((s) => s.key)),
    tiers: tierSpend(tl, lo, hi),
  }
  for (const l of tl.lanes)
    for (const c of l.calls) {
      if (!(c.t >= lo && c.t < hi)) continue
      out.usd += c.usd
      out.kind[c.kind] += c.usd - c.reread
      out.kind.reread += c.reread
      out.tier[c.tier] += c.usd
      let rest = c.usd
      for (const k of ['read', 'write', 'reread', 'input'] as const) {
        out.class[k] += c.byClass[k]
        rest -= c.byClass[k]
      }
      out.class.output += rest
    }
  return out
}

/**
 * The overhead of the windows the harness reported that falls in `[lo, hi)`. A window is not known to
 * the time of its calls, so it is apportioned by how much of its stretch is inside the range; one of no
 * length is in when its moment is.
 */
export function overheadIn(
  windows: readonly Overhead[],
  lo = Number.NEGATIVE_INFINITY,
  hi = Number.POSITIVE_INFINITY,
): number {
  let usd = 0
  for (const o of windows) {
    if (o.t1 > o.t0) {
      const inside = Math.min(o.t1, hi) - Math.max(o.t0, lo)
      if (inside > 0) usd += o.usd * Math.min(1, inside / (o.t1 - o.t0))
    } else if (o.t0 >= lo && o.t0 < hi) usd += o.usd
  }
  return usd
}

/** A segment of a bar. */
export interface Segment {
  key: string
  label: string
  /** A CSS colour; none for the hatched tail. */
  color?: string
  usd: number
  /** The overhead tail. */
  hatched?: boolean
  /** The models of a model tier. */
  names?: string[]
}

/** The non-zero parts of one partition in the order of its series, with the overhead (if any) as a hatched tail. */
export function segmentsOf(
  series: readonly SeriesDef[],
  values: Record<string, number>,
  overhead: number,
  tiers?: readonly TierSpend[],
): Segment[] {
  const segs: Segment[] = series
    .filter((s) => (values[s.key] ?? 0) > 0)
    .map((s) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      usd: values[s.key],
      names: tiers
        ? [...new Set((tiers.find((t) => t.tier === s.key)?.models ?? []).map((m) => modelLabel(m.model)))]
        : undefined,
    }))
  return overhead > 0
    ? [...segs, { key: 'overhead', label: 'Not explained by messages', usd: overhead, hatched: true }]
    : segs
}
