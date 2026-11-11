// The Overview page (experimental, docs/ui.md section 10b): where the agents' work went over a day,
// a week or a month, drawn as the Session page's spend graph zoomed out. One linear time axis; a row
// per group of sessions with its context above the baseline, its spend below and the work it launched
// hanging under as spines, on scales every row shares.

import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useOverview } from '../../api/queries'
import type { GroupDim, Overview, OverviewLane, OverviewSpan } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatDuration, formatMoney, formatTokens, plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { Money, QueryBoundary, RelTime, SegmentedControl, Select, Skeleton } from '../../ui'
import {
  BranchNode,
  COLOR,
  COMPACT_MARK,
  CTX_FILL,
  CTX_LINE,
  elbowPath,
  markColor,
  SPEND_COLOR,
  SPINE_OPACITY,
  SPINE_W,
  WORKFLOW_DASH,
} from '../spend/TimeView'
import {
  ACTIVE_W,
  type Axis,
  activityRuns,
  axisTicks,
  type CtxMode,
  chooseSlot,
  compactionsBySlot,
  contextOf,
  describeCompactions,
  formatOpen,
  type Heights,
  LANE_H,
  LANES_GAP,
  laneBlock,
  lanesIn,
  layoutSpans,
  makeAxis,
  midnightXs,
  niceFloor,
  parseOpen,
  RANGES,
  type Range,
  rangeLabel,
  rowHeights,
  type Scales,
  type SortKey,
  SPAN_LABEL,
  scalesFor,
  slotAt,
  slotLabel,
  slotX,
  sortGroups,
  stepAreaPath,
  toggleOpen,
  xOf,
} from './model'
import { useDebounced, useWidth } from './useWidth'

const LABEL_W = 248
const PAD = 4
const MIN_ROW = 34
const MIN_LANE = 24
const CARD_BORDER = 2
const TEN_MIN = 600_000

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

/** The colour a span is drawn in: the Session page's, by kind; a branched session is the main colour. */
const spanColor = (k: OverviewSpan['kind']): string =>
  k === 'session-fork' || k === 'continuation'
    ? COLOR.main
    : k === 'teammate'
      ? COLOR.addressable
      : k === 'fork'
        ? COLOR.fork
        : COLOR.subagent

const isBranch = (k: OverviewSpan['kind']) => k === 'session-fork' || k === 'continuation'

// ---- the rows' data, one shape for a group and a lane ------------------------------------

interface RowData {
  key: string
  ctx: number[]
  usd: number[]
  active: number[]
  events: Overview['groups'][number]['events']
  spans: OverviewSpan[] | undefined
  lane?: OverviewLane
}

interface Hover {
  row: string
  slot: number
  span?: OverviewSpan
  lane?: OverviewLane
}

interface Selection {
  /** A group key, or null for the scripted row (not selectable). */
  key: string
  name: string
  /** Time range, the end exclusive. */
  t0: number
  t1: number
  /** A click on a spine: list this session. */
  session?: { harness: string; id: string }
  what?: string
}

interface Shared {
  axis: Axis
  scales: Scales
  hover: Hover | null
  setHover: (h: Hover | null) => void
  selection: Selection | null
  select: (s: Omit<Selection, 'name'> & { name?: string }) => void
}

// ---- the plot of one row -----------------------------------------------------------------

function RowPlot({
  data,
  groupKey,
  h,
  height,
  layout,
  shared,
  faint,
  scaleLabels,
}: {
  data: RowData
  /** The group a click on this row lists (a lane's is its group's). */
  groupKey: string
  h: Heights
  height: number
  layout: ReturnType<typeof layoutSpans>
  shared: Shared
  faint?: boolean
  scaleLabels?: boolean
}) {
  const { axis, scales, hover, setHover, selection } = shared
  const anchor = useRef(-1)
  const base = PAD + h.up
  const lanesTop = base + h.down + LANES_GAP + LANE_H / 2
  const marks = useMemo(() => compactionsBySlot(data.events), [data.events])
  const path = useMemo(() => stepAreaPath(data.ctx, axis, base, scales.pxPerTok), [data.ctx, axis, base, scales])
  const runs = useMemo(() => activityRuns(data.active), [data.active])
  const midnights = useMemo(() => midnightXs(axis), [axis])
  const spend = useMemo(() => {
    let d = ''
    const y0 = base + 1.5
    data.usd.forEach((v, i) => {
      if (!(v > 0)) return
      const x = Math.round((slotX(axis, i) + axis.slotW / 2) * 10) / 10
      d += `M${x},${y0}V${Math.round((y0 + Math.max(1, Math.min(h.down, v * scales.pxPerUsd))) * 10) / 10}`
    })
    return d
  }, [data.usd, axis, base, h.down, scales.pxPerUsd])
  const pointerX = (e: React.PointerEvent) => e.clientX - e.currentTarget.getBoundingClientRect().left
  const svgX = (e: React.PointerEvent<SVGElement>) =>
    e.clientX - (e.currentTarget.ownerSVGElement ?? (e.currentTarget as SVGSVGElement)).getBoundingClientRect().left
  const mine = hover?.row === data.key ? hover.slot : -1
  const sel = selection && selection.key === groupKey && !selection.session ? selection : null
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
        const s = slotAt(axis, pointerX(e))
        if (s < 0) setHover(null)
        else if (mine !== s || hover?.span) setHover({ row: data.key, slot: s, lane: data.lane })
      }}
      onPointerLeave={() => {
        anchor.current = -1
        setHover(null)
      }}
      onPointerCancel={() => setHover(null)}
      onPointerDown={(e) => {
        anchor.current = slotAt(axis, pointerX(e))
      }}
      onPointerUp={(e) => {
        const s = slotAt(axis, pointerX(e))
        if (s >= 0 && anchor.current >= 0) {
          const a = Math.min(anchor.current, s)
          const b = Math.max(anchor.current, s)
          shared.select({
            key: groupKey,
            t0: axis.fromMs + a * axis.slotMs,
            t1: axis.fromMs + (b + 1) * axis.slotMs,
          })
        }
        anchor.current = -1
      }}
    >
      {midnights.map((x) => (
        <line key={x} x1={x} x2={x} y1={0} y2={height} stroke="var(--line)" strokeWidth={1} opacity={0.6} />
      ))}
      {sel && (
        <rect
          x={xOf(axis, sel.t0)}
          y={0}
          width={Math.max(2, xOf(axis, sel.t1) - xOf(axis, sel.t0))}
          height={height}
          fill="var(--accent)"
          opacity={0.16}
        />
      )}
      {mine >= 0 && (
        <rect
          x={slotX(axis, mine)}
          y={0}
          width={Math.max(1.5, axis.slotW)}
          height={height}
          fill="var(--text)"
          opacity={0.1}
        />
      )}
      <g opacity={sc}>
        <path d={path.area} fill={COLOR.main} fillOpacity={CTX_FILL} />
        <path d={path.line} fill="none" stroke={COLOR.main} strokeWidth={CTX_LINE} strokeLinejoin="round" />
        <path d={spend} fill="none" stroke={SPEND_COLOR} strokeWidth={1} opacity={0.85} />
      </g>
      <line x1={0} x2={axis.width} y1={base} y2={base} stroke="var(--line)" strokeWidth={1} />
      <g opacity={sc}>
        {runs.map((r) => (
          <line
            key={r.from}
            x1={slotX(axis, r.from)}
            x2={slotX(axis, r.to)}
            y1={base}
            y2={base}
            stroke={COLOR.main}
            strokeWidth={ACTIVE_W[r.weight]}
          />
        ))}
      </g>
      {ctxTick > 0 && ctxTick * scales.pxPerTok >= 14 && (
        <ScaleLine y={base - ctxTick * scales.pxPerTok} text={`${formatTokens(ctxTick)} tokens`} />
      )}
      {usdTick > 0 && usdTick * scales.pxPerUsd >= 12 && (
        <ScaleLine y={base + 1.5 + usdTick * scales.pxPerUsd} text={`${formatMoney(usdTick)} per slot`} />
      )}
      {[...marks.entries()].map(([i, m]) => {
        const cx = slotX(axis, i) + axis.slotW / 2
        const cold = m.cold > 0
        const mark = cold ? COMPACT_MARK.cold : COMPACT_MARK.warm
        const c = data.ctx[i] ?? 0
        const y0 = c > 0 ? Math.max(2, base - c * scales.pxPerTok - 4) : base - 8
        return (
          <line
            key={i}
            x1={cx}
            x2={cx}
            y1={y0}
            y2={base}
            stroke={markColor(cold ? { cache: 'cold' } : m.warm ? { cache: 'warm' } : undefined)}
            strokeWidth={mark.width}
            strokeDasharray={mark.dash}
            opacity={sc}
            pointerEvents="none"
          />
        )
      })}
      {layout.items.map((it, k) => {
        const kind = it.span.kind
        const color = spanColor(kind)
        const y = lanesTop + it.lane * LANE_H
        const on = hover?.span === it.span
        const r = Math.min(6, Math.abs(y - base))
        const x1 = Math.max(it.x1, it.x0 + 16)
        const sel2 = selection?.session?.id === it.span.session.id && selection.what === kind
        return (
          <g
            // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
            key={k}
            opacity={sc}
            className="cursor-pointer"
            onPointerMove={(e) => {
              e.stopPropagation()
              if (hover?.span !== it.span)
                setHover({ row: data.key, slot: slotAt(axis, svgX(e)), span: it.span, lane: data.lane })
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={() =>
              shared.select({
                key: groupKey,
                t0: axis.fromMs,
                t1: axis.toMs,
                session: it.span.session,
                what: kind,
              })
            }
          >
            <rect x={it.x0 - 3} y={y - LANE_H / 2} width={x1 - it.x0 + 6} height={LANE_H} fill="transparent" />
            {!it.clipped && (
              <path
                d={elbowPath(it.x0, base, y)}
                fill="none"
                stroke={color}
                strokeWidth={SPINE_W}
                strokeLinecap="round"
                opacity={on || sel2 ? 1 : SPINE_OPACITY}
                pointerEvents="none"
              />
            )}
            <line
              x1={it.clipped ? 0 : it.x0 + r}
              x2={x1}
              y1={y}
              y2={y}
              stroke={color}
              strokeWidth={on || sel2 ? 2.5 : 2}
              strokeDasharray={kind === 'workflow' ? WORKFLOW_DASH : undefined}
              pointerEvents="none"
            />
            {!it.clipped && (kind === 'fork' || isBranch(kind)) && (
              <BranchNode x={it.x0} y={base} color={color} ring={kind === 'continuation'} />
            )}
            {it.span.n > 1 && x1 + 24 <= axis.width && (
              <text
                x={x1 + 3}
                y={y + 3}
                fontSize={9}
                fill="var(--muted)"
                stroke="var(--surface)"
                strokeWidth={2.5}
                paintOrder="stroke"
                pointerEvents="none"
              >
                {`×${it.span.n}`}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

const axisPad = 14

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

// ---- rows --------------------------------------------------------------------------------

const groupData = (g: Overview['groups'][number], mode: CtxMode): RowData => ({
  key: g.key,
  ctx: contextOf(g, mode),
  usd: g.usdSlots,
  active: g.active,
  events: g.events,
  spans: g.spans,
})

const laneData = (groupKey: string, l: OverviewLane): RowData => ({
  key: `${groupKey}\u0000${l.harness}/${l.id}`,
  ctx: l.context,
  usd: l.usdSlots,
  active: l.active,
  events: l.events,
  spans: l.spans,
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

/** A row: its height is its own peaks on the shared scales plus the sub-lanes its spines need. */
function PlotRow({
  data,
  groupKey,
  shared,
  label,
  className,
  minHeight,
  minSide,
  faint,
  noContext,
  scaleLabels,
}: {
  data: RowData
  groupKey: string
  shared: Shared
  label: ReactNode
  className?: string
  minHeight: number
  minSide?: number
  faint?: boolean
  noContext?: boolean
  scaleLabels?: boolean
}) {
  const layout = useMemo(() => layoutSpans(data.spans, shared.axis), [data.spans, shared.axis])
  const h = rowHeights(noContext ? [] : data.ctx, data.usd, shared.scales, minSide)
  const hh: Heights = noContext ? { up: 0, down: h.down } : h
  const height = Math.max(minHeight, hh.up + hh.down + 2 * PAD + laneBlock(layout.lanes))
  return (
    <RowShell
      className={className}
      label={label}
      plot={
        <RowPlot
          data={data}
          groupKey={groupKey}
          h={hh}
          height={height}
          layout={layout}
          shared={shared}
          faint={faint}
          scaleLabels={scaleLabels}
        />
      }
    />
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
  return (
    <PlotRow
      data={groupData(g, mode)}
      groupKey={g.key}
      shared={shared}
      minHeight={MIN_ROW}
      scaleLabels={first}
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
    />
  )
}

function Lanes({
  groupKey,
  base,
  shared,
}: {
  groupKey: string
  base: Parameters<typeof useOverview>[0]
  shared: Shared
}) {
  const q = useOverview({ ...base, group: groupKey })
  const lanes = q.data?.lanes
  // a refetch after a change of slot keeps the old lanes until the new ones come: skip them meanwhile
  if (!lanes || q.data?.slotMs !== shared.axis.slotMs)
    return (
      <RowShell
        label={<Skeleton className="ml-5 h-3 w-32" />}
        plot={<div style={{ height: MIN_LANE }} />}
        className="bg-surface-2/40"
      />
    )
  return (
    <>
      {lanes.map((l) => (
        <PlotRow
          key={`${l.harness}/${l.id}`}
          data={laneData(groupKey, l)}
          groupKey={groupKey}
          shared={shared}
          className="bg-surface-2/40"
          minHeight={MIN_LANE}
          minSide={3}
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
        />
      ))}
      {lanes.length === 0 && (
        <RowShell label={<span className="pl-5 text-meta text-faint">no sessions</span>} plot={null} />
      )}
    </>
  )
}

/** Scripted runs are not groups: no click lists them. */
const noSelect = (s: Shared): Shared => ({ ...s, select: () => {}, selection: null })

function ScriptedRow({ o, shared }: { o: Overview; shared: Shared }) {
  const data: RowData = { key: '\u0000scripted', ctx: [], usd: o.scripted.usdSlots, active: [], events: [], spans: [] }
  return (
    <PlotRow
      data={data}
      groupKey=""
      shared={noSelect(shared)}
      className="border-b-0"
      minHeight={MIN_LANE}
      minSide={3}
      faint
      noContext
      label={
        <div className="flex min-w-0 items-baseline gap-1 pl-5 text-meta text-faint">
          <span className="truncate">{plural(o.scripted.sessions, 'scripted run')}</span>
          <span>·</span>
          <Money usd={o.scripted.usd} dim />
        </div>
      }
    />
  )
}

// ---- the axis ----------------------------------------------------------------------------

function AxisRow({ axis }: { axis: Axis }) {
  const ticks = axisTicks(axis)
  return (
    <div className="flex border-line border-b">
      <div className="shrink-0" style={{ width: LABEL_W }} />
      <div className="min-w-0 flex-1">
        <svg width={axis.width} height={22} className="block" role="img" aria-label="Time axis">
          {ticks.map((t) => {
            const right = t.x > axis.width - 52
            return (
              <g key={t.x}>
                <line x1={t.x} x2={t.x} y1={t.day ? 4 : t.labelled ? 14 : 17} y2={22} stroke="var(--line)" />
                {t.labelled && (
                  <text
                    x={t.x + (right ? -3 : 3)}
                    y={13}
                    fontSize={11}
                    textAnchor={right ? 'end' : 'start'}
                    fill={t.day ? 'var(--muted)' : 'var(--faint)'}
                  >
                    {t.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// ---- hover readout -----------------------------------------------------------------------

const clock = (t: number) =>
  new Date(t).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })

function Readout({ o, hover }: { o: Overview; hover: Hover | null }) {
  const fromMs = Date.parse(o.from)
  let body: ReactNode = (
    <span className="text-faint">
      Hover a slot for its numbers, a spine for its work; click to list the sessions, drag across a row for a range.
    </span>
  )
  if (hover && hover.slot >= 0 && hover.slot < o.slots) {
    const when = slotLabel(fromMs, o.slotMs, hover.slot)
    const lane = hover.lane
    const g = lane ? undefined : o.groups.find((x) => x.key === hover.row)
    const i = hover.slot
    const sp = hover.span
    const words = describeCompactions(compactionsBySlot((lane ?? g)?.events).get(i))
    if (sp) {
      const t0 = Date.parse(sp.start)
      const t1 = Date.parse(sp.end)
      body = (
        <>
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 text-fg">
              {SPAN_LABEL[sp.kind]}
              {sp.n > 1 ? ` ×${sp.n}` : ''}
            </span>
            <span className="min-w-0 truncate text-muted">{sp.title || sp.session.id.slice(0, 8)}</span>
          </div>
          <div className="text-muted">
            started {clock(t0)}, {formatDuration(t1 - t0)} long
          </div>
        </>
      )
    } else if (g) {
      body = (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-fg">{g.name || 'no value'}</span>
            <span className="text-muted">{when}</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 text-muted">
            <span>
              <Money usd={g.usdSlots[i] ?? 0} /> in the slot
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
      body = (
        <>
          <div className="flex items-baseline gap-2">
            <span className="truncate text-fg">{lane.title || lane.id}</span>
            <span className="shrink-0 text-muted">{when}</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 text-muted">
            <span>
              <Money usd={lane.usdSlots[i] ?? 0} /> in the slot
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
            <Money usd={o.scripted.usdSlots[i] ?? 0} /> in the slot
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
  onClose,
}: {
  sel: Selection
  base: Parameters<typeof useOverview>[0]
  onClose: () => void
}) {
  const q = useOverview({ ...base, group: sel.key })
  const o = q.data
  const hits = useMemo(() => {
    if (!o?.lanes) return undefined
    const from = Date.parse(o.from)
    const r = {
      from: Math.max(0, Math.floor((sel.t0 - from) / o.slotMs)),
      to: Math.min(o.slots - 1, Math.ceil((sel.t1 - from) / o.slotMs) - 1),
    }
    const all = lanesIn(o.lanes, r)
    return sel.session
      ? all.filter((h) => h.lane.harness === sel.session?.harness && h.lane.id === sel.session.id)
      : all
  }, [o, sel])
  return (
    <section
      className="sticky bottom-0 z-10 border-line border-t bg-surface shadow-[0_-1px_0_var(--line)]"
      aria-label="Sessions in the selected range"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-sec">
        <span className="font-medium text-fg">{sel.name || 'no value'}</span>
        <span className="text-muted">
          {sel.session
            ? `the session of this ${SPAN_LABEL[sel.what as OverviewSpan['kind']] ?? 'spine'}`
            : rangeLabel(sel.t0, sel.t1)}
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
        {hits?.length === 0 && <div className="px-3 py-2 text-sec text-faint">No session ran here.</div>}
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

  // The plot's width picks the slot (about one per pixel); the width is followed live, the slot only
  // once the width has held still, so a drag of the window does not refetch at every pixel.
  const cardRef = useRef<HTMLDivElement>(null)
  const cardW = useWidth(cardRef)
  const plotW = Math.max(240, cardW - CARD_BORDER - LABEL_W)
  const slot = chooseSlot(RANGES[range].ms, useDebounced(plotW, 250))

  // "Ending now", rounded up so that the query key holds still between refreshes.
  const now = useNow(300_000)
  const to = Math.ceil(now.getTime() / TEN_MIN) * TEN_MIN
  const base = { from: new Date(to - RANGES[range].ms).toISOString(), to: new Date(to).toISOString(), slot, by }
  const query = useOverview(base)

  const [hover, setHover] = useState<Hover | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new grain or range makes the old hover meaningless
  useEffect(() => setHover(null), [slot, range, by])

  return (
    <div className="mx-auto w-full max-w-[2000px] px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="mr-2 font-semibold text-title">Overview</h1>
        <SegmentedControl<Range>
          label="Range"
          value={range}
          options={[
            { value: '1d', label: '1d', title: 'The last day' },
            { value: '7d', label: '7d', title: 'The last week' },
            { value: '30d', label: '30d', title: 'The last 30 days' },
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
      <div ref={cardRef}>
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
              plotW={plotW}
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
    </div>
  )
}

function Plot({
  o,
  plotW,
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
  plotW: number
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
  const axis = useMemo(
    () => makeAxis(Date.parse(o.from), Date.parse(o.to), o.slotMs, plotW),
    [o.from, o.to, o.slotMs, plotW],
  )
  const scales = useMemo(() => scalesFor(o.groups, mode, o.scripted.usdSlots), [o, mode])
  const groups = useMemo(() => sortGroups(o.groups, sort), [o.groups, sort])
  const shared: Shared = {
    axis,
    scales,
    hover,
    setHover,
    selection,
    select: (s) => setSelection({ ...s, name: o.groups.find((g) => g.key === s.key)?.name ?? s.key }),
  }
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface" onPointerLeave={() => setHover(null)}>
      <div className="border-line border-b">
        <Readout o={o} hover={hover} />
      </div>
      <AxisRow axis={axis} />
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
          {open.includes(g.key) && <Lanes groupKey={g.key} base={base} shared={shared} />}
        </div>
      ))}
      {o.scripted.usd > 0 && <ScriptedRow o={o} shared={shared} />}
      {selection && <SlotList sel={selection} base={base} onClose={() => setSelection(null)} />}
    </div>
  )
}
