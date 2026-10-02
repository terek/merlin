// The context chart: a sawtooth of the context size per turn, a marker at each compaction.
import { type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionDetail } from '../../api/types'
import { formatCount, formatTokens, plural } from '../../lib/format'
import { Card } from '../../ui'
import {
  compactionMarks,
  contextPoints,
  linear,
  nearestMark,
  nearestPoint,
  niceTicks,
  type Point,
  segments,
  stepCursor,
} from './chart'

export interface ContextChartProps {
  detail: SessionDetail
  /** Scroll the timeline to a turn (a click on the chart). */
  onSelectTurn: (index: number) => void
  /** Dev and screenshots: start with the cursor on this turn. */
  initialCursor?: number
}

const HEIGHT = 128
const M = { top: 14, right: 8, bottom: 18, left: 34 }

const path = (pts: readonly Point[], x: (i: number) => number, y: (v: number) => number) =>
  pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.index).toFixed(1)} ${y(p.tokens).toFixed(1)}`).join('')

function useWidth(ref: RefObject<HTMLElement | null>, active: boolean): number {
  const [w, setW] = useState(340)
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return
    setW(Math.floor(el.getBoundingClientRect().width) || 340)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width) || 340))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, active])
  return w
}

const tok = (n: number | undefined) => (n === undefined ? '?' : formatTokens(n))

export function ContextChart({ detail, onSelectTurn, initialCursor }: ContextChartProps) {
  const points = useMemo(() => contextPoints(detail.digest.turns), [detail.digest.turns])
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap, points.length >= 3)
  const [cursor, setCursor] = useState<number | null>(initialCursor ?? null)

  if (points.length < 3) return null

  const lo = points[0].index
  const hi = points[points.length - 1].index
  const marks = compactionMarks(detail.digest.compactions, lo, hi)
  const maxV = Math.max(...points.map((p) => p.tokens), ...marks.map((m) => m.pre ?? 0))
  const yTicks = niceTicks(maxV, 4)
  const xTicks = niceTicks(hi, Math.max(2, Math.floor(width / 80))).filter((t) => t >= lo && t <= hi)
  const x = linear(lo, hi, M.left, Math.max(M.left + 10, width - M.right))
  const y = linear(0, yTicks[yTicks.length - 1], HEIGHT - M.bottom, M.top)
  const base = y(0)

  const cur = cursor === null ? undefined : nearestPoint(points, cursor)
  const nearMarks = cur ? marks.filter((m) => cur.index === m.turn || cur.index === m.turn + 1) : []
  // only the compaction at or nearest the cursor is labelled: all of them at once overlap
  const labelled = cur ? nearestMark(marks, cur.index) : undefined

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setCursor(nearestPoint(points, x.invert(e.clientX - r.left))?.index ?? null)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey ? 10 : 1
    let next: Point | undefined
    if (e.key === 'ArrowLeft') next = stepCursor(points, cursor, -big)
    else if (e.key === 'ArrowRight') next = stepCursor(points, cursor, big)
    else if (e.key === 'Home') next = points[0]
    else if (e.key === 'End') next = points[points.length - 1]
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (cur) onSelectTurn(cur.index)
      return
    } else return
    e.preventDefault()
    if (next) setCursor(next.index)
  }

  const segs = segments(points)

  return (
    <Card
      title="Context"
      actions={marks.length > 0 && <span className="text-sec text-muted">{plural(marks.length, 'compaction')}</span>}
    >
      <div className="mb-1 min-h-9 text-sec" aria-live="polite">
        {cur ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-mono">turn {cur.index}</span>
              <span className="font-mono" title={`${formatCount(cur.tokens)} tokens`}>
                {formatTokens(cur.tokens)}
              </span>
              {cur.abandoned && <span className="text-muted">rewound</span>}
              <span className="min-w-0 flex-1 truncate text-muted">{cur.prompt}</span>
            </div>
            {nearMarks.map((m) => (
              <div key={m.at} className="text-muted">
                compaction{m.trigger ? ` (${m.trigger})` : ''}: {tok(m.pre)} → {tok(m.post)}
              </div>
            ))}
          </>
        ) : (
          <span className="text-faint">Hover, or press ← →, to read a turn. Click or Enter goes to it.</span>
        )}
      </div>
      <div
        ref={wrap}
        role="slider"
        tabIndex={0}
        aria-label="Context size per turn"
        aria-valuemin={lo}
        aria-valuemax={hi}
        aria-valuenow={cur?.index ?? lo}
        aria-valuetext={cur ? `turn ${cur.index}, ${formatTokens(cur.tokens)} tokens` : undefined}
        onPointerMove={onMove}
        onPointerLeave={(e) => {
          if (document.activeElement !== e.currentTarget) setCursor(null)
        }}
        onBlur={() => setCursor(null)}
        onClick={() => cur && onSelectTurn(cur.index)}
        onKeyDown={onKey}
        className="cursor-crosshair rounded-badge"
      >
        <svg width={width} height={HEIGHT} role="img" aria-label="Context size over the turns" className="block">
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
              <text
                x={M.left - 4}
                y={y(t)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={10}
                fill="var(--muted)"
              >
                {t === 0 ? '0' : formatTokens(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={HEIGHT - 4} textAnchor="middle" fontSize={10} fill="var(--muted)">
              {t}
            </text>
          ))}

          {segs.map((s, i) =>
            s.abandoned ? (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: positional
                key={i}
                d={path(s.points, x, y)}
                fill="none"
                stroke="var(--muted)"
                strokeWidth={1}
                strokeDasharray="2 2"
                opacity={0.45}
              />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              <g key={i}>
                <path
                  d={`${path(s.points, x, y)}L${x(s.points[s.points.length - 1].index).toFixed(1)} ${base}L${x(s.points[0].index).toFixed(1)} ${base}Z`}
                  fill="var(--accent)"
                  opacity={0.12}
                />
                <path
                  d={path(s.points, x, y)}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                />
              </g>
            ),
          )}

          {marks.map((m) => {
            return (
              <g key={m.at}>
                <title>
                  {`compaction after turn ${m.turn}${m.trigger ? ` (${m.trigger})` : ''}: ${tok(m.pre)} → ${tok(m.post)}`}
                </title>
                <line
                  x1={x(m.at)}
                  x2={x(m.at)}
                  y1={M.top - 4}
                  y2={base}
                  stroke="var(--warn)"
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                />
                {labelled === m && (
                  <text
                    transform={`translate(${x(m.at) + 11},${M.top}) rotate(90)`}
                    fontSize={10}
                    fill="var(--warn)"
                    stroke="var(--surface)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {tok(m.pre)}→{tok(m.post)}
                  </text>
                )}
              </g>
            )
          })}

          {cur && (
            <g pointerEvents="none">
              <line x1={x(cur.index)} x2={x(cur.index)} y1={M.top} y2={base} stroke="var(--text)" opacity={0.5} />
              <circle
                cx={x(cur.index)}
                cy={y(cur.tokens)}
                r={3.5}
                fill="var(--surface)"
                stroke="var(--accent)"
                strokeWidth={2}
              />
            </g>
          )}
        </svg>
      </div>
    </Card>
  )
}
