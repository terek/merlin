// The day locator above the time view of a session that ran on more than one day: a narrow cell per
// day with what was spent on it, a break where days went by with nothing; the cell picked is the day
// the plot shows. Cells keep a small width of their own: two days take two cells, not the whole card.
import { type KeyboardEvent, useMemo, useRef, useState } from 'react'
import { formatMoney } from '../../lib/format'
import { PinMark } from './marks'
import { CLASS_SERIES, KIND_SERIES, type Split } from './model'
import { type Day, daySpend, type Timeline } from './timeline'
import { useWidth } from './useWidth'

/** A cell is at most this wide, and at least this. */
const CELL_MAX = 44
const CELL_MIN = 14
/** The break between two days with days of nothing between them. */
const GAP_W = 12
/** The most expensive day's bar. */
const BAR_H = 30

const ORDER = { kind: KIND_SERIES, class: CLASS_SERIES }
const DAY_MS = 24 * 60 * 60_000

const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const longDate = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
const month = (t: number) => new Date(t).toLocaleDateString([], { month: 'short' })

export interface DayStripProps {
  days: readonly Day[]
  /** The whole session, every day of it. */
  timeline: Timeline
  split: Split
  selected: number
  /** The day of the pinned turn, or -1. */
  pinned: number
  onSelect: (day: number) => void
}

export function DayStrip({ days, timeline, split, selected, pinned, onSelect }: DayStripProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const [hover, setHover] = useState<number | null>(null)

  // what each day spent, in the plot's parts
  const bars = useMemo(() => daySpend(timeline, days, split), [days, timeline, split])
  const max = Math.max(1e-9, ...bars.map((b) => b.total ?? 0))

  // the calendar days with nothing between one day and the next
  const skipped = days.map((d, i) => (i === 0 ? 0 : Math.max(0, Math.round((d.date - days[i - 1].date) / DAY_MS) - 1)))
  const gaps = skipped.filter((n) => n > 0).length
  const cell = Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor((width - gaps * GAP_W) / days.length)))
  const calendar = Math.round((days[days.length - 1].date - days[0].date) / DAY_MS) + 1

  const shown = hover ?? selected
  const d = days[shown]
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === 'ArrowLeft'
        ? selected - 1
        : e.key === 'ArrowRight'
          ? selected + 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? days.length - 1
              : undefined
    if (next === undefined) return
    e.preventDefault()
    const k = Math.max(0, Math.min(days.length - 1, next))
    onSelect(k)
    wrap.current?.querySelector<HTMLButtonElement>(`[data-day="${k}"]`)?.focus()
  }

  return (
    <div className="mb-3">
      <div className="flex min-h-5 items-baseline gap-x-3 overflow-hidden whitespace-nowrap text-sec">
        <span className="text-muted">
          Day {shown + 1} of {days.length}
        </span>
        <span className="font-medium">{longDate(d.date)}</span>
        <span className="font-mono text-muted">
          {clock(d.t0)}–{clock(d.t1)}
        </span>
        <span className="font-mono">{formatMoney(bars[shown].total ?? 0)}</span>
        <span className="truncate text-faint">
          {calendar > days.length ? `active on ${days.length} of ${calendar} calendar days; ` : ''}pick a day to show it
          below
        </span>
      </div>
      <div
        ref={wrap}
        role="toolbar"
        aria-label="Days of the session"
        onKeyDown={onKey}
        onPointerLeave={() => setHover(null)}
        className="mt-1 flex items-start overflow-x-auto pb-1"
      >
        {days.map((day, i) => {
          const bar = bars[i]
          const on = i === selected
          const newMonth = i === 0 || month(day.date) !== month(days[i - 1].date)
          const num = new Date(day.date).getDate()
          return (
            <div key={day.date} className="flex shrink-0 items-start">
              {skipped[i] > 0 && (
                <div
                  className="relative shrink-0 self-stretch"
                  style={{ width: GAP_W }}
                  title={`${skipped[i]} ${skipped[i] === 1 ? 'day' : 'days'} with nothing`}
                >
                  <svg width={GAP_W} height={BAR_H + 8} className="absolute top-0 left-0">
                    <title>{`${skipped[i]} ${skipped[i] === 1 ? 'day' : 'days'} with nothing`}</title>
                    <path
                      d={`M${GAP_W / 2 - 2.5} ${BAR_H + 4}l3 -6M${GAP_W / 2 + 0.5} ${BAR_H + 4}l3 -6`}
                      stroke="var(--faint)"
                      strokeWidth={1}
                    />
                  </svg>
                </div>
              )}
              <button
                type="button"
                data-day={i}
                tabIndex={on ? 0 : -1}
                aria-pressed={on}
                aria-label={`${longDate(day.date)}, ${formatMoney(bar.total ?? 0)}`}
                title={`${longDate(day.date)} ${clock(day.t0)}–${clock(day.t1)}: ${formatMoney(bar.total ?? 0)}`}
                onClick={() => onSelect(i)}
                onPointerEnter={() => setHover(i)}
                className={`flex shrink-0 cursor-pointer flex-col items-stretch rounded-badge px-0.5 pt-2 ${
                  on ? 'bg-accent-soft' : 'hover:bg-surface-2'
                }`}
                style={{ width: cell }}
              >
                <span className="relative flex flex-col-reverse" style={{ height: BAR_H }}>
                  {i === pinned && (
                    <span className="-top-2 -translate-x-1/2 absolute left-1/2">
                      <PinMark />
                    </span>
                  )}
                  {ORDER[split].map((p) => {
                    const v = bar[p.key] ?? 0
                    return v > 0 ? (
                      <span
                        key={p.key}
                        className="block shrink-0"
                        style={{ height: Math.max(0.75, (v / max) * BAR_H), background: p.color }}
                      />
                    ) : null
                  })}
                </span>
                <span
                  className={`mt-0.5 border-t-2 text-center text-meta leading-tight ${
                    on ? 'border-accent font-semibold text-text' : 'border-transparent text-muted'
                  }`}
                >
                  {cell >= 18 || on || num === 1 || i === 0 ? num : ' '}
                </span>
                <span className="h-3.5 whitespace-nowrap text-left text-faint text-meta leading-tight">
                  {newMonth ? month(day.date) : ''}
                </span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
