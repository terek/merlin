// The Moments timeline (docs/moments.md, "The page"): a thin strip of the prompts typed per day over a month axis,
// then one row per seen moment, oldest first, and the suggestions after them. A row starts with the moment's label;
// its track holds one square for every stretch of days the moment came back. A click opens the row in place, as an
// accordion (one at a time): the details sit under it. Hovering raises a row a step. Nothing else moves.

import { useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { MomentDepth, MomentHit, MomentsReport, MomentView } from '../../api/types'
import { plural } from '../../lib/format'
import { sessionPath } from '../../lib/paths'
import { dayStart, parseTime, shortDate } from '../../lib/time'
import { RelTime } from '../../ui'
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
  type TimelineLayout,
} from './layout'
import { useLabelMeasure } from './measure'

/** The intensity strip, the month axis, and what is above the first row. */
const AREA_TOP = 4
const AREA_H = 22
const AXIS_H = 20
const R = GLYPH_R
/** Where a row's detail text starts: under its label. */
const INDENT = ROW_GLYPH_W

/** The words a depth is shown with. */
export const DEPTH_WORD: Record<MomentDepth, string> = {
  routine: 'routine',
  paused: 'quiet lately',
  tried: 'tried',
  new: 'new',
}

/** What a row's mark can be: a depth, or the dotted ring of a suggestion. */
export type GlyphKind = MomentDepth | 'next'

/** The depth of a moment; an older API without `depth` is read from the status. */
export function depthOf(m: Pick<MomentView, 'status' | 'depth'>): MomentDepth {
  return m.depth ?? (m.status === 'habit' ? 'routine' : 'tried')
}

/** What each depth looks like, in a 12 x 12 box: a filled dot, a ring, a half-filled ring, a dot in a ring. */
function DepthShapes({ depth }: { depth: GlyphKind }) {
  const ring = { fill: 'var(--surface)', stroke: 'var(--accent)' }
  switch (depth) {
    case 'next':
      return (
        <circle
          cx="6"
          cy="6"
          r="4.5"
          fill="none"
          strokeWidth="1.5"
          strokeDasharray="1.6 1.4"
          style={{ stroke: 'var(--accent)' }}
        />
      )
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
export function Glyph({ depth, size = 11 }: { depth: GlyphKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="shrink-0">
      <title>{depth === 'next' ? 'to try' : DEPTH_WORD[depth]}</title>
      <DepthShapes depth={depth} />
    </svg>
  )
}

/** One quiet line that says what the marks before the labels mean. */
export function Legend() {
  const items: [GlyphKind, string][] = [
    ['routine', 'part of your routine'],
    ['paused', 'quiet lately'],
    ['tried', 'tried a few times'],
    ['new', 'new'],
    ['next', 'to try'],
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

export function Timeline({
  report,
  hover,
  pin,
  onHover,
  onPin,
  tickDay,
  onTick,
  onK,
}: {
  report: MomentsReport
  /** The moment under the pointer or the keyboard focus. */
  hover: string | null
  /** The open moment: a seen one, or a suggestion. */
  pin: string | null
  onHover: (id: string | null) => void
  onPin: (id: string) => void
  /** The day of the square under the pointer or chosen with the arrow keys. */
  tickDay: string | null
  onTick: (day: string | null) => void
  /** Days per bucket, as the measured width makes it. */
  onK: (k: number) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const since = report.since
  const measure = useLabelMeasure()
  const l = since ? layoutRows(report.moments, since, report.now, width, measure) : null
  const k = l ? daysPerBucket(l) : 1
  useEffect(() => onK(k), [k, onK])
  return (
    <div ref={wrap} className="w-full">
      {since && l && (
        <Chart
          report={report}
          layout={l}
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

/** A hit as a link into the session, at its turn. */
function hitPath(h: MomentHit): string {
  return sessionPath(h.session, h.turn !== undefined ? `t${h.turn}` : undefined)
}

function Chart({
  report,
  layout: l,
  measure,
  hover,
  pin,
  onHover,
  onPin,
  tickDay,
  onTick,
}: {
  report: MomentsReport
  layout: TimelineLayout
  measure: (text: string, weight?: number, size?: number) => number
  hover: string | null
  pin: string | null
  onHover: (id: string | null) => void
  onPin: (id: string) => void
  tickDay: string | null
  onTick: (day: string | null) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const now = new Date(report.now)
  const start = new Date(l.from).toISOString()
  const areaBottom = AREA_TOP + AREA_H
  const area = activityArea(report.activity ?? [], l, start, report.now)
  const areaPath =
    area.length > 0
      ? `M${area[0].x},${areaBottom} ${area.map((p) => `L${p.x.toFixed(1)},${(areaBottom - p.v * (AREA_H - 2)).toFixed(1)}`).join(' ')} L${area[area.length - 1].x},${areaBottom} Z`
      : ''
  const months = monthTicks(l)
  const byId = new Map(report.moments.map((m) => [m.id, m]))
  const suggested = report.suggestions
    .map((s) => ({ s, m: byId.get(s.moment) }))
    .filter((x): x is { s: (typeof report.suggestions)[number]; m: MomentView } => x.m !== undefined)
  // up and down move the focus from row to row
  const step = (e: React.KeyboardEvent, el: HTMLElement) => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!d) return false
    e.preventDefault()
    const all = [...(list.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])]
    all[Math.max(0, Math.min(all.length - 1, all.indexOf(el) + d))]?.focus()
    return true
  }
  const rowProps = (id: string, label: string) => ({
    'data-row': '',
    role: 'button' as const,
    tabIndex: 0,
    'aria-expanded': pin === id,
    'aria-label': label,
    className:
      'block w-full cursor-pointer outline-none focus-visible:[&_rect:first-of-type]:stroke-accent focus-visible:[&_rect:first-of-type]:stroke-[1.5]',
    onMouseEnter: () => onHover(id),
    onMouseLeave: () => onHover(null),
    onFocus: () => onHover(id),
    onBlur: () => onHover(null),
    onClick: () => onPin(id),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (step(e, e.currentTarget)) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onPin(id)
      }
    },
  })
  const band = (id: string) => (
    <rect
      x={0}
      y={0}
      width={l.width}
      height={ROWS_PITCH}
      rx={4}
      style={{ fill: pin === id ? 'var(--chip-sel)' : hover === id ? 'var(--surface-2)' : 'transparent' }}
    />
  )
  const label = (m: MomentView) => {
    const text = fitText(m.title, l.left - ROW_GLYPH_W - 8, (t) => measure(t, 400, ROW_LABEL_SIZE))
    return (
      <text
        x={ROW_GLYPH_W}
        y={ROWS_PITCH / 2 + 4}
        fontSize={ROW_LABEL_SIZE}
        fontWeight={pin === m.id ? 600 : 400}
        style={{ fill: pin === m.id ? 'var(--accent)' : 'var(--text)' }}
      >
        {text}
        {text !== m.title && <title>{m.title}</title>}
      </text>
    )
  }
  const mark = (kind: GlyphKind) => (
    <svg x={PAD_X + R - 5} y={ROWS_PITCH / 2 - 5} width={10} height={10} viewBox="0 0 12 12">
      <title>{kind === 'next' ? 'to try' : kind}</title>
      <DepthShapes depth={kind} />
    </svg>
  )
  return (
    <div>
      <svg width={l.width} height={areaBottom + AXIS_H} role="img" aria-label="Prompts per day" className="block">
        <title>Prompts per day</title>
        {areaPath && <path d={areaPath} style={{ fill: 'var(--faint)', opacity: 0.32 }} />}
        <line x1={l.left} x2={l.right} y1={areaBottom + 0.5} y2={areaBottom + 0.5} style={{ stroke: 'var(--line)' }} />
        {months.map((t) => (
          <g key={t.label}>
            <line x1={t.x} x2={t.x} y1={areaBottom} y2={areaBottom + 4} style={{ stroke: 'var(--line)' }} />
            <text x={t.x + 4} y={areaBottom + 14} fontSize={11} style={{ fill: 'var(--muted)' }}>
              {t.label}
            </text>
          </g>
        ))}
      </svg>
      <div ref={list} className="relative">
        {/* the month lines, one overlay behind every row and panel so that they run through the whole list */}
        <svg width={l.width} className="pointer-events-none absolute top-0 left-0 h-full" aria-hidden focusable="false">
          <title>Months</title>
          {months.map((t) => (
            <line key={t.label} x1={t.x} x2={t.x} y1={0} y2="100%" style={{ stroke: 'var(--line)', opacity: 0.6 }} />
          ))}
        </svg>
        {l.rows.map((m) => {
          const on = pin === m.id
          const raised = !on && hover === m.id
          const ticks = bucketTicks(m, l, start)
          return (
            <div key={m.id} className="relative">
              <div {...rowProps(m.id, `${m.title}, ${depthOf(m)}, first ${dateOf(m.first, now)}`)}>
                <svg width={l.width} height={ROWS_PITCH} className="block">
                  <title>{m.title}</title>
                  {band(m.id)}
                  {mark(depthOf(m))}
                  {label(m)}
                  {ticks.length > 0 && (
                    <line
                      x1={Math.min(...ticks.map((t) => t.x))}
                      x2={l.right}
                      y1={ROWS_PITCH / 2}
                      y2={ROWS_PITCH / 2}
                      style={{
                        stroke: on ? 'var(--accent)' : raised ? 'var(--text)' : 'var(--muted)',
                        opacity: on ? 0.3 : raised ? 0.2 : 0.1,
                      }}
                    />
                  )}
                  <Squares ticks={ticks} on={on} raised={raised} tickDay={tickDay} onTick={onTick} now={now} />
                </svg>
              </div>
              {on && <Panel moment={m} tickDay={tickDay} start={start} k={daysPerBucket(l)} now={now} />}
            </div>
          )
        })}
        {suggested.map(({ s, m }) => (
          <div key={m.id} className="relative">
            <div {...rowProps(m.id, `To try: ${m.title}`)}>
              <svg width={l.width} height={ROWS_PITCH} className="block">
                <title>{m.title}</title>
                {band(m.id)}
                {mark('next')}
                {label(m)}
              </svg>
            </div>
            {pin === m.id && <NextPanel moment={m} reason={s.reason} example={s.example} />}
          </div>
        ))}
      </div>
    </div>
  )
}

/** The squares of a row's track; on the open row they are bigger, accent, and open that day's session. */
function Squares({
  ticks,
  on,
  raised,
  tickDay,
  onTick,
  now,
}: {
  ticks: ReturnType<typeof bucketTicks>
  on: boolean
  raised: boolean
  tickDay: string | null
  onTick: (day: string | null) => void
  now: Date
}) {
  const navigate = useNavigate()
  const cy = ROWS_PITCH / 2
  return (
    <>
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
            y={0}
            width={Math.max(1, t.x1 - t.x0)}
            height={ROWS_PITCH}
            fill="transparent"
            onMouseEnter={() => onTick(t.day)}
            onMouseLeave={() => onTick(null)}
            onClick={(e) => {
              const to = tickPath(t)
              if (!to) return
              e.stopPropagation()
              navigate(to)
            }}
          >
            <title>{`${rangeOf(t, now)}: ${plural(t.hits, 'time')}`}</title>
          </rect>
        ))}
    </>
  )
}

/** The details under an open row: quiet, indented to the label, spanning the whole width. */
function Panel({
  moment: m,
  tickDay,
  start,
  k,
  now,
}: {
  moment: MomentView
  tickDay: string | null
  start: string
  k: number
  now: Date
}) {
  const latest = m.examples?.[0]
  const tick = tickDay ? bucketDays(m.days ?? [], start, k).find((d) => d.day === tickDay) : undefined
  return (
    <div className="space-y-0.5 pr-4 pb-2 text-sec" style={{ paddingLeft: INDENT }}>
      <p className="flex flex-wrap items-center gap-x-2 text-muted">
        <span className="font-medium text-fg">{depthOf(m)}</span>
        <Dot />
        <span>first {dateOf(m.first, now)}</span>
        <Dot />
        <span>{timesInWeeks(m)}</span>
        {m.last && (
          <>
            <Dot />
            <span>
              last <RelTime time={m.last} />
            </span>
          </>
        )}
      </p>
      <p>{m.what}</p>
      {m.detects && (
        <p className="text-faint">
          <span>How Merlin spots it:</span> {m.detects}
        </p>
      )}
      <p className="flex flex-wrap gap-x-4">
        {m.firstHit && <Link to={hitPath(m.firstHit)}>Open the first time →</Link>}
        {latest && (
          <Link to={hitPath(latest)} title={latest.note}>
            {latest.note || 'Open the latest'} →
          </Link>
        )}
      </p>
      <p className="min-h-5 text-muted">
        {tick && (
          <>
            <span className="font-medium text-fg">{rangeOf(tick, now)}</span> · {plural(tick.hits, 'time')}
            {tick.example?.note ? ` · ${tick.example.note}` : ''}
            {tick.example && <span className="text-faint"> · click to open</span>}
          </>
        )}
      </p>
    </div>
  )
}

/** The details under an open suggestion. */
function NextPanel({ moment: m, reason, example }: { moment: MomentView; reason?: string; example?: MomentHit }) {
  return (
    <div className="space-y-0.5 pr-4 pb-2 text-sec" style={{ paddingLeft: INDENT }}>
      {reason && <p>{reason}</p>}
      <p className="text-muted">{m.try}</p>
      {example && (
        <p>
          <Link to={hitPath(example)}>See it in your sessions →</Link>
        </p>
      )}
      {m.detects && (
        <p className="text-faint">
          <span>How Merlin spots it:</span> {m.detects}
        </p>
      )}
    </div>
  )
}

function Dot() {
  return (
    <span aria-hidden className="text-faint">
      ·
    </span>
  )
}
