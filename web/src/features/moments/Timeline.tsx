// The Moments timeline (docs/moments.md, "The page"): a thin strip of the prompts typed per day over a month axis,
// then one row per seen moment, oldest first. A row starts with the moment's label; its track holds one square for
// every stretch of days the moment came back. A click selects a row (a tinted background across it), hovering raises
// it a step. Nothing else moves and nothing fades.

import { useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { MomentDepth, MomentHit, MomentsReport, MomentView } from '../../api/types'
import { cn } from '../../lib/cn'
import { plural } from '../../lib/format'
import { sessionPath } from '../../lib/paths'
import { dayStart, parseTime, shortDate } from '../../lib/time'
import { useWidth } from '../spend/useWidth'
import {
  activityArea,
  type Bucket,
  bucketDays,
  bucketTicks,
  daysPerBucket,
  fitText,
  GLYPH_R,
  layoutRows,
  monthTicks,
  PAD_X,
  ROW_GLYPH_W,
  ROW_LABEL_SIZE,
  ROWS_PITCH,
  STRIP_PX,
  seenMoments,
  type TimelineLayout,
} from './layout'
import { useLabelMeasure } from './measure'

/** The intensity strip, the month axis, and what is above the first row. */
const AREA_TOP = 4
const AREA_H = 22
const AXIS_H = 20
const R = GLYPH_R

/** The depth of a moment; an older API without `depth` is read from the status. */
export function depthOf(m: Pick<MomentView, 'status' | 'depth'>): MomentDepth {
  return m.depth ?? (m.status === 'habit' ? 'routine' : 'tried')
}

/** What each depth looks like, in a 12 x 12 box: a filled dot, a ring, a half-filled ring, a dot in a ring. */
function DepthShapes({ depth }: { depth: MomentDepth }) {
  const ring = { fill: 'var(--surface)', stroke: 'var(--accent)' }
  switch (depth) {
    case 'routine':
      return <circle cx="6" cy="6" r="5" style={{ fill: 'var(--accent)' }} />
    case 'new':
      return (
        <>
          <circle cx="6" cy="6" r="4.75" strokeWidth="1.25" style={ring} />
          <circle cx="6" cy="6" r="2.5" style={{ fill: 'var(--accent)' }} />
        </>
      )
    case 'paused':
      return (
        <>
          <circle cx="6" cy="6" r="4.5" strokeWidth="1.5" style={ring} />
          <path d="M6 1.5 A4.5 4.5 0 0 0 6 10.5 Z" style={{ fill: 'var(--accent)' }} />
        </>
      )
    default:
      return <circle cx="6" cy="6" r="4.5" strokeWidth="1.5" style={ring} />
  }
}

/** The mark of a moment's depth, with its word as the tooltip. The same look in the rows and the legend. */
export function Glyph({ depth, size = 11 }: { depth: MomentDepth; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="shrink-0">
      <title>{depth}</title>
      <DepthShapes depth={depth} />
    </svg>
  )
}

/** One quiet line that says what the marks before the labels mean. */
export function Legend() {
  const items: [MomentDepth, string][] = [
    ['routine', 'part of your routine'],
    ['paused', 'quiet lately'],
    ['tried', 'tried a few times'],
    ['new', 'new'],
  ]
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-sec text-faint">
      {items.map(([d, text]) => (
        <span key={d} className="inline-flex items-center gap-1.5">
          <Glyph depth={d} size={10} />
          {text}
        </span>
      ))}
    </p>
  )
}

/** "since 24 Aug" style date of an API time. */
export function dateOf(s: string | undefined, now: Date): string {
  const d = parseTime(s)
  return d ? shortDate(d, now) : ''
}

export function timesInWeeks(m: MomentView): string {
  return `${plural(m.hits, 'time')} in ${plural(m.weeks, 'week')}`
}

interface TimelineProps {
  report: MomentsReport
  /** The moment under the pointer or the keyboard focus. */
  hover: string | null
  /** The selected moment. */
  pin: string | null
  onHover: (id: string | null) => void
  onPin: (id: string) => void
  /** The day of the tick under the pointer or chosen with the arrow keys. */
  tickDay: string | null
  onTick: (day: string | null) => void
  /** Days per strip bucket, as the measured width makes it. */
  onK: (k: number) => void
}

/** "13 Oct" for a one-day bucket, "13–15 Oct" for a longer one. */
export function rangeOf(b: Pick<Bucket, 'day' | 'end'>, now: Date): string {
  const a = shortDate(dayStart(b.day), now)
  if (b.end === b.day) return a
  const z = shortDate(dayStart(b.end), now)
  const [da, ma] = a.split(' ')
  const [dz, mz] = z.split(' ')
  return ma === mz ? `${da}–${dz} ${mz}` : `${a} – ${z}`
}

/** A bucket of a moment as a link into its example session. */
export function tickPath(t: Pick<Bucket, 'example'>): string | undefined {
  const h = t.example
  return h ? sessionPath(h.session, h.turn !== undefined ? `t${h.turn}` : undefined) : undefined
}

export function Timeline({ report, hover, pin, onHover, onPin, tickDay, onTick, onK }: TimelineProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const since = report.since
  const measure = useLabelMeasure()
  const layout = since ? layoutRows(report.moments, since, report.now, width, measure) : null
  const k = layout ? daysPerBucket(layout) : 1
  useEffect(() => onK(k), [k, onK])
  return (
    <div ref={wrap} className="w-full">
      {since && layout && (
        <Chart
          report={report}
          since={since}
          layout={layout}
          measure={measure}
          hover={hover}
          pin={pin}
          onHover={onHover}
          onPin={onPin}
          tickDay={tickDay}
          onTick={onTick}
        />
      )}
    </div>
  )
}

function Chart({
  report,
  since,
  layout: l,
  measure,
  hover,
  pin,
  onHover,
  onPin,
  tickDay,
  onTick,
}: Omit<TimelineProps, 'onK'> & {
  since: string
  layout: TimelineLayout
  measure: (text: string, weight?: number, size?: number) => number
}) {
  const navigate = useNavigate()
  const svg = useRef<SVGSVGElement>(null)
  const now = new Date(report.now)
  const areaBottom = AREA_TOP + AREA_H
  const rowsTop = areaBottom + AXIS_H
  const height = rowsTop + l.rows.length * ROWS_PITCH + 8
  const area = activityArea(report.activity ?? [], l, since, report.now)
  const areaPath =
    area.length > 0
      ? `M${area[0].x},${areaBottom} ${area.map((p) => `L${p.x.toFixed(1)},${(areaBottom - p.v * (AREA_H - 2)).toFixed(1)}`).join(' ')} L${area[area.length - 1].x},${areaBottom} Z`
      : ''
  const months = monthTicks(l)
  const room = l.left - ROW_GLYPH_W - 8
  // up and down move the focus from row to row
  const step = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!d) return false
    e.preventDefault()
    const all = [...(svg.current?.querySelectorAll<SVGGElement>('[data-row]') ?? [])]
    const at = all.findIndex((g) => Number(g.dataset.row) === i)
    all[Math.max(0, Math.min(all.length - 1, at + d))]?.focus()
    return true
  }
  return (
    <svg ref={svg} width={l.width} height={height} role="img" aria-label="Timeline of your moments" className="block">
      <title>Timeline of your moments</title>
      {areaPath && <path d={areaPath} style={{ fill: 'var(--faint)', opacity: 0.32 }} />}
      <line x1={l.left} x2={l.right} y1={areaBottom + 0.5} y2={areaBottom + 0.5} style={{ stroke: 'var(--line)' }} />
      {months.map((t) => (
        <g key={t.label}>
          <line x1={t.x} x2={t.x} y1={areaBottom} y2={areaBottom + 4} style={{ stroke: 'var(--line)' }} />
          <line
            x1={t.x}
            x2={t.x}
            y1={rowsTop}
            y2={rowsTop + l.rows.length * ROWS_PITCH}
            style={{ stroke: 'var(--line)', opacity: 0.6 }}
          />
          <text x={t.x + 4} y={areaBottom + 14} fontSize={11} style={{ fill: 'var(--muted)' }}>
            {t.label}
          </text>
        </g>
      ))}

      {l.rows.map((m, i) => {
        const y = rowsTop + i * ROWS_PITCH
        const cy = y + ROWS_PITCH / 2
        const on = pin === m.id
        const raised = !on && hover === m.id
        const text = fitText(m.title, room, (t) => measure(t, 400, ROW_LABEL_SIZE))
        const ticks = bucketTicks(m, l, since)
        const href = (t: { example?: MomentHit }) => tickPath(t)
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
          <g
            key={m.id}
            data-row={i}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            aria-label={`${m.title}, ${depthOf(m)}, first ${dateOf(m.first, now)}`}
            className="cursor-pointer outline-none [&:focus-visible>rect:first-of-type]:stroke-accent [&:focus-visible>rect:first-of-type]:stroke-[1.5]"
            onMouseEnter={() => onHover(m.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(m.id)}
            onBlur={() => onHover(null)}
            onClick={() => onPin(m.id)}
            onKeyDown={(e) => {
              if (step(e, i)) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onPin(m.id)
              }
            }}
          >
            <rect
              x={0}
              y={y}
              width={l.width}
              height={ROWS_PITCH}
              rx={4}
              style={{ fill: on ? 'var(--chip-sel)' : raised ? 'var(--surface-2)' : 'transparent' }}
            />
            <svg x={PAD_X + R - 5} y={cy - 5} width={10} height={10} viewBox="0 0 12 12">
              <title>{depthOf(m)}</title>
              <DepthShapes depth={depthOf(m)} />
            </svg>
            <text x={ROW_GLYPH_W} y={cy + 4} fontSize={ROW_LABEL_SIZE} style={{ fill: 'var(--text)' }}>
              {text}
              {text !== m.title && <title>{m.title}</title>}
            </text>
            {ticks.length > 0 && (
              <line
                x1={Math.min(...ticks.map((t) => t.x))}
                x2={l.right}
                y1={cy}
                y2={cy}
                style={{
                  stroke: on ? 'var(--accent)' : raised ? 'var(--text)' : 'var(--muted)',
                  opacity: on ? 0.3 : raised ? 0.2 : 0.1,
                }}
              />
            )}
            {ticks.map((t) => {
              const sel = on && t.day === tickDay
              const s = on ? STRIP_PX + 2 : STRIP_PX
              return (
                <rect
                  key={t.day}
                  x={on ? t.x - 1 : t.x}
                  y={cy - s / 2}
                  width={s}
                  height={s}
                  strokeWidth={sel ? 1.5 : 0}
                  style={{
                    fill: on ? 'var(--accent)' : raised ? 'var(--text)' : 'var(--muted)',
                    opacity: on ? 1 : raised ? 0.55 + t.h * 0.4 : 0.3 + t.h * 0.4,
                    stroke: sel ? 'var(--text)' : 'none',
                  }}
                />
              )
            })}
            {on &&
              ticks.map((t) => (
                <rect
                  key={`hit-${t.day}`}
                  x={t.x0}
                  y={y}
                  width={Math.max(1, t.x1 - t.x0)}
                  height={ROWS_PITCH}
                  fill="transparent"
                  onMouseEnter={() => onTick(t.day)}
                  onMouseLeave={() => onTick(null)}
                  onClick={(e) => {
                    const to = href(t)
                    if (!to) return
                    e.stopPropagation()
                    navigate(to)
                  }}
                >
                  <title>{`${rangeOf(t, now)}: ${plural(t.hits, 'time')}`}</title>
                </rect>
              ))}
          </g>
        )
      })}
    </svg>
  )
}

/** Height of the readout, fixed so that nothing under the timeline moves with the content. */
export const READOUT_H = 'h-[128px]'

/**
 * The line under the timeline. Idle: the totals. On a moment: its title, first date and counts, and the note of
 * the first hit; pinned also its sentence and a link to the first time. On the pinned edge stack: its moments,
 * each one hoverable.
 */
export function Readout({
  report,
  hover,
  pin,
  tickDay,
  k,
  onClear,
}: {
  report: MomentsReport
  hover: string | null
  pin: string | null
  tickDay: string | null
  k: number
  onClear: () => void
}) {
  const now = new Date(report.now)
  const seen = seenMoments(report.moments)
  const count = (d: MomentDepth) => seen.filter((x) => depthOf(x) === d).length
  const id = pin ?? hover
  const m = id ? report.moments.find((x) => x.id === id) : undefined
  const pinned = m !== undefined && pin === m.id
  const tick =
    m && tickDay && report.since ? bucketDays(m.days ?? [], report.since, k).find((d) => d.day === tickDay) : undefined
  return (
    <div className={cn(READOUT_H, 'overflow-y-auto pt-2 text-body')} aria-live="polite">
      {m?.firstHit ? (
        <div className="relative">
          {pinned && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Unselect"
              title="Unselect (Esc)"
              className="absolute top-0 right-0 flex h-6 w-6 items-center justify-center rounded-card text-muted hover:bg-surface-2 hover:text-fg"
            >
              ×
            </button>
          )}
          <p className="flex flex-wrap items-center gap-x-2">
            <Glyph depth={depthOf(m)} />
            <span className="font-medium">{m.title}</span>
            <span className="text-muted">{depthOf(m)}</span>
            <span className="text-muted">first {dateOf(m.first, now)}</span>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span className="text-muted">{timesInWeeks(m)}</span>
            {m.firstHit.note && (
              <>
                <span aria-hidden className="text-faint">
                  ·
                </span>
                <span className="text-muted">{m.firstHit.note}</span>
              </>
            )}
          </p>
          <p className="mt-1 text-sec text-muted">
            {m.what}
            {pinned && m.firstHit && (
              <>
                {' '}
                <Link
                  to={sessionPath(
                    m.firstHit.session,
                    m.firstHit.turn !== undefined ? `t${m.firstHit.turn}` : undefined,
                  )}
                >
                  Open the first time →
                </Link>
              </>
            )}
          </p>
          {pinned && m.detects && (
            <p className="text-sec text-muted">
              <span className="text-faint">How Merlin spots it:</span> {m.detects}
            </p>
          )}
          {tick && (
            <p className="mt-1 text-sec">
              <span className="font-medium">{rangeOf(tick, now)}</span>
              <span className="text-muted">
                {' '}
                · {plural(tick.hits, 'time')}
                {tick.example?.note ? ` · ${tick.example.note}` : ''}
              </span>
              {tick.example && <span className="text-faint"> · click to open</span>}
            </p>
          )}
        </div>
      ) : (
        <p className="text-muted">
          From {plural(report.sessions - report.scripted, 'session')}
          {report.since ? ` since ${dateOf(report.since, now)}` : ''}: {count('routine')} routine, {count('paused')}{' '}
          paused, {count('tried')} tried, {count('new')} new.
          <span className="text-faint"> Hover a mark to see when it came back; click to pin it.</span>
        </p>
      )}
    </div>
  )
}
