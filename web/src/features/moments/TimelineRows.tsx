// The rows layout of the Moments timeline (`?tl=rows`): the soft activity area and the month axis on top, then one
// row per moment that starts with its label in a left gutter, a marker at the first hit and the activity squares after
// it. The suggestions are the last rows, with their ring in the zone after "now". Nothing floats and nothing dims.

import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MomentHit, MomentsReport } from '../../api/types'
import { plural } from '../../lib/format'
import {
  activityArea,
  bucketTicks,
  fitText,
  LABEL_GAP,
  MARKER_R,
  monthTicks,
  NEXT_PREFIX,
  PAD_X,
  ROW_GLYPH_W,
  ROW_LABEL_SIZE,
  ROWS_HEAD,
  ROWS_PITCH,
  type RowItem,
  rowsY,
  STRIP_PX,
  type TimelineLayout,
  xOf,
} from './layout'
import { dateOf, rangeOf, tickPath } from './Timeline'

const AREA_H = 72
const AREA_TOP = 8
const AXIS_H = 20
const R = MARKER_R
const HEAD_FONT = 11

export interface RowsProps {
  report: MomentsReport
  since: string
  layout: TimelineLayout & { rows: RowItem[] }
  measure: (text: string, weight?: number, size?: number) => number
  hover: string | null
  pin: string | null
  onHover: (id: string | null) => void
  onPin: (id: string) => void
  tickDay: string | null
  onTick: (day: string | null) => void
  onNext: (id: string | null) => void
}

export function RowsChart({
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
  onNext,
}: RowsProps) {
  const navigate = useNavigate()
  const svg = useRef<SVGSVGElement>(null)
  const now = new Date(report.now)
  const hasFuture = l.right < l.width
  const futureX = l.right
  const areaBottom = AREA_TOP + AREA_H
  const rowsTop = areaBottom + AXIS_H
  const { tops, height: rowsH } = rowsY(l.rows)
  const height = rowsTop + rowsH + 8
  const area = activityArea(report.activity ?? [], l, since, report.now)
  const areaPath =
    area.length > 0
      ? `M${area[0].x},${areaBottom} ${area.map((p) => `L${p.x.toFixed(1)},${(areaBottom - p.v * (AREA_H - 6)).toFixed(1)}`).join(' ')} L${area[area.length - 1].x},${areaBottom} Z`
      : ''
  const months = monthTicks(l)
  const st = (id: string): 'sel' | 'hov' | 'none' => (pin === id ? 'sel' : hover === id ? 'hov' : 'none')
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
      {hasFuture && (
        <>
          <rect
            x={futureX}
            y={0}
            width={l.width - futureX}
            height={height}
            style={{ fill: 'var(--accent)', opacity: 0.05 }}
          />
          <line
            x1={futureX + 0.5}
            x2={futureX + 0.5}
            y1={0}
            y2={height}
            strokeDasharray="3 3"
            style={{ stroke: 'var(--faint)' }}
          />
        </>
      )}
      <line x1={l.left} x2={futureX} y1={areaBottom + 0.5} y2={areaBottom + 0.5} style={{ stroke: 'var(--line)' }} />
      {areaPath && <path d={areaPath} style={{ fill: 'var(--faint)', opacity: 0.32 }} />}
      {months.map((t) => (
        <g key={t.label}>
          <line x1={t.x} x2={t.x} y1={areaBottom} y2={areaBottom + 4} style={{ stroke: 'var(--line)' }} />
          <line x1={t.x} x2={t.x} y1={rowsTop} y2={rowsTop + rowsH} style={{ stroke: 'var(--line)', opacity: 0.6 }} />
          <text x={t.x + 4} y={areaBottom + 14} fontSize={11} style={{ fill: 'var(--muted)' }}>
            {t.label}
          </text>
        </g>
      ))}

      {l.rows.map((r, i) => {
        const y = rowsTop + tops[i]
        if (r.kind === 'head') {
          return (
            <text
              key={r.text}
              x={PAD_X}
              y={y + ROWS_HEAD - 7}
              fontSize={HEAD_FONT}
              letterSpacing="0.04em"
              style={{ fill: 'var(--muted)', paintOrder: 'stroke', stroke: 'var(--bg)', strokeWidth: 4 }}
            >
              {r.text.toUpperCase()}
            </text>
          )
        }
        const m = r.moment
        const cy = y + ROWS_PITCH / 2
        if (r.kind === 'next') {
          const id = NEXT_PREFIX + m.id
          const on = hover === id
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
            <g
              key={`n-${m.id}`}
              data-row={i}
              role="button"
              tabIndex={0}
              aria-label={`Next for you: ${m.title}`}
              className="cursor-pointer outline-none"
              onMouseEnter={() => onHover(id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(id)}
              onBlur={() => onHover(null)}
              onClick={() => onNext(m.id)}
              onKeyDown={(e) => {
                if (step(e, i)) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onNext(m.id)
                }
              }}
            >
              <rect x={0} y={y} width={l.width} height={ROWS_PITCH} fill="transparent" />
              <line x1={l.left} x2={futureX} y1={cy} y2={cy} style={{ stroke: 'var(--muted)', opacity: 0.08 }} />
              <circle
                cx={PAD_X + R}
                cy={cy}
                r={R}
                fill="none"
                strokeWidth={1.5}
                strokeDasharray="2 1.5"
                style={{ stroke: 'var(--accent)' }}
              />
              <circle
                cx={futureX + 12 + R}
                cy={cy}
                r={R}
                fill="none"
                strokeWidth={1.5}
                strokeDasharray="2 1.5"
                style={{ stroke: 'var(--accent)' }}
              />
              <text
                x={ROW_GLYPH_W}
                y={cy + 4}
                fontSize={ROW_LABEL_SIZE}
                fontWeight={on ? 600 : 400}
                style={{ fill: 'var(--text)' }}
              >
                {fitText(m.title, room, (t) => measure(t, on ? 600 : 400, ROW_LABEL_SIZE))}
              </text>
            </g>
          )
        }
        const state = st(m.id)
        const on = state === 'sel'
        const raised = state === 'hov'
        const weight = on ? 600 : 400
        const text = fitText(m.title, room, (t) => measure(t, weight, ROW_LABEL_SIZE))
        const mx = xOf(l, Date.parse(m.first ?? ''))
        // the first bucket is the marker: only the squares after it are drawn
        const ticks = bucketTicks(m, l, since).filter((t) => t.x + STRIP_PX / 2 > mx + R + 1)
        const href = (t: { example?: MomentHit }) => tickPath(t)
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
          <g
            key={m.id}
            data-row={i}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            aria-label={`${m.title}, ${m.status}, first ${dateOf(m.first, now)}`}
            className="cursor-pointer outline-none [&:focus-visible>rect:first-of-type]:stroke-accent"
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
            <rect x={0} y={y} width={futureX} height={ROWS_PITCH} fill="transparent" strokeWidth={0} />
            {on && (
              <rect x={0} y={y} width={futureX} height={ROWS_PITCH} style={{ fill: 'var(--accent)', opacity: 0.08 }} />
            )}
            <line
              x1={mx}
              x2={futureX}
              y1={cy}
              y2={cy}
              style={{ stroke: on ? 'var(--accent)' : 'var(--muted)', opacity: on ? 0.3 : 0.1 }}
            />
            {state !== 'none' && (
              <rect
                x={PAD_X + 2 * R + LABEL_GAP - 4}
                y={cy - 9}
                width={measure(text, weight, ROW_LABEL_SIZE) + 8}
                height={18}
                rx={4}
                style={{ fill: on ? 'var(--chip-sel)' : 'var(--surface-2)' }}
              />
            )}
            <circle
              cx={PAD_X + R}
              cy={cy}
              r={R}
              strokeWidth={m.status === 'habit' ? 0 : 1.5}
              style={{ fill: m.status === 'habit' ? 'var(--accent)' : 'var(--surface)', stroke: 'var(--accent)' }}
            />
            <text
              x={ROW_GLYPH_W}
              y={cy + 4}
              fontSize={ROW_LABEL_SIZE}
              fontWeight={weight}
              style={{ fill: on ? 'var(--accent)' : 'var(--text)' }}
            >
              {text}
              {text !== m.title && <title>{m.title}</title>}
            </text>
            <circle
              cx={mx}
              cy={cy}
              r={on || raised ? R + 1 : R}
              strokeWidth={m.status === 'habit' ? 0 : 1.5}
              style={{ fill: m.status === 'habit' ? 'var(--accent)' : 'var(--surface)', stroke: 'var(--accent)' }}
            />
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
