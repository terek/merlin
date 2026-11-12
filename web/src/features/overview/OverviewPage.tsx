// The Overview page (experimental, docs/ui.md section 10b): where the agents' work went over a day,
// a week or a month, as a table of sessions grouped by project. Every row has its text line (title, turns,
// agents, spend, last activity) and under it a merged cell with the row's graph on one shared linear time
// axis: context as a quiet area, the pauses as a paler one, a line where a session ran, and one spine lane
// with a thin vertical per agent the session spawned.

import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useOverview } from '../../api/queries'
import type { GroupDim, Overview, OverviewGroup, OverviewLane, OverviewSpan } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatTokens, plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { Money, QueryBoundary, SegmentedControl, Select, Skeleton } from '../../ui'
import { BranchNode, COLOR, CTX_FILL, elbowPath, WORKFLOW_DASH } from '../spend/TimeView'
import {
  ACTIVE_W,
  type Axis,
  activityRuns,
  axisTicks,
  type CtxMode,
  chooseSlot,
  contextOf,
  describeSpawns,
  fitLabels,
  formatKeys,
  idleOf,
  isBranch,
  LANE_DEPTH,
  laneAt,
  lanesByGroup,
  lastLabel,
  makeAxis,
  midnightXs,
  parseKeys,
  RANGES,
  type Range,
  SHOWN,
  type SortKey,
  type SpawnsNear,
  slotAt,
  slotLabel,
  slotX,
  sortGroups,
  sortLanes,
  spawnsNear,
  spineLanes,
  stepAreaPath,
  toggleKey,
  tokenScale,
  visibleLanes,
} from './model'
import { useDebounced, useWidth } from './useWidth'

/** The group gutter, the table's columns (px) and the cell padding the graph sits in. */
const GUTTER_W = 150
const COLS = { turns: 52, agents: 56, spend: 84, last: 64 }
const CELL_PAD = 12
const CARD_BORDER = 2
const TEN_MIN = 600_000

/** The idle context's fill: the main colour, severely tinted. */
const IDLE_FILL = 0.2
/** The thin vertical of a spawn. */
const TICK_W = 0.75
const TICK_OPACITY = 0.6
const RUN_W = 2
const PAD_TOP = 1

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

// ---- the rows' data, one shape for a group and a lane ------------------------------------

interface RowData {
  key: string
  ctx: number[]
  idle: number[]
  active: number[]
  /** The slot of index 0 of the arrays (a lane's are trimmed). */
  offset: number
  spans: OverviewSpan[]
  group?: OverviewGroup
  lane?: OverviewLane
}

interface Hover {
  row: string
  slot: number
  spawns?: SpawnsNear
  group?: OverviewGroup
  lane?: OverviewLane
}

interface Shared {
  axis: Axis
  pxPerTok: number
  mode: CtxMode
  hover: Hover | null
  setHover: (h: Hover | null) => void
}

const groupData = (g: OverviewGroup, mode: CtxMode): RowData => ({
  key: `g:${g.key}`,
  ctx: contextOf(g, mode),
  idle: idleOf(g, mode),
  active: g.active,
  offset: 0,
  spans: g.spans,
  group: g,
})

const laneData = (l: OverviewLane): RowData => ({
  key: `l:${l.group}\u0000${l.harness}/${l.id}`,
  ctx: l.context,
  idle: l.idle,
  active: l.active,
  offset: l.slot0,
  spans: l.spans,
  lane: l,
})

// ---- the graph of one row ----------------------------------------------------------------

function RowGraph({ data, shared }: { data: RowData; shared: Shared }) {
  const { axis, pxPerTok, hover, setHover } = shared
  const last = useRef('')
  const base = PAD_TOP + 15
  const spines = useMemo(() => spineLanes(data.spans, axis), [data.spans, axis])
  const laneY = base + LANE_DEPTH
  const height = base + (spines.length > 0 ? LANE_DEPTH + 3 : 3)
  const ctxPath = useMemo(
    () => stepAreaPath(data.ctx, axis, base, pxPerTok, data.offset),
    [data.ctx, data.offset, axis, base, pxPerTok],
  )
  const idlePath = useMemo(
    () => stepAreaPath(data.idle, axis, base, pxPerTok, data.offset),
    [data.idle, data.offset, axis, base, pxPerTok],
  )
  const runs = useMemo(() => activityRuns(data.active, data.offset), [data.active, data.offset])
  const midnights = useMemo(() => midnightXs(axis), [axis])
  const mine = hover?.row === data.key ? hover.slot : -1

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const slot = slotAt(axis, x)
    if (slot < 0) {
      last.current = ''
      setHover(null)
      return
    }
    const near = spines.length > 0 && y > base + 2 ? spawnsNear(data.spans, axis, x) : null
    const k = `${data.key}|${slot}|${near ? `${near.total}:${near.titles[0] ?? ''}` : ''}`
    if (k === last.current) return
    last.current = k
    setHover({ row: data.key, slot, spawns: near ?? undefined, group: data.group, lane: data.lane })
  }

  return (
    <svg
      width={axis.width}
      height={height}
      className="block cursor-crosshair select-none"
      role="img"
      aria-label="Context and spawned agents over time"
      onPointerMove={onMove}
      onPointerLeave={() => {
        last.current = ''
        setHover(null)
      }}
    >
      {midnights.map((x) => (
        <line key={x} x1={x} x2={x} y1={0} y2={height} stroke="var(--line)" strokeWidth={1} opacity={0.6} />
      ))}
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
      <path d={idlePath} fill={COLOR.main} fillOpacity={IDLE_FILL} />
      <path d={ctxPath} fill={COLOR.main} fillOpacity={CTX_FILL} />
      <line x1={0} x2={axis.width} y1={base} y2={base} stroke="var(--line)" strokeWidth={1} />
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
            {ks.ticks.length > 0 && (
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
            {isBranch(ks.kind) &&
              ks.ticks.map((x) => (
                <BranchNode key={x} x={x} y={base} color={color} ring={ks.kind === 'continuation'} />
              ))}
          </g>
        )
      })}
    </svg>
  )
}

// ---- table rows --------------------------------------------------------------------------

function Num({ w, children, className }: { w: number; children: ReactNode; className?: string }) {
  return (
    <span className={cn('shrink-0 text-right tabular-nums', className)} style={{ width: w }}>
      {children}
    </span>
  )
}

/** The text line of a row: title and the four columns. */
function TextLine({
  title,
  turns,
  agents,
  usd,
  last,
  className,
}: {
  title: ReactNode
  turns?: number
  agents?: number
  usd?: number
  last?: string
  className?: string
}) {
  const now = useNow()
  const count = (n: number | undefined) =>
    n === undefined ? '' : n === 0 ? <span className="text-faint">0</span> : n.toLocaleString('en-US')
  return (
    <div className={cn('flex items-baseline gap-2 pt-1 text-sec', className)}>
      <div className="min-w-0 flex-1 truncate">{title}</div>
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

function SessionRow({ l, shared }: { l: OverviewLane; shared: Shared }) {
  return (
    <div className="border-line border-t border-dashed first:border-t-0">
      <TextLine
        title={
          <Link
            to={`/s/${encodeURIComponent(l.harness)}/${encodeURIComponent(l.id)}`}
            className="text-fg hover:underline"
            title={l.title || l.id}
          >
            {l.title || l.id.slice(0, 8)}
          </Link>
        }
        turns={l.turns}
        agents={l.agents}
        usd={l.usd}
        last={l.lastActivityAt}
      />
      <RowGraph data={laneData(l)} shared={shared} />
    </div>
  )
}

function GroupBlock({
  g,
  lanes,
  closed,
  all,
  onToggle,
  onAll,
  shared,
}: {
  g: OverviewGroup
  lanes: OverviewLane[]
  closed: boolean
  all: boolean
  onToggle: () => void
  onAll: () => void
  shared: Shared
}) {
  const { shown, more } = visibleLanes(lanes, all)
  return (
    <div className="flex border-line border-t">
      <div className="shrink-0 py-1.5 pr-1 pl-2" style={{ width: GUTTER_W }}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!closed}
          className="flex w-full min-w-0 items-start gap-1 text-left"
          title={g.key || 'no value'}
        >
          {closed ? (
            <ChevronRight size={14} className="mt-0.5 shrink-0 text-muted" />
          ) : (
            <ChevronDown size={14} className="mt-0.5 shrink-0 text-muted" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-body text-fg">{g.name || 'no value'}</span>
            <span className="flex items-baseline gap-1 whitespace-nowrap text-meta text-muted">
              <Money usd={g.usd} dim />
              <span>·</span>
              <span>{g.sessions}</span>
            </span>
          </span>
        </button>
      </div>
      <div className="min-w-0 flex-1 pb-1" style={{ paddingInline: CELL_PAD }}>
        <div>
          <TextLine
            className="font-medium"
            title={`All ${plural(g.sessions, 'session')}`}
            turns={g.turns}
            agents={g.agents}
            usd={g.usd}
            last={g.lastActivityAt}
          />
          <RowGraph data={groupData(g, shared.mode)} shared={shared} />
        </div>
        {!closed && (
          <div className="mt-0.5 border-line border-t">
            {shown.map((l) => (
              <SessionRow key={`${l.harness}/${l.id}`} l={l} shared={shared} />
            ))}
            {(more > 0 || (all && lanes.length > SHOWN)) && (
              <button
                type="button"
                onClick={onAll}
                className="py-1 text-left text-meta text-muted hover:text-fg"
                aria-label={more > 0 ? `Show ${more} more sessions` : 'Show fewer sessions'}
              >
                {more > 0 ? `${more} more ›` : '‹ fewer'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ScriptedRow({ o }: { o: Overview }) {
  return (
    <div className="flex border-line border-t">
      <div style={{ width: GUTTER_W }} className="shrink-0" />
      <div className="min-w-0 flex-1 pb-1 text-faint" style={{ paddingInline: CELL_PAD }}>
        <TextLine
          title={`${plural(o.scripted.sessions, 'scripted run')}`}
          usd={o.scripted.usd}
          className="[&_*]:text-faint"
        />
      </div>
    </div>
  )
}

// ---- the header: columns and time axis ---------------------------------------------------

function Header({ axis, maxTok }: { axis: Axis; maxTok: number }) {
  const ticks = fitLabels(axisTicks(axis), axis.width)
  const th = 'shrink-0 text-right text-meta uppercase tracking-wide text-faint'
  return (
    <div className="sticky top-0 z-10 border-line border-b bg-surface">
      <div className="flex">
        <div className="shrink-0" style={{ width: GUTTER_W }} />
        <div className="min-w-0 flex-1" style={{ paddingInline: CELL_PAD }}>
          <div className="flex items-baseline gap-2 pt-1.5">
            <div className="flex min-w-0 flex-1 items-baseline gap-3 text-meta uppercase tracking-wide text-faint">
              <span>Session</span>
              {maxTok > 0 && (
                <span className="truncate normal-case tracking-normal">
                  context: 15 px = {formatTokens(maxTok)} tokens
                </span>
              )}
            </div>
            <span className={th} style={{ width: COLS.turns }}>
              Turns
            </span>
            <span className={th} style={{ width: COLS.agents }}>
              Agents
            </span>
            <span className={th} style={{ width: COLS.spend }}>
              Spend
            </span>
            <span className={th} style={{ width: COLS.last }}>
              Last
            </span>
          </div>
          <svg width={axis.width} height={20} className="block" role="img" aria-label="Time axis">
            {ticks.map((t) => {
              return (
                <g key={t.x}>
                  <line x1={t.x} x2={t.x} y1={t.day ? 3 : t.labelled ? 11 : 14} y2={20} stroke="var(--line)" />
                  {t.labelled && (
                    <text x={t.x + 3} y={12} fontSize={11} fill={t.day ? 'var(--muted)' : 'var(--faint)'}>
                      {t.label}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      </div>
    </div>
  )
}

// ---- hover readout -----------------------------------------------------------------------

function Readout({ o, hover }: { o: Overview; hover: Hover | null }) {
  const fromMs = Date.parse(o.from)
  let body: ReactNode = (
    <span className="text-faint">
      Hover a graph for its numbers; under a row, each thin line is an agent the session launched, a bar the run of
      them.
    </span>
  )
  if (hover && hover.slot >= 0 && hover.slot < o.slots) {
    const i = hover.slot
    const when = slotLabel(fromMs, o.slotMs, i)
    const { group: g, lane, spawns } = hover
    const name = lane
      ? lane.title || lane.id.slice(0, 8)
      : `All ${plural(g?.sessions ?? 0, 'session')} of ${g?.name || 'no value'}`
    if (spawns) {
      body = (
        <>
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 text-fg">{describeSpawns(spawns)}</span>
            <span className="min-w-0 truncate text-muted">{spawns.titles.join(' · ')}</span>
          </div>
          <div className="truncate text-muted">
            launched near {when}, in {name}
          </div>
        </>
      )
    } else if (g || lane) {
      const usd = lane ? laneAt(lane.usdSlots, lane.slot0, i) : (g?.usdSlots[i] ?? 0)
      const ctx = lane ? laneAt(lane.context, lane.slot0, i) : (g?.contextSum[i] ?? 0)
      const peak = g?.contextPeak[i] ?? 0
      const idle = lane ? laneAt(lane.idle, lane.slot0, i) : (g?.idleSum[i] ?? 0)
      const running = lane ? laneAt(lane.active, lane.slot0, i) : (g?.active[i] ?? 0)
      body = (
        <>
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-fg">{name}</span>
            <span className="shrink-0 text-muted">{when}</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 text-muted">
            <span>
              <Money usd={usd} /> in the slot
            </span>
            <span>{lane ? (running > 0 ? 'running' : 'not running') : `${plural(running, 'session')} running`}</span>
            <span>
              context {formatTokens(ctx)}
              {g && ctx !== peak ? ` summed, ${formatTokens(peak)} peak` : ''}
            </span>
            {idle > 0 && <span>{formatTokens(idle)} idle</span>}
          </div>
        </>
      )
    }
  }
  return <div className="h-11 overflow-hidden px-3 py-1 text-sec leading-snug">{body}</div>
}

// ---- the page ----------------------------------------------------------------------------

export function OverviewPage() {
  useDocumentTitle('Overview')
  const [sp, setSp] = useSearchParams()
  const range = oneOf<Range>(sp.get('range'), ['1d', '7d', '30d'], '7d')
  const by = oneOf<GroupDim>(sp.get('by'), ['dir', 'checkout', 'repo', 'remote'], 'dir')
  const sort = oneOf<SortKey>(sp.get('sort'), ['spend', 'sessions', 'priciest', 'recent'], 'spend')
  const mode = oneOf<CtxMode>(sp.get('ctx'), ['sum', 'peak'], 'peak')
  // groups are open unless listed in `closed`; `all` lists the groups that show every session
  const closed = useMemo(() => parseKeys(sp.get('closed')), [sp])
  const all = useMemo(() => parseKeys(sp.get('all')), [sp])

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
  const plotW = Math.max(240, cardW - CARD_BORDER - GUTTER_W - 2 * CELL_PAD)
  const slot = chooseSlot(RANGES[range].ms, useDebounced(plotW, 250))

  // "Ending now", rounded up so that the query key holds still between refreshes.
  const now = useNow(300_000)
  const to = Math.ceil(now.getTime() / TEN_MIN) * TEN_MIN
  const query = useOverview({
    from: new Date(to - RANGES[range].ms).toISOString(),
    to: new Date(to).toISOString(),
    slot,
    by,
  })

  const [hover, setHover] = useState<Hover | null>(null)
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
          onChange={(v) => set({ range: v === '7d' ? undefined : v })}
        />
        <div className="flex items-center gap-1.5 text-sec text-muted">
          group
          <Select<GroupDim>
            label="Group by"
            value={by}
            options={BY_OPTIONS}
            onChange={(v) => set({ by: v === 'dir' ? undefined : v, closed: undefined, all: undefined })}
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
            onChange={(v) => set({ ctx: v === 'peak' ? undefined : v })}
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
            <Table
              o={o}
              plotW={plotW}
              sort={sort}
              mode={mode}
              closed={closed}
              all={all}
              hover={hover}
              setHover={setHover}
              onToggle={(key) => set({ closed: formatKeys(toggleKey(closed, key)) })}
              onAll={(key) => set({ all: formatKeys(toggleKey(all, key)) })}
            />
          )}
        </QueryBoundary>
      </div>
    </div>
  )
}

function Table({
  o,
  plotW,
  sort,
  mode,
  closed,
  all,
  hover,
  setHover,
  onToggle,
  onAll,
}: {
  o: Overview
  plotW: number
  sort: SortKey
  mode: CtxMode
  closed: string[]
  all: string[]
  hover: Hover | null
  setHover: (h: Hover | null) => void
  onToggle: (key: string) => void
  onAll: (key: string) => void
}) {
  const axis = useMemo(
    () => makeAxis(Date.parse(o.from), Date.parse(o.to), o.slotMs, plotW),
    [o.from, o.to, o.slotMs, plotW],
  )
  const { maxTok, pxPerTok } = useMemo(() => tokenScale(o.groups, mode), [o.groups, mode])
  const groups = useMemo(() => sortGroups(o.groups, sort), [o.groups, sort])
  const lanes = useMemo(() => {
    const m = lanesByGroup(o.lanes)
    return new Map([...m].map(([k, v]) => [k, sortLanes(v, sort)]))
  }, [o.lanes, sort])
  const shared: Shared = { axis, pxPerTok, mode, hover, setHover }
  return (
    <div className="overflow-clip rounded-card border border-line bg-surface" onPointerLeave={() => setHover(null)}>
      <div className="border-line border-b">
        <Readout o={o} hover={hover} />
      </div>
      <Header axis={axis} maxTok={maxTok} />
      {groups.map((g) => (
        <GroupBlock
          key={g.key}
          g={g}
          lanes={lanes.get(g.key) ?? []}
          closed={closed.includes(g.key)}
          all={all.includes(g.key)}
          onToggle={() => onToggle(g.key)}
          onAll={() => onAll(g.key)}
          shared={shared}
        />
      ))}
      {o.scripted.usd > 0 && <ScriptedRow o={o} />}
    </div>
  )
}
