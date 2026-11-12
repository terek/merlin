// The Overview page (experimental, docs/ui.md section 10b): where the agents' work went over a day,
// a week or a month, as one table in a fixed-height container: the toolbar and the sortable column headers
// stay on top, the rows scroll, the date axis and the totals stay at the bottom. Every row has its
// text line (head, description, turns, agents, spend, last activity) and under it a merged cell with the
// row's graph on one shared linear time axis.

import { ArrowDown, ArrowUp } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useOverview } from '../../api/queries'
import type { Overview, OverviewGroup, OverviewLane, OverviewSpan } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatTokens, plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { Money, QueryBoundary, SegmentedControl, Skeleton } from '../../ui'
import { COLOR, CTX_FILL, elbowPath, WORKFLOW_DASH } from '../spend/TimeView'
import {
  ACTIVE_W,
  type Axis,
  activityRuns,
  apiBy,
  axisTicks,
  type By,
  buildRows,
  chooseSlot,
  fitLabels,
  formatSort,
  groupDescription,
  groupScale,
  isBranch,
  LANE_DEPTH,
  laneDescription,
  laneHead,
  laneScale,
  lanesByGroup,
  lastLabel,
  lifeSpan,
  makeAxis,
  midnightXs,
  nextSort,
  oneLine,
  parseBy,
  parseShow,
  parseSort,
  RANGES,
  type Range,
  type Row,
  type Show,
  type Sort,
  type SortKey,
  slotX,
  spineLanes,
  stepAreaPath,
} from './model'
import { useDebounced, useWidth } from './useWidth'

/** The first column (flat table only), the numeric columns (px) and the cell padding the graph sits in. */
const GUTTER_W = 140
const COLS = { turns: 52, agents: 56, spend: 84, last: 64 }
const CELL_PAD = 12
const CARD_BORDER = 2
/** A nested session's indent, and the scrollbar width the page assumes before it has measured one. */
const INDENT = 16
const SCROLLBAR = 15
const TEN_MIN = 600_000

/** The idle context's fill: the main colour, severely tinted. */
const IDLE_FILL = 0.2
/** The thin vertical of a spawn. */
const TICK_W = 0.75
const TICK_OPACITY = 0.6
const RUN_W = 2
const PAD_TOP = 1

const BY_LABEL: Record<By, string> = {
  none: 'Project',
  dir: 'Project',
  checkout: 'Checkout',
  repo: 'Repository',
  remote: 'Remote',
}

/** The colour a span is drawn in: the Session page's, by kind; a branched session is the main colour. */
const spanColor = (k: OverviewSpan['kind']): string =>
  k === 'session-fork' || k === 'continuation'
    ? COLOR.main
    : k === 'teammate'
      ? COLOR.addressable
      : k === 'fork'
        ? COLOR.fork
        : COLOR.subagent

// ---- the rows' data, one shape for a group and a lane ------------------------------------

interface RowData {
  key: string
  ctx: number[]
  idle: number[]
  active: number[]
  /** The slot of index 0 of the arrays (a lane's are trimmed). */
  offset: number
  /** The sessions whose lifetimes the row covers: day lines are drawn only inside them. */
  lives: OverviewLane[]
  spans: OverviewSpan[]
  /** A session row: its lifetime is drawn as the faint baseline, and the line, spine and nodes on it. */
  lane?: OverviewLane
}

/** The axis and the two token scales: one for the group rows (total context), one for the session rows. */
interface Shared {
  axis: Axis
  groupPx: number
  lanePx: number
}

/** A group row shows only its total context, held and idle: no session line, spawns or baseline. */
const groupData = (g: OverviewGroup, lanes: OverviewLane[]): RowData => ({
  key: `g:${g.key}`,
  lives: lanes,
  ctx: g.contextSum,
  idle: g.idleSum,
  active: [],
  offset: 0,
  spans: [],
})

const laneData = (l: OverviewLane): RowData => ({
  key: `l:${l.group}\u0000${l.harness}/${l.id}`,
  lives: [l],
  ctx: l.context,
  idle: l.idle,
  active: l.active,
  offset: l.slot0,
  spans: l.spans,
  lane: l,
})

// ---- the graph of one row ----------------------------------------------------------------

function RowGraph({ data, shared }: { data: RowData; shared: Shared }) {
  const { axis } = shared
  const pxPerTok = data.lane ? shared.lanePx : shared.groupPx
  const base = PAD_TOP + 15
  const spines = useMemo(() => spineLanes(data.spans, axis), [data.spans, axis])
  const laneY = base + LANE_DEPTH
  const height = base + (spines.some((k) => !isBranch(k.kind)) ? LANE_DEPTH + 3 : 3)
  const ctxPath = useMemo(
    () => stepAreaPath(data.ctx, axis, base, pxPerTok, data.offset),
    [data.ctx, data.offset, axis, base, pxPerTok],
  )
  const idlePath = useMemo(
    () => stepAreaPath(data.idle, axis, base, pxPerTok, data.offset),
    [data.idle, data.offset, axis, base, pxPerTok],
  )
  const runs = useMemo(() => activityRuns(data.active, data.offset), [data.active, data.offset])
  const midnights = useMemo(() => {
    const spans = data.lives.flatMap((l) => {
      const s = lifeSpan(l.startedAt, l.lastActivityAt, axis)
      return s ? [s] : []
    })
    return midnightXs(axis).filter((x) => spans.some((s) => x >= s[0] && x <= s[1]))
  }, [axis, data.lives])
  const life = useMemo(
    () => (data.lane ? lifeSpan(data.lane.startedAt, data.lane.lastActivityAt, axis) : null),
    [data.lane, axis],
  )

  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decoration; the row's text is the content
    <svg width={axis.width} height={height} className="pointer-events-none block select-none" aria-hidden>
      {midnights.map((x) => (
        <line key={x} x1={x} x2={x} y1={0} y2={height} stroke="var(--line)" strokeWidth={1} opacity={0.6} />
      ))}
      <path d={idlePath} fill={COLOR.main} fillOpacity={IDLE_FILL} />
      <path d={ctxPath} fill={COLOR.main} fillOpacity={CTX_FILL} />
      {life && <line x1={life[0]} x2={life[1]} y1={base} y2={base} stroke="var(--line)" strokeWidth={1} />}
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
      {spines.map((ks) => {
        const color = spanColor(ks.kind)
        return (
          <g key={ks.kind}>
            {ks.ticks.length > 0 && !isBranch(ks.kind) && (
              <path
                d={ks.ticks.map((x) => `M${x},${base}V${laneY}`).join('')}
                stroke={color}
                strokeWidth={TICK_W}
                opacity={TICK_OPACITY}
                fill="none"
              />
            )}
            {ks.runs.map((r) => {
              const rad = Math.min(6, LANE_DEPTH)
              return (
                <g key={r.x0}>
                  {!r.clipped && (
                    <path
                      d={elbowPath(r.x0, base, laneY)}
                      fill="none"
                      stroke={color}
                      strokeWidth={RUN_W - 0.5}
                      strokeLinecap="round"
                      opacity={0.85}
                    />
                  )}
                  <line
                    x1={r.clipped ? 0 : r.x0 + rad}
                    x2={r.x1}
                    y1={laneY}
                    y2={laneY}
                    stroke={color}
                    strokeWidth={RUN_W}
                    strokeDasharray={ks.kind === 'workflow' ? WORKFLOW_DASH : undefined}
                  />
                </g>
              )
            })}
            {isBranch(ks.kind) && ks.ticks.length > 0 && (
              <path
                d={ks.ticks.map((x) => `M${x},1V${base}`).join('')}
                stroke={color}
                strokeWidth={RUN_W}
                strokeLinecap="round"
                fill="none"
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

// ---- table rows --------------------------------------------------------------------------

const oneOf = <T extends string>(v: string | null, allowed: readonly T[], def: T): T =>
  allowed.includes(v as T) ? (v as T) : def

function Num({ w, children, className }: { w: number; children: ReactNode; className?: string }) {
  return (
    <span className={cn('shrink-0 text-right tabular-nums', className)} style={{ width: w }}>
      {children}
    </span>
  )
}

/**
 * The text line of a row: a bold head and a muted description on one line (cut with an ellipsis, the whole
 * text in the title), then the four columns.
 */
function TextLine({
  head,
  headText,
  desc,
  indent = 0,
  turns,
  agents,
  usd,
  last,
  className,
}: {
  head: ReactNode
  headText: string
  desc?: string
  indent?: number
  turns?: number
  agents?: number
  usd?: number
  last?: string
  className?: string
}) {
  const now = useNow()
  const count = (n: number | undefined) =>
    n === undefined ? '' : n === 0 ? <span className="text-faint">0</span> : n.toLocaleString('en-US')
  const text = oneLine(desc ?? '')
  return (
    <div className={cn('flex items-baseline gap-2 pt-1 text-sec', className)} style={{ paddingLeft: indent }}>
      <div className="min-w-0 flex-1 truncate" title={text ? `${headText}: ${text}` : headText}>
        {head}
        {text && <span className="ml-2 text-muted">{text}</span>}
      </div>
      <Num w={COLS.turns}>{count(turns)}</Num>
      <Num w={COLS.agents}>{count(agents)}</Num>
      <Num w={COLS.spend}>{usd !== undefined && <Money usd={usd} />}</Num>
      <Num w={COLS.last} className="whitespace-nowrap text-muted">
        {last !== undefined && (
          <time dateTime={last} title={last}>
            {lastLabel(last, now.getTime())}
          </time>
        )}
      </Num>
    </div>
  )
}

/** A row: the first column (flat table only) and the cell with the text line and the graph. */
function Frame({
  gutter,
  first,
  tint,
  children,
}: {
  gutter: number
  first?: ReactNode
  tint?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn('flex border-line border-t first:border-t-0', tint && 'bg-surface-2')}>
      {gutter > 0 && (
        <div className="min-w-0 shrink-0 truncate pt-1 pr-1 pl-3 text-muted text-sec" style={{ width: gutter }}>
          {first}
        </div>
      )}
      <div className="min-w-0 flex-1 pb-1" style={{ paddingInline: CELL_PAD }}>
        {children}
      </div>
    </div>
  )
}

function SessionRow({
  l,
  nested,
  groupName,
  gutter,
  shared,
}: {
  l: OverviewLane
  nested: boolean
  groupName: string
  gutter: number
  shared: Shared
}) {
  const head = laneHead(l)
  return (
    <Frame gutter={gutter} first={<span title={groupName || 'no value'}>{groupName || 'no value'}</span>}>
      <TextLine
        head={
          <Link
            to={`/s/${encodeURIComponent(l.harness)}/${encodeURIComponent(l.id)}`}
            className="font-semibold text-fg hover:underline"
          >
            {head}
          </Link>
        }
        headText={head}
        desc={laneDescription(l)}
        indent={nested ? INDENT : 0}
        turns={l.turns}
        agents={l.agents}
        usd={l.usd}
        last={l.lastActivityAt}
      />
      <RowGraph data={laneData(l)} shared={shared} />
    </Frame>
  )
}

function GroupRow({
  g,
  lanes,
  priciestHead,
  gutter,
  tint,
  shared,
}: {
  g: OverviewGroup
  priciestHead?: string
  lanes: OverviewLane[]
  gutter: number
  tint: boolean
  shared: Shared
}) {
  const name = g.name || 'no value'
  return (
    <Frame gutter={gutter} tint={tint}>
      <TextLine
        head={<span className="font-semibold text-fg">{name}</span>}
        headText={name}
        desc={groupDescription(g, priciestHead)}
        turns={g.turns}
        agents={g.agents}
        usd={g.usd}
        last={g.lastActivityAt}
      />
      <RowGraph data={groupData(g, lanes)} shared={shared} />
    </Frame>
  )
}

function ScriptedRow({ o, gutter }: { o: Overview; gutter: number }) {
  return (
    <Frame gutter={gutter}>
      <TextLine
        head={`${plural(o.scripted.sessions, 'scripted run')}`}
        headText={`${plural(o.scripted.sessions, 'scripted run')}`}
        usd={o.scripted.usd}
        className="[&_*]:text-faint"
      />
    </Frame>
  )
}

// ---- the sticky top: column headers ------------------------------------------------------

function Th({
  col,
  label,
  w,
  sort,
  onSort,
  title,
}: {
  col: SortKey
  label: string
  w?: number
  sort: Sort
  onSort: (k: SortKey) => void
  title: string
}) {
  const on = sort.key === col
  const Arrow = sort.desc ? ArrowDown : ArrowUp
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      title={title}
      aria-label={`Sort by ${label.toLowerCase()}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-meta uppercase tracking-wide hover:text-fg',
        w === undefined ? 'min-w-0 flex-1 justify-start' : 'justify-end',
        on ? 'text-fg' : 'text-faint',
      )}
      style={w === undefined ? undefined : { width: w }}
    >
      {w !== undefined && <Arrow size={11} aria-hidden className={cn('shrink-0', !on && 'invisible')} />}
      {label}
      {w === undefined && <Arrow size={11} aria-hidden className={cn('shrink-0', !on && 'invisible')} />}
    </button>
  )
}

function Header({
  gutter,
  byLabel,
  sort,
  onSort,
  padRight,
}: {
  gutter: number
  byLabel: string
  sort: Sort
  onSort: (k: SortKey) => void
  padRight: number
}) {
  const th = { sort, onSort }
  return (
    <div className="shrink-0 border-line border-y bg-surface" style={{ paddingRight: padRight }}>
      <div className="flex py-1">
        {gutter > 0 && (
          <div
            className="shrink-0 truncate pl-3 text-faint text-meta uppercase tracking-wide"
            style={{ width: gutter }}
          >
            {byLabel}
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-baseline gap-2" style={{ paddingInline: CELL_PAD }}>
          <Th {...th} col="session" label="Session" title="Sort by start time (group rows: by number of sessions)" />
          <Th {...th} col="turns" label="Turns" w={COLS.turns} title="Sort by turns" />
          <Th {...th} col="agents" label="Agents" w={COLS.agents} title="Sort by agents launched" />
          <Th {...th} col="spend" label="Spend" w={COLS.spend} title="Sort by spend" />
          <Th {...th} col="last" label="Last" w={COLS.last} title="Sort by last activity" />
        </div>
      </div>
    </div>
  )
}

// ---- the sticky footer: date axis and totals ---------------------------------

function AxisRow({ axis, gutter, padRight }: { axis: Axis; gutter: number; padRight: number }) {
  const ticks = fitLabels(axisTicks(axis), axis.width)
  return (
    <div className="border-line border-t" style={{ paddingRight: padRight }}>
      <div className="flex">
        <div className="shrink-0" style={{ width: gutter }} />
        <div className="min-w-0 flex-1" style={{ paddingInline: CELL_PAD }}>
          <svg width={axis.width} height={20} className="block" role="img" aria-label="Time axis">
            {ticks.map((t) => (
              <g key={t.x}>
                <line x1={t.x} x2={t.x} y1={0} y2={t.day ? 6 : t.labelled ? 4 : 3} stroke="var(--line)" />
                {t.labelled && (
                  <text x={t.x + 3} y={16} fontSize={11} fill={t.day ? 'var(--muted)' : 'var(--faint)'}>
                    {t.label}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
      </div>
    </div>
  )
}

function Totals({ o, gutter, padRight }: { o: Overview; gutter: number; padRight: number }) {
  const sum = (f: (g: OverviewGroup) => number) => o.groups.reduce((a, g) => a + f(g), 0)
  const n = sum((g) => g.sessions)
  return (
    <div className="border-line border-t" style={{ paddingRight: padRight }}>
      <div className="flex">
        <div className="shrink-0" style={{ width: gutter }} />
        <div className="min-w-0 flex-1 pb-1" style={{ paddingInline: CELL_PAD }}>
          <TextLine
            className="font-medium"
            head={<span className="text-fg">Total</span>}
            headText="Total"
            desc={plural(n, 'session')}
            turns={sum((g) => g.turns)}
            agents={sum((g) => g.agents)}
            usd={sum((g) => g.usd)}
          />
        </div>
      </div>
    </div>
  )
}

// ---- the page ----------------------------------------------------------------------------

export function OverviewPage() {
  useDocumentTitle('Overview')
  const [sp, setSp] = useSearchParams()
  const range = oneOf<Range>(sp.get('range'), ['1d', '7d', '30d'], '7d')
  const by = parseBy(sp.get('by'))
  const show = parseShow(sp.get('show'))
  const sort = useMemo(() => parseSort(sp.get('sort'), sp.get('dir')), [sp])
  const flat = by === 'none'

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
  const gutter = flat ? GUTTER_W : 0
  const pagePlotW = Math.max(240, cardW - CARD_BORDER - SCROLLBAR - gutter - 2 * CELL_PAD)
  const slot = chooseSlot(RANGES[range].ms, useDebounced(pagePlotW, 250))

  // "Ending now", rounded up so that the query key holds still between refreshes.
  const now = useNow(300_000)
  const to = Math.ceil(now.getTime() / TEN_MIN) * TEN_MIN
  const query = useOverview({
    from: new Date(to - RANGES[range].ms).toISOString(),
    to: new Date(to).toISOString(),
    slot,
    by: apiBy(by),
  })

  // Group rows (total context) and session rows have a token scale each; the note names those on screen.
  const scales = useMemo(
    () => ({
      groups: query.data ? groupScale(query.data.groups) : { maxTok: 0, pxPerTok: 0 },
      lanes: query.data ? laneScale(query.data.lanes) : { maxTok: 0, pxPerTok: 0 },
    }),
    [query.data],
  )
  const notes = [
    !flat && scales.groups.maxTok > 0 && `groups 15 px = ${formatTokens(scales.groups.maxTok)}`,
    (flat || show === 'sessions') && scales.lanes.maxTok > 0 && `sessions 15 px = ${formatTokens(scales.lanes.maxTok)}`,
  ].filter(Boolean)

  return (
    <div className="mx-auto flex h-[calc(100vh-44px)] w-full max-w-[2000px] flex-col px-4 py-3">
      <div
        ref={cardRef}
        className="flex min-h-0 flex-1 flex-col overflow-clip rounded-card border border-line bg-surface"
      >
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
          <h1 className="mr-1 font-semibold text-title">Overview</h1>
          <SegmentedControl<Range>
            label="Range"
            value={range}
            options={[
              { value: '1d', label: '1d', title: 'The last day' },
              { value: '7d', label: '7d', title: 'The last week' },
              { value: '30d', label: '30d', title: 'The last 30 days' },
            ]}
            onChange={(v) => set({ range: v === '7d' ? undefined : v })}
          />
          <div className="flex items-center gap-1.5 text-muted text-sec">
            group
            <SegmentedControl<By>
              label="Group by"
              value={by}
              options={[
                { value: 'none', label: 'None', title: 'One row per session' },
                { value: 'dir', label: 'Project' },
                { value: 'checkout', label: 'Checkout' },
                { value: 'repo', label: 'Repo', title: 'Repository' },
                { value: 'remote', label: 'Remote' },
              ]}
              onChange={(v) => set({ by: v === 'dir' ? undefined : v })}
            />
          </div>
          {!flat && (
            <div className="flex items-center gap-1.5 text-muted text-sec">
              show
              <SegmentedControl<Show>
                label="Show"
                value={show}
                options={[
                  { value: 'sessions', label: 'Sessions', title: 'Every group with all its sessions under it' },
                  {
                    value: 'groups',
                    label: 'Groups',
                    title: 'The groups alone, each with the graph of all its sessions',
                  },
                ]}
                onChange={(v) => set({ show: v === 'sessions' ? undefined : v })}
              />
            </div>
          )}
          {notes.length > 0 && (
            <span className="ml-auto truncate text-faint text-meta">context: {notes.join(' · ')} tokens</span>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <QueryBoundary
            query={query}
            isEmpty={(o) => o.groups.length === 0 && o.scripted.usd === 0}
            empty={<div className="border-line border-t p-6 text-muted">Nothing ran in this range.</div>}
            skeleton={<Skeleton className="m-3 h-64" />}
          >
            {(o) => (
              <Table
                o={o}
                by={by}
                show={show}
                sort={sort}
                scales={scales}
                onSort={(k) => set(formatSort(nextSort(sort, k)))}
              />
            )}
          </QueryBoundary>
        </div>
      </div>
    </div>
  )
}

function Table({
  o,
  by,
  show,
  sort,
  scales,
  onSort,
}: {
  o: Overview
  by: By
  show: Show
  sort: Sort
  scales: { groups: { pxPerTok: number }; lanes: { pxPerTok: number } }
  onSort: (k: SortKey) => void
}) {
  const gutter = by === 'none' ? GUTTER_W : 0
  // The rows scroll; header and footer do not. The scrollbar takes width from the rows only, so the
  // header and the footer give up as much (padRight) and the columns and the date axis stay aligned.
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const innerW = useWidth(innerRef)
  const plotW = Math.max(240, innerW - gutter - 2 * CELL_PAD)
  const [padRight, setPadRight] = useState(0)
  const rows = useMemo(() => buildRows(o, by, show, sort), [o, by, show, sort])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the rows decide whether the scrollbar is there
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setPadRight(el.offsetWidth - el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rows.length])

  const axis = useMemo(
    () => makeAxis(Date.parse(o.from), Date.parse(o.to), o.slotMs, plotW),
    [o.from, o.to, o.slotMs, plotW],
  )
  const shared: Shared = { axis, groupPx: scales.groups.pxPerTok, lanePx: scales.lanes.pxPerTok }
  const byGroup = useMemo(() => lanesByGroup(o.lanes), [o.lanes])
  const priciest = useMemo(() => {
    const m = new Map(o.lanes.map((l) => [`${l.harness}/${l.id}`, laneHead(l)]))
    return (g: OverviewGroup) => (g.priciest ? m.get(`${g.priciest.harness}/${g.priciest.id}`) : undefined)
  }, [o.lanes])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header gutter={gutter} byLabel={BY_LABEL[by]} sort={sort} onSort={onSort} padRight={padRight} />
      <div ref={scrollRef} id="overview-rows" className="min-h-0 flex-1 overflow-y-auto">
        <div ref={innerRef}>
          {rows.map((r: Row) =>
            r.kind === 'group' ? (
              <GroupRow
                key={r.key}
                g={r.g}
                lanes={byGroup.get(r.g.key) ?? []}
                priciestHead={priciest(r.g)}
                gutter={gutter}
                tint={show === 'sessions'}
                shared={shared}
              />
            ) : (
              <SessionRow
                key={r.key}
                l={r.l}
                nested={r.nested}
                groupName={r.groupName}
                gutter={gutter}
                shared={shared}
              />
            ),
          )}
          {o.scripted.usd > 0 && <ScriptedRow o={o} gutter={gutter} />}
        </div>
      </div>
      <div className="shrink-0 bg-surface">
        <AxisRow axis={axis} gutter={gutter} padRight={padRight} />
        <Totals o={o} gutter={gutter} padRight={padRight} />
      </div>
    </div>
  )
}
