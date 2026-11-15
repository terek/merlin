import { dayStart, midnightsBetween } from './timeline'

export interface MappingAxis {
  lo: number
  hi: number
  x: (t: number) => number
}

export interface TimeBoundary {
  t: number
  source: number
  target: number
}

/** Calendar boundaries shared by two axes, spaced at both ends of the connection. Never clamp time. */
export function timeBoundaries(source: MappingAxis, target: MappingAxis, separation = 24): TimeBoundary[] {
  const lo = Math.max(source.lo, target.lo)
  const hi = Math.min(source.hi, target.hi)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return []
  const duration = hi - lo
  const candidates: number[] = []
  if (duration >= 2 * 86_400_000) {
    if (dayStart(lo) === lo) candidates.push(lo)
    candidates.push(...midnightsBetween(lo, hi))
  } else {
    const minute = 60_000
    const step = duration >= 2 * 60 * minute ? 60 : duration >= 30 * minute ? 15 : duration >= 10 * minute ? 5 : 1
    // Start on a local clock boundary, then advance in elapsed time: repeated DST hours remain distinct.
    const d = new Date(lo)
    d.setSeconds(0, 0)
    d.setMinutes(Math.floor(d.getMinutes() / step) * step)
    for (let t = d.getTime(); t <= hi; t += step * minute) if (t >= lo) candidates.push(t)
  }
  // A sub-minute session can have no clock boundary; its real endpoints still describe the mapping.
  if (candidates.length < 2) candidates.push(lo, hi)
  const out: TimeBoundary[] = []
  for (const t of [...new Set(candidates)].sort((a, b) => a - b)) {
    const a = source.x(t)
    const b = target.x(t)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    const prev = out.at(-1)
    if (prev && (a - prev.source < separation || b - prev.target < separation)) continue
    out.push({ t, source: a, target: b })
  }
  // A wide range can otherwise turn into a fence. Preserve an even selection of the already spaced marks.
  if (out.length <= 8) return out
  return Array.from({ length: 8 }, (_, i) => out[Math.round((i * (out.length - 1)) / 7)])
}
