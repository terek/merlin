// The structure of the spend, in three bars of the same length: by who, by token class, by model tier.
// They partition the same dollars, so each bar is one stack of linear shares; the length of the stack is
// logarithmic and saturating (partition.ts), so that a $1 session and a $1000 one both read. What is
// counted is what the plot shows (the effective window); behind each bar, faint, is the whole session's
// bar on the same scale. Overhead no message explains is a hatched tail on every bar.
//
// The layout does not move while a window is dragged: the rows have a fixed height, the header a fixed
// width, the figures are tabular, and the room for the dollars after a bar is reserved.
import { useMemo, useRef } from 'react'
import { formatMoney, formatPercent } from '../../lib/format'
import { CLASS_SERIES, KIND_SERIES, TIER_SERIES } from './model'
import { lengthShare, overheadIn, type RangeSpend, SCALE_TICKS, type Segment, segmentsOf, sumRange } from './partition'
import type { Timeline, Win } from './timeline'
import type { Tree } from './tree'
import { useWidth } from './useWidth'

/** The hatching of the overhead, as a background (the same as the legend's swatch of old). */
export const HATCH_BG = 'repeating-linear-gradient(45deg, var(--muted) 0 1px, transparent 1px 3.5px)'

/** Room after the track for "$12.30 of $45.10", so that a bar can be as long as the track. */
const END_ROOM = 'mr-44'
/** Approximate width of a character of a segment's label, and its padding, to decide whether the label fits. */
const CHAR_PX = 6.4
const PAD_PX = 14

const ROWS = [
  {
    key: 'kind',
    head: 'Who',
    title: 'Who spent it: the main agent, agents by kind, cache misses',
    series: KIND_SERIES,
  },
  {
    key: 'class',
    head: 'Token class',
    title: 'What the dollars bought: output, cache reads and writes, uncached input, cache misses',
    series: CLASS_SERIES,
  },
  {
    key: 'tier',
    head: 'Model tier',
    title: 'Heavy, mid and light models, by what their input costs (heavy from $4 per million tokens, light up to $1)',
    series: TIER_SERIES,
  },
] as const

const tipOf = (s: Segment, total: number, partial: boolean) =>
  [
    `${s.label}: ${formatMoney(s.usd)} (${formatPercent(s.usd, total)})`,
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
}: {
  segs: Segment[]
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
            title={tipOf(s, total, partial)}
            className="flex h-full min-w-px items-center justify-center overflow-hidden"
            style={{
              width: w,
              background: s.hatched ? HATCH_BG : s.color,
              boxShadow: 'inset -1px 0 0 var(--surface)',
            }}
          >
            {fits && (
              <span className="whitespace-nowrap rounded-[3px] bg-surface/80 px-1 text-meta leading-4 text-text">
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
  const ticks = SCALE_TICKS.map((v) => ({ v, x: lengthShare(v) * width })).filter((t) => t.x <= width - 16)

  return (
    <div className="mb-2 text-sec tabular-nums">
      {ROWS.map((row) => (
        <div key={row.key} className="flex h-7 items-center">
          <div className="w-24 shrink-0 text-muted" title={row.title}>
            {row.head}
          </div>
          {/* the track is measured on the first row only; every row has the same one */}
          <div ref={row.key === 'kind' ? track : undefined} className={`relative h-full min-w-0 flex-1 ${END_ROOM}`}>
            <div
              aria-hidden
              className="absolute inset-y-0.5 left-0 rounded-[3px] bg-surface-2"
              style={{ width: lenWhole }}
              title={partial ? `The whole session: ${formatMoney(wholeTotal)}` : undefined}
            />
            {winTotal > 0 && <Bar segs={segs(win, row.key)} px={len} partial={partial} />}
            <div
              className="absolute inset-y-0 flex items-center gap-1.5 whitespace-nowrap pl-2"
              style={{ left: Math.max(len, 0) }}
            >
              <span className="font-semibold text-text">{formatMoney(winTotal)}</span>
              {partial && <span className="text-muted">of {formatMoney(wholeTotal)}</span>}
            </div>
          </div>
        </div>
      ))}
      <div className="flex h-4 items-start">
        <div className="w-24 shrink-0" />
        <div className={`relative h-full min-w-0 flex-1 ${END_ROOM}`}>
          <div className="absolute inset-x-0 top-0 border-t border-line" />
          {ticks.map((t) => (
            <div key={t.v} className="absolute top-0" style={{ left: t.x }}>
              <div className="h-1 border-l border-line" />
              <div className="-translate-x-1/2 text-meta leading-3 text-faint">
                {t.v >= 1000 ? `$${t.v / 1000}k` : `$${t.v}`}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
