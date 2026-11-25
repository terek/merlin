// The Moments timeline (docs/moments.md, "The page"): a thin strip of the prompts typed per day over a month axis,
// then one row per seen moment, oldest first, and the suggestions after them. A row starts with the moment's label;
// its track holds one square for every stretch of days the moment came back. A click opens the row in place, as an
// accordion (one at a time): the details sit under it. Hovering raises a row a step. Nothing else moves.

import { ArrowDown, ArrowUp } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { MomentDepth, MomentHit, MomentPersona, MomentsReport, MomentTechnique, MomentView } from '../../api/types'
import { cn } from '../../lib/cn'
import { plural } from '../../lib/format'
import { sessionPath } from '../../lib/paths'
import { dayStart, parseTime, shortDate } from '../../lib/time'
import { useWidth } from '../spend/useWidth'
import {
  activityArea,
  type Bucket,
  bucketTicks,
  clickSort,
  DEPTH_RIGHT,
  daysPerBucket,
  depthOf,
  dollars,
  fitText,
  GROUP_W,
  groupMoments,
  isWatching,
  layoutRows,
  type MomentGroup,
  monthTicks,
  placeSuggestions,
  ROW_GLYPH_W,
  ROW_LABEL_SIZE,
  ROWS_PITCH,
  type Sort,
  type SortKey,
  STRIP_PX,
  saves,
  savesCell,
  type TimelineLayout,
} from './layout'
import { useLabelMeasure } from './measure'
import { SavedLine, TechniqueSection } from './Technique'

/** The intensity strip, the month axis, and what is above the first row. */
const AREA_TOP = 0
const AREA_H = 24
/** The room an arrow takes beside a header label, shown or not. */
const ARROW_SLOT = 13
/** Where a row's detail text starts: under its label. */
const INDENT = ROW_GLYPH_W

/** The words a depth is shown with. */
export const DEPTH_WORD: Record<MomentDepth, string> = {
  routine: 'routine',
  paused: 'quiet lately',
  tried: 'tried',
  new: 'new',
}

/**
 * What a row's mark can be: a depth, the dotted ring of a suggestion, the red disc of a technique that saves money, or
 * the clock of a fix being watched.
 */
export type GlyphKind = MomentDepth | 'next' | 'save' | 'watching'

/** The words a mark is shown with in a tooltip. */
function kindWord(k: GlyphKind): string {
  return k === 'next' ? 'to try' : k === 'save' ? 'could save' : k === 'watching' ? 'watching' : DEPTH_WORD[k]
}

export { depthOf }

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
    case 'save':
      return <circle cx="6" cy="6" r="5" style={{ fill: 'var(--bad)' }} />
    case 'watching':
      return (
        <>
          <circle cx="6" cy="6" r="4.75" strokeWidth="1.25" style={ring} />
          <path
            d="M6 3 V6 L8.2 7.2"
            fill="none"
            strokeWidth="1.15"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ stroke: 'var(--accent)' }}
          />
        </>
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
      <title>{kindWord(depth)}</title>
      <DepthShapes depth={depth} />
    </svg>
  )
}

/** The depth marks, in the order of the Depth sort. */
const DEPTH_KEY: [GlyphKind, string][] = [
  ['routine', 'routine'],
  ['paused', 'quiet lately'],
  ['new', 'new'],
  ['tried', 'tried'],
  ['next', 'to try'],
  ['save', 'could save'],
  ['watching', 'watching'],
]

/** The key of the Moments page, for the shell's legend panel: symbols and a few words, as on the session page. */
export function MomentsKey() {
  const group = (title: string, children: React.ReactNode) => (
    <section className="mb-2.5">
      <h4 className="mb-1 font-medium text-[0.6875rem] text-faint uppercase tracking-wide">{title}</h4>
      <ul className="m-0 grid list-none grid-cols-[28px_1fr] items-center gap-x-2 gap-y-1.5 p-0">{children}</ul>
    </section>
  )
  const sample = (title: string, children: React.ReactNode) => (
    <svg width={28} height={16} className="shrink-0">
      <title>{title}</title>
      {children}
    </svg>
  )
  return (
    <div data-testid="moments-key" className="text-meta text-muted">
      {group(
        'Depth',
        <>
          {DEPTH_KEY.map(([d, word]) => (
            <li key={d} className="contents">
              <span className="flex justify-center">
                <Glyph depth={d} size={10} />
              </span>
              <span>{word}</span>
            </li>
          ))}
        </>,
      )}
      {group(
        'Saves',
        <>
          <li className="contents">
            {sample(
              'Could save',
              <text x={14} y={12} fontSize={11} textAnchor="middle" style={{ fill: 'var(--bad)' }}>
                ≈ $
              </text>,
            )}
            <span>could save</span>
          </li>
          <li className="contents">
            {sample(
              'Saving',
              <text x={14} y={12} fontSize={11} textAnchor="middle" style={{ fill: 'var(--ok)' }}>
                ≈ $
              </text>,
            )}
            <span>saving</span>
          </li>
        </>,
      )}
      {group(
        'Groups',
        <li className="contents">
          {sample(
            'Practised',
            <>
              <rect x={4} y={6} width={20} height={4} rx={2} style={{ fill: 'var(--line)' }} />
              <rect x={4} y={6} width={14} height={4} rx={2} style={{ fill: 'var(--accent)', opacity: 0.45 }} />
              <rect x={4} y={6} width={8} height={4} rx={2} style={{ fill: 'var(--accent)' }} />
            </>,
          )}
          <span>practised</span>
        </li>,
      )}
      {group(
        'Timeline',
        <>
          <li className="contents">
            {sample('A day', <rect x={12} y={6} width={4} height={4} style={{ fill: 'var(--muted)' }} />)}
            <span>day, darker = more</span>
          </li>
          <li className="contents">
            {sample(
              'Prompts per day',
              <rect x={2} y={4} width={24} height={9} style={{ fill: 'var(--faint)', opacity: 0.32 }} />,
            )}
            <span>prompts per day</span>
          </li>
        </>,
      )}
    </div>
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

type GroupChoices = Partial<Record<MomentPersona, boolean>>

export function Timeline({
  report,
  hover,
  pin,
  onHover,
  onPin,
  tickDay,
  onTick,
  onK,
  sort,
  onSort,
  onCopy,
  groupChoices,
  onGroup,
}: {
  report: MomentsReport
  sort: Sort
  onSort: (s: Sort) => void
  /** The remembered open or closed state of each group, and a click on a group's header. */
  groupChoices: GroupChoices
  onGroup: (persona: MomentPersona, open: boolean) => void
  /** The person copied a technique's fix. */
  onCopy?: (id: string) => void
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
  const again = placeSuggestions(report.moments, report.suggestions).again
  const tagWidth = (m: MomentView) => tagsWidth(rowTags(again.has(m.id)), measure)
  const l = since
    ? layoutRows(report.moments, since, report.now, width, measure, tagWidth, suggestedMoments(report))
    : null
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
          sort={sort}
          onSort={onSort}
          onCopy={onCopy}
          groupChoices={groupChoices}
          onGroup={onGroup}
        />
      )}
    </div>
  )
}

/** The moments of the suggestions, in order. */
function suggestedMoments(report: MomentsReport): MomentView[] {
  const byId = new Map(report.moments.map((m) => [m.id, m]))
  return report.suggestions.flatMap((s) => byId.get(s.moment) ?? [])
}

/** A small word after a row's title. */
interface RowTag {
  text: string
}

/** The tags after a seen row's title: "try again" (the saving has its own column). */
function rowTags(again: boolean): RowTag[] {
  return again ? [{ text: 'try again' }] : []
}

const TAG_SIZE = 11
const TAG_GAP = 8

function tagsWidth(tags: RowTag[], measure: (text: string, weight?: number, size?: number) => number): number {
  return tags.reduce((n, t) => n + measure(t.text, 400, TAG_SIZE) + TAG_GAP, 0)
}

/** The mark of a seen row: the clock while its fix is watched, else its depth. */
function seenMark(m: MomentView): GlyphKind {
  return isWatching(m.technique) ? 'watching' : depthOf(m)
}

/** The mark of a suggestion's row: the clock while watched, the red disc for a saving of $20 a month or more. */
function nextMark(t: MomentTechnique | undefined): GlyphKind {
  return isWatching(t) ? 'watching' : saves(t) ? 'save' : 'next'
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
  sort,
  onSort,
  onCopy,
  groupChoices,
  onGroup,
}: {
  report: MomentsReport
  sort: Sort
  onSort: (s: Sort) => void
  groupChoices: GroupChoices
  onGroup: (persona: MomentPersona, open: boolean) => void
  onCopy?: (id: string) => void
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
  const startW = measure('START', 400, 12) * 1.1 + ARROW_SLOT + 8
  const endW = measure('END', 400, 12) * 1.1 + ARROW_SLOT + 8
  const { again, rows: suggested } = placeSuggestions(report.moments, report.suggestions)
  // up and down move the focus from row to row
  const step = (e: React.KeyboardEvent, el: HTMLElement) => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!d) return false
    e.preventDefault()
    const all = [...(list.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])]
    all[Math.max(0, Math.min(all.length - 1, all.indexOf(el) + d))]?.focus()
    return true
  }
  const groups = groupMoments(report.moments, l.rows, sort, again, groupChoices, pin)
  const groupProps = (g: MomentGroup) => ({
    'data-row': '',
    role: 'button' as const,
    tabIndex: 0,
    'aria-expanded': g.open,
    'aria-label': `${g.name}, ${g.seen.length} of ${g.total} practised`,
    className: 'block w-full cursor-pointer outline-none focus-visible:[&_rect:first-of-type]:stroke-accent',
    onMouseEnter: () => onHover(`group:${g.persona}`),
    onMouseLeave: () => onHover(null),
    onFocus: () => onHover(`group:${g.persona}`),
    onBlur: () => onHover(null),
    onClick: () => toggleGroup(g),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (step(e, e.currentTarget)) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggleGroup(g)
      }
    },
  })
  // a group held open only by its pinned row closes with the pin
  const toggleGroup = (g: MomentGroup) => {
    if (g.forced && pin) onPin(pin)
    onGroup(g.persona, !g.open)
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
  const label = (m: MomentView, tags: RowTag[], t?: MomentTechnique) => {
    const w = (t: string) => measure(t, 400, ROW_LABEL_SIZE)
    const cell = savesCell(m, t)
    const text = fitText(m.title, l.cols.title - ROW_GLYPH_W - 8 - tagsWidth(tags, measure), w)
    let tagX = ROW_GLYPH_W + w(text) + TAG_GAP
    return (
      <>
        <text x={ROW_GLYPH_W} y={ROWS_PITCH / 2 + 4} fontSize={ROW_LABEL_SIZE} style={{ fill: 'var(--text)' }}>
          {text}
          {text !== m.title && <title>{m.title}</title>}
        </text>
        {m.status !== 'unseen' && (
          <text
            x={l.cols.countRight}
            y={ROWS_PITCH / 2 + 4}
            fontSize={12}
            textAnchor="end"
            className="tabular-nums"
            style={{ fill: 'var(--muted)' }}
          >
            {m.hits}
          </text>
        )}
        {cell.text && (
          <text
            x={l.cols.savesRight}
            y={ROWS_PITCH / 2 + 4}
            fontSize={12}
            textAnchor="end"
            className="tabular-nums"
            style={{ fill: cell.color }}
          >
            <title>
              {cell.kind === 'green' ? 'already saving about this much a month' : 'could save about this much a month'}
            </title>
            {cell.text}
          </text>
        )}
        {tags.map((t) => {
          const x = tagX
          tagX += measure(t.text, 400, TAG_SIZE) + TAG_GAP
          return (
            <text key={t.text} x={x} y={ROWS_PITCH / 2 + 4} fontSize={TAG_SIZE} style={{ fill: 'var(--faint)' }}>
              {t.text}
            </text>
          )
        })}
      </>
    )
  }
  const mark = (kind: GlyphKind) => (
    <svg x={DEPTH_RIGHT - ARROW_SLOT / 2 - 5} y={ROWS_PITCH / 2 - 5} width={10} height={10} viewBox="0 0 12 12">
      <title>{kindWord(kind)}</title>
      <DepthShapes depth={kind} />
    </svg>
  )
  return (
    <div>
      <div className="relative" style={{ height: areaBottom }}>
        <svg width={l.width} height={areaBottom} role="img" aria-label="Prompts per day" className="block">
          <title>Prompts per day</title>
          {areaPath && <path d={areaPath} style={{ fill: 'var(--faint)', opacity: 0.32 }} />}
          <line
            x1={l.left}
            x2={l.right}
            y1={areaBottom - 0.5}
            y2={areaBottom - 0.5}
            style={{ stroke: 'var(--line)' }}
          />
          {months.map((t) => {
            const end = t.x > l.right - 40
            const mw = measure(t.label, 400, 11)
            const x0 = end ? t.x - 4 - mw : t.x + 4
            const hit = (a: number, b: number) => x0 < b && x0 + mw > a
            const hidden = hit(l.left - 4, l.left + startW + 4) || hit(l.right - endW - 4, l.right + 4)
            return (
              <g key={t.label}>
                <line x1={t.x} x2={t.x} y1={areaBottom - 5} y2={areaBottom} style={{ stroke: 'var(--line)' }} />
                {!hidden && (
                  <text
                    x={end ? t.x - 4 : t.x + 4}
                    textAnchor={end ? 'end' : 'start'}
                    y={areaBottom - 7}
                    fontSize={11}
                    style={{ fill: 'var(--faint)' }}
                  >
                    {t.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        <div className="absolute flex text-sec" style={{ left: 0, top: areaBottom - 20, height: 20 }}>
          <span className="absolute -translate-x-full" style={{ left: DEPTH_RIGHT }}>
            <SortButton label="Depth" k="depth" sort={sort} onSort={onSort} />
          </span>
          <span className="absolute" style={{ left: ROW_GLYPH_W }}>
            <SortButton label="Practice" k="moment" sort={sort} onSort={onSort} />
          </span>
          <span className="absolute -translate-x-full" style={{ left: l.cols.countRight }}>
            <SortButton label="Count" k="count" sort={sort} onSort={onSort} arrowFirst />
          </span>
          <span className="absolute -translate-x-full" style={{ left: l.cols.savesRight }}>
            <SortButton label="Saves" k="saves" sort={sort} onSort={onSort} arrowFirst />
          </span>
          <span className="absolute" style={{ left: l.left }}>
            <SortButton label="Start" k="start" sort={sort} onSort={onSort} halo />
          </span>
          <span className="absolute -translate-x-full" style={{ left: l.right }}>
            <SortButton label="End" k="end" sort={sort} onSort={onSort} arrowFirst halo />
          </span>
        </div>
      </div>
      <div ref={list} className="relative">
        {/* the month lines, one overlay behind every row and panel so that they run through the whole list */}
        <svg width={l.width} className="pointer-events-none absolute top-0 left-0 h-full" aria-hidden focusable="false">
          <title>Months</title>
          {months.map((t) => (
            <line key={t.label} x1={t.x} x2={t.x} y1={0} y2="100%" style={{ stroke: 'var(--line)', opacity: 0.6 }} />
          ))}
        </svg>
        {groups.map((g) => (
          <div key={g.persona}>
            <GroupHeader g={g} l={l} start={start} hover={hover === `group:${g.persona}`} rowProps={groupProps(g)} />
            {g.rows.map((m) => {
              const on = pin === m.id
              const raised = !on && hover === m.id
              const ticks = bucketTicks(m, l, start)
              return (
                <div key={m.id} className="relative">
                  <div {...rowProps(m.id, `${m.title}, ${kindWord(seenMark(m))}, first ${dateOf(m.first, now)}`)}>
                    <svg width={l.width} height={ROWS_PITCH} className="block">
                      <title>{m.title}</title>
                      {band(m.id)}
                      {mark(seenMark(m))}
                      {label(m, rowTags(again.has(m.id)), m.technique)}
                      <Track ticks={ticks} on={on} raised={raised} tickDay={tickDay} onTick={onTick} now={now} l={l} />
                    </svg>
                  </div>
                  {on && <Panel moment={m} again={again.get(m.id)} usual={report.usualHarness} onCopy={onCopy} />}
                </div>
              )
            })}
          </div>
        ))}
        {suggested.length > 0 && (
          <div
            className="flex items-end pb-0.5 text-faint text-meta uppercase tracking-wide"
            style={{ height: ROWS_PITCH + 4, paddingLeft: ROW_GLYPH_W }}
          >
            To try
          </div>
        )}
        {suggested.map(({ s, m }) => {
          const sugTicks = bucketTicks({ days: s.technique?.days }, l, start)
          return (
            <div key={m.id} className="relative">
              <div {...rowProps(m.id, `${kindWord(nextMark(s.technique))}: ${m.title}`)}>
                <svg width={l.width} height={ROWS_PITCH} className="block">
                  <title>{m.title}</title>
                  {band(m.id)}
                  {mark(nextMark(s.technique))}
                  {label(m, [], s.technique)}
                  <Track
                    ticks={sugTicks}
                    on={pin === m.id}
                    raised={hover === m.id && pin !== m.id}
                    tickDay={tickDay}
                    onTick={onTick}
                    now={now}
                    l={l}
                  />
                </svg>
              </div>
              {pin === m.id && <NextPanel moment={m} s={s} now={now} usual={report.usualHarness} onCopy={onCopy} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A group's header row: chevron, name, how much of it is practised (fraction and bar), the sums and a quiet track. */
function GroupHeader({
  g,
  l,
  start,
  hover,
  rowProps,
}: {
  g: MomentGroup
  l: TimelineLayout
  start: string
  hover: boolean
  rowProps: React.HTMLAttributes<HTMLElement>
}) {
  const cy = ROWS_PITCH / 2
  const ticks = bucketTicks({ days: g.days }, l, start)
  const seen = g.seen.length
  const BAR_W = 40
  const chevX = DEPTH_RIGHT - ARROW_SLOT / 2
  const barX = l.cols.title + GROUP_W - BAR_W - 8
  const share = (n: number) => (g.total > 0 ? (n / g.total) * BAR_W : 0)
  return (
    <div {...rowProps}>
      <svg width={l.width} height={ROWS_PITCH} className="block">
        <title>{`${g.name}: ${seen} of ${g.total} practised`}</title>
        <rect
          x={0}
          y={0}
          width={l.width}
          height={ROWS_PITCH}
          rx={4}
          style={{ fill: hover ? 'var(--surface-2)' : 'transparent' }}
        />
        <path
          d={
            g.open ? `M${chevX - 3.5},${cy - 1.5} l3.5,3.5 l3.5,-3.5` : `M${chevX - 1.5},${cy - 3.5} l3.5,3.5 l-3.5,3.5`
          }
          fill="none"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ stroke: 'var(--muted)' }}
        />
        <text x={ROW_GLYPH_W} y={cy + 4} fontSize={ROW_LABEL_SIZE} fontWeight={500} style={{ fill: 'var(--text)' }}>
          {g.name}
        </text>
        <text x={l.cols.title} y={cy + 4} fontSize={12} className="tabular-nums" style={{ fill: 'var(--muted)' }}>
          {seen} / {g.total}
        </text>
        <rect x={barX} y={cy - 2} width={BAR_W} height={4} rx={2} style={{ fill: 'var(--line)' }} />
        {seen > 0 && (
          <rect
            x={barX}
            y={cy - 2}
            width={share(seen)}
            height={4}
            rx={2}
            style={{ fill: 'var(--accent)', opacity: 0.45 }}
          />
        )}
        {g.routine > 0 && (
          <rect x={barX} y={cy - 2} width={share(g.routine)} height={4} rx={2} style={{ fill: 'var(--accent)' }} />
        )}
        {g.hits > 0 && (
          <text
            x={l.cols.countRight}
            y={cy + 4}
            fontSize={12}
            textAnchor="end"
            className="tabular-nums"
            style={{ fill: 'var(--muted)' }}
          >
            {g.hits}
          </text>
        )}
        {g.savedUSD >= 1 && (
          <text
            x={l.cols.savesRight}
            y={cy + 4}
            fontSize={12}
            textAnchor="end"
            className="tabular-nums"
            style={{ fill: 'var(--ok)' }}
          >
            {`≈ ${dollars(g.savedUSD)} / mo`}
          </text>
        )}
        {ticks.map((t) => (
          <rect
            key={t.day}
            x={t.x}
            y={cy - STRIP_PX / 2}
            width={STRIP_PX}
            height={STRIP_PX}
            style={{ fill: 'var(--muted)', opacity: 0.08 + t.h * 0.2 }}
          />
        ))}
      </svg>
    </div>
  )
}

/** A row's track: the line from its first square to the end, and the squares. */
function Track({
  ticks,
  on,
  raised,
  tickDay,
  onTick,
  now,
  l,
}: {
  ticks: ReturnType<typeof bucketTicks>
  on: boolean
  raised: boolean
  tickDay: string | null
  onTick: (day: string | null) => void
  now: Date
  l: TimelineLayout
}) {
  return (
    <>
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
    </>
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
            <title>{`${rangeOf(t, now)} · ${plural(t.hits, 'time')}${t.example?.note ? ` · ${t.example.note}` : ''}`}</title>
          </rect>
        ))}
    </>
  )
}

/** A column header that sorts: the active one shows an arrow; the same one again flips the direction. */
function SortButton({
  label,
  k,
  sort,
  onSort,
  arrowFirst,
  halo,
}: {
  label: string
  k: SortKey
  sort: Sort
  onSort: (s: Sort) => void
  /** The arrow's slot is before the label (right-aligned headers), else after it. */
  arrowFirst?: boolean
  /** Drawn over the strip: a pill in the page colour keeps it readable. */
  halo?: boolean
}) {
  const active = sort.key === k
  // the slot is always there, and invisible when the column is not the sort
  const Icon = active && sort.dir === 'desc' ? ArrowDown : ArrowUp
  const arrow = (
    <span className={cn('inline-flex shrink-0 justify-center', !active && 'invisible')} style={{ width: ARROW_SLOT }}>
      <Icon size={11} aria-hidden />
    </span>
  )
  return (
    <button
      type="button"
      onClick={() => onSort(clickSort(sort, k))}
      title={`Sort by ${label.toLowerCase()}`}
      className={cn(
        'inline-flex h-5 cursor-pointer items-center align-top text-meta uppercase tracking-wide hover:text-fg',
        halo && 'rounded bg-surface',
        active ? 'text-fg' : 'text-faint',
      )}
    >
      {arrowFirst && arrow}
      {label}
      {!arrowFirst && arrow}
    </button>
  )
}

/** What a suggestion says: the reason, the try text and, when the symptom has one, where it shows. */
function Suggestion({ moment: m, reason, example }: { moment: MomentView; reason?: string; example?: MomentHit }) {
  return (
    <div className="space-y-0.5 pt-1">
      {reason && <p>{reason}</p>}
      <p className="text-muted">{m.try}</p>
      {example && (
        <p>
          <Link to={hitPath(example)}>See it in your sessions →</Link>
        </p>
      )}
    </div>
  )
}

/** What Merlin says a practice is, and how it spots it. */
function About({ moment: m }: { moment: MomentView }) {
  return (
    <>
      <p>{m.what}</p>
      {(m.detects || m.category) && (
        <p className="text-faint">
          {m.detects && <span>How Merlin spots it: {m.detects}</span>}
          {m.detects && m.category && ' · '}
          {m.category}
        </p>
      )}
    </>
  )
}

/** The details under an open row: what it is and how Merlin spots it, then a suggestion if there is one. */
function Panel({
  moment: m,
  again,
  usual,
  onCopy,
}: {
  usual?: string
  moment: MomentView
  again?: { reason?: string; example?: MomentHit }
  onCopy?: (id: string) => void
}) {
  return (
    <div className="space-y-0.5 pr-4 pb-2 text-sec" style={{ paddingLeft: INDENT }}>
      {m.note && <p className="pt-1">{m.note}</p>}
      {m.saved && <SavedLine saved={m.saved} />}
      {m.technique && <TechniqueSection t={m.technique} now={new Date()} usual={usual} onCopy={() => onCopy?.(m.id)} />}
      <About moment={m} />
      {!m.technique && again && <Suggestion moment={m} reason={again.reason} example={again.example} />}
    </div>
  )
}

/** The details under an open suggestion: a technique when it is one, else the reason and the try text. */
function NextPanel({
  moment: m,
  s,
  now,
  usual,
  onCopy,
}: {
  usual?: string
  moment: MomentView
  s: MomentsReport['suggestions'][number]
  now: Date
  onCopy?: (id: string) => void
}) {
  return (
    <div className="space-y-0.5 pr-4 pb-2 text-sec" style={{ paddingLeft: INDENT }}>
      {s.technique ? (
        <>
          {m.note && <p className="pt-1">{m.note}</p>}
          <TechniqueSection t={s.technique} now={now} usual={usual} onCopy={() => onCopy?.(m.id)} />
          <About moment={m} />
        </>
      ) : (
        <>
          <About moment={m} />
          <Suggestion moment={m} reason={s.reason} example={s.example} />
        </>
      )}
    </div>
  )
}
