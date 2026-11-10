// The structure of the spend, at the top of the Spend card: three bars of linear shares, one per partition
// of the same dollars (by who, by token class, by model tier), and to their right the names of their parts,
// as three narrow columns (swatch and name only; the figures are in each part's hover title). What is counted is what the plot shows (the effective window).
//
// Each row has the whole session's rectangle, outlined, whose length is the session's dollars on a
// logarithmic, saturating scale (`lengthShare`: $1 or less tiny, $100 four fifths, then toward the whole
// track). The coloured segments are the window's parts, scaled linearly inside that rectangle (a part of
// $x is x / the session's total of the rectangle's width, from its left edge, series order, the overhead
// tail last), so that the whole session fills it and a part of it fills a part. The fills are as faint as
// the agent strips of the plot (`CTX_FILL` under a full-colour top edge of `CTX_LINE`).
//
// Hovering a segment or a name of the legend frames the segment and underlines the name (one shared state,
// held by the card); nothing dims. Nothing moves while a window is dragged: the rows have a fixed height,
// the price's place depends only on the session's rectangle, and the figures are tabular.
import { type CSSProperties, useMemo, useRef } from 'react'
import { formatMoney, formatPercent } from '../../lib/format'
import { CLASS_SERIES, KIND_SERIES, TIER_SERIES } from './model'
import {
  lengthShare,
  overheadIn,
  type RangeSpend,
  type Segment,
  type SeriesRowKey,
  segmentsOf,
  sumRange,
} from './partition'
import { CTX_FILL, CTX_LINE, MISS_COLOR } from './TimeView'
import type { Timeline, Win } from './timeline'
import type { Tree } from './tree'
import { useWidth } from './useWidth'

/** The hatching of the overhead, as a background (the swatch of its row). */
export const HATCH_BG = 'repeating-linear-gradient(45deg, var(--muted) 0 1px, transparent 1px 3.5px)'

/**
 * The token classes are drawn in black and white, as patterns of the theme's own tokens (so they read in
 * both themes), to look like another kind of partition than the coloured ones; the cache miss alone
 * keeps its pink, as everywhere. They are laid on nothing, so that they take the same faint opacity as the
 * coloured fills (`look`). A class without a pattern is drawn in its colour.
 */
export const CLASS_PATTERNS: Record<string, CSSProperties> = {
  output: { background: 'var(--text)' },
  read: { background: 'color-mix(in srgb, var(--text) 40%, transparent)' },
  write: { background: 'repeating-linear-gradient(45deg, var(--text) 0 1.5px, transparent 1.5px 5px)' },
  input: { background: 'radial-gradient(circle, var(--text) 1.1px, transparent 1.5px) 0 0 / 6px 6px' },
}

/** How a part is drawn: its fill (at an opacity, like the plot's context areas) and the colour of its top edge. */
function look(row: RowKey, s: Segment): { fill: CSSProperties; opacity: number; edge: string } {
  if (s.hatched) return { fill: { background: HATCH_BG }, opacity: 1, edge: 'transparent' }
  const pattern = row === 'class' ? CLASS_PATTERNS[s.key] : undefined
  if (pattern) return { fill: pattern, opacity: CTX_FILL, edge: 'var(--muted)' }
  const color = row === 'class' && s.key === 'reread' ? MISS_COLOR : (s.color ?? 'var(--muted)')
  return { fill: { background: color }, opacity: CTX_FILL, edge: color }
}

const ROWS = [
  { key: 'kind', head: 'Who', series: KIND_SERIES },
  { key: 'class', head: 'Token class', series: CLASS_SERIES },
  { key: 'tier', head: 'Model tier', series: TIER_SERIES },
] as const
type RowKey = (typeof ROWS)[number]['key'] & SeriesRowKey

/** What is under the pointer: a part of a bar, or the overhead (`row` is empty: it is in every bar). */
export interface Hover {
  row: RowKey | ''
  key: string
}
const same = (h: Hover | null, row: RowKey, s: Segment) => !!h && h.key === s.key && (s.hatched || h.row === row)

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

/** The numbers of the card's breakdown: the window's parts in the three partitions, and the session's total. */
export function useBreakdown(tree: Tree, timeline: Timeline, range: Win) {
  const overheads = useMemo(() => tree.branches.flatMap((b) => b.overhead), [tree])
  // the overhead of the whole session is the tree's; a daemon that does not split it by reported window
  // leaves part (or all) of it at no time, which only a window over the whole session holds
  const whole = useMemo(
    () => ({ ...sumRange(timeline), over: Math.max(tree.overheadUSD, overheadIn(overheads)) }),
    [timeline, overheads, tree],
  )
  const win = useMemo(() => {
    const r = sumRange(timeline, range.lo, range.hi)
    const placed = overheadIn(overheads, range.lo, range.hi)
    const all = r.usd >= whole.usd - 0.005
    return { ...r, over: all ? Math.max(whole.over, placed) : placed }
  }, [timeline, overheads, range, whole])
  const wholeTotal = whole.usd + whole.over
  const winTotal = win.usd + win.over
  const partial = winTotal < wholeTotal - 0.005
  const valuesOf = (r: RangeSpend, key: RowKey) => r[key] as Record<string, number>
  const rows = ROWS.map((row) => {
    const tiers = row.key === 'tier' ? win.tiers : undefined
    return {
      ...row,
      // the segments: what is there, and the overhead; the map's rows: every series, zero ones included
      segs: segmentsOf(row.series, valuesOf(win, row.key), win.over, tiers),
      all: segmentsOf(row.series, valuesOf(win, row.key), 0, tiers, true),
    }
  })
  const overhead: Segment = {
    key: 'overhead',
    // short, for the row; the hover says the rest
    label: 'Not in messages',
    usd: win.over,
    hatched: true,
  }
  return { rows, overhead, winTotal, wholeTotal, partial }
}
export type BreakdownData = ReturnType<typeof useBreakdown>

/** The swatch of a part, in the faint look of its segment. */
function Swatch({ row, s }: { row: RowKey; s: Segment }) {
  const l = look(row, s)
  return (
    <span aria-hidden className="relative inline-block h-2.5 w-5 shrink-0 overflow-hidden rounded-[2px]">
      <span className="absolute inset-0" style={{ ...l.fill, opacity: l.opacity }} />
      <span className="absolute inset-x-0 top-0" style={{ height: CTX_LINE, background: l.edge }} />
    </span>
  )
}

/** One name of the bars' legend: swatch and name, faint when the window has none of it (so nothing jumps). */
function Name({
  row,
  s,
  tip,
  hover,
  onHover,
}: {
  row: RowKey
  s: Segment
  tip: string
  hover: Hover | null
  onHover: (h: Hover | null) => void
}) {
  const on = same(hover, row, s)
  return (
    <li
      title={tip}
      onMouseEnter={() => onHover({ row: s.hatched ? '' : row, key: s.key })}
      onMouseLeave={() => onHover(null)}
      data-on={on || undefined}
      className={`flex items-center gap-1.5 whitespace-nowrap ${s.usd > 0 ? '' : 'opacity-40'}`}
    >
      <Swatch row={row} s={s} />
      <span className={`underline-offset-2 ${on ? 'text-text underline' : ''}`}>{s.label}</span>
    </li>
  )
}

/** Approximate width of a character of a segment's label, and its padding, to decide whether the label fits. */
const CHAR_PX = 6.4
const PAD_PX = 14
/** The room right of the track for the price: it never moves, so the track is the same for every window. */
const PRICE_ROOM = 150

function Bar({
  row,
  head,
  segs,
  px,
  scale,
  total,
  partial,
  hover,
  onHover,
}: {
  row: RowKey
  head: string
  segs: Segment[]
  /** The width, in pixels, inside the session's rectangle. */
  px: number
  /** The dollars the rectangle stands for. */
  scale: number
  /** The window's total, for the percents. */
  total: number
  partial: boolean
  hover: Hover | null
  onHover: (h: Hover | null) => void
}) {
  return (
    <div className="absolute inset-0 flex" onMouseLeave={() => onHover(null)}>
      {segs.map((s) => {
        const w = scale > 0 ? (s.usd / scale) * px : 0
        const text = `${s.label} ${formatPercent(s.usd, total)}`
        const fits = !s.hatched && w >= text.length * CHAR_PX + PAD_PX
        const l = look(row, s)
        const on = same(hover, row, s)
        return (
          <div
            key={s.key}
            title={tipOf(head, s, total, partial)}
            onMouseEnter={() => onHover({ row: s.hatched ? '' : row, key: s.key })}
            className="relative h-full shrink-0 overflow-hidden"
            style={{ width: w }}
          >
            <div className="absolute inset-0" style={{ ...l.fill, opacity: l.opacity }} />
            <div className="absolute inset-x-0 top-0" style={{ height: CTX_LINE, background: l.edge }} />
            {/* the gap between neighbours, and the frame of the part hovered */}
            <div
              className="absolute inset-0"
              style={{
                boxShadow: on ? 'inset 0 0 0 1.5px var(--text)' : 'inset -1px 0 0 var(--surface)',
              }}
            />
            {fits && (
              <span className="absolute inset-0 flex items-center justify-center whitespace-nowrap text-meta text-text">
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
  data: BreakdownData
  hover: Hover | null
  onHover: (h: Hover | null) => void
}

export function Breakdown({ data, hover, onHover }: BreakdownProps) {
  const track = useRef<HTMLDivElement>(null)
  const width = useWidth(track)
  const { rows, overhead, winTotal, wholeTotal, partial } = data
  const lenWhole = Math.round(lengthShare(wholeTotal) * width)
  const inner = Math.max(0, lenWhole - 2) // inside the rectangle's 1 px outline

  return (
    <section
      className="mb-3 flex items-start text-sec tabular-nums"
      aria-label="The spend in three bars: by who, by token class, by model tier"
    >
      <div className="relative min-w-0 flex-1">
        <div ref={track} style={{ marginRight: PRICE_ROOM }}>
          {rows.map((row) => (
            <div key={row.key} className="h-7 py-0.5">
              <div
                className="relative h-full rounded-[3px]"
                style={{ width: lenWhole, boxShadow: 'inset 0 0 0 1px var(--faint)' }}
              >
                <div className="absolute inset-px overflow-hidden rounded-[2px]">
                  {winTotal > 0 && (
                    <Bar
                      row={row.key}
                      head={row.head}
                      segs={row.segs}
                      px={inner}
                      scale={wholeTotal}
                      total={winTotal}
                      partial={partial}
                      hover={hover}
                      onHover={onHover}
                    />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        {/* the price, once, right of the session's rectangle: it moves only with the session, not as the window is dragged */}
        <div
          className="pointer-events-none absolute inset-y-0 flex items-center gap-1.5 whitespace-nowrap pl-3"
          style={{ left: lenWhole }}
        >
          <span className="font-semibold text-text">{formatMoney(winTotal)}</span>
          {partial && <span className="text-muted">of {formatMoney(wholeTotal)}</span>}
        </div>
      </div>
      {/* the names: three columns as narrow as their longest name, side by side, a heading each; the swatches
          line up in each. The overhead (in every bar) ends the last column, once. */}
      <div className="flex shrink-0 items-start gap-x-5 pl-5 text-meta text-muted">
        {rows.map((row, i) => (
          <div key={row.key}>
            <h4 className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-faint">{row.head}</h4>
            <ul className="space-y-0.5">
              {row.all.map((s) => (
                <Name
                  key={s.key}
                  row={row.key}
                  s={s}
                  tip={tipOf(row.head, s, winTotal, partial)}
                  hover={hover}
                  onHover={onHover}
                />
              ))}
              {i === rows.length - 1 && (
                <Name
                  row="kind"
                  s={overhead}
                  tip={tipOf('Overhead', overhead, winTotal, partial)}
                  hover={hover}
                  onHover={onHover}
                />
              )}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
