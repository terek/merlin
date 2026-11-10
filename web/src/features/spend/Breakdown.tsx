// The structure of the spend, at the top of the Spend card: three thin rings, one per partition of the
// same dollars (outside in: by who, by token class, by model tier), each a full circle cut into arcs by
// linear share, from 12 o'clock clockwise; in the middle the price. To the right of them the legend in
// four columns, the first of which maps the arcs (swatch, label, dollars, percent) and the other three
// are the plot's key (Key.tsx). What is counted is what the plot shows (the effective window).
// Overhead no message explains is a hatched arc at the end of every ring.
//
// Hovering an arc or a row of the first column frames the arc and underlines the row (one shared state);
// nothing else changes, so the colours keep their full contrast and moving the pointer does not flicker.
// Nothing moves while a window is dragged: the rings and their price are a fixed size, and the figures
// of the first column are tabular in columns of a fixed width.
import { type CSSProperties, useId, useMemo, useState } from 'react'
import { formatMoney, formatPercent } from '../../lib/format'
import { type KeyFacts, Legend } from './Key'
import { CLASS_SERIES, KIND_SERIES, TIER_SERIES } from './model'
import { overheadIn, type RangeSpend, type Segment, segmentsOf, sumRange } from './partition'
import { arcPath, spansOf } from './ring'
import { MISS_COLOR } from './TimeView'
import type { Timeline, Win } from './timeline'
import type { Tree } from './tree'

/** The hatching of the overhead, as a background (the swatch of its row). */
export const HATCH_BG = 'repeating-linear-gradient(45deg, var(--muted) 0 1px, transparent 1px 3.5px)'

/**
 * The token classes are drawn in black and white, as patterns of the theme's own tokens (so they read in
 * both themes), to look like another kind of partition than the coloured ones; the cache miss alone
 * keeps its pink, as everywhere. These are the swatches (CSS); the arcs use the same look as SVG patterns
 * (`ClassDefs`). A class without a pattern is drawn in its colour.
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

/** The size of the rings, in pixels: the whole drawing, a ring's thickness, the gap between rings, the gap between arcs. */
export const RING = { size: 176, thick: 10, between: 3, arcGap: 1 } as const

const ROWS = [
  { key: 'kind', head: 'Who', series: KIND_SERIES },
  { key: 'class', head: 'Token class', series: CLASS_SERIES },
  { key: 'tier', head: 'Model tier', series: TIER_SERIES },
] as const
type RowKey = (typeof ROWS)[number]['key']

/** What is under the pointer: a part of a ring, or the overhead (`row` is empty: it is in every ring). */
interface Hover {
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

/** The token classes' patterns as SVG, for the arcs; `id` prefixes their ids. */
function ClassDefs({ id }: { id: string }) {
  return (
    <defs>
      <pattern id={`${id}-write`} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width={5} height={5} style={{ fill: 'var(--surface)' }} />
        <rect width={1.5} height={5} style={{ fill: 'var(--muted)' }} />
      </pattern>
      <pattern id={`${id}-input`} width={6} height={6} patternUnits="userSpaceOnUse">
        <rect width={6} height={6} style={{ fill: 'var(--surface)' }} />
        <circle cx={3} cy={3} r={1.1} style={{ fill: 'var(--muted)' }} />
      </pattern>
      <pattern
        id={`${id}-overhead`}
        width={3.5}
        height={3.5}
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width={1} height={3.5} style={{ fill: 'var(--muted)' }} />
      </pattern>
    </defs>
  )
}

/** The fill of an arc: its colour, or for the token classes and the overhead their pattern. */
function fillOf(id: string, row: RowKey, s: Segment): CSSProperties {
  if (s.hatched) return { fill: `url(#${id}-overhead)` }
  if (row === 'class') {
    if (s.key === 'write' || s.key === 'input') return { fill: `url(#${id}-${s.key})` }
    const b = CLASS_PATTERNS[s.key]?.background
    if (b) return { fill: b }
  }
  return { fill: s.color }
}

/** A swatch of a row of the first column: the arc's colour or pattern. */
function Swatch({ row, s }: { row: RowKey; s: Segment }) {
  const style: CSSProperties = s.hatched
    ? { background: HATCH_BG }
    : row === 'class' && CLASS_PATTERNS[s.key]
      ? CLASS_PATTERNS[s.key]
      : { background: s.color }
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-7 shrink-0 rounded-[2px] border border-line/60"
      style={{ ...style, boxSizing: 'border-box' }}
    />
  )
}

/** One row of the first column. Zero parts are faint, so that the column keeps its rows while a window is dragged. */
function SpendRow({
  row,
  s,
  total,
  tip,
  hover,
  onHover,
}: {
  row: RowKey
  s: Segment
  total: number
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
      className={`grid grid-cols-[28px_minmax(0,1fr)_3.75rem_2.5rem] items-center gap-x-2 rounded-[3px] ${
        s.usd > 0 ? '' : 'opacity-40'
      }`}
    >
      <Swatch row={row} s={s} />
      <span className={`truncate underline-offset-2 ${on ? 'text-text underline' : ''}`}>{s.label}</span>
      <span className="text-right tabular-nums">{formatMoney(s.usd)}</span>
      <span className="text-right tabular-nums">{formatPercent(s.usd, total)}</span>
    </li>
  )
}

export interface BreakdownProps {
  tree: Tree
  timeline: Timeline
  /** The window the plot shows. */
  range: Win
  /** What the legend is told about the tree. */
  facts: KeyFacts
}

export function Breakdown({ tree, timeline, range, facts }: BreakdownProps) {
  const id = useId().replace(/[^a-zA-Z0-9-]/g, '')
  const [hover, setHover] = useState<Hover | null>(null)
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
      // the arcs: what is there, and the overhead; the legend rows: every series, zero ones included
      arcs: segmentsOf(row.series, valuesOf(win, row.key), win.over, tiers),
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
  const c = RING.size / 2
  const big = formatMoney(winTotal)

  const spend = (
    <section aria-label="The spend of the window">
      {rows.map((row) => (
        <div key={row.key} className="mb-2.5">
          <h4 className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-faint">{row.head}</h4>
          <ul className="space-y-0.5">
            {row.all.map((s) => (
              <SpendRow
                key={s.key}
                row={row.key}
                s={s}
                total={winTotal}
                tip={tipOf(row.head, s, winTotal, partial)}
                hover={hover}
                onHover={setHover}
              />
            ))}
          </ul>
        </div>
      ))}
      <ul>
        <SpendRow
          row="kind"
          s={overhead}
          total={winTotal}
          tip={tipOf('Overhead', overhead, winTotal, partial)}
          hover={hover}
          onHover={setHover}
        />
      </ul>
    </section>
  )

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-3 text-sec">
      <div className="relative shrink-0" style={{ width: RING.size, height: RING.size }}>
        <svg
          width={RING.size}
          height={RING.size}
          // the hover is let go only when the pointer leaves the rings: crossing the gap between two arcs keeps it
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label="The spend in three rings: by who, by token class, by model tier"
        >
          <ClassDefs id={id} />
          {rows.map((row, i) => {
            const rOut = c - 1 - i * (RING.thick + RING.between)
            const rIn = rOut - RING.thick
            const spans = spansOf(row.arcs.map((s) => s.usd))
            return (
              <g key={row.key}>
                {/* the empty ring, under the arcs: what a window of no spend leaves */}
                <path
                  d={arcPath(c, c, rIn, rOut, { from: 0, to: 1 })}
                  fillRule="evenodd"
                  style={{ fill: 'var(--surface-2)' }}
                />
                {winTotal > 0 &&
                  row.arcs.map((s, k) => (
                    <path
                      key={s.key}
                      d={arcPath(c, c, rIn, rOut, spans[k], RING.arcGap)}
                      fillRule="evenodd"
                      style={fillOf(id, row.key, s)}
                      onMouseEnter={() => setHover({ row: s.hatched ? '' : row.key, key: s.key })}
                    >
                      <title>{tipOf(row.head, s, winTotal, partial)}</title>
                    </path>
                  ))}
              </g>
            )
          })}
          {/* the frame of the arc hovered (in every ring, for the overhead), over the rings and taking no pointer */}
          {hover &&
            winTotal > 0 &&
            rows.map((row, i) => {
              const k = row.arcs.findIndex((s) => same(hover, row.key, s))
              if (k < 0) return null
              const rOut = c - 1 - i * (RING.thick + RING.between)
              const span = spansOf(row.arcs.map((s) => s.usd))[k]
              return (
                <path
                  key={`frame-${row.key}`}
                  d={arcPath(c, c, rOut - RING.thick, rOut, span, RING.arcGap)}
                  fill="none"
                  stroke="var(--text)"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  pointerEvents="none"
                />
              )
            })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center tabular-nums">
          <span
            className="font-semibold leading-none text-text"
            style={{ fontSize: big.length > 6 ? '1.125rem' : '1.5rem' }}
          >
            {big}
          </span>
          {partial && <span className="mt-1 text-meta text-muted">of {formatMoney(wholeTotal)}</span>}
        </div>
      </div>
      <Legend facts={facts} spend={spend} />
    </div>
  )
}
