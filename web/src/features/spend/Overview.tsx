// The overview above the time view of a session that ran long or on more than one day: the whole tree
// on one wall-clock scale (idle time squeezed out as in the plot) with a brush on it. The brush is the
// window the plot shows. Drag across the strip for a new range, drag the window to move it, drag a
// handle to resize it, click anywhere on it to select the day partition there (sessions of a day or more; the
// partitions tile the strip, cut at local midnights, a whole idle day cut once); ← → move the window by its own
// width (a partition at a time when it is one).
import { type KeyboardEvent, type PointerEvent, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'
import { formatDuration, formatMoney } from '../../lib/format'
import { MISS_COLOR, SPEND_COLOR } from './TimeView'
import {
  axisSpans,
  boundsOf,
  contextEnvelope,
  dayParts,
  dragWindow,
  hasDays,
  type Part,
  resizeWindow,
  spendDensity,
  stepWindow,
  stripEnds,
  type TimeAxis,
  type Timeline,
  timeAxis,
  type Win,
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
/** The window: a band BAND tall, centred on the line between the context area and the spend bars. */
const AXIS = CTX_BASE + 0.5
const BAND = 20

const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const longDate = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
const month = (t: number) => new Date(t).toLocaleDateString([], { month: 'short' })

export interface OverviewProps {
  /** The whole tree. */
  timeline: Timeline
  win: Win
  /** What the plot really shows: `win`, grown to the end of the turn it cuts (`effectiveWindow`). */
  eff: Win
  onWin: (w: Win) => void
  /** The start of the pinned turn, if there is one. */
  pinnedT?: number
  /** The last work episode: what "Latest" goes back to. */
  latest: Win
  /** Where the "Showing … Latest All" line goes (a heading row); it stays above the strip when there is none. */
  controlsHost?: HTMLElement | null
  /** The strip sits in a head of its own (a pinned slot): no space under it, and nothing above it but the strip. */
  docked?: boolean
}

/** The strip's time axis at a width: the whole tree, idle time squeezed out. */
export const stripAxis = (timeline: Timeline, width: number): TimeAxis =>
  timeAxis(axisSpans(timeline), PAD, Math.max(PAD + 80, width - PAD), undefined, STRIP_BREAKS)

type Drag =
  | { mode: 'move'; x: number; xlo: number; xhi: number; moved: boolean }
  | { mode: 'lo' | 'hi' }
  | { mode: 'new'; x: number; t: number; moved: boolean }

export function Overview({ timeline, win, eff, onWin, pinnedT, latest, controlsHost, docked }: OverviewProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const drag = useRef<Drag | null>(null)
  const [cursor, setCursor] = useState('crosshair')
  // the x under the pointer (not dragging, not at an edge): the partition a click there selects gets a soft wash
  const [hoverX, setHoverX] = useState<number | null>(null)
  const x0 = PAD
  const x1 = Math.max(x0 + 80, width - PAD)
  const bounds = useMemo(() => boundsOf(timeline), [timeline])
  const axis = useMemo(() => stripAxis(timeline, width), [timeline, width])

  const env = useMemo(() => contextEnvelope(timeline, axis, COL), [timeline, axis])
  const peak = Math.max(1, ...env)
  const dens = useMemo(() => spendDensity(timeline, axis, COL), [timeline, axis])
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

  // the partitions of the strip: cut at local midnights (a whole idle day cut once), tiling the strip's background
  const parts = useMemo(() => dayParts(timeline, axis, bounds, 0, width), [timeline, axis, bounds, width])
  // a label at the start of each partition it fits in
  const labels = useMemo(() => {
    let prev = -1
    return parts.flatMap((p, i) => {
      const d = new Date(p.m)
      const text =
        d.getMonth() !== prev
          ? `${month(p.m)} ${d.getDate()}`
          : `${d.toLocaleDateString([], { weekday: 'short' })} ${d.getDate()}`
      if (text.length * 5.5 + 4 > p.x1 - p.x0) return []
      prev = d.getMonth()
      return [{ i, x: p.x0 + 2, text }]
    })
  }, [parts])
  const lines = useMemo(() => parts.slice(1).map((p) => p.x0), [parts])

  // the brush at an end of the session is drawn at the strip's end: the first piece's start, and the last
  // activity's end (not the wait for a limit's reset)
  const ends = useMemo(() => stripEnds(timeline, axis, bounds), [timeline, axis, bounds])
  const sx = (t: number) => (t <= bounds.t0 ? ends.x0 : t >= bounds.t1 ? ends.x1 : axis.x(t))
  const xlo = sx(win.lo)
  const xhi = Math.max(xlo + 2, sx(win.hi))
  const xeff0 = Math.min(xlo, sx(eff.lo))
  const xeff = Math.max(xhi, sx(eff.hi))
  // a day on the locator is a partition as drawn; a session shorter than a day has none
  const daily = hasDays(bounds)
  const partAt = (x: number): Part => parts.find((p) => x < p.x1) ?? parts[parts.length - 1]
  const dayIdx = daily
    ? parts.findIndex((p) => Math.abs(p.win.lo - win.lo) < 1000 && Math.abs(p.win.hi - win.hi) < 1000)
    : -1
  const wash = hoverX === null || !daily ? null : partAt(hoverX)

  const at = (e: PointerEvent) => e.clientX - (e.currentTarget as Element).getBoundingClientRect().left
  const zoneAt = (x: number): 'lo' | 'hi' | 'move' | 'new' =>
    Math.abs(x - xlo) <= GRAB ? 'lo' : Math.abs(x - xhi) <= GRAB ? 'hi' : x > xlo && x < xhi ? 'move' : 'new'

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    e.preventDefault()
    setHoverX(null)
    const x = at(e)
    const z = zoneAt(x)
    drag.current =
      z === 'move'
        ? { mode: 'move', x, xlo, xhi, moved: false }
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
      // an edge is for resizing; anywhere else a click selects the day under the pointer
      setHoverX(z === 'lo' || z === 'hi' ? null : x)
      return
    }
    if (d.mode === 'move') {
      if (Math.abs(x - d.x) > 3) d.moved = true
      if (!d.moved) return
      // the brush moves as the pointer does, its width on the strip kept: what the user holds is the brush
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
    // a click without movement, inside the window or out, selects the day under the pointer
    if ((d?.mode === 'new' || d?.mode === 'move') && !d.moved) {
      if (daily) onWin(partAt(at(e)).win)
    }
  }
  const onCancel = () => {
    drag.current = null
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const w = win.hi - win.lo
    let next: Win | undefined
    const step = (dir: -1 | 1) => parts[Math.max(0, Math.min(parts.length - 1, dayIdx + dir))].win
    if (e.key === 'ArrowLeft') next = dayIdx >= 0 ? step(-1) : stepWindow(win, -1, [], bounds)
    else if (e.key === 'ArrowRight') next = dayIdx >= 0 ? step(1) : stepWindow(win, 1, [], bounds)
    else if (e.key === 'Home') next = dayIdx >= 0 ? parts[0].win : dragWindow(bounds.t0, bounds.t0 + w, bounds)
    else if (e.key === 'End')
      next = dayIdx >= 0 ? parts[parts.length - 1].win : dragWindow(bounds.t1 - w, bounds.t1, bounds)
    if (!next) return
    e.preventDefault()
    onWin(next)
  }

  const whole = eff.lo <= bounds.t0 && eff.hi >= bounds.t1
  const from = Math.max(eff.lo, timeline.t0)
  const to = Math.min(eff.hi, timeline.t1)
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString()

  const showing = (
    <div className="flex min-h-5 items-baseline gap-x-3 overflow-hidden whitespace-nowrap text-sec normal-case tracking-normal">
      <span className="text-muted">Showing</span>
      <span className="font-medium">
        {whole
          ? 'the whole session'
          : dayIdx >= 0
            ? longDate(parts[dayIdx].m)
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
      {!controlsHost && (
        <span className="truncate text-faint">
          click a day (sessions over a day), drag to select a range, drag the window or its edges
        </span>
      )}
    </div>
  )

  return (
    <div className={docked ? undefined : 'mb-3'}>
      {controlsHost ? createPortal(showing, controlsHost) : docked ? null : showing}
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
        className={cn(docked ? undefined : 'mt-1', 'rounded-badge')}
      >
        <svg
          data-testid="session-locator-axis"
          width={width}
          height={H}
          role="img"
          aria-label="The whole session over time"
          className="block touch-none select-none"
          style={{ cursor, userSelect: 'none', WebkitUserSelect: 'none' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onCancel}
          onPointerLeave={() => setHoverX(null)}
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
          {wash && (
            <rect
              x={wash.x0}
              y={0}
              width={wash.x1 - wash.x0}
              height={H}
              fill="var(--accent)"
              fillOpacity={0.08}
              pointerEvents="none"
            />
          )}
          {lines.map((x) => (
            <line key={x} x1={x} x2={x} y1={0} y2={H} stroke="var(--faint)" strokeOpacity={0.7} strokeWidth={1} />
          ))}
          <path d={area} fill="var(--series-1)" fillOpacity={0.28} stroke="none" />
          <line x1={x0} x2={x1} y1={CTX_BASE + 0.5} y2={CTX_BASE + 0.5} stroke="var(--line)" strokeWidth={1} />
          {dens.map((d, i) => {
            const total = d.total ?? 0
            if (total <= 0) return null
            const k = (BAR_BASE - BAR_TOP) / maxBar
            const h = Math.max(0.75, total * k)
            const miss = Math.min(h, (d.miss ?? 0) * k)
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions
              <g key={i}>
                <rect x={x0 + i * COL} y={BAR_BASE - h} width={COL} height={h - miss} fill={SPEND_COLOR} />
                {miss > 0 && <rect x={x0 + i * COL} y={BAR_BASE - miss} width={COL} height={miss} fill={MISS_COLOR} />}
              </g>
            )
          })}
          {labels.map((l) => (
            <text
              key={l.i}
              x={l.x}
              y={LABEL_H - 3}
              fontSize={10}
              fill={dayIdx === l.i ? 'var(--text)' : 'var(--muted)'}
              fontWeight={dayIdx === l.i ? 600 : 400}
              pointerEvents="none"
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
              width={xeff0 <= ends.x0 ? 0 : xeff0}
              height={H - LABEL_H}
              fill="var(--surface)"
              opacity={0.55}
            />
            <rect
              x={xeff}
              y={LABEL_H}
              width={xeff >= ends.x1 && timeline.wait === undefined ? 0 : Math.max(0, width - xeff)}
              height={H - LABEL_H}
              fill="var(--surface)"
              opacity={0.55}
            />
            <rect x={xlo} y={AXIS - BAND / 2} width={xhi - xlo} height={BAND} fill="var(--accent)" fillOpacity={0.16} />
            {/* a turn the window cuts runs on, and the plot shows it whole: a fainter continuation */}
            {(
              [
                [xeff0, xlo, 'l'],
                [xhi, xeff, 'r'],
              ] as const
            ).map(([x0, x1, side]) =>
              x1 - x0 > 0.5 ? (
                <g key={side} data-testid={`overview-effective-${side}`}>
                  <rect
                    x={x0}
                    y={AXIS - BAND / 2}
                    width={x1 - x0}
                    height={BAND}
                    fill="var(--accent)"
                    fillOpacity={0.07}
                  />
                </g>
              ) : null,
            )}
            {[xlo, xhi].map((x, i) => (
              <rect
                key={i === 0 ? 'lo' : 'hi'}
                x={x - 1.5}
                y={AXIS - BAND / 2}
                width={3}
                height={BAND}
                rx={1.5}
                fill="var(--accent)"
              />
            ))}
          </g>
        </svg>
      </div>
    </div>
  )
}
