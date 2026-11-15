// The one mark of a limit lockout: a light red fill (--bad-soft) with thin diagonal red stripes. Every surface that
// shows a lockout (the Overview's rows and axis, the session graph and its break veil, the legends) uses it, so it
// reads the same everywhere. The stripes lean the other way and sit wider than the grey 45° hatches of overhead and
// "not in messages", so the two are never mistaken for one another.
import { useId } from 'react'

/** The distance between two stripes (px). */
export const LOCK_PITCH = 6
const STRIPE_W = 1
const STRIPE_OPACITY = 0.45

/** A pattern id for one svg, safe in `url(#…)`. */
export function useLockoutId(): string {
  return `lock${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
}

/** The pattern, for the `<defs>` of an svg: fill with `url(#id)`. */
export function LockoutPattern({ id }: { id: string }) {
  return (
    <pattern
      id={id}
      width={LOCK_PITCH}
      height={LOCK_PITCH}
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(-45)"
    >
      <rect width={LOCK_PITCH} height={LOCK_PITCH} fill="var(--bad-soft)" />
      <line
        x1={0}
        y1={0}
        x2={0}
        y2={LOCK_PITCH}
        stroke="var(--bad)"
        strokeWidth={STRIPE_W}
        strokeOpacity={STRIPE_OPACITY}
      />
    </pattern>
  )
}

/** A small striped sample for a legend (an svg of its own). */
export function LockoutSwatch({ width = 28, height = 16 }: { width?: number; height?: number }) {
  const id = useLockoutId()
  return (
    <svg width={width} height={height} className="shrink-0" role="img" aria-label="Locked out by a limit">
      <defs>
        <LockoutPattern id={id} />
      </defs>
      <rect x={0.5} y={0.5} width={width - 1} height={height - 1} rx={2} fill={`url(#${id})`} />
    </svg>
  )
}
