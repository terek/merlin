import { useHarness } from '../api/harnesses'
import { cn } from '../lib/cn'

/** Eight rays from the centre of a 16 x 16 box: a sparkle. */
const RAYS = [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
  const a = (deg * Math.PI) / 180
  const long = deg % 90 === 0
  const r0 = 2
  const r1 = long ? 7 : 5.4
  const f = (n: number) => Math.round(n * 100) / 100
  return `M${f(8 + r0 * Math.cos(a))},${f(8 + r0 * Math.sin(a))}L${f(8 + r1 * Math.cos(a))},${f(8 + r1 * Math.sin(a))}`
})

function Mark({ harness }: { harness: string }) {
  switch (harness) {
    case 'claude':
      return (
        <path d={RAYS.join('')} fill="none" stroke="var(--harness-claude)" strokeWidth={1.7} strokeLinecap="round" />
      )
    case 'codex':
      return (
        <g fill="none" stroke="var(--text)" strokeLinecap="round" strokeLinejoin="round">
          <rect x={1.5} y={1.5} width={13} height={13} rx={3.5} strokeWidth={1.4} />
          <path d="M4.8,6l2.4,2l-2.4,2" strokeWidth={1.4} />
          <path d="M8.6,10.6h2.6" strokeWidth={1.4} />
        </g>
      )
    case 'pi':
      return (
        <g fill="none" stroke="var(--harness-pi)" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7}>
          <path d="M2.6,4.6h10.8" />
          <path d="M5.6,4.6c-0.1,3-0.5,5.6-1.6,7.6" />
          <path d="M10.4,4.6c-0.1,2.9,0,5.2,1.2,7.2c0.3,0.4,0.7,0.6,1.1,0.5" />
        </g>
      )
    default:
      return (
        <g>
          <circle cx={8} cy={8} r={6.6} fill="none" stroke="currentColor" strokeWidth={1.2} />
          <text x={8} y={11.2} textAnchor="middle" fontSize={9} fontWeight={600} fill="currentColor">
            {harness.slice(0, 1).toUpperCase()}
          </text>
        </g>
      )
  }
}

/**
 * A small mark for the harness a session ran in: a sparkle for Claude Code, a prompt in a rounded square for
 * Codex, a pi for Pi, the first letter in a circle for any other. The title is the product name.
 */
export function HarnessIcon({ harness, size = 14, className }: { harness: string; size?: number; className?: string }) {
  const { title } = useHarness(harness)
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn('inline-flex shrink-0 text-muted', className)}
      style={{ width: size, height: size }}
    >
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decoration; the wrapper carries the product name */}
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden className="block">
        <Mark harness={harness} />
      </svg>
    </span>
  )
}
