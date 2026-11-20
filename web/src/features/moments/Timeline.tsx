// The Moments timeline (docs/moments.md, "The page"): linear time from the first session to now, a soft area of
// the prompts typed per day as ground, and one marker per seen moment at its first hit (filled: a habit; a ring:
// explored). Moments already there in the first week sit in one stack at the left edge. Hovering a moment shows each
// later occurrence as a tick under the area, and dims the other markers; a click pins it. Nothing else moves.

import { useRef } from 'react'
import { Link } from 'react-router-dom'
import type { MomentStatus, MomentsReport, MomentView } from '../../api/types'
import { cn } from '../../lib/cn'
import { plural } from '../../lib/format'
import { sessionPath } from '../../lib/paths'
import { parseTime, shortDate } from '../../lib/time'
import { useWidth } from '../spend/useWidth'
import {
  activityArea,
  dayTicks,
  EDGE_ID,
  EDGE_LABEL,
  LABEL_SIZE,
  labelWidth,
  layoutTimeline,
  MARKER_GAP,
  MARKER_R,
  monthTicks,
  seenMoments,
  type TimelineLayout,
  xOf,
} from './layout'

const AREA_H = 72
const TICK_H = 14
const AXIS_H = 20
const R = MARKER_R
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
}

export function Timeline({ report, hover, pin, onHover, onPin }: TimelineProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const since = report.since
  const layout = since ? layoutTimeline(report.moments, since, report.now, width) : null
  const active = hover ?? pin
  const activeMoment = active && active !== EDGE_ID ? report.moments.find((m) => m.id === active) : undefined
  return (
    <div ref={wrap} className="w-full">
      {since && layout && (
        <Chart
          report={report}
          since={since}
          layout={layout}
          active={active}
          activeMoment={activeMoment}
          pin={pin}
          onHover={onHover}
          onPin={onPin}
        />
      )}
    </div>
  )
}

function Chart({
  report,
  since,
  layout: l,
  active,
  activeMoment,
  pin,
  onHover,
  onPin,
}: Omit<TimelineProps, 'hover'> & {
  since: string
  layout: TimelineLayout
  active: string | null
  activeMoment?: MomentView
}) {
  const markersH = l.lanes * MARKER_GAP + MARKER_TOP
  const laneY = (lane: number) => markersH - MARKER_GAP / 2 - lane * MARKER_GAP
  const areaBottom = markersH + AREA_H
  const height = areaBottom + TICK_H + AXIS_H
  const area = activityArea(report.activity ?? [], l, since, report.now)
  const areaPath =
    area.length > 0
      ? `M${area[0].x},${areaBottom} ${area.map((p) => `L${p.x.toFixed(1)},${(areaBottom - p.v * (AREA_H - 6)).toFixed(1)}`).join(' ')} L${area[area.length - 1].x},${areaBottom} Z`
      : ''
  const ticks = activeMoment ? dayTicks(activeMoment, l) : []
  const edgeIds = new Set(l.edge.map((m) => m.id))
  const edgeActive = active === EDGE_ID || (!!active && edgeIds.has(active))
  const dim = active !== null
  const activeX = activeMoment?.first ? xOf(l, Date.parse(activeMoment.first)) : undefined
  const edgeMark = l.edge.length > 0
  const key = (id: string) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPin(id)
    }
  }
  return (
    <svg width={l.width} height={height} role="img" aria-label="Timeline of your moments" className="block">
      <title>Timeline of your moments</title>
      <line x1={0} x2={l.width} y1={areaBottom + 0.5} y2={areaBottom + 0.5} style={{ stroke: 'var(--line)' }} />
      {areaPath && <path d={areaPath} style={{ fill: 'var(--faint)', opacity: 0.2 }} />}

      {activeX !== undefined && (
        <line
          x1={activeX}
          x2={activeX}
          y1={laneY(l.markers.find((m) => m.moment.id === active)?.lane ?? 0)}
          y2={areaBottom + TICK_H}
          strokeDasharray="2 3"
          style={{ stroke: 'var(--accent)', opacity: 0.45 }}
        />
      )}
      {ticks.map((t) => (
        <rect
          key={t.x}
          x={t.x - 1}
          y={areaBottom + 2}
          width={2}
          height={3 + t.h * (TICK_H - 5)}
          rx={1}
          style={{ fill: 'var(--accent)', opacity: 0.35 + t.h * 0.65 }}
        >
          <title>{plural(t.hits, 'time')}</title>
        </rect>
      ))}

      {monthTicks(l).map((t) => (
        <g key={t.label}>
          <line x1={t.x} x2={t.x} y1={areaBottom} y2={areaBottom + 4} style={{ stroke: 'var(--line)' }} />
          <text x={t.x + 4} y={areaBottom + TICK_H + 12} fontSize={11} style={{ fill: 'var(--faint)' }}>
            {t.label}
          </text>
        </g>
      ))}

      {edgeMark && (
        // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
        <g
          role="button"
          tabIndex={0}
          aria-pressed={pin === EDGE_ID}
          aria-label={`Already doing when your history starts (${l.edge.length})`}
          className="cursor-pointer outline-none [&:focus-visible>rect:nth-of-type(2)]:stroke-[2.5]"
          opacity={dim && !edgeActive ? 0.3 : 1}
          onMouseEnter={() => onHover(EDGE_ID)}
          onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(EDGE_ID)}
          onBlur={() => onHover(null)}
          onClick={() => onPin(EDGE_ID)}
          onKeyDown={key(EDGE_ID)}
        >
          <title>{`Already doing when your history starts (${l.edge.length})`}</title>
          <rect
            x={0}
            y={laneY(0) - MARKER_GAP / 2}
            width={l.edgeLabelX + labelWidth(EDGE_LABEL(l.edge.length))}
            height={MARKER_GAP}
            fill="transparent"
          />
          <rect
            x={l.edgeX - 13}
            y={laneY(0) - 8}
            width={26}
            height={16}
            rx={8}
            strokeWidth={edgeActive ? 2 : 1.5}
            style={{ fill: 'var(--surface)', stroke: 'var(--accent)' }}
          />
          <text
            x={l.edgeX}
            y={laneY(0) + 4}
            textAnchor="middle"
            fontSize={11}
            fontWeight={600}
            style={{ fill: 'var(--accent)' }}
          >
            {l.edge.length}
          </text>
          <text
            x={l.edgeLabelX}
            y={laneY(0) + 4}
            fontSize={LABEL_SIZE}
            fontWeight={edgeActive ? 600 : 400}
            style={{ fill: edgeActive ? 'var(--text)' : 'var(--muted)' }}
          >
            {EDGE_LABEL(l.edge.length)}
          </text>
        </g>
      )}

      {l.markers.map(({ moment: m, x, lane, flip, labelX, labelW }) => {
        const y = laneY(lane)
        const on = active === m.id
        const faded = dim && !on
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
          <g
            key={m.id}
            role="button"
            tabIndex={0}
            aria-pressed={pin === m.id}
            aria-label={`${m.title}, ${m.status}, first ${dateOf(m.first, new Date(report.now))}`}
            className="cursor-pointer outline-none [&:focus-visible>circle:first-of-type]:stroke-accent"
            opacity={faded ? 0.3 : 1}
            onMouseEnter={() => onHover(m.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(m.id)}
            onBlur={() => onHover(null)}
            onClick={() => onPin(m.id)}
            onKeyDown={key(m.id)}
          >
            <title>{m.title}</title>
            <rect
              x={flip ? labelX - labelW - 2 : x - MARKER_GAP / 2}
              y={y - MARKER_GAP / 2}
              width={flip ? x + MARKER_GAP / 2 - (labelX - labelW - 2) : labelX + labelW + 2 - (x - MARKER_GAP / 2)}
              height={MARKER_GAP}
              fill="transparent"
            />
            <circle
              cx={x}
              cy={y}
              r={on ? R + 1 : R}
              strokeWidth={m.status === 'habit' ? 0 : 1.5}
              style={{ fill: m.status === 'habit' ? 'var(--accent)' : 'var(--surface)', stroke: 'var(--accent)' }}
            />
            <text
              x={labelX}
              y={y + 4}
              textAnchor={flip ? 'end' : 'start'}
              fontSize={LABEL_SIZE}
              fontWeight={on ? 600 : 400}
              style={{ fill: on ? 'var(--text)' : 'var(--muted)' }}
            >
              {m.title}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** Height of the readout, fixed so that nothing under the timeline moves with the content. */
export const READOUT_H = 'h-[88px]'

/**
 * The line under the timeline. Idle: the totals. On a moment: its title, first date and counts, and the note of
 * the first hit; pinned also its sentence and a link to the first time. On the pinned edge stack: its moments,
 * each one hoverable.
 */
export function Readout({
  report,
  hover,
  pin,
  onHover,
}: {
  report: MomentsReport
  hover: string | null
  pin: string | null
  onHover: (id: string | null) => void
}) {
  const now = new Date(report.now)
  const seen = seenMoments(report.moments)
  const habits = seen.filter((x) => x.status === 'habit').length
  const explored = seen.filter((x) => x.status === 'explored').length
  const layout = report.since ? layoutTimeline(report.moments, report.since, report.now, 1000) : null
  const edge = layout?.edge ?? []
  const edgeIds = new Set(edge.map((m) => m.id))
  const showEdge = pin === EDGE_ID && (hover === null || hover === EDGE_ID || edgeIds.has(hover))
  const id = hover && hover !== EDGE_ID ? hover : pin && pin !== EDGE_ID ? pin : null
  const m = id ? report.moments.find((x) => x.id === id) : undefined
  const pinned = !showEdge && m !== undefined && pin === m.id
  return (
    <div className={cn(READOUT_H, 'overflow-y-auto pt-2 text-body')} aria-live="polite">
      {showEdge ? (
        <div>
          <p className="text-muted">
            Already doing when your history starts ({edge.length}). Hover one to see when it came back.
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {edge.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className={cn(
                    'flex items-center gap-1.5 rounded-card px-1.5 py-0.5 hover:bg-surface-2',
                    hover === e.id && 'bg-surface-2',
                  )}
                  onMouseEnter={() => onHover(e.id)}
                  onMouseLeave={() => onHover(EDGE_ID)}
                >
                  <Glyph status={e.status} />
                  {e.title}
                  <span className="text-faint text-sec">{e.hits > 0 && timesInWeeks(e)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : m?.firstHit ? (
        <div>
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
          {pinned && (
            <p className="mt-1 text-sec text-muted">
              {m.what}{' '}
              <Link
                to={sessionPath(m.firstHit.session, m.firstHit.turn !== undefined ? `t${m.firstHit.turn}` : undefined)}
              >
                Open the first time →
              </Link>
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
