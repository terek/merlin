// The Moments timeline (docs/moments.md, "The page"): linear time from the first session to now, a soft area of
// the prompts typed per day as ground, and one marker per seen moment at its first hit (filled: a habit; a ring:
// explored). Moments already there in the first week sit in one stack at the left edge. Hovering a moment shows each
// later occurrence as a tick under the area, and dims the other markers; a click pins it. Nothing else moves.

import { useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { MomentHit, MomentStatus, MomentsReport, MomentView } from '../../api/types'
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
  LABEL_GAP,
  LABEL_SIZE,
  layoutTimeline,
  MARKER_GAP,
  MARKER_R,
  monthTicks,
  NEXT_PREFIX,
  PAD_X,
  seenMoments,
  type TimelineLayout,
} from './layout'

const AREA_H = 72
const AXIS_H = 20
const R = MARKER_R
/** A label's halo in the page background, so a stem never strikes through text. */
const HALO = { paintOrder: 'stroke', stroke: 'var(--bg)', strokeWidth: 3, strokeLinejoin: 'round' } as const

/** A marker's stem: dotted and faint; solid and in the accent when it is the active one; dimmed with the rest. */
function stem(state: 'sel' | 'hov' | 'none', dim: boolean) {
  if (state === 'sel') return { strokeWidth: 1.5, style: { stroke: 'var(--accent)', opacity: 0.75 } }
  if (state === 'hov') return { strokeWidth: 1.5, style: { stroke: 'var(--muted)', opacity: 0.8 } }
  return { strokeWidth: 1, strokeDasharray: '1.5 3', style: { stroke: 'var(--faint)', opacity: dim ? 0.4 : 0.6 } }
}
const MARKER_TOP = 10

/** The mark of a moment's status: filled for a habit, a ring for explored. Same look as on the timeline. */
export function Glyph({ status, size = 11 }: { status: MomentStatus; size?: number }) {
  const habit = status === 'habit'
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="shrink-0">
      <title>{habit ? 'habit' : 'explored'}</title>
      <circle
        cx="6"
        cy="6"
        r={habit ? 5 : 4.25}
        style={{ fill: habit ? 'var(--accent)' : 'var(--surface)', stroke: 'var(--accent)' }}
        strokeWidth={habit ? 0 : 1.5}
      />
    </svg>
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
  /** The moment (or EDGE_ID) under the pointer or the keyboard focus. */
  hover: string | null
  /** The pinned moment, or EDGE_ID. */
  pin: string | null
  onHover: (id: string | null) => void
  onPin: (id: string) => void
  /** The day of the tick under the pointer or chosen with the arrow keys. */
  tickDay: string | null
  onTick: (day: string | null) => void
  /** A suggestion (or the header, null) was clicked: show what is next. */
  onNext: (id: string | null) => void
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

export function Timeline({ report, hover, pin, onHover, onPin, tickDay, onTick, onNext, onK }: TimelineProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const since = report.since
  const layout = since ? layoutTimeline(report.moments, since, report.now, width, report.suggestions.length > 0) : null
  const k = layout ? daysPerBucket(layout) : 1
  useEffect(() => onK(k), [k, onK])
  return (
    <div ref={wrap} className="w-full">
      {since && layout && (
        <Chart
          report={report}
          since={since}
          layout={layout}
          hover={hover}
          pin={pin}
          onHover={onHover}
          onPin={onPin}
          tickDay={tickDay}
          onTick={onTick}
          onNext={onNext}
        />
      )}
    </div>
  )
}

const EDGE_HEAD_H = 22
const ROW_H = 4
const ROW_PITCH = 6
const DIM = 0.6

function Chart({
  report,
  since,
  layout: l,
  hover,
  pin,
  onHover,
  onPin,
  tickDay,
  onTick,
  onNext,
}: Omit<TimelineProps, 'onK'> & {
  since: string
  layout: TimelineLayout
}) {
  const navigate = useNavigate()
  const now = new Date(report.now)
  const seen = seenMoments(report.moments)
  const nexts = report.suggestions
    .slice(0, 3)
    .map((s) => report.moments.find((m) => m.id === s.moment))
    .filter((m): m is MomentView => m !== undefined)
  const futureX = l.right
  const hasFuture = nexts.length > 0
  const listH = (n: number) => (n > 0 ? EDGE_HEAD_H + n * MARKER_GAP + 6 : 0)
  const markersH = Math.max(l.lanes * MARKER_GAP + MARKER_TOP, listH(l.edge.length), listH(nexts.length))
  const laneY = (lane: number) => markersH - MARKER_GAP / 2 - lane * MARKER_GAP
  const listY = (i: number) => EDGE_HEAD_H + i * MARKER_GAP + MARKER_GAP / 2
  const areaBottom = markersH + AREA_H
  const stripTop = areaBottom + AXIS_H
  const height = stripTop + seen.length * ROW_PITCH + 8
  const area = activityArea(report.activity ?? [], l, since, report.now)
  const areaPath =
    area.length > 0
      ? `M${area[0].x},${areaBottom} ${area.map((p) => `L${p.x.toFixed(1)},${(areaBottom - p.v * (AREA_H - 6)).toFixed(1)}`).join(' ')} L${area[area.length - 1].x},${areaBottom} Z`
      : ''
  // a selection holds its accent; a hovered moment is raised a step; only a selection dims the rest
  const dim = pin !== null
  const st = (id: string): 'sel' | 'hov' | 'none' => (pin === id ? 'sel' : hover === id ? 'hov' : 'none')
  const key = (id: string) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPin(id)
    }
  }
  // what a moment's mark does on the timeline: hover, focus and click act as one
  const markProps = (m: MomentView) => ({
    role: 'button' as const,
    tabIndex: 0,
    'aria-pressed': pin === m.id,
    'aria-label': `${m.title}, ${m.status}, first ${dateOf(m.first, now)}`,
    className: 'cursor-pointer outline-none [&:focus-visible>circle:first-of-type]:stroke-accent',
    opacity: dim && st(m.id) === 'none' ? DIM : 1,
    onMouseEnter: () => onHover(m.id),
    onMouseLeave: () => onHover(null),
    onFocus: () => onHover(m.id),
    onBlur: () => onHover(null),
    onClick: () => onPin(m.id),
    onKeyDown: key(m.id),
  })
  const dot = (m: MomentView, x: number, y: number) => (
    <circle
      cx={x}
      cy={y}
      r={st(m.id) !== 'none' ? R + 1 : R}
      strokeWidth={m.status === 'habit' ? 0 : 1.5}
      style={{ fill: m.status === 'habit' ? 'var(--accent)' : 'var(--surface)', stroke: 'var(--accent)' }}
    />
  )
  const label = (m: MomentView, x: number, y: number, anchor: 'start' | 'end' = 'start') => (
    <text
      x={x}
      y={y + 4}
      textAnchor={anchor}
      fontSize={LABEL_SIZE}
      fontWeight={st(m.id) === 'sel' ? 600 : 400}
      style={{ fill: st(m.id) !== 'none' ? 'var(--text)' : 'var(--muted)', ...HALO }}
    >
      {m.title}
    </text>
  )
  const rows = seen.map((m, i) => ({ m, y: stripTop + i * ROW_PITCH }))
  const ordered = [
    ...rows.filter((r) => st(r.m.id) === 'none'),
    ...rows.filter((r) => st(r.m.id) === 'hov'),
    ...rows.filter((r) => st(r.m.id) === 'sel'),
  ]
  return (
    <svg width={l.width} height={height} role="img" aria-label="Timeline of your moments" className="block">
      <title>Timeline of your moments</title>
      {hasFuture && (
        <>
          <rect
            x={futureX}
            y={0}
            width={l.width - futureX}
            height={areaBottom}
            style={{ fill: 'var(--accent)', opacity: 0.05 }}
          />
          <line
            x1={futureX + 0.5}
            x2={futureX + 0.5}
            y1={0}
            y2={areaBottom}
            strokeDasharray="3 3"
            style={{ stroke: 'var(--faint)' }}
          />
        </>
      )}
      <line x1={l.left} x2={futureX} y1={areaBottom + 0.5} y2={areaBottom + 0.5} style={{ stroke: 'var(--line)' }} />
      {areaPath && <path d={areaPath} style={{ fill: 'var(--faint)', opacity: 0.32 }} />}

      {/* stems: from each marker down to the axis, behind everything; the active one is solid */}
      {l.markers.map(({ moment: m, x, lane }) => (
        <line key={m.id} x1={x} x2={x} y1={laneY(lane) + R + 1} y2={areaBottom} {...stem(st(m.id), dim)} />
      ))}

      {monthTicks(l).map((t) => (
        <g key={t.label}>
          <line x1={t.x} x2={t.x} y1={areaBottom} y2={areaBottom + 4} style={{ stroke: 'var(--line)' }} />
          <text x={t.x + 4} y={areaBottom + 14} fontSize={11} style={{ fill: 'var(--muted)' }}>
            {t.label}
          </text>
        </g>
      ))}

      {l.edge.length > 0 && (
        <text x={PAD_X} y={13} fontSize={11} letterSpacing="0.04em" style={{ fill: 'var(--muted)' }}>
          ALREADY DOING WHEN YOUR HISTORY STARTS
        </text>
      )}
      {l.edge.map((m, i) => {
        const y = listY(i)
        return (
          <g key={m.id} {...markProps(m)}>
            <title>{m.title}</title>
            <rect x={0} y={y - MARKER_GAP / 2} width={l.left - 8} height={MARKER_GAP} fill="transparent" />
            {dot(m, PAD_X + R, y)}
            {label(m, PAD_X + 2 * R + LABEL_GAP, y)}
          </g>
        )
      })}

      {l.markers.map(({ moment: m, x, lane, flip, labelX, labelW }) => {
        const y = laneY(lane)
        return (
          <g key={m.id} {...markProps(m)}>
            <title>{m.title}</title>
            <rect
              x={flip ? labelX - labelW - 2 : x - MARKER_GAP / 2}
              y={y - MARKER_GAP / 2}
              width={flip ? x + MARKER_GAP / 2 - (labelX - labelW - 2) : labelX + labelW + 2 - (x - MARKER_GAP / 2)}
              height={MARKER_GAP}
              fill="transparent"
            />
            {dot(m, x, y)}
            {label(m, labelX, y, flip ? 'end' : 'start')}
          </g>
        )
      })}

      {/* the event strip: a thin row per moment, a tick for every day it happened, oldest first */}
      {ordered.map(({ m, y }) => {
        const on = st(m.id) === 'sel'
        const raised = st(m.id) === 'hov'
        const ticks = bucketTicks(m, l, since)
        const href = (t: { example?: MomentHit }) => tickPath(t)
        return (
          <g
            key={m.id}
            onMouseEnter={() => onHover(m.id)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onPin(m.id)}
            className="cursor-pointer"
          >
            <rect x={l.left} y={y - 1} width={Math.max(1, futureX - l.left)} height={ROW_PITCH} fill="transparent" />
            {ticks.length > 0 && (
              <line
                x1={Math.min(...ticks.map((t) => t.x))}
                x2={futureX}
                y1={y + ROW_H / 2}
                y2={y + ROW_H / 2}
                style={{
                  stroke: on ? 'var(--accent)' : raised ? 'var(--text)' : 'var(--muted)',
                  opacity: on ? 0.35 : raised ? 0.3 : 0.12,
                }}
              />
            )}
            <g opacity={dim && !on && !raised ? DIM : 1}>
              {ticks.map((t) => {
                const sel = on && t.day === tickDay
                return (
                  <rect
                    key={t.day}
                    x={on ? t.x - 1 : t.x}
                    y={on ? y - 1 : y}
                    width={on ? ROW_H + 2 : ROW_H}
                    height={on ? ROW_H + 2 : ROW_H}
                    strokeWidth={sel ? 1.5 : 0}
                    style={{
                      fill: on ? 'var(--accent)' : raised ? 'var(--text)' : 'var(--muted)',
                      opacity: on ? 1 : raised ? 0.55 + t.h * 0.4 : 0.3 + t.h * 0.4,
                      stroke: sel ? 'var(--text)' : 'none',
                    }}
                  />
                )
              })}
            </g>
            {on &&
              ticks.map((t) => (
                <rect
                  key={`hit-${t.day}`}
                  x={t.x0}
                  y={y - 4}
                  width={Math.max(1, t.x1 - t.x0)}
                  height={ROW_PITCH + 8}
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

      {hasFuture && (
        <>
          <text
            x={futureX + 12}
            y={13}
            fontSize={11}
            letterSpacing="0.04em"
            className="cursor-pointer"
            style={{ fill: 'var(--muted)' }}
            onClick={() => onNext(null)}
          >
            NEXT FOR YOU
          </text>
          {nexts.map((m, i) => {
            const y = listY(i)
            const id = NEXT_PREFIX + m.id
            const on = hover === id
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
              <g
                key={m.id}
                role="button"
                tabIndex={0}
                aria-label={`Next for you: ${m.title}`}
                className="cursor-pointer outline-none"
                opacity={dim && !on ? DIM : 1}
                onMouseEnter={() => onHover(id)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(id)}
                onBlur={() => onHover(null)}
                onClick={() => onNext(m.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onNext(m.id)
                  }
                }}
              >
                <rect
                  x={futureX + 4}
                  y={y - MARKER_GAP / 2}
                  width={l.width - futureX - 8}
                  height={MARKER_GAP}
                  fill="transparent"
                />
                <circle
                  cx={futureX + 12 + R}
                  cy={y}
                  r={R}
                  fill="none"
                  strokeWidth={1.5}
                  strokeDasharray="2 1.5"
                  style={{ stroke: 'var(--accent)' }}
                />
                <text
                  x={futureX + 12 + 2 * R + LABEL_GAP}
                  y={y + 4}
                  fontSize={LABEL_SIZE}
                  fontWeight={on ? 600 : 400}
                  style={{ fill: on ? 'var(--text)' : 'var(--muted)', ...HALO }}
                >
                  {m.title}
                </text>
              </g>
            )
          })}
        </>
      )}
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
  const habits = seen.filter((x) => x.status === 'habit').length
  const explored = seen.filter((x) => x.status === 'explored').length
  const nextId = hover?.startsWith(NEXT_PREFIX) ? hover.slice(NEXT_PREFIX.length) : null
  const next = nextId ? report.suggestions.find((x) => x.moment === nextId) : undefined
  const nextMoment = nextId ? report.moments.find((x) => x.id === nextId) : undefined
  const id = pin ?? (nextId ? null : hover)
  const m = id ? report.moments.find((x) => x.id === id) : undefined
  const pinned = m !== undefined && pin === m.id
  const tick =
    m && tickDay && report.since ? bucketDays(m.days ?? [], report.since, k).find((d) => d.day === tickDay) : undefined
  return (
    <div className={cn(READOUT_H, 'overflow-y-auto pt-2 text-body')} aria-live="polite">
      {nextMoment ? (
        <div>
          <p className="flex flex-wrap items-center gap-x-2">
            <span className="font-medium">{nextMoment.title}</span>
            <span className="text-muted">next for you</span>
          </p>
          {next?.reason && <p className="mt-1">{next.reason}</p>}
          <p className="mt-1 text-sec text-muted">{nextMoment.try}</p>
        </div>
      ) : m?.firstHit ? (
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
            <Glyph status={m.status} />
            <span className="font-medium">{m.title}</span>
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
          {report.since ? ` since ${dateOf(report.since, now)}` : ''}: {plural(habits, 'habit')}, {explored} explored.
          <span className="text-faint"> Hover a mark to see when it came back; click to pin it.</span>
        </p>
      )}
    </div>
  )
}
