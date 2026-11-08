// The overview above the time view of a session that ran long or on more than one day: the whole tree
// on one wall-clock scale (idle time squeezed out as in the plot) with a brush on it. The brush is the
// window the plot shows. Drag across the strip for a new range, drag the window to move it, drag a
// handle to resize it, click a day to snap to it; ← → move the window by its own width (a day at a
// time when it is a day).
import { type KeyboardEvent, type PointerEvent, useMemo, useRef, useState } from 'react'
import { formatDuration, formatMoney } from '../../lib/format'
import { CLASS_SERIES, KIND_SERIES, type Split, TIER_SERIES } from './model'
import {
  boundsOf,
  centerWindow,
  contextEnvelope,
  type Day,
  dayAt,
  dayStart,
  dragWindow,
  midnightsBetween,
  resizeWindow,
  snapDay,
  snapTarget,
  spendDensity,
  stepWindow,
  type Timeline,
  timeAxis,
  type Win,
  windowDay,
} from './timeline'
import { useWidth } from './useWidth'

const H = 54
/** The labels along the top, the context area under them, the spend bars along the bottom. */
const LABEL_H = 12
const CTX_TOP = 15
const CTX_BASE = 37
const BAR_TOP = 40
const BAR_BASE = H - 2
const PAD = 8
const COL = 2
/** How close to an edge of the window the pointer grabs its handle. */
const GRAB = 7
/** The most breaks the strip makes: more idle stretches are squeezed together. */
const STRIP_BREAKS = 16

const ORDER = { kind: KIND_SERIES, class: CLASS_SERIES, tier: TIER_SERIES }

const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const longDate = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
const month = (t: number) => new Date(t).toLocaleDateString([], { month: 'short' })

export interface OverviewProps {
  /** The whole tree. */
  timeline: Timeline
  days: readonly Day[]
  split: Split
  win: Win
  /** What the plot really shows: `win`, grown to the end of the turn it cuts (`effectiveWindow`). */
  eff: Win
  onWin: (w: Win) => void
  /** The start of the pinned turn, if there is one. */
  pinnedT?: number
  /** The last work episode: what "Latest" goes back to. */
  latest: Win
}

type Drag =
  | { mode: 'move'; x: number; xlo: number; xhi: number }
  | { mode: 'lo' | 'hi' }
  | { mode: 'new'; x: number; t: number; moved: boolean }

export function Overview({ timeline, days, split, win, eff, onWin, pinnedT, latest }: OverviewProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const drag = useRef<Drag | null>(null)
  const [cursor, setCursor] = useState('crosshair')
  const x0 = PAD
  const x1 = Math.max(x0 + 80, width - PAD)
  const bounds = useMemo(() => boundsOf(timeline), [timeline])
  const axis = useMemo(() => timeAxis(timeline.spans, x0, x1, undefined, STRIP_BREAKS), [timeline, x1])

  const env = useMemo(() => contextEnvelope(timeline, axis, COL), [timeline, axis])
  const peak = Math.max(1, ...env)
  const dens = useMemo(() => spendDensity(timeline, axis, COL, split), [timeline, axis, split])
  const maxBar = Math.max(1e-9, ...dens.map((d) => d.total ?? 0))
  const area = useMemo(() => {
    const k = (CTX_BASE - CTX_TOP) / peak
    let d = `M${x0} ${CTX_BASE}`
    env.forEach((v, i) => {
      const y = (CTX_BASE - v * k).toFixed(1)
      d += `L${(x0 + i * COL).toFixed(1)} ${y}L${(x0 + (i + 1) * COL).toFixed(1)} ${y}`
    })
    return `${d}L${x0 + env.length * COL} ${CTX_BASE}Z`
  }, [env, peak])

  const spent = useMemo(() => {
    let usd = 0
    for (const l of timeline.lanes) for (const c of l.calls) if (c.t >= eff.lo && c.t < eff.hi) usd += c.usd
    return usd
  }, [timeline, eff])

  // a label for the strip's first day and for every midnight in it, where they do not collide; each snaps
  // to its day
  const mids = useMemo(() => midnightsBetween(timeline.t0, timeline.t1), [timeline])
  const labels = useMemo(() => {
    let end = Number.NEGATIVE_INFINITY
    let prev = -1
    return [dayStart(timeline.t0), ...mids].flatMap((m, i) => {
      const x = (i === 0 ? x0 : axis.x(m)) + 2
      const d = new Date(m)
      const text =
        d.getMonth() !== prev
          ? `${month(m)} ${d.getDate()}`
          : `${d.toLocaleDateString([], { weekday: 'short' })} ${d.getDate()}`
      if (x < end + 4 || x + text.length * 5.5 > x1 + PAD) return []
      end = x + text.length * 5.5
      prev = d.getMonth()
      return [{ m, x, text }]
    })
  }, [timeline, mids, axis, x1])
  const midnights = useMemo(() => {
    let last = Number.NEGATIVE_INFINITY
    return mids
      .map((m) => axis.x(m))
      .filter((x) => {
        const keep = x - last >= 3
        if (keep) last = x
        return keep
      })
  }, [mids, axis])

  const xlo = axis.x(win.lo)
  const xhi = Math.max(xlo + 2, axis.x(win.hi))
  const xeff = Math.max(xhi, axis.x(eff.hi))
  const dayOfWin = windowDay(win, days)
  const snap = (k: number) => onWin(snapDay(days[k]))
  const snapped = dayOfWin >= 0 ? { m: days[dayOfWin].date } : undefined

  const at = (e: PointerEvent) => e.clientX - (e.currentTarget as Element).getBoundingClientRect().left
  const zoneAt = (x: number): 'lo' | 'hi' | 'move' | 'new' =>
    Math.abs(x - xlo) <= GRAB ? 'lo' : Math.abs(x - xhi) <= GRAB ? 'hi' : x > xlo && x < xhi ? 'move' : 'new'

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    e.preventDefault()
    const m = (e.target as Element).getAttribute('data-snap')
    if (m !== null) {
      const w = snapTarget(timeline, days, Number(m))
      if (w) onWin(w)
      return
    }
    const x = at(e)
    const z = zoneAt(x)
    drag.current =
      z === 'move'
        ? { mode: 'move', x, xlo, xhi }
        : z === 'new'
          ? { mode: 'new', x, t: axis.t(x), moved: false }
          : { mode: z }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // a synthetic pointer has nothing to capture
    }
  }
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const x = at(e)
    const d = drag.current
    if (!d) {
      const z = zoneAt(x)
      setCursor(z === 'move' ? 'grab' : z === 'new' ? 'crosshair' : 'ew-resize')
      return
    }
    if (d.mode === 'move') {
      const w = d.xhi - d.xlo
      const a = Math.max(x0, Math.min(x1 - w, d.xlo + x - d.x))
      onWin(dragWindow(axis.t(a), axis.t(a + w), bounds))
    } else if (d.mode === 'new') {
      if (Math.abs(x - d.x) > 3) d.moved = true
      if (d.moved) onWin(dragWindow(d.t, axis.t(x), bounds))
    } else onWin(resizeWindow(win, d.mode, axis.t(x), bounds))
  }
  const onUp = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    drag.current = null
    // a click outside the window brings it there
    if (d?.mode === 'new' && !d.moved) onWin(centerWindow(win, axis.t(at(e)), bounds))
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const w = win.hi - win.lo
    let next: Win | undefined
    if (e.key === 'ArrowLeft') next = stepWindow(win, -1, days, bounds)
    else if (e.key === 'ArrowRight') next = stepWindow(win, 1, days, bounds)
    else if (e.key === 'Home') next = dayOfWin >= 0 ? snapDay(days[0]) : dragWindow(bounds.t0, bounds.t0 + w, bounds)
    else if (e.key === 'End')
      next = dayOfWin >= 0 ? snapDay(days[days.length - 1]) : dragWindow(bounds.t1 - w, bounds.t1, bounds)
    if (!next) return
    e.preventDefault()
    onWin(next)
  }

  const whole = eff.lo <= bounds.t0 && eff.hi >= bounds.t1
  const from = Math.max(win.lo, timeline.t0)
  const to = Math.min(eff.hi, timeline.t1)
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString()

  return (
    <div className="mb-3">
      <div className="flex min-h-5 items-baseline gap-x-3 overflow-hidden whitespace-nowrap text-sec">
        <span className="text-muted">Showing</span>
        <span className="font-medium">
          {whole
            ? 'the whole session'
            : dayOfWin >= 0
              ? longDate(days[dayOfWin].date)
              : sameDay
                ? `${longDate(from)} ${clock(from)}–${clock(to)}`
                : `${longDate(from)} ${clock(from)} – ${longDate(to)} ${clock(to)}`}
        </span>
        <span className="text-muted">{formatDuration(eff.hi - eff.lo)}</span>
        <span className="font-mono">{formatMoney(spent)}</span>
        <button
          type="button"
          onClick={() => onWin(latest)}
          className="cursor-pointer text-accent hover:underline focus-visible:underline"
        >
          Latest
        </button>
        <button
          type="button"
          onClick={() => onWin({ lo: bounds.t0, hi: bounds.t1 })}
          className="cursor-pointer text-accent hover:underline focus-visible:underline"
        >
          All
        </button>
        <span className="truncate text-faint">drag to select a range, drag the window or its edges, click a date</span>
      </div>
      <div
        ref={wrap}
        role="slider"
        tabIndex={0}
        aria-label="Window of the session shown below"
        aria-valuemin={bounds.t0}
        aria-valuemax={bounds.t1}
        aria-valuenow={win.lo}
        aria-valuetext={`${longDate(from)} ${clock(from)} to ${clock(to)}`}
        onKeyDown={onKey}
        className="mt-1 rounded-badge"
      >
        <svg
          width={width}
          height={H}
          role="img"
          aria-label="The whole session over time"
          className="block touch-none select-none"
          style={{ cursor, userSelect: 'none', WebkitUserSelect: 'none' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onDoubleClick={(e) => {
            const k = dayAt(days, axis.t(e.clientX - e.currentTarget.getBoundingClientRect().left))
            if (k >= 0) snap(k)
          }}
        >
          <rect x={0} y={LABEL_H} width={width} height={H - LABEL_H} fill="var(--surface-2)" opacity={0.5} rx={3} />
          {axis.breaks.map((b) => (
            <rect
              key={b.t0}
              x={b.x0}
              y={LABEL_H}
              width={b.x1 - b.x0}
              height={H - LABEL_H}
              fill="var(--surface)"
              opacity={0.9}
            >
              <title>{`${formatDuration(b.t1 - b.t0)} in which nothing ran, left out`}</title>
            </rect>
          ))}
          {midnights.map((x) => (
            <line key={x} x1={x} x2={x} y1={0} y2={H} stroke="var(--line)" strokeWidth={1} />
          ))}
          <path d={area} fill="var(--series-1)" fillOpacity={0.28} stroke="none" />
          <line x1={x0} x2={x1} y1={CTX_BASE + 0.5} y2={CTX_BASE + 0.5} stroke="var(--line)" strokeWidth={1} />
          {dens.map((d, i) => {
            let y = BAR_BASE
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions
              <g key={i}>
                {ORDER[split].map((p) => {
                  const v = d[p.key] ?? 0
                  if (v <= 0) return null
                  const h = Math.max(0.75, (v / maxBar) * (BAR_BASE - BAR_TOP))
                  y -= h
                  return <rect key={p.key} x={x0 + i * COL} y={y} width={COL} height={h} fill={p.color} />
                })}
              </g>
            )
          })}
          {labels.map((l) => (
            <text
              key={l.m}
              data-snap={l.m}
              x={l.x}
              y={LABEL_H - 3}
              fontSize={10}
              fill={snapped?.m === l.m ? 'var(--text)' : 'var(--muted)'}
              fontWeight={snapped?.m === l.m ? 600 : 400}
              style={{ cursor: 'pointer' }}
            >
              {l.text}
            </text>
          ))}
          {pinnedT !== undefined && Number.isFinite(pinnedT) && (
            <g pointerEvents="none">
              <line
                x1={axis.x(pinnedT)}
                x2={axis.x(pinnedT)}
                y1={LABEL_H}
                y2={H}
                stroke="var(--accent)"
                strokeWidth={1}
                opacity={0.8}
              />
              <path d={`M${axis.x(pinnedT) - 4} ${LABEL_H - 1}h8l-4 6z`} fill="var(--accent)" />
            </g>
          )}
          {/* what is outside the window is dimmed */}
          <g pointerEvents="none">
            <rect
              x={0}
              y={LABEL_H}
              width={Math.max(0, xlo)}
              height={H - LABEL_H}
              fill="var(--surface)"
              opacity={0.55}
            />
            <rect
              x={xeff}
              y={LABEL_H}
              width={Math.max(0, width - xeff)}
              height={H - LABEL_H}
              fill="var(--surface)"
              opacity={0.55}
            />
            <rect
              x={xlo}
              y={LABEL_H + 0.75}
              width={xhi - xlo}
              height={H - LABEL_H - 1.5}
              fill="var(--accent)"
              fillOpacity={0.08}
              stroke="var(--accent)"
              strokeWidth={1.5}
              rx={2}
            />
            {/* the turn the window cuts runs on, and the plot shows it whole: a fainter continuation */}
            {xeff - xhi > 0.5 && (
              <g data-testid="overview-effective">
                <rect
                  x={xhi}
                  y={LABEL_H + 0.75}
                  width={xeff - xhi}
                  height={H - LABEL_H - 1.5}
                  fill="var(--accent)"
                  fillOpacity={0.04}
                />
                <path
                  d={`M${xhi} ${LABEL_H + 0.75}H${xeff}V${H - 0.75}H${xhi}`}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1}
                  strokeOpacity={0.4}
                />
              </g>
            )}
            {[xlo, xhi].map((x, i) => (
              <rect
                key={i === 0 ? 'lo' : 'hi'}
                x={x - 2.5}
                y={LABEL_H + 12}
                width={5}
                height={H - LABEL_H - 24}
                rx={2}
                fill="var(--accent)"
              />
            ))}
          </g>
        </svg>
      </div>
    </div>
  )
}
