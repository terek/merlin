// The numbers behind the context chart: points, scales, segments, compaction positions, cursor
// movement. Pure and tested; ContextChart.tsx only draws them.

import type { Compaction, Turn } from '../../api/types'
import { firstLine } from '../../lib/paths'

export interface Point {
  /** The turn's index (the x value). */
  index: number
  tokens: number
  abandoned: boolean
  /** First line of the prompt, for the readout. */
  prompt: string
}

/** One point per turn that has a context size; a turn without one is skipped, never drawn as zero. */
export function contextPoints(turns: readonly Turn[] | undefined): Point[] {
  const out: Point[] = []
  for (const t of turns ?? []) {
    const v = t.contextTokens
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    out.push({ index: t.index, tokens: v, abandoned: !!t.abandoned, prompt: firstLine(t.userText ?? '') })
  }
  return out
}

/** Round ticks from 0 up to at least `max`, about `count` of them: 0, 50k, 100k, 150k, 200k. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const pow = 10 ** Math.floor(Math.log10(raw))
  const f = raw / pow
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow
  const ticks: number[] = []
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

export interface Linear {
  (v: number): number
  invert: (px: number) => number
}

/** A linear scale from the domain to the range; a flat domain maps to the middle of the range. */
export function linear(d0: number, d1: number, r0: number, r1: number): Linear {
  const span = d1 - d0
  const f = ((v: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0))) as Linear
  f.invert = (px: number) => (r1 === r0 ? d0 : d0 + ((px - r0) / (r1 - r0)) * span)
  return f
}

export interface Segment {
  abandoned: boolean
  points: Point[]
}

/**
 * Runs of points of one kind (kept or abandoned). Each run after the first starts with the last
 * point of the one before, so that the drawn line is continuous.
 */
export function segments(points: readonly Point[]): Segment[] {
  const out: Segment[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && last.abandoned === p.abandoned) {
      last.points.push(p)
    } else {
      const prev = last?.points[last.points.length - 1]
      out.push({ abandoned: p.abandoned, points: prev ? [prev, p] : [p] })
    }
  }
  return out
}

export interface Mark {
  /** Position on the turn axis: between the last turn before the compaction and the next. */
  at: number
  turn: number
  pre?: number
  post?: number
  trigger?: string
}

/** Compactions placed between turn c and c + 1, clamped to the drawn range [lo, hi]. */
export function compactionMarks(compactions: readonly Compaction[] | undefined, lo: number, hi: number): Mark[] {
  const marks: Mark[] = []
  for (const c of compactions ?? []) {
    const at = Math.min(hi, Math.max(lo, c.turn + 0.5))
    marks.push({ at, turn: c.turn, pre: c.preTokens, post: c.postTokens, trigger: c.trigger })
  }
  return marks.sort((a, b) => a.at - b.at)
}

/** The mark nearest to the turn `index` (the earlier one on a tie); undefined for no marks. */
export function nearestMark(marks: readonly Mark[], index: number): Mark | undefined {
  let best: Mark | undefined
  for (const m of marks) if (!best || Math.abs(m.at - index) < Math.abs(best.at - index)) best = m
  return best
}

/** Which of the (sorted) x positions get a label: each at least `gap` px after the previous labelled one. */
export function spacedLabels(xs: readonly number[], gap: number): boolean[] {
  let last = Number.NEGATIVE_INFINITY
  return xs.map((x) => {
    if (x - last < gap) return false
    last = x
    return true
  })
}

/** The point whose turn index is nearest to `index`; undefined for no points. */
export function nearestPoint(points: readonly Point[], index: number): Point | undefined {
  if (points.length === 0) return undefined
  let lo = 0
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].index < index) lo = mid + 1
    else hi = mid
  }
  const a = points[lo]
  const b = points[lo - 1]
  return b && index - b.index <= a.index - index ? b : a
}

/** Moves a cursor (a turn index, or null) by `steps` points, clamped; from null it lands on the last point. */
export function stepCursor(points: readonly Point[], cursor: number | null, steps: number): Point | undefined {
  if (points.length === 0) return undefined
  const here = cursor === null ? undefined : nearestPoint(points, cursor)
  if (!here) return points[points.length - 1]
  const i = points.indexOf(here) + steps
  return points[Math.min(points.length - 1, Math.max(0, i))]
}
