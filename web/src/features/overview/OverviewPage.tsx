// The Overview page (experimental, docs/ui.md section 10b): where the agents' work went over a day,
// a week or a month. One shared time axis; a row per group of sessions with its context above the
// baseline and its spend below, on scales every row shares.

import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useOverview } from '../../api/queries'
import type { GroupDim, Overview, OverviewEvent, OverviewLane } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatMoney, formatTokens, plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { Money, QueryBoundary, RelTime, SegmentedControl, Select, Skeleton } from '../../ui'
import {
  type Axis,
  activityRuns,
  axisTicks,
  BREAK_W,
  breakLabel,
  buildAxis,
  type CtxMode,
  contextOf,
  describeMarks,
  formatOpen,
  type Heights,
  lanesIn,
  marksBySlot,
  midnightXs,
  niceFloor,
  parseOpen,
  quietSlots,
  RANGES,
  type Range,
  rowHeights,
  type Scales,
  type SlotRange,
  type SortKey,
  scalesFor,
  slotAt,
  slotLabel,
  slotRange,
  sortGroups,
  stepAreaPath,
  toggleOpen,
} from './model'
import { useWidth } from './useWidth'

const LABEL_W = 248
const PAD = 4
const MIN_ROW = 36
const MIN_LANE = 22

const BY_OPTIONS: { value: GroupDim; label: string }[] = [
  { value: 'dir', label: 'Project' },
  { value: 'checkout', label: 'Checkout' },
  { value: 'repo', label: 'Repository' },
  { value: 'remote', label: 'Remote' },
]
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'spend', label: 'Spend' },
  { value: 'sessions', label: 'Sessions' },
  { value: 'priciest', label: 'Priciest session' },
  { value: 'recent', label: 'Last activity' },
]

const oneOf = <T extends string>(v: string | null, allowed: readonly T[], def: T): T =>
  allowed.includes(v as T) ? (v as T) : def

// ---- the rows' data, one shape for a group and a lane ------------------------------------

interface RowData {
  key: string
  ctx: number[]
  usd: number[]
  active: number[]
  events: OverviewEvent[]
  lane?: OverviewLane
}

interface Hover {
  row: string
  slot: number
  lane?: OverviewLane
}

interface Selection {
  /** A group key, or null for the scripted row (not selectable). */
  key: string
  name: string
  range: SlotRange
}

interface Shared {
  axis: Axis
  scales: Scales
  fromMs: number
  slotMs: number
  hover: Hover | null
  setHover: (h: Hover | null) => void
  selection: Selection | null
  select: (key: string, range: SlotRange) => void
}

// ---- the plot of one row -----------------------------------------------------------------

function RowPlot({
  data,
  groupKey,
  h,
  height,
  shared,
  faint,
  scaleLabels,
  thin,
}: {
  data: RowData
  /** The group a click on this row lists (a lane's is its group's). */
  groupKey: string
  h: Heights
  height: number
  shared: Shared
  faint?: boolean
  scaleLabels?: boolean
  thin?: boolean
}) {
  const { axis, scales, hover, setHover, selection } = shared
  const anchor = useRef(-1)
  const base = height - h.down - PAD
  const marks = useMemo(() => marksBySlot(data.events), [data.events])
  const area = useMemo(() => stepAreaPath(data.ctx, axis, base, scales.pxPerTok), [data.ctx, axis, base, scales])
  const runs = useMemo(() => activityRuns(data.active, axis.shown), [data.active, axis])
  const midnights = useMemo(() => midnightXs(axis, shared.fromMs, shared.slotMs), [axis, shared.fromMs, shared.slotMs])
  const barW = Math.max(1, axis.slotW - (axis.slotW > 4 ? 1 : 0))
  const slotX = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return slotAt(axis, e.clientX - r.left)
  }
  const mine = hover?.row === data.key ? hover.slot : -1
  const sel = selection && selection.key === groupKey ? selection.range : null

  const gl = thin ? 0.8 : 1
  const sc = faint ? 0.5 : 1

  const ctxTick = scaleLabels ? niceFloor((h.up / Math.max(scales.pxPerTok, 1e-9)) * 0.92) : 0
  const usdTick = scaleLabels ? niceFloor((h.down / Math.max(scales.pxPerUsd, 1e-9)) * 0.92) : 0

  return (
    <svg
      width={axis.width}
      height={height}
      className="block cursor-crosshair select-none"
      role="img"
      aria-label={`Spend and context of ${data.key || 'no value'} over time`}
      onPointerMove={(e) => {
        const s = slotX(e)
        if (s < 0) setHover(null)
        else if (mine !== s) setHover({ row: data.key, slot: s, lane: data.lane })
      }}
      onPointerLeave={() => {
        anchor.current = -1
        setHover(null)
      }}
      onPointerDown={(e) => {
        anchor.current = slotX(e)
      }}
      onPointerUp={(e) => {
        const s = slotX(e)
        if (s >= 0 && anchor.current >= 0) shared.select(groupKey, slotRange(anchor.current, s, axis.slots))
        anchor.current = -1
      }}
    >
      {axis.segments
        .filter((s) => s.kind === 'break')
        .map((s) => (
          <rect key={s.from} x={s.x0} y={0} width={s.x1 - s.x0} height={height} fill="var(--surface-2)" opacity={0.7} />
        ))}
      {midnights.map((x) => (
        <line key={x} x1={x} x2={x} y1={0} y2={height} stroke="var(--line)" strokeWidth={1} opacity={0.6} />
      ))}
      {sel && (
        <rect
          x={axis.x[sel.from]}
          y={0}
          width={Math.max(2, axis.x[sel.to] + axis.slotW - axis.x[sel.from])}
          height={height}
          fill="var(--accent)"
          opacity={0.16}
        />
      )}
      {mine >= 0 && (
        <rect x={axis.x[mine]} y={0} width={Math.max(2, axis.slotW)} height={height} fill="var(--text)" opacity={0.1} />
      )}
      <path d={area} fill="var(--accent)" opacity={0.4 * sc} />
      {data.usd.map((v, i) =>
        v > 0 && axis.shown[i] ? (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: slots are positional
            key={i}
            x={axis.x[i] + (axis.slotW - barW) / 2}
            y={base + 1.5}
            width={barW}
            height={Math.max(1, Math.min(h.down, v * scales.pxPerUsd))}
            fill="var(--muted)"
            opacity={0.75 * sc}
          />
        ) : null,
      )}
      <line x1={0} x2={axis.width} y1={base} y2={base} stroke="var(--line)" strokeWidth={1} />
      {runs.map((r) => (
        <line
          key={r.from}
          x1={axis.x[r.from]}
          x2={axis.x[r.from] + (r.to - r.from) * axis.slotW}
          y1={base}
          y2={base}
          stroke="var(--text)"
          strokeWidth={(r.weight === 1 ? 1 : r.weight === 2 ? 2 : 3) * gl}
          opacity={0.8 * sc}
        />
      ))}
      {ctxTick > 0 && ctxTick * scales.pxPerTok >= 14 && (
        <ScaleLine y={base - ctxTick * scales.pxPerTok} text={`${formatTokens(ctxTick)} tokens`} />
      )}
      {usdTick > 0 && usdTick * scales.pxPerUsd >= 12 && (
        <ScaleLine y={base + 1.5 + usdTick * scales.pxPerUsd} text={`${formatMoney(usdTick)} per slot`} />
      )}
      {[...marks.entries()].map(([i, m]) => {
        if (!axis.shown[i]) return null
        const cx = axis.x[i] + axis.slotW / 2
        return (
          <g key={i} opacity={sc}>
            {m.cold + m.warm + m.other > 0 && (
              <line
                x1={cx}
                x2={cx}
                y1={base - 7}
                y2={base + 7}
                strokeWidth={2}
                stroke={m.cold ? 'var(--bad)' : m.warm ? 'var(--warn)' : 'var(--faint)'}
              />
            )}
            {m.agents > 0 && <Plus cx={cx} cy={base - 9} r={m.agents >= 4 ? 4.5 : 2.5} />}
            {m.fork > 0 && (
              <circle cx={cx - (m.continuation ? 3 : 0)} cy={base} r={3} fill="var(--text)" stroke="var(--surface)" />
            )}
            {m.continuation > 0 && (
              <circle
                cx={cx + (m.fork ? 3 : 0)}
                cy={base}
                r={3}
                fill="var(--surface)"
                stroke="var(--text)"
                strokeWidth={1.25}
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

function ScaleLine({ y, text }: { y: number; text: string }) {
  return (
    <g pointerEvents="none">
      <line x1={0} x2={axisPad} y1={y} y2={y} stroke="var(--faint)" strokeWidth={1} strokeDasharray="2 2" />
      <text
        x={axisPad + 3}
        y={y + 3}
        fontSize={9}
        fill="var(--faint)"
        stroke="var(--surface)"
        strokeWidth={2.5}
        paintOrder="stroke"
      >
        {text}
      </text>
    </g>
  )
}
const axisPad = 14

function Plus({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <path
      d={`M${cx - r},${cy}H${cx + r}M${cx},${cy - r}V${cy + r}`}
      stroke="var(--text)"
      strokeWidth={r > 3 ? 1.75 : 1.25}
      fill="none"
      strokeLinecap="round"
    />
  )
}

// ---- rows --------------------------------------------------------------------------------

const groupData = (g: Overview['groups'][number], mode: CtxMode): RowData => ({
  key: g.key,
  ctx: contextOf(g, mode),
  usd: g.usdSlots,
  active: g.active,
  events: g.events ?? [],
})

const laneData = (groupKey: string, l: OverviewLane): RowData => ({
  key: `${groupKey}\u0000${l.harness}/${l.id}`,
  ctx: l.context,
  usd: l.usdSlots,
  active: l.usdSlots.map((v, i) => (v > 0 || (l.context[i] ?? 0) > 0 ? 1 : 0)),
  events: l.events ?? [],
  lane: l,
})

function RowShell({ label, plot, className }: { label: ReactNode; plot: ReactNode; className?: string }) {
  return (
    <div className={cn('flex border-line border-b', className)}>
      <div className="shrink-0 overflow-hidden px-3 py-1" style={{ width: LABEL_W }}>
        {label}
      </div>
      <div className="min-w-0 flex-1">{plot}</div>
    </div>
  )
}

function GroupRow({
  g,
  mode,
  shared,
  open,
  onToggle,
  first,
}: {
  g: Overview['groups'][number]
  mode: CtxMode
  shared: Shared
  open: boolean
  onToggle: () => void
  first: boolean
}) {
  const data = groupData(g, mode)
  const h = rowHeights(data.ctx, data.usd, shared.scales)
  const height = Math.max(MIN_ROW, h.up + h.down + 2 * PAD)
  return (
    <RowShell
      label={
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full min-w-0 items-start gap-1 text-left"
          title={g.key || 'no value'}
        >
          {open ? (
            <ChevronDown size={14} className="mt-0.5 shrink-0 text-muted" />
          ) : (
            <ChevronRight size={14} className="mt-0.5 shrink-0 text-muted" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body text-fg">{g.name || 'no value'}</span>
            <span className="flex items-baseline gap-1 whitespace-nowrap text-meta text-muted">
              <Money usd={g.usd} />
              <span>·</span>
              <span>{plural(g.sessions, 'session')}</span>
              {g.priciest && (
                <>
                  <span>·</span>
                  <span>max</span>
                  <Money usd={g.priciest.usd} dim />
                </>
              )}
            </span>
          </span>
        </button>
      }
      plot={<RowPlot data={data} groupKey={g.key} h={h} height={height} shared={shared} scaleLabels={first} />}
    />
  )
}

function Lanes({
  groupKey,
  base,
  shared,
  scales,
}: {
  groupKey: string
  base: Parameters<typeof useOverview>[0]
  shared: Shared
  scales: Scales
}) {
  const q = useOverview({ ...base, group: groupKey })
  const lanes = q.data?.lanes
  if (!lanes)
    return (
      <RowShell
        label={<Skeleton className="ml-5 h-3 w-32" />}
        plot={<div style={{ height: MIN_LANE }} />}
        className="bg-surface-2/40"
      />
    )
  return (
    <>
      {lanes.map((l) => {
        const data = laneData(groupKey, l)
        const h = rowHeights(data.ctx, data.usd, scales, 3)
        const height = Math.max(MIN_LANE, h.up + h.down + 2 * PAD)
        return (
          <RowShell
            key={data.key}
            className="bg-surface-2/40"
            label={
              <div className="flex min-w-0 items-baseline gap-2 pl-5">
                <Link
                  to={`/s/${encodeURIComponent(l.harness)}/${encodeURIComponent(l.id)}`}
                  className="min-w-0 flex-1 truncate text-sec"
                  title={l.title || l.id}
                >
                  {l.title || l.id.slice(0, 8)}
                </Link>
                <Money usd={l.usd} dim className="text-meta" />
              </div>
            }
            plot={<RowPlot data={data} groupKey={groupKey} h={h} height={height} shared={shared} thin />}
          />
        )
      })}
      {lanes.length === 0 && (
        <RowShell label={<span className="pl-5 text-meta text-faint">no sessions</span>} plot={null} />
      )}
    </>
  )
}

function ScriptedRow({ o, shared }: { o: Overview; shared: Shared }) {
  const data: RowData = { key: '\u0000scripted', ctx: [], usd: o.scripted.usdSlots, active: [], events: [] }
  const h = rowHeights([], data.usd, shared.scales, 3)
  const height = Math.max(MIN_LANE, h.up + h.down + 2 * PAD)
  const shrunk: Heights = { up: 0, down: h.down }
  return (
    <RowShell
      className="border-b-0"
      label={
        <div className="flex min-w-0 items-baseline gap-1 pl-5 text-meta text-faint">
          <span className="truncate">{plural(o.scripted.sessions, 'scripted run')}</span>
          <span>·</span>
          <Money usd={o.scripted.usd} dim />
        </div>
      }
      plot={
        <RowPlot
          data={data}
          groupKey=""
          h={shrunk}
          height={Math.min(height, h.down + 2 * PAD)}
          shared={noSelect(shared)}
          faint
        />
      }
    />
  )
}

/** Scripted runs are not groups: no click lists them. */
const noSelect = (s: Shared): Shared => ({ ...s, select: () => {}, selection: null })

// ---- the axis ----------------------------------------------------------------------------

function AxisRow({
  axis,
  o,
  fromMs,
  slotMs,
  plotRef,
}: {
  axis: Axis
  o: Overview
  fromMs: number
  slotMs: number
  plotRef: React.RefObject<HTMLDivElement | null>
}) {
  const ticks = axisTicks(axis, fromMs, slotMs)
  return (
    <div className="flex border-line border-b">
      <div className="shrink-0" style={{ width: LABEL_W }} />
      <div ref={plotRef} className="min-w-0 flex-1">
        <svg width={axis.width} height={22} className="block" role="img" aria-label="Time axis">
          {axis.segments
            .filter((s) => s.kind === 'break')
            .map((s) => (
              <g key={s.from}>
                <rect x={s.x0} y={0} width={BREAK_W} height={22} fill="var(--surface-2)" opacity={0.7} />
                <text x={(s.x0 + s.x1) / 2} y={14} fontSize={10} textAnchor="middle" fill="var(--faint)">
                  {breakLabel((s.to - s.from) * o.slotMs)}
                </text>
              </g>
            ))}
          {ticks.map((t) => (
            <g key={t.x}>
              <line x1={t.x} x2={t.x} y1={t.day ? 4 : 14} y2={22} stroke="var(--line)" />
              <text
                x={t.x + (t.x > axis.width - 52 ? -3 : 3)}
                y={13}
                fontSize={11}
                textAnchor={t.x > axis.width - 52 ? 'end' : 'start'}
                fill={t.day ? 'var(--muted)' : 'var(--faint)'}
              >
                {t.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  )
}

// ---- hover readout -----------------------------------------------------------------------

function Readout({ o, hover, fromMs }: { o: Overview; hover: Hover | null; fromMs: number }) {
  let body: ReactNode = (
    <span className="text-faint">
      Hover a slot for its numbers; click it to list the sessions, drag across slots for a range.
    </span>
  )
  if (hover) {
    const when = slotLabel(fromMs, o.slotMs, hover.slot)
    const lane = hover.lane
    const g = lane ? undefined : o.groups.find((x) => x.key === hover.row)
    const i = hover.slot
    if (g) {
      const words = describeMarks(marksBySlot(g.events).get(i))
      body = (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-fg">{g.name || 'no value'}</span>
            <span className="text-muted">{when}</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 text-muted">
            <span>
              <Money usd={g.usdSlots[i] ?? 0} /> spent
            </span>
            <span>{plural(g.active[i] ?? 0, 'session')} running</span>
            <span>
              context {formatTokens(g.contextSum[i] ?? 0)} summed, {formatTokens(g.contextPeak[i] ?? 0)} peak
            </span>
            {words && <span className="text-fg">{words}</span>}
          </div>
        </>
      )
    } else if (lane) {
      const words = describeMarks(marksBySlot(lane.events).get(i))
      body = (
        <>
          <div className="flex items-baseline gap-2">
            <span className="truncate text-fg">{lane.title || lane.id}</span>
            <span className="shrink-0 text-muted">{when}</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 text-muted">
            <span>
              <Money usd={lane.usdSlots[i] ?? 0} /> spent
            </span>
            <span>context {formatTokens(lane.context[i] ?? 0)}</span>
            {words && <span className="text-fg">{words}</span>}
          </div>
        </>
      )
    } else if (hover.row.endsWith('scripted')) {
      body = (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-fg">Scripted runs</span>
            <span className="text-muted">{when}</span>
          </div>
          <div className="text-muted">
            <Money usd={o.scripted.usdSlots[i] ?? 0} /> spent
          </div>
        </>
      )
    }
  }
  return <div className="h-11 overflow-hidden px-3 py-1 text-sec leading-snug">{body}</div>
}

// ---- the list under the plot -------------------------------------------------------------

function SlotList({
  sel,
  base,
  fromMs,
  slotMs,
  slots,
  onClose,
}: {
  sel: Selection
  base: Parameters<typeof useOverview>[0]
  fromMs: number
  slotMs: number
  slots: number
  onClose: () => void
}) {
  const q = useOverview({ ...base, group: sel.key })
  const hits = q.data?.lanes ? lanesIn(q.data.lanes, sel.range) : undefined
  return (
    <section
      className="sticky bottom-0 z-10 border-line border-t bg-surface shadow-[0_-1px_0_var(--line)]"
      aria-label="Sessions in the selected slots"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-sec">
        <span className="font-medium text-fg">{sel.name || 'no value'}</span>
        <span className="text-muted">
          {slotLabel(fromMs, slotMs, sel.range.from, Math.min(sel.range.to, slots - 1))}
        </span>
        {hits && <span className="text-faint">{plural(hits.length, 'session')}</span>}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-muted hover:text-fg"
          aria-label="Close the list"
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-56 overflow-auto border-line border-t">
        {!hits && <div className="px-3 py-2 text-sec text-faint">Loading</div>}
        {hits?.length === 0 && <div className="px-3 py-2 text-sec text-faint">No session ran in these slots.</div>}
        {hits?.map(({ lane, usdIn }) => (
          <div
            key={`${lane.harness}/${lane.id}`}
            className="flex items-baseline gap-4 border-line border-b px-3 py-1 text-sec last:border-b-0"
          >
            <Link
              to={`/s/${encodeURIComponent(lane.harness)}/${encodeURIComponent(lane.id)}`}
              className="min-w-0 flex-1 truncate"
              title={lane.title || lane.id}
            >
              {lane.title || lane.id.slice(0, 8)}
            </Link>
            <span className="w-28 text-right text-muted">
              <Money usd={usdIn} /> here
            </span>
            <span className="w-28 text-right text-muted">
              <Money usd={lane.usd} dim /> in range
            </span>
            <span className="w-28 text-right text-muted">
              <RelTime time={lane.lastActivityAt} />
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---- the page ----------------------------------------------------------------------------

export function OverviewPage() {
  useDocumentTitle('Overview')
  const [sp, setSp] = useSearchParams()
  const range = oneOf<Range>(sp.get('range'), ['1d', '7d', '30d'], '7d')
  const by = oneOf<GroupDim>(sp.get('by'), ['dir', 'checkout', 'repo', 'remote'], 'dir')
  const sort = oneOf<SortKey>(sp.get('sort'), ['spend', 'sessions', 'priciest', 'recent'], 'spend')
  const mode = oneOf<CtxMode>(sp.get('ctx'), ['sum', 'peak'], 'sum')
  const open = useMemo(() => parseOpen(sp.get('open')), [sp])

  const set = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined || v === '') next.delete(k)
      else next.set(k, v)
    }
    setSp(next, { replace: true })
  }

  // "Ending now", rounded up to the slot so the query key holds still between refreshes.
  const now = useNow(300_000)
  const cfg = RANGES[range]
  const slotLen = { '15m': 15, '1h': 60, '6h': 360 }[cfg.slot as '15m' | '1h' | '6h'] * 60_000
  const to = Math.ceil(now.getTime() / slotLen) * slotLen
  const base = { from: new Date(to - cfg.ms).toISOString(), to: new Date(to).toISOString(), slot: cfg.slot, by }
  const query = useOverview(base)

  const [hover, setHover] = useState<Hover | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)

  return (
    <div className="mx-auto w-full max-w-[2000px] px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="mr-2 font-semibold text-title">Overview</h1>
        <SegmentedControl<Range>
          label="Range"
          value={range}
          options={[
            { value: '1d', label: '1d', title: 'The last day, in 15 minute slots' },
            { value: '7d', label: '7d', title: 'The last week, in 1 hour slots' },
            { value: '30d', label: '30d', title: 'The last 30 days, in 6 hour slots' },
          ]}
          onChange={(v) => {
            setSelection(null)
            set({ range: v === '7d' ? undefined : v })
          }}
        />
        <div className="flex items-center gap-1.5 text-sec text-muted">
          group
          <Select<GroupDim>
            label="Group by"
            value={by}
            options={BY_OPTIONS}
            onChange={(v) => {
              setSelection(null)
              set({ by: v === 'dir' ? undefined : v, open: undefined })
            }}
          />
        </div>
        <div className="flex items-center gap-1.5 text-sec text-muted">
          sort
          <Select<SortKey>
            label="Sort by"
            value={sort}
            options={SORT_OPTIONS}
            onChange={(v) => set({ sort: v === 'spend' ? undefined : v })}
          />
        </div>
        <div className="flex items-center gap-1.5 text-sec text-muted">
          context
          <SegmentedControl<CtxMode>
            label="Context"
            value={mode}
            options={[
              { value: 'sum', label: 'Sum', title: "What the group carried: the sum of its sessions' contexts" },
              { value: 'peak', label: 'Peak', title: "Its deepest session's context" },
            ]}
            onChange={(v) => set({ ctx: v === 'sum' ? undefined : v })}
          />
        </div>
      </div>
      <QueryBoundary
        query={query}
        isEmpty={(o) => o.groups.length === 0 && o.scripted.usd === 0}
        empty={
          <div className="rounded-card border border-line bg-surface p-6 text-muted">Nothing ran in this range.</div>
        }
        skeleton={<Skeleton className="h-64 w-full" />}
      >
        {(o) => (
          <Plot
            o={o}
            range={range}
            sort={sort}
            mode={mode}
            open={open}
            hover={hover}
            setHover={setHover}
            selection={selection}
            setSelection={setSelection}
            onToggle={(key) => set({ open: formatOpen(toggleOpen(open, key)) })}
            base={base}
          />
        )}
      </QueryBoundary>
    </div>
  )
}

function Plot({
  o,
  range,
  sort,
  mode,
  open,
  hover,
  setHover,
  selection,
  setSelection,
  onToggle,
  base,
}: {
  o: Overview
  range: Range
  sort: SortKey
  mode: CtxMode
  open: string[]
  hover: Hover | null
  setHover: (h: Hover | null) => void
  selection: Selection | null
  setSelection: (s: Selection | null) => void
  onToggle: (key: string) => void
  base: Parameters<typeof useOverview>[0]
}) {
  const plotRef = useRef<HTMLDivElement>(null)
  const width = useWidth(plotRef)
  const fromMs = Date.parse(o.from)
  const quiet = useMemo(() => quietSlots(o), [o])
  const axis = useMemo(
    () => buildAxis(quiet, o.slotMs, RANGES[range].breakMs, Math.max(240, width)),
    [quiet, o.slotMs, range, width],
  )
  const scales = useMemo(() => scalesFor(o.groups, mode, o.scripted.usdSlots), [o, mode])
  const groups = useMemo(() => sortGroups(o.groups, sort), [o.groups, sort])
  const shared: Shared = {
    axis,
    scales,
    fromMs,
    slotMs: o.slotMs,
    hover,
    setHover,
    selection,
    select: (key, r) => setSelection({ key, name: o.groups.find((g) => g.key === key)?.name ?? key, range: r }),
  }
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="border-line border-b" onPointerLeave={() => setHover(null)}>
        <Readout o={o} hover={hover} fromMs={fromMs} />
      </div>
      <AxisRow axis={axis} o={o} fromMs={fromMs} slotMs={o.slotMs} plotRef={plotRef} />
      {groups.map((g, i) => (
        <div key={g.key}>
          <GroupRow
            g={g}
            mode={mode}
            shared={shared}
            open={open.includes(g.key)}
            onToggle={() => onToggle(g.key)}
            first={i === 0}
          />
          {open.includes(g.key) && <Lanes groupKey={g.key} base={base} shared={shared} scales={scales} />}
        </div>
      ))}
      {o.scripted.usd > 0 && <ScriptedRow o={o} shared={shared} />}
      {selection && (
        <SlotList
          sel={selection}
          base={base}
          fromMs={fromMs}
          slotMs={o.slotMs}
          slots={o.slots}
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  )
}
