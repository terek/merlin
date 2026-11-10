// The geometry of the Spend card's rings (Breakdown.tsx): a partition is a full circle cut into arcs by
// linear share, from 12 o'clock clockwise. Pure, so that it is tested without a DOM.

/** An arc as fractions of the full turn, `from` up to `to`. */
export interface Span {
  from: number
  to: number
}

/** The spans of parts of these sizes, side by side from 0 to 1 (nothing when they add up to nothing). */
export function spansOf(parts: readonly number[]): Span[] {
  const total = parts.reduce((s, x) => s + Math.max(0, x), 0)
  let at = 0
  return parts.map((p) => {
    const from = at
    if (total > 0) at += Math.max(0, p) / total
    return { from, to: total > 0 ? Math.min(1, at) : 0 }
  })
}

const fix = (n: number) => Number(n.toFixed(2))
const TAU = Math.PI * 2

/**
 * The path of a ring's arc: the part of the ring between radii `rIn` and `rOut`, around (cx, cy), from
 * `from` to `to` (fractions of a turn, 0 at 12 o'clock, clockwise). Each end is pulled in by half of `gap`
 * (pixels at the ring's middle) so that neighbours are told apart; a part too short for that keeps a
 * hairline. A whole turn is a full ring (two circles, filled even-odd).
 */
export function arcPath(cx: number, cy: number, rIn: number, rOut: number, span: Span, gap = 0): string {
  if (span.to - span.from >= 0.9999) {
    const c = (r: number) => `M${fix(cx - r)} ${fix(cy)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`
    return c(rOut) + c(rIn)
  }
  const rMid = (rIn + rOut) / 2
  const pull = gap / (TAU * rMid) / 2
  let a = span.from + pull
  let b = span.to - pull
  if (b <= a) {
    const m = (span.from + span.to) / 2
    a = m - 0.0005
    b = m + 0.0005
  }
  const pt = (r: number, f: number) => `${fix(cx + r * Math.sin(f * TAU))} ${fix(cy - r * Math.cos(f * TAU))}`
  const large = b - a > 0.5 ? 1 : 0
  return `M${pt(rOut, a)}A${rOut} ${rOut} 0 ${large} 1 ${pt(rOut, b)}L${pt(rIn, b)}A${rIn} ${rIn} 0 ${large} 0 ${pt(rIn, a)}Z`
}
