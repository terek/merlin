// The two capsules both lenses of the scope (the Overview and Cost) put in the top bar: the range with its
// axis, and the search with the `in` chip. The scope is the URL's `range`, `from`, `to`, `by`, `in` and `q`
// (docs/ui.md section 10b).

import { ChevronsLeft, ChevronsRight, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCost } from '../../api/queries'
import { cn } from '../../lib/cn'
import { useNow } from '../../lib/hooks'
import { ShellSlot } from '../../shell/ShellSlot'
import { useShortcut } from '../../shell/useShortcut'
import { IconButton, KeyHint } from '../../ui'
import {
  type Beads,
  type Brush,
  brushRange,
  type CustomRange,
  customLabel,
  dailySpend,
  dayIndexAt,
  displayPath,
  drawBrush,
  firstSpendDay,
  formatCustom,
  monthRange,
  moveBrush,
  parseBy,
  parseCustom,
  parseIn,
  parseStoredCustom,
  presetRange,
  type Range,
  rangeBrush,
  resizeBrush,
  stripOf,
  stripTicks,
} from './model'
import { useDebounced, useWidth } from './useWidth'

const oneOf = <T extends string>(v: string | null, allowed: readonly T[], def: T): T =>
  allowed.includes(v as T) ? (v as T) : def

const RANGE_TITLE = { '1d': 'The last day', '7d': 'The last week', '30d': 'The last 30 days' } as const

/** The scope in the URL, and the two ways to change it: `set` replaces the entry, `select` adds one. */
export function useScope() {
  const [sp, setSp] = useSearchParams()
  const range = oneOf<Range>(sp.get('range'), ['1d', '7d', '30d'], '7d')
  // a custom range (both days, in order) wins over `range`
  const custom = parseCustom(sp.get('from'), sp.get('to'))
  const by = parseBy(sp.get('by'))
  const sel = parseIn(sp.get('in'))
  const q = sp.get('q') ?? ''
  const set = (changes: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(changes)) {
      if (!v) next.delete(k)
      else next.set(k, v)
    }
    setSp(next, { replace: true })
  }
  // the selection is a place in history: back and forward walk through it
  const select = (path: string | null) => {
    const next = new URLSearchParams(sp)
    if (path === null) next.delete('in')
    else next.set('in', path)
    setSp(next)
  }
  return { sp, set, select, range, custom, by, sel, q }
}

export type Scope = ReturnType<typeof useScope>

// ---- the locator: an arbitrary range on the whole history ---------------------------------

/** The locator's height (px): the day bars over the light axis. */
const LOC_H = 28
const LOC_BAR = 15
/** The brush: a band LOC_BAND tall, centred on the bars' baseline (the axis as it reads). */
const LOC_AXIS = LOC_BAR + 0.5
const LOC_BAND = 14
/** How close to an edge of the brush (px) the pointer grabs it. */
const LOC_GRAB = 6

type LocDrag =
  | { mode: 'move'; grab: number; base: Brush }
  | { mode: 'lo' | 'hi'; base: Brush }
  | { mode: 'new'; anchor: number; x: number; moved: boolean; base: Brush }

/**
 * The strip of the locator, like the Session page's overview: the whole history as whole local days (the
 * first day with spend to today), the daily spend as thin bars, a light month / day axis, and the brush. Drag
 * on the strip to draw a range, drag the brush to move it, drag its edges to resize; a click on the strip
 * brings the brush there. The brush snaps to whole days (one at least). `onLive` follows every move,
 * `onCommit` the end of a drag (the page applies the range then); the arrow keys move the brush by a day.
 */
function Locator({
  value,
  now,
  onLive,
  onCommit,
}: {
  /** The range the brush starts on: the custom range, else the preset's. */
  value: CustomRange
  now: Date
  onLive: (r: CustomRange | null) => void
  onCommit: (r: CustomRange) => void
}) {
  const days = useCost({ by: 'day' })
  const rows = days.data?.rows
  const strip = useMemo(() => stripOf(rows ? firstSpendDay(rows) : undefined, now, value), [rows, now, value])
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const spend = useMemo(() => dailySpend(rows ?? [], strip), [rows, strip])
  const ticks = useMemo(() => stripTicks(strip, width), [strip, width])
  const peak = Math.max(1e-9, ...spend)
  const dw = width / strip.days
  const [live, setLive] = useState<Brush | null>(null)
  const drag = useRef<LocDrag | null>(null)
  const [cursor, setCursor] = useState('crosshair')
  // the month whose name the pointer is on: its days get a soft wash, saying what a click selects
  const [hoverMonth, setHoverMonth] = useState<number | null>(null)
  const monthWash = hoverMonth === null || live ? null : rangeBrush(strip, monthRange(strip, hoverMonth, now))
  const brush = live ?? rangeBrush(strip, value)
  const x0 = brush.lo * dw
  const x1 = (brush.hi + 1) * dw
  const grab = Math.min(LOC_GRAB, Math.max(2, (x1 - x0) / 3))
  const at = (e: React.PointerEvent) => e.clientX - (e.currentTarget as Element).getBoundingClientRect().left
  const zoneAt = (x: number): 'lo' | 'hi' | 'move' | 'new' =>
    Math.abs(x - x0) <= grab ? 'lo' : Math.abs(x - x1) <= grab ? 'hi' : x > x0 && x < x1 ? 'move' : 'new'
  const show = (b: Brush) => {
    setLive(b)
    onLive(brushRange(strip, b))
  }
  const finish = (b: Brush) => {
    setLive(null)
    onLive(null)
    onCommit(brushRange(strip, b))
  }

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.preventDefault()
    // a click on a month's name selects that month
    const month = (e.target as Element).getAttribute('data-month')
    if (month !== null) {
      finish(rangeBrush(strip, monthRange(strip, Number(month), now)))
      return
    }
    const x = at(e)
    const z = zoneAt(x)
    const day = dayIndexAt(strip, width, x)
    drag.current =
      z === 'move'
        ? { mode: 'move', grab: day, base: brush }
        : z === 'new'
          ? { mode: 'new', anchor: day, x, moved: false, base: brush }
          : { mode: z, base: brush }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // a synthetic pointer has nothing to capture
    }
  }
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const x = at(e)
    const d = drag.current
    if (!d) {
      const z = zoneAt(x)
      setCursor(z === 'move' ? 'grab' : z === 'new' ? 'crosshair' : 'ew-resize')
      return
    }
    const day = dayIndexAt(strip, width, x)
    if (d.mode === 'move') show(moveBrush(d.base, d.grab, day, strip.days))
    else if (d.mode === 'new') {
      if (Math.abs(x - d.x) > 3) d.moved = true
      if (d.moved) show(drawBrush(d.anchor, day))
    } else show(resizeBrush(d.base, d.mode, day))
  }
  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const day = dayIndexAt(strip, width, at(e))
    if (d.mode === 'new' && !d.moved) {
      // a click on the strip brings the brush there, its length kept
      finish(moveBrush(d.base, Math.floor((d.base.lo + d.base.hi) / 2), day, strip.days))
    } else if (live) finish(live)
    else setLive(null)
  }
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (!step) return
    e.preventDefault()
    finish(moveBrush(brush, 0, step, strip.days))
  }

  return (
    <div
      ref={wrap}
      role="slider"
      tabIndex={0}
      aria-label="The days the page covers"
      aria-valuemin={0}
      aria-valuemax={strip.days - 1}
      aria-valuenow={brush.lo}
      onKeyDown={onKey}
      className="ml-1.5 min-w-0 flex-1 rounded-badge"
    >
      <svg
        width={width}
        height={LOC_H}
        role="img"
        aria-label="Spend by day over the whole history"
        className="block touch-none select-none"
        style={{ cursor }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {monthWash && (
          <rect
            x={monthWash.lo * dw}
            y={0}
            width={(monthWash.hi - monthWash.lo + 1) * dw}
            height={LOC_H}
            rx={3}
            fill="var(--accent)"
            fillOpacity={0.08}
            pointerEvents="none"
          />
        )}
        {/* the brush: a light accent band centred on the axis line, under the bars and labels */}
        <rect
          x={x0}
          y={LOC_AXIS - LOC_BAND / 2}
          width={Math.max(2, x1 - x0)}
          height={LOC_BAND}
          fill="var(--accent)"
          fillOpacity={0.16}
        />
        {spend.map((v, i) =>
          v > 0 ? (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: days are positions
              key={i}
              x={i * dw + dw * 0.15}
              y={LOC_BAR + 1 - Math.max(1, (v / peak) * LOC_BAR)}
              width={Math.max(1, dw * 0.7)}
              height={Math.max(1, (v / peak) * LOC_BAR)}
              fill="var(--faint)"
            />
          ) : null,
        )}
        <line x1={0} x2={width} y1={LOC_BAR + 2.5} y2={LOC_BAR + 2.5} stroke="var(--line)" />
        {ticks.map((t) => (
          <g key={t.x}>
            <line x1={t.x} x2={t.x} y1={LOC_BAR + 2.5} y2={LOC_BAR + (t.month ? 6 : 5)} stroke="var(--line)" />
            <text
              x={t.x + 2}
              y={LOC_H - 2}
              fontSize={10}
              fill={t.month ? 'var(--muted)' : 'var(--faint)'}
              data-month={t.month ? t.day : undefined}
              onPointerEnter={t.month ? () => setHoverMonth(t.day) : undefined}
              onPointerLeave={t.month ? () => setHoverMonth(null) : undefined}
              className={t.month ? 'cursor-pointer hover:underline' : undefined}
              style={t.month ? { cursor: 'pointer' } : undefined}
            >
              {t.title && <title>{t.title}</title>}
              {t.label}
            </text>
          </g>
        ))}
        <g pointerEvents="none">
          {[x0, x1].map((x, i) => (
            <rect
              key={i === 0 ? 'lo' : 'hi'}
              x={x - 1.5}
              y={LOC_AXIS - LOC_BAND / 2}
              width={3}
              height={LOC_BAND}
              rx={1.5}
              fill="var(--accent)"
            />
          ))}
        </g>
      </svg>
    </div>
  )
}

const CUSTOM_KEY = 'overview.custom'

/**
 * The last custom range applied (the URL's `from` and `to`, or a locator drag), kept in the browser so that
 * it survives choosing a preset (a per-viewer convenience: fine without storage, for this page only).
 */
function useRememberedCustom(applied: CustomRange | null): CustomRange | null {
  const [last, setLast] = useState<CustomRange | null>(() => {
    try {
      return parseStoredCustom(localStorage.getItem(CUSTOM_KEY))
    } catch {
      return null
    }
  })
  const from = applied?.from
  const to = applied?.to
  useEffect(() => {
    if (!from || !to) return
    setLast((cur) => (cur?.from === from && cur.to === to ? cur : { from, to }))
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify({ from, to }))
    } catch {
      // no storage: it is remembered for this page only
    }
  }, [from, to])
  return applied ?? last
}

/** The capsules in the top bar's slot. `home` and `beads` name the selection in its chip. */
export function ScopeSlot({
  scope,
  home,
  beads,
  search = true,
}: {
  scope: Scope
  home: string | undefined
  beads?: Beads
  /** False on Cost: the range capsule alone, the axis opening into the room the search had. */
  search?: boolean
}) {
  const { set, select, range, custom, by, sel, q } = scope
  const now = useNow(300_000)
  const days = custom ?? presetRange(range, now)
  // ---- the slot's two capsules: exactly one is expanded (page state, not URL); the search starts expanded ----
  // The axis is open only while the user works the time axis; any other choice puts the search back.
  const [axisOpen, setAxisOpen] = useState(false)
  const [live, setLive] = useState<CustomRange | null>(null)
  const wantFocus = useRef(false)
  const rangeRef = useRef<HTMLFieldSetElement>(null)
  const openSearch = () => {
    setLive(null)
    setAxisOpen(false)
    wantFocus.current = true
  }
  useShortcut('Escape', openSearch, { enabled: axisOpen })
  useEffect(() => {
    if (!axisOpen) return
    const onDown = (e: PointerEvent) => {
      if (!rangeRef.current?.contains(e.target as Node)) {
        setLive(null)
        setAxisOpen(false)
      }
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [axisOpen])

  // ---- search box: typing is local, the URL follows after 200 ms ----
  const [draft, setDraft] = useState(q)
  const debounced = useDebounced(draft, 200)
  const written = useRef(q)
  // biome-ignore lint/correctness/useExhaustiveDependencies: write only when the debounced text changes
  useEffect(() => {
    if (search && debounced !== written.current) {
      written.current = debounced
      set({ q: debounced })
    }
  }, [debounced, search])
  useEffect(() => {
    // back / forward changed `q`: the box follows
    if (search && q !== written.current) {
      written.current = q
      setDraft(q)
    }
  }, [q, search])
  const inputRef = useRef<HTMLInputElement>(null)
  useShortcut(
    '/',
    () => {
      if (axisOpen) return openSearch()
      inputRef.current?.focus()
      inputRef.current?.select()
    },
    { enabled: search },
  )
  // the search capsule is back: focus its input if a `/` or the magnifier asked for it
  useEffect(() => {
    if (search && !axisOpen && wantFocus.current) {
      wantFocus.current = false
      inputRef.current?.focus()
    }
  }, [axisOpen, search])
  const searchNote =
    q || sel !== null
      ? `Search: ${[q, sel !== null ? `in ${displayPath(sel, home, by)}` : ''].filter(Boolean).join(' · ')}`
      : ''
  // the last custom range outlives the presets: the Custom segment keeps showing it, unpressed
  const remembered = useRememberedCustom(custom)
  const shown = live ?? custom
  const label = shown ?? remembered
  const grow = 'transition-[flex-grow,min-width] duration-150 motion-reduce:transition-none'
  return (
    <ShellSlot>
      <div className="flex w-full min-w-0 items-center gap-2">
        {/* the two capsules: exactly one is expanded and takes the room; the other is a small one */}
        {/* the range capsule: the four modes always; Custom's editor, the axis, opens only while it is worked */}
        <fieldset
          ref={rangeRef}
          aria-label="Range"
          className={cn(
            'm-0 inline-flex h-8 min-w-0 shrink-0 items-center rounded-full border border-line bg-surface-2 p-0.5',
            grow,
          )}
          style={{ flexGrow: axisOpen ? 1 : 0, flexBasis: axisOpen ? 0 : 'auto' }}
        >
          {(['1d', '7d', '30d'] as const).map((v) => {
            const on = !shown && range === v
            return (
              <button
                key={v}
                type="button"
                aria-pressed={on}
                title={RANGE_TITLE[v]}
                onClick={() => {
                  setAxisOpen(false)
                  setLive(null)
                  set({ range: v === '7d' ? undefined : v, ...formatCustom(null) })
                }}
                className={cn(
                  'h-full shrink-0 whitespace-nowrap rounded-full px-2.5 text-sec',
                  on ? 'bg-surface text-fg outline outline-1 outline-line' : 'text-muted hover:text-fg',
                )}
              >
                {v}
              </button>
            )
          })}
          {/* Custom: one unit, a pill (white when pressed, on the grey when not) holding the label and, open, the axis */}
          <span
            className={cn(
              'inline-flex h-full min-w-0 items-center rounded-full',
              axisOpen && 'flex-1',
              shown ? 'bg-surface text-fg outline outline-1 outline-line' : 'text-muted',
            )}
          >
            <button
              type="button"
              aria-pressed={!!shown}
              aria-expanded={axisOpen}
              title={axisOpen ? 'Close the timeline' : 'Pick any range of days on the timeline'}
              onClick={() => {
                if (axisOpen) return openSearch()
                if (!shown && remembered) set({ range: undefined, ...formatCustom(remembered) })
                setAxisOpen(true)
              }}
              className="inline-flex h-full shrink-0 items-center gap-1 whitespace-nowrap pr-1.5 pl-2.5 text-left text-sec hover:text-fg"
            >
              {/* one width for a range label, so that nothing shifts under a drag */}
              {label ? <span className="inline-block min-w-[13ch]">{customLabel(label, now)}</span> : 'Custom'}
              {axisOpen ? (
                <ChevronsLeft size={12} aria-hidden className="text-muted" />
              ) : (
                <ChevronsRight size={12} aria-hidden className="text-muted" />
              )}
            </button>
            {axisOpen && (
              <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                <Locator
                  value={days}
                  now={now}
                  onLive={setLive}
                  onCommit={(r) => set({ range: undefined, ...formatCustom(r) })}
                />
              </div>
            )}
          </span>
        </fieldset>
        {search && (
          <div
            className={cn(
              'relative flex h-8 items-center overflow-hidden rounded-full border border-line bg-surface-2',
              grow,
              axisOpen ? 'shrink-0' : 'min-w-0',
            )}
            style={{ flexGrow: axisOpen ? 0 : 1, flexBasis: axisOpen ? 32 : 0, minWidth: axisOpen ? 32 : 160 }}
          >
            <button
              type="button"
              aria-label={axisOpen ? 'Search sessions' : 'Focus the search'}
              title={axisOpen ? ['Search sessions (/)', searchNote].filter(Boolean).join('\n') : 'Search sessions (/)'}
              onClick={() => (axisOpen ? openSearch() : inputRef.current?.focus())}
              className="relative inline-flex size-[30px] shrink-0 items-center justify-center rounded-full text-faint hover:text-fg"
            >
              <Search size={14} aria-hidden />
              {axisOpen && (q || sel !== null) && (
                <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-accent" aria-hidden />
              )}
            </button>
            {!axisOpen && (
              <>
                <input
                  ref={inputRef}
                  type="search"
                  aria-label="Search sessions"
                  value={draft}
                  placeholder="Search sessions…"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') return
                    if (draft) setDraft('')
                    else e.currentTarget.blur()
                  }}
                  className="h-full min-w-0 flex-1 border-0 bg-transparent pr-2 text-body text-fg outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
                />
                {draft ? (
                  <IconButton label="Clear" onClick={() => setDraft('')} className="mr-1 size-5 shrink-0">
                    <X size={13} />
                  </IconButton>
                ) : (
                  <KeyHint className="mr-1.5 shrink-0">/</KeyHint>
                )}
                {sel !== null && (
                  <span className="mr-1 inline-flex h-6 max-w-[260px] shrink-0 items-center gap-1 rounded-full border border-line bg-surface pr-1 pl-2.5 text-sec">
                    <span className="text-muted">in</span>
                    <span
                      className="truncate font-medium text-fg"
                      title={
                        by === 'bead'
                          ? [beads?.[displayPath(sel, home, by)]?.title, sel].filter(Boolean).join('\n')
                          : sel
                      }
                    >
                      {displayPath(sel, home, by)}
                    </span>
                    <button
                      type="button"
                      onClick={() => select(null)}
                      aria-label="Clear the selection"
                      title="Clear the selection"
                      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted hover:bg-line hover:text-fg"
                    >
                      <X size={11} aria-hidden />
                    </button>
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </ShellSlot>
  )
}
