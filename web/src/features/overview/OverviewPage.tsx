// The Overview page (experimental, docs/ui.md section 10b): where the agents' work went over a day,
// a week or a month, as one full-bleed table under the top bar: the toolbar and the sortable column headers
// stay on top, the rows scroll, the date axis and the totals stay at the bottom, and beside the rows an
// index of the groups (when the table shows sessions under groups). Every row has its text line (harness,
// head, description, turns, agents, spend, last activity) and under it a merged cell with the row's graph
// on one shared linear time axis.

import { ArrowDown, ArrowUp } from 'lucide-react'
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useOverview, useSearch } from '../../api/queries'
import type { Overview, OverviewGroup, OverviewLane, OverviewSpan } from '../../api/types'
import { cn } from '../../lib/cn'
import { plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { useShortcut } from '../../shell/useShortcut'
import { HarnessIcon, Money, QueryBoundary, SearchInput, SegmentedControl, Skeleton } from '../../ui'
import { COLOR, CTX_FILL, elbowPath, WORKFLOW_DASH } from '../spend/TimeView'
import {
  ACTIVE_W,
  type Axis,
  activityRuns,
  apiBy,
  axisTicks,
  type Band,
  type By,
  bandAt,
  buildRows,
  type Column,
  type ColumnBox,
  chooseSlot,
  columnAt,
  columnBoxes,
  type Filtered,
  filterOverview,
  fitLabels,
  formatSort,
  groupDescription,
  groupHarnesses,
  groupScale,
  isBranch,
  LANE_DEPTH,
  type Layout,
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
  sessionKey,
  slotX,
  spineLanes,
  stepAreaPath,
} from './model'
import { useDebounced, useWidth } from './useWidth'

/** The harness column, the first column (flat table only), the numeric columns (px) and the cell padding the graph sits in. */
const HARNESS_W = 48
const GUTTER_W = 140
const COLS = { turns: 52, agents: 56, spend: 84, last: 64 }
const CELL_PAD = 12
const GAP = 8
/** The index beside the rows (px, its right border included). */
const SIDEBAR_W = 220
const LAYOUT: Omit<Layout, 'gutter'> = { harness: HARNESS_W, pad: CELL_PAD, gap: GAP, ...COLS }
/** The hovered row's background: the text colour, faintly, over the row's own. */
const HOVER = 'hover:bg-[color-mix(in_srgb,var(--text)_5%,var(--surface))]'
const HOVER_TINT = 'hover:bg-[color-mix(in_srgb,var(--text)_6%,var(--surface-2))]'
const HOT = 'bg-[color-mix(in_srgb,var(--text)_5%,var(--surface))]'
/** A header cell's rule on its left: tiny, between the sort arrows. */
const RULE =
  'before:absolute before:top-1/2 before:left-[-4px] before:h-[55%] before:w-px before:-translate-y-1/2 before:bg-line'

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
  none: 'Folder',
  dir: 'Folder',
  checkout: 'Worktree',
  repo: 'Repo',
  remote: 'Remote',
}

const BY_TITLE: Partial<Record<By, string>> = {
  repo: 'Repository: worktrees of one clone merge',
  remote: 'Origin URL: clones of one remote merge',
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
    <div className={cn('flex items-baseline pt-1 text-sec', className)} style={{ paddingLeft: indent, columnGap: GAP }}>
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

/** The harness column of a row: one mark, or up to three of a group's side by side (a little smaller). */
function HarnessCell({ harnesses }: { harnesses: string[] }) {
  const many = harnesses.length > 1
  return (
    <div
      className={cn('flex shrink-0 items-start gap-0.5 pl-2', many ? 'pt-[6px]' : 'pt-[5px]')}
      style={{ width: HARNESS_W }}
    >
      {harnesses.map((h) => (
        <HarnessIcon key={h} harness={h} size={many ? 12 : 14} />
      ))}
    </div>
  )
}

/**
 * A row: the harness column, the first column (flat table only) and the cell with the text line and the
 * graph. The row's hover is CSS, so that moving the pointer does not render it; `data-group` lets the
 * table find the group a hovered row belongs to.
 */
function Frame({
  group,
  isGroup,
  harnesses,
  gutter,
  first,
  tint,
  children,
}: {
  group: string
  isGroup?: boolean
  harnesses: string[]
  gutter: number
  first?: ReactNode
  tint?: boolean
  children: ReactNode
}) {
  return (
    <div
      data-group={group}
      data-grow={isGroup ? '' : undefined}
      className={cn('flex border-line border-t first:border-t-0', tint ? `bg-surface-2 ${HOVER_TINT}` : HOVER)}
    >
      <HarnessCell harnesses={harnesses} />
      {gutter > 0 && (
        <div className="min-w-0 shrink-0 truncate pt-1 pr-1 text-muted text-sec" style={{ width: gutter }}>
          {first}
        </div>
      )}
      <div className="min-w-0 flex-1 pb-1" style={{ paddingInline: CELL_PAD }}>
        {children}
      </div>
    </div>
  )
}

const SessionRow = memo(function SessionRow({
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
    <Frame
      group={l.group}
      harnesses={[l.harness]}
      gutter={gutter}
      first={<span title={groupName || 'no value'}>{groupName || 'no value'}</span>}
    >
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
})

const GroupRow = memo(function GroupRow({
  g,
  lanes,
  shown,
  priciestHead,
  gutter,
  tint,
  shared,
}: {
  g: OverviewGroup
  priciestHead?: string
  lanes: OverviewLane[]
  /** The group's sessions that match the search (undefined: no search). */
  shown?: number
  gutter: number
  tint: boolean
  shared: Shared
}) {
  const name = g.name || 'no value'
  const harnesses = useMemo(() => groupHarnesses(lanes), [lanes])
  return (
    <Frame group={g.key} isGroup harnesses={harnesses} gutter={gutter} tint={tint}>
      <TextLine
        head={<span className="font-semibold text-fg">{name}</span>}
        headText={name}
        desc={groupDescription(g, priciestHead, shown)}
        turns={g.turns}
        agents={g.agents}
        usd={g.usd}
        last={g.lastActivityAt}
      />
      <RowGraph data={groupData(g, lanes)} shared={shared} />
    </Frame>
  )
})

function ScriptedRow({ o, gutter }: { o: Overview; gutter: number }) {
  return (
    <Frame group="" harnesses={[]} gutter={gutter}>
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
  rule,
}: {
  col: SortKey
  label: string
  w?: number
  sort: Sort
  onSort: (k: SortKey) => void
  title: string
  /** A tiny rule on the cell's left edge (every cell but the first). */
  rule?: boolean
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
        'relative inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap py-1.5 text-meta uppercase tracking-wide hover:text-fg',
        w === undefined ? 'min-w-0 flex-1 justify-start' : 'justify-end',
        rule && RULE,
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

/** The light band behind a column under the pointer. */
function ColumnBand({ boxes, col, skip }: { boxes: ColumnBox[]; col: Column | null; skip?: Column[] }) {
  const b = col && !skip?.includes(col) ? boxes.find((x) => x.col === col) : undefined
  if (!b) return null
  return (
    <div className={cn('pointer-events-none absolute inset-y-0', HOT)} style={{ left: b.x, width: b.w }} aria-hidden />
  )
}

function Header({
  gutter,
  byLabel,
  byTitle,
  sort,
  onSort,
  padRight,
  boxes,
  hotCol,
}: {
  gutter: number
  byLabel: string
  byTitle?: string
  sort: Sort
  onSort: (k: SortKey) => void
  padRight: number
  boxes: ColumnBox[]
  hotCol: Column | null
}) {
  const th = { sort, onSort }
  return (
    <div className="shrink-0 border-line border-b bg-surface" style={{ paddingRight: padRight }}>
      <div className="relative flex items-stretch">
        <ColumnBand boxes={boxes} col={hotCol} />
        <div className="shrink-0" style={{ width: HARNESS_W }} title="Harness" />
        {gutter > 0 && (
          <div
            className="relative shrink-0 truncate py-1.5 text-faint text-meta uppercase tracking-wide"
            style={{ width: gutter }}
            title={byTitle}
          >
            {byLabel}
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-stretch" style={{ paddingInline: CELL_PAD, columnGap: GAP }}>
          <Th
            {...th}
            col="session"
            label="Session"
            rule={gutter > 0}
            title="Sort by start time (group rows: by number of sessions)"
          />
          <Th {...th} col="turns" label="Turns" w={COLS.turns} rule title="Sort by turns" />
          <Th {...th} col="agents" label="Agents" w={COLS.agents} rule title="Sort by agents launched" />
          <Th {...th} col="spend" label="Spend" w={COLS.spend} rule title="Sort by spend" />
          <Th {...th} col="last" label="Last" w={COLS.last} rule title="Sort by last activity" />
        </div>
      </div>
    </div>
  )
}

// ---- the sticky footer: date axis and totals ---------------------------------

function AxisRow({
  axis,
  lead,
  padRight,
  band,
}: {
  axis: Axis
  lead: number
  padRight: number
  /** The stretch of the axis under the pointer: a light band, its label in the body colour. */
  band: Band | null
}) {
  const ticks = fitLabels(axisTicks(axis), axis.width)
  const inBand = (x: number) => !!band && x >= band.x0 - 0.5 && x < band.x1 - 0.5
  return (
    <div className="border-line border-t" style={{ paddingRight: padRight }}>
      <div className="flex">
        <div className="shrink-0" style={{ width: lead }} />
        <div className="min-w-0 flex-1 overflow-hidden" style={{ paddingInline: CELL_PAD }}>
          <svg width={axis.width} height={20} className="block" role="img" aria-label="Time axis">
            {band && <rect x={band.x0} y={0} width={band.x1 - band.x0} height={20} fill="var(--surface-2)" />}
            {ticks.map((t) => (
              <g key={t.x}>
                <line x1={t.x} x2={t.x} y1={0} y2={t.day ? 6 : t.labelled ? 4 : 3} stroke="var(--line)" />
                {t.labelled && (
                  <text
                    x={t.x + 3}
                    y={16}
                    fontSize={11}
                    fill={inBand(t.x) ? 'var(--text)' : t.day ? 'var(--muted)' : 'var(--faint)'}
                  >
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

function Totals({
  f,
  term,
  lead,
  padRight,
  boxes,
  hotCol,
}: {
  f: Filtered
  term: string
  lead: number
  padRight: number
  boxes: ColumnBox[]
  hotCol: Column | null
}) {
  // under a search the totals are those of the matching sessions
  const sum = (a: (g: OverviewGroup) => number, b: (l: OverviewLane) => number) =>
    term ? f.lanes.reduce((n, l) => n + b(l), 0) : f.groups.reduce((n, g) => n + a(g), 0)
  const n = term ? f.lanes.length : f.groups.reduce((a, g) => a + g.sessions, 0)
  return (
    <div className="border-line border-t" style={{ paddingRight: padRight }}>
      <div className="relative">
        <ColumnBand boxes={boxes} col={hotCol} skip={['harness', 'first']} />
        <div className="relative flex">
          <div className="shrink-0" style={{ width: lead }} />
          <div className="min-w-0 flex-1 pb-1" style={{ paddingInline: CELL_PAD }}>
            <TextLine
              className="font-medium"
              head={
                <span className="text-fg" title={term ? 'Totals of the matching sessions' : 'Totals of the range'}>
                  Total
                </span>
              }
              headText={term ? 'Totals of the matching sessions' : 'Totals'}
              desc={term ? `${plural(n, 'matching session')}` : plural(n, 'session')}
              turns={sum(
                (g) => g.turns,
                (l) => l.turns,
              )}
              agents={sum(
                (g) => g.agents,
                (l) => l.agents,
              )}
              usd={sum(
                (g) => g.usd,
                (l) => l.usd,
              )}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- the index beside the rows -----------------------------------------------------------

interface IndexItem {
  key: string
  name: string
  count: number
  usd: number
}

/**
 * One item per group of the table, in its order: the name, the shown sessions and the spend. A click scrolls
 * the group to the top of the rows; `current` is the group at the top of the rows now, `hover` the group of
 * the row under the pointer. Its width goes to 0 when the table needs no index (the rows are the index).
 */
function Sidebar({
  open,
  label,
  title,
  items,
  current,
  hover,
  onPick,
}: {
  open: boolean
  label: string
  title?: string
  items: IndexItem[]
  current: string | null
  hover: string | null
  onPick: (key: string) => void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!open || current === null) return
    const li = [...(listRef.current?.children ?? [])].find((c) => (c as HTMLElement).dataset.key === current)
    li?.scrollIntoView({ block: 'nearest' })
  }, [current, open])
  return (
    <aside
      aria-label={`${label} index`}
      aria-hidden={!open}
      inert={!open}
      className="shrink-0 overflow-hidden border-line border-r transition-[width] duration-150 motion-reduce:transition-none"
      style={{ width: open ? SIDEBAR_W : 0, borderRightWidth: open ? 1 : 0 }}
    >
      <div className="flex h-full flex-col" style={{ width: SIDEBAR_W - 1 }}>
        <div
          className="shrink-0 truncate border-line border-b px-3 py-1.5 text-faint text-meta uppercase tracking-wide"
          title={title}
        >
          {label}
        </div>
        <ul ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto p-1.5">
          {items.map((it) => {
            const name = it.name || 'no value'
            return (
              <li key={it.key} data-key={it.key}>
                <button
                  type="button"
                  onClick={() => onPick(it.key)}
                  aria-current={current === it.key ? 'true' : undefined}
                  title={name}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-card px-2 py-1 text-left text-body',
                    hover === it.key && 'bg-surface-2',
                    current === it.key && 'bg-accent-soft font-medium text-accent',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span className="w-7 shrink-0 text-right text-muted text-sec tabular-nums">{it.count}</span>
                  <Money usd={it.usd} dim className="w-14 shrink-0 text-right text-sec" />
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </aside>
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
  const q = sp.get('q') ?? ''

  const set = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined || v === '') next.delete(k)
      else next.set(k, v)
    }
    setSp(next, { replace: true })
  }

  // ---- search box: typing is local, the URL follows after 200 ms ----
  const [draft, setDraft] = useState(q)
  const debounced = useDebounced(draft, 200)
  const written = useRef(q)
  // biome-ignore lint/correctness/useExhaustiveDependencies: write only when the debounced text changes
  useEffect(() => {
    if (debounced !== written.current) {
      written.current = debounced
      set({ q: debounced })
    }
  }, [debounced])
  useEffect(() => {
    // back / forward changed `q`: the box follows
    if (q !== written.current) {
      written.current = q
      setDraft(q)
    }
  }, [q])
  const inputRef = useRef<HTMLInputElement>(null)
  useShortcut('/', () => {
    inputRef.current?.focus()
    inputRef.current?.select()
  })
  const term = q.trim()
  const search = useSearch(term)
  const hits = useMemo(
    () => (search.data ? new Set(search.data.hits.map((h) => sessionKey(h.session.harness, h.session.id))) : undefined),
    [search.data],
  )

  // The plot's width picks the slot (about one per pixel); the width is followed live, the slot only
  // once the width has held still, so a drag of the window does not refetch at every pixel.
  const rootRef = useRef<HTMLDivElement>(null)
  const pageW = useWidth(rootRef)
  const gutter = flat ? GUTTER_W : 0
  const sbW = !flat && show === 'sessions' ? SIDEBAR_W : 0
  const pagePlotW = Math.max(240, pageW - sbW - SCROLLBAR - HARNESS_W - gutter - 2 * CELL_PAD)
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

  // Group rows (total context) and session rows have a token scale each.
  const scales = useMemo(
    () => ({
      groups: query.data ? groupScale(query.data.groups) : { maxTok: 0, pxPerTok: 0 },
      lanes: query.data ? laneScale(query.data.lanes) : { maxTok: 0, pxPerTok: 0 },
    }),
    [query.data],
  )

  // The page fills the window and scrolls inside: the document drops its reserved scrollbar gutter meanwhile.
  useEffect(() => {
    document.documentElement.dataset.fullbleed = ''
    return () => {
      delete document.documentElement.dataset.fullbleed
    }
  }, [])

  return (
    <div ref={rootRef} className="flex h-[calc(100vh-44px)] w-full flex-col bg-surface">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-line border-b px-3 py-2">
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
              { value: 'dir', label: 'Folder' },
              { value: 'checkout', label: 'Worktree', title: 'Git worktree (checkout)' },
              { value: 'repo', label: 'Repo', title: BY_TITLE.repo },
              { value: 'remote', label: 'Remote', title: BY_TITLE.remote },
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
        <div className="flex min-w-[220px] flex-1 justify-center">
          <SearchInput
            value={draft}
            onChange={setDraft}
            placeholder="Search sessions…"
            hint="/"
            inputRef={inputRef}
            label="Search sessions"
            className="w-full max-w-[420px]"
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <QueryBoundary
          query={query}
          isEmpty={(o) => o.groups.length === 0 && o.scripted.usd === 0}
          empty={<div className="p-6 text-muted">Nothing ran in this range.</div>}
          skeleton={<Skeleton className="m-3 h-64" />}
        >
          {(o) => (
            <Table
              o={o}
              by={by}
              show={show}
              sort={sort}
              term={term}
              hits={hits}
              pageW={pageW}
              scales={scales}
              onSort={(k) => set(formatSort(nextSort(sort, k)))}
            />
          )}
        </QueryBoundary>
      </div>
    </div>
  )
}

/** The pointer over the rows: x from the left of the rows (whole px) and the group of the row under it. */
interface Hover {
  x: number
  group: string | null
}

function Table({
  o,
  by,
  show,
  sort,
  term,
  hits,
  pageW,
  scales,
  onSort,
}: {
  o: Overview
  by: By
  show: Show
  sort: Sort
  term: string
  hits?: ReadonlySet<string>
  pageW: number
  scales: { groups: { pxPerTok: number }; lanes: { pxPerTok: number } }
  onSort: (k: SortKey) => void
}) {
  const flat = by === 'none'
  const gutter = flat ? GUTTER_W : 0
  const lead = HARNESS_W + gutter
  const indexOpen = !flat && show === 'sessions'
  // The rows scroll; header and footer do not. The scrollbar takes width from the rows only, so the
  // header and the footer give up as much (padRight) and the columns and the date axis stay aligned.
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const innerW = useWidth(innerRef)
  const [padRight, setPadRight] = useState(0)
  // the plot is sized for where the index will be, not for the width it has while it slides
  const plotW = Math.max(240, pageW - (indexOpen ? SIDEBAR_W : 0) - padRight - lead - 2 * CELL_PAD)
  const f = useMemo(() => filterOverview(o, term, hits), [o, term, hits])
  const rows = useMemo(() => buildRows(f, by, show, sort), [f, by, show, sort])
  const searching = term !== ''
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
  const shared: Shared = useMemo(
    () => ({ axis, groupPx: scales.groups.pxPerTok, lanePx: scales.lanes.pxPerTok }),
    [axis, scales.groups.pxPerTok, scales.lanes.pxPerTok],
  )
  const byGroup = useMemo(() => lanesByGroup(o.lanes), [o.lanes])
  const priciest = useMemo(() => {
    const m = new Map(o.lanes.map((l) => [`${l.harness}/${l.id}`, laneHead(l)]))
    return (g: OverviewGroup) => (g.priciest ? m.get(`${g.priciest.harness}/${g.priciest.id}`) : undefined)
  }, [o.lanes])

  // ---- hover: one state, the pointer's x and the group under it ----
  const [hover, setHover] = useState<Hover | null>(null)
  const boxes = useMemo(() => columnBoxes(innerW, { ...LAYOUT, gutter }), [innerW, gutter])
  const hx = hover ? hover.x : null
  const hotCol = hx === null ? null : columnAt(boxes, hx)
  const band = hx === null ? null : bandAt(axis, hx - lead - CELL_PAD)
  const onMove = (e: React.MouseEvent) => {
    const left = innerRef.current?.getBoundingClientRect().left ?? 0
    const x = Math.floor(e.clientX - left)
    const group = (e.target as Element).closest('[data-group]')?.getAttribute('data-group') ?? null
    setHover((h) => (h && h.x === x && h.group === group ? h : { x, group }))
  }

  // ---- the index: groups in the table's order, the one at the top, a click to scroll there ----
  const items: IndexItem[] = useMemo(
    () =>
      rows.flatMap((r) =>
        r.kind === 'group' ? [{ key: r.g.key, name: r.g.name, count: f.shown.get(r.g.key) ?? 0, usd: r.g.usd }] : [],
      ),
    [rows, f.shown],
  )
  const [current, setCurrent] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows change what is at the top
  useEffect(() => {
    const el = scrollRef.current
    const inner = innerRef.current
    if (!el || !inner) return
    let raf = 0
    const update = () => {
      raf = 0
      let cur: string | null = null
      for (const n of inner.querySelectorAll<HTMLElement>('[data-grow]')) {
        if (n.offsetTop > el.scrollTop + 2) break
        cur = n.dataset.group ?? null
      }
      setCurrent(cur)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [rows])
  const pick = (key: string) => {
    const el = scrollRef.current
    const n = [...(innerRef.current?.querySelectorAll<HTMLElement>('[data-grow]') ?? [])].find(
      (x) => x.dataset.group === key,
    )
    if (!el || !n) return
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: n.offsetTop, behavior: calm ? 'auto' : 'smooth' })
  }

  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar
        open={indexOpen}
        label={BY_LABEL[by]}
        title={BY_TITLE[by]}
        items={items}
        current={indexOpen ? current : null}
        hover={indexOpen && hover ? hover.group : null}
        onPick={pick}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          gutter={gutter}
          byLabel={BY_LABEL[by]}
          byTitle={BY_TITLE[by]}
          sort={sort}
          onSort={onSort}
          padRight={padRight}
          boxes={boxes}
          hotCol={hotCol}
        />
        <div
          ref={scrollRef}
          id="overview-rows"
          className="min-h-0 flex-1 overflow-y-auto"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          <div ref={innerRef} className="relative">
            {rows.map((r: Row) =>
              r.kind === 'group' ? (
                <GroupRow
                  key={r.key}
                  g={r.g}
                  lanes={byGroup.get(r.g.key) ?? []}
                  shown={searching ? f.shown.get(r.g.key) : undefined}
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
            {!searching && o.scripted.usd > 0 && <ScriptedRow o={o} gutter={gutter} />}
            {searching && rows.length === 0 && <div className="p-6 text-muted">No sessions match “{term}”.</div>}
          </div>
        </div>
        <div className="shrink-0 bg-surface">
          <AxisRow axis={axis} lead={lead} padRight={padRight} band={band} />
          <Totals f={f} term={term} lead={lead} padRight={padRight} boxes={boxes} hotCol={hotCol} />
        </div>
      </div>
    </div>
  )
}
