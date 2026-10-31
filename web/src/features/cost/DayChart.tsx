// The day chart: an SVG bar chart, one bar per local day (per week for a long "all"), stacked by
// model or by source, or showing the estimated compaction calls on their own (warm-cache cost, the
// cold-cache extra on top, and the number of cold calls over the bar). Hover or arrow keys show the
// bar's split; a click or Enter selects it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import { formatMoney, plural } from '../../lib/format'
import { modelLabel } from '../../lib/models'
import { dayStart, shortDate } from '../../lib/time'
import { Money } from '../../ui'
import { type Bucket, barTotal, labelEvery, niceTicks, type Segment, type Stack, stackOf, tickLabel } from './model'

const HEIGHT = 224
const M = { left: 52, right: 8, top: 10, bottom: 24 }
const MAX_BAR = 48

export function segmentLabel(key: string): string {
  if (key === 'other') return 'Other models'
  if (key === 'reported') return 'Reported'
  if (key === 'attributed') return 'Attributed'
  if (key === 'compaction-warm') return 'At the warm-cache price'
  if (key === 'compaction-cold') return 'Extra for a cold cache'
  return modelLabel(key)
}

/** "Wed 16 Sep" or, for a week, "Week of 14 Sep – 20 Sep". */
export function bucketTitle(b: Bucket): string {
  const from = dayStart(b.key)
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][from.getDay()]
  if (!b.weekly) return `${dow} ${shortDate(from)}`
  return `Week of ${shortDate(from)}${b.to === b.key ? '' : ` – ${shortDate(dayStart(b.to))}`}`
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [w, setW] = useState(900)
  useLayoutEffect(() => {
    if (ref.current) setW(ref.current.clientWidth || 900)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const o = new ResizeObserver(() => setW(el.clientWidth || 900))
    o.observe(el)
    return () => o.disconnect()
  }, [])
  return [ref, w]
}

export function DayChart({
  buckets,
  stack,
  top,
  selected,
  onSelect,
}: {
  buckets: Bucket[]
  stack: Stack
  top: string[]
  /** Key of the selected bucket; the others are dimmed. */
  selected?: string
  onSelect: (b: Bucket) => void
}) {
  const [wrap, width] = useWidth()
  const [active, setActive] = useState<number | undefined>(undefined)
  const n = buckets.length
  const stacks = buckets.map((b) => stackOf(b, stack, top))
  const max = Math.max(0, ...buckets.map((b) => barTotal(b, stack)))
  const { ticks, top: yTop } = niceTicks(max)
  const plotW = Math.max(40, width - M.left - M.right)
  const plotH = HEIGHT - M.top - M.bottom
  const band = plotW / Math.max(1, n)
  const barW = Math.max(1, Math.min(band * 0.74, MAX_BAR))
  const y = (v: number) => M.top + plotH - (v / yTop) * plotH
  const every = labelEvery(n, plotW)

  const move = (i: number) => setActive(Math.min(n - 1, Math.max(0, i)))
  const cur = active === undefined ? undefined : buckets[active]
  const centre = (i: number) => M.left + band * i + band / 2

  return (
    <div ref={wrap} className="relative">
      <svg
        width={width}
        height={HEIGHT}
        role="application"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart is one tab stop; arrow keys move between bars
        tabIndex={0}
        aria-label={`${stack === 'compaction' ? 'Estimated compaction calls' : 'Spend'} per ${buckets[0]?.weekly ? 'week' : 'day'}. Arrow keys move between bars, Enter selects one.`}
        className="block rounded-card"
        onFocus={() => setActive((a) => a ?? n - 1)}
        onBlur={() => setActive(undefined)}
        onKeyDown={(e) => {
          if (active === undefined) return
          if (e.key === 'ArrowRight') move(active + 1)
          else if (e.key === 'ArrowLeft') move(active - 1)
          else if (e.key === 'Home') move(0)
          else if (e.key === 'End') move(n - 1)
          else if (e.key === 'Enter' || e.key === ' ') onSelect(buckets[active])
          else return
          e.preventDefault()
        }}
        onMouseLeave={() => setActive(undefined)}
      >
        <defs>
          <pattern id="overhead-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="var(--surface)" />
            <rect width="2.5" height="5" fill="var(--overhead)" />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={M.left - 8} y={y(t)} textAnchor="end" dominantBaseline="central" fontSize={11} fill="var(--muted)">
              {tickLabel(t)}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const dim = selected !== undefined && selected !== b.key
          const x = centre(i) - barW / 2
          let acc = 0
          const parts = stacks[i]
          return (
            <g key={b.key} opacity={dim ? 0.4 : 1}>
              {(active === i || selected === b.key) && (
                <rect x={M.left + band * i} y={M.top} width={band} height={plotH} fill="var(--surface-2)" />
              )}
              {parts.map((s: Segment) => {
                const y0 = y(acc)
                acc += s.usd
                const y1 = y(acc)
                return (
                  <rect
                    key={s.key}
                    x={x}
                    y={y1}
                    width={barW}
                    height={Math.max(1, y0 - y1)}
                    fill={s.tone === 'overhead' ? 'url(#overhead-hatch)' : `var(--${s.tone})`}
                    stroke="var(--surface)"
                    strokeWidth={parts.length > 1 ? 0.5 : 0}
                  />
                )
              })}
              {barTotal(b, stack) <= 0 && (
                <rect x={x} y={M.top + plotH - 1} width={barW} height={1} fill="var(--line)" />
              )}
              {stack === 'compaction' && (b.compactions?.cold ?? 0) > 0 && band >= 12 && (
                <text
                  x={centre(i)}
                  y={y(acc) - 4}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--bad)"
                  data-testid="cold-count"
                >
                  {b.compactions?.cold}
                </text>
              )}
              {i % every === 0 && (
                <text x={centre(i)} y={HEIGHT - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
                  {shortDate(dayStart(b.key))}
                </text>
              )}
              <rect
                data-testid="bar"
                data-key={b.key}
                x={M.left + band * i}
                y={M.top}
                width={band}
                height={plotH}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setActive(i)}
                onClick={() => onSelect(b)}
              />
            </g>
          )
        })}
      </svg>
      <span className="sr-only" aria-live="polite">
        {cur
          ? `${bucketTitle(cur)}: ${formatMoney(cur.total)}${cur.compactions ? ` · compactions ~${formatMoney(cur.compactions.usd)}${cur.compactions.cold ? ` (${cur.compactions.cold} cold, warm ~${formatMoney(cur.compactions.warmUSD)})` : ''}` : ''}`
          : ''}
      </span>
      {cur && active !== undefined && (
        <Tip bucket={cur} stack={stack} segments={stacks[active]} x={centre(active)} width={width} />
      )}
    </div>
  )
}

/** The colour chip of a series; (overhead) is hatched, as in the bars, because it shares a hue with a model. */
export function Swatch({ tone }: { tone: string }) {
  const style =
    tone === 'overhead'
      ? { background: 'repeating-linear-gradient(45deg, var(--overhead) 0 2px, var(--surface) 2px 4px)' }
      : { background: `var(--${tone})` }
  return <span className="inline-block size-2 shrink-0 rounded-badge" style={style} />
}

function Tip({
  bucket,
  stack,
  segments,
  x,
  width,
}: {
  bucket: Bucket
  stack: Stack
  segments: Segment[]
  x: number
  width: number
}) {
  const w = stack === 'compaction' ? 300 : 232
  const c = bucket.compactions
  const left = Math.min(Math.max(0, x - w / 2), width - w)
  return (
    <div
      role="tooltip"
      style={{ left, top: 4, width: w }}
      className={cn(
        'pointer-events-none absolute z-20 rounded-card border border-line bg-surface p-2 text-sec shadow-pop',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-fg">{bucketTitle(bucket)}</span>
        {stack === 'compaction' ? (
          <span className="font-mono">~{formatMoney(c?.usd ?? 0)}</span>
        ) : (
          <Money usd={bucket.total} />
        )}
      </div>
      {stack === 'compaction' && c && (
        <p className="mt-0.5 text-muted">
          {plural(c.calls, 'compaction')}
          {c.cold > 0 && <span className="text-bad">, {c.cold} cold</span>}
        </p>
      )}
      {segments.length === 0 ? (
        <p className="mt-1 text-muted">{stack === 'compaction' ? 'No compactions.' : 'No spend.'}</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {[...segments].reverse().map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <Swatch tone={s.tone} />
              <span className="min-w-0 flex-1 truncate text-muted">{segmentLabel(s.key)}</span>
              <Money usd={s.usd} />
            </li>
          ))}
        </ul>
      )}
      {stack === 'compaction' && c && (
        <p className="mt-1 text-faint">
          Estimated; not in the spend totals.
          {c.uncoveredUSD > 0 && ` ~${formatMoney(c.uncoveredUSD)} of it is outside any reported figure.`}
        </p>
      )}
    </div>
  )
}
