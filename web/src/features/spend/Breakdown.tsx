// The structure of the spend, in three bars of the same length: by who, by token class, by model tier.
// They partition the same dollars, so each bar is one stack of linear shares; the length of the stack is
// logarithmic and saturating (partition.ts), so that a $1 session and a $1000 one both read. What is
// counted is what the plot shows (the effective window); behind each bar, faint, is the whole session's
// bar on the same scale. Overhead no message explains is a hatched tail on every bar.
//
// The layout does not move while a window is dragged: the rows have a fixed height and the price, written
// once to the right of the bars, a fixed place.
import { useMemo, useRef } from 'react'
import { formatMoney, formatPercent } from '../../lib/format'
import { CLASS_SERIES, KIND_SERIES, TIER_SERIES } from './model'
import { lengthShare, overheadIn, type RangeSpend, type Segment, segmentsOf, sumRange } from './partition'
import { MISS_COLOR } from './TimeView'
import type { Timeline, Win } from './timeline'
import type { Tree } from './tree'
import { useWidth } from './useWidth'

/** The hatching of the overhead, as a background (the same as the legend's swatch of old). */
export const HATCH_BG = 'repeating-linear-gradient(45deg, var(--muted) 0 1px, transparent 1px 3.5px)'

/**
 * The token classes are drawn in black and white, as patterns of the theme's own tokens (so they read in
 * both themes), to look like another kind of partition than the coloured ones; the cache miss alone
 * keeps its pink, as everywhere. A class without a pattern is drawn in its colour.
 */
export const CLASS_PATTERNS: Record<string, { background: string; backgroundSize?: string }> = {
  output: { background: 'color-mix(in srgb, var(--text) 62%, var(--surface))' },
  read: { background: 'color-mix(in srgb, var(--text) 14%, var(--surface))' },
  write: {
    background: 'repeating-linear-gradient(45deg, var(--muted) 0 1.5px, var(--surface) 1.5px 5px)',
  },
  reread: { background: MISS_COLOR },
  input: {
    background: 'radial-gradient(circle, var(--muted) 1.1px, transparent 1.5px) 0 0 / 6px 6px, var(--surface)',
  },
}
/** Approximate width of a character of a segment's label, and its padding, to decide whether the label fits. */
const CHAR_PX = 6.4
const PAD_PX = 14

const ROWS = [
  {
    key: 'kind',
    head: 'Who',
    series: KIND_SERIES,
  },
  {
    key: 'class',
    head: 'Token class',
    series: CLASS_SERIES,
  },
  {
    key: 'tier',
    head: 'Model tier',
    series: TIER_SERIES,
  },
] as const

const tipOf = (head: string, s: Segment, total: number, partial: boolean) =>
  [
    `${head}: ${s.label} · ${formatMoney(s.usd)} · ${formatPercent(s.usd, total)}`,
    s.names && s.names.length > 0 ? `Models: ${s.names.join(', ')}` : '',
    s.hatched
      ? `Spend the harness reported that no message explains, in no part of the three. ${partial ? 'Of each reported stretch, the share inside this window is counted.' : ''}`.trim()
      : '',
  ]
    .filter(Boolean)
    .join('\n')

function Bar({
  segs,
  px,
  partial,
  head,
  patterned,
}: {
  segs: Segment[]
  /** The partition's name, for the hover titles. */
  head: string
  /** Draw the segments as black-and-white patterns (the token classes). */
  patterned?: boolean
  /** The length of the whole bar. */
  px: number
  partial: boolean
}) {
  const total = segs.reduce((s, x) => s + x.usd, 0)
  return (
    <div className="absolute inset-y-0.5 left-0 flex overflow-hidden rounded-[3px]" style={{ width: px }}>
      {segs.map((s) => {
        const w = total > 0 ? (s.usd / total) * px : 0
        const text = `${s.label} ${formatPercent(s.usd, total)}`
        const fits = !s.hatched && w >= text.length * CHAR_PX + PAD_PX
        return (
          <div
            key={s.key}
            title={tipOf(head, s, total, partial)}
            className="flex h-full min-w-px items-center justify-center overflow-hidden"
            style={{
              width: w,
              ...(s.hatched
                ? { background: HATCH_BG }
                : patterned && CLASS_PATTERNS[s.key]
                  ? CLASS_PATTERNS[s.key]
                  : { background: s.color }),
              boxShadow: 'inset -1px 0 0 var(--surface)',
            }}
          >
            {fits && (
              <span className="whitespace-nowrap rounded-[3px] bg-surface/90 px-1 text-meta leading-4 text-text">
                {text}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export interface BreakdownProps {
  tree: Tree
  timeline: Timeline
  /** The window the plot shows. */
  range: Win
}

export function Breakdown({ tree, timeline, range }: BreakdownProps) {
  const track = useRef<HTMLDivElement>(null)
  const width = useWidth(track)
  const overheads = useMemo(() => tree.branches.flatMap((b) => b.overhead), [tree])
  const whole = useMemo(() => ({ ...sumRange(timeline), over: overheadIn(overheads) }), [timeline, overheads])
  const win = useMemo(
    () => ({ ...sumRange(timeline, range.lo, range.hi), over: overheadIn(overheads, range.lo, range.hi) }),
    [timeline, overheads, range],
  )
  const wholeTotal = whole.usd + whole.over
  const winTotal = win.usd + win.over
  const partial = winTotal < wholeTotal - 0.005
  const segs = (r: RangeSpend & { over: number }, key: (typeof ROWS)[number]['key']) => {
    const row = ROWS.find((x) => x.key === key)
    return segmentsOf(row?.series ?? [], r[key], r.over, key === 'tier' ? r.tiers : undefined)
  }
  const len = lengthShare(winTotal) * width
  const lenWhole = lengthShare(wholeTotal) * width

  return (
    <div className="relative mb-2 text-sec tabular-nums">
      <div>
        {ROWS.map((row) => (
          // the track is measured on the first row only; every row has the same one
          <div key={row.key} ref={row.key === 'kind' ? track : undefined} className="relative h-7">
            <div
              aria-hidden
              className="absolute inset-y-0.5 left-0 rounded-[3px] bg-surface-2"
              style={{ width: lenWhole }}
              title={partial ? `The whole session: ${formatMoney(wholeTotal)}` : undefined}
            />
            {winTotal > 0 && (
              <Bar
                segs={segs(win, row.key)}
                px={len}
                partial={partial}
                head={row.head}
                patterned={row.key === 'class'}
              />
            )}
          </div>
        ))}
      </div>
      {/* the price, once, right after the whole session's bar (the longest a bar gets): it moves only
          with the session, not as the window is dragged */}
      <div
        className="absolute inset-y-0 flex items-center gap-1.5 whitespace-nowrap pl-3"
        style={{ left: Math.max(lenWhole, 0) }}
      >
        <span className="font-semibold text-text">{formatMoney(winTotal)}</span>
        {partial && <span className="text-muted">of {formatMoney(wholeTotal)}</span>}
      </div>
    </div>
  )
}
