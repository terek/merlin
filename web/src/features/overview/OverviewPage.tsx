// The Overview page (experimental, docs/ui.md section 10b): where the agents' work went over a day,
// a week or a month, as one full-bleed table under the top bar: the toolbar and the sortable column headers
// stay on top, the rows scroll, the date axis and the totals stay at the bottom, and beside the rows an
// index of the places (always there; its selection filters the table). Every row has its text line (head,
// description, harness, turns, agents, spend, last activity) and under it a merged cell with the row's graph
// on one shared linear time axis.

import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  Globe,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react'
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useOverview, useSearch } from '../../api/queries'
import type { Overview, OverviewGroup, OverviewLane, OverviewSpan } from '../../api/types'
import { cn } from '../../lib/cn'
import { plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { placeLabels } from '../../lib/places'
import { useShortcut } from '../../shell/useShortcut'
import {
  HarnessIcon,
  IconButton,
  Money,
  QueryBoundary,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
} from '../../ui'
import { COLOR, CTX_FILL, elbowPath, WORKFLOW_DASH } from '../spend/TimeView'
import {
  ACTIVE_W,
  type Axis,
  activityRuns,
  ancestorIds,
  axisTicks,
  type Band,
  BYS,
  type By,
  bandAt,
  buildPlaceTree,
  buildRows,
  type Column,
  type ColumnBox,
  chooseSlot,
  columnAt,
  columnBoxes,
  displayPath,
  type Filtered,
  filterOverview,
  fitLabels,
  formatIn,
  formatSort,
  formatView,
  groupDescription,
  groupHarnesses,
  groupScale,
  groupsHome,
  type IndexItem,
  isBranch,
  keepSelection,
  LANE_DEPTH,
  type Layout,
  laneDescription,
  laneHead,
  laneScale,
  lanesByGroup,
  lastLabel,
  lifeSpan,
  makeAxis,
  markedNode,
  midnightXs,
  NONE_SEL,
  nextSort,
  nodeForPath,
  oneLine,
  type PlaceNode,
  type PlaceTree,
  parseIn,
  parseSort,
  parseView,
  RANGES,
  type Range,
  type Row,
  type Show,
  type Sort,
  type SortKey,
  selectOverview,
  sessionKey,
  slotX,
  spineLanes,
  stepAreaPath,
  totalOf,
  visibleRows,
} from './model'
import { useDebounced, useWidth } from './useWidth'

/** The harness column (after Session), the first column (flat table only), the numeric columns (px) and the cell padding the graph sits in. */
const HARNESS_W = 44
const GUTTER_W = 140
const COLS = { turns: 52, agents: 56, spend: 84, last: 64 }
const CELL_PAD = 12
const GAP = 8
/** The index beside the rows (px, its right border included), and the strip it folds to. */
const SIDEBAR_W = 260
const STRIP_W = 37
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
  harnesses,
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
  /** The marks of the harness column (none: the column stays empty). */
  harnesses?: string[]
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
      <HarnessCell harnesses={harnesses ?? []} />
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

/** The harness column of a text line: one mark, or up to three of a group's side by side (a little smaller). */
function HarnessCell({ harnesses }: { harnesses: string[] }) {
  const many = harnesses.length > 1
  return (
    <div className="flex shrink-0 items-center gap-0.5 self-center" style={{ width: HARNESS_W }}>
      {harnesses.map((h) => (
        <HarnessIcon key={h} harness={h} size={many ? 12 : 14} />
      ))}
    </div>
  )
}

/**
 * A row: the first column (flat table only) and the cell with the text line and the graph. The row's hover is CSS, so that moving the pointer does not render it; `data-group` lets the
 * table find the group a hovered row belongs to.
 */
function Frame({
  group,
  gutter,
  first,
  tint,
  children,
}: {
  group: string
  gutter: number
  first?: ReactNode
  tint?: boolean
  children: ReactNode
}) {
  return (
    <div
      data-group={group}
      className={cn('flex border-line border-t first:border-t-0', tint ? `bg-surface-2 ${HOVER_TINT}` : HOVER)}
    >
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
        harnesses={[l.harness]}
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
  label,
  lanes,
  shown,
  priciestHead,
  gutter,
  tint,
  shared,
}: {
  g: OverviewGroup
  /** The name shown: with enough of the path when groups share a name. */
  label: string
  priciestHead?: string
  lanes: OverviewLane[]
  /** The group's sessions that match the search (undefined: no search). */
  shown?: number
  gutter: number
  tint: boolean
  shared: Shared
}) {
  const name = label || 'no value'
  const harnesses = useMemo(() => groupHarnesses(lanes), [lanes])
  return (
    <Frame group={g.key} gutter={gutter} tint={tint}>
      <TextLine
        head={
          <span className="font-semibold text-fg" title={g.key || name}>
            {name}
          </span>
        }
        headText={name}
        desc={groupDescription(g, priciestHead, shown)}
        harnesses={harnesses}
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
    <Frame group="" gutter={gutter}>
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
          <div className="shrink-0" style={{ width: HARNESS_W }} title="Harness" />
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
        <ColumnBand boxes={boxes} col={hotCol} skip={['first']} />
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

const TREE_INDENT = 12
const TREE_GUTTER = 8

/** The ids of the folders the user closed in this grouping: kept per grouping, and fine without storage. */
function useClosed(by: By): [ReadonlySet<string>, (id: string) => void, (ids: string[]) => void] {
  const storeKey = `overview.tree.${by}`
  const read = (): Set<string> => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(storeKey) ?? '[]')
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
  }
  const [state, setState] = useState(() => ({ storeKey, closed: read() }))
  // the grouping changed: its own closed folders
  const closed = state.storeKey === storeKey ? state.closed : read()
  if (state.storeKey !== storeKey) setState({ storeKey, closed })
  const write = (next: Set<string>) => {
    setState({ storeKey, closed: next })
    try {
      localStorage.setItem(storeKey, JSON.stringify([...next]))
    } catch {
      // no storage: the state lives for this page only
    }
  }
  const toggle = (id: string) => {
    const next = new Set(closed)
    if (!next.delete(id)) next.add(id)
    write(next)
  }
  const open = (ids: string[]) => {
    const next = new Set(closed)
    for (const id of ids) next.delete(id)
    write(next)
  }
  return [closed, toggle, open]
}

/** Whether the index is open: the user's choice, kept in the browser (open without it). */
function useSidebarOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('overview.sidebar') !== 'closed'
    } catch {
      return true
    }
  })
  return [
    open,
    (v) => {
      setOpen(v)
      try {
        localStorage.setItem('overview.sidebar', v ? 'open' : 'closed')
      } catch {
        // no storage: the choice lives for this page only
      }
    },
  ]
}

const folderIcon = (n: PlaceNode, by: By, open: boolean) => {
  if (n.host) return Globe
  if (n.group && (by === 'repo' || by === 'checkout' || by === 'remote')) return FolderGit2
  return open ? FolderOpen : Folder
}

const ITEM = 'flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left text-body'
const SELECTED = 'bg-accent-soft font-medium text-accent'

/** The figures at the end of an item: sessions shown and spend. */
function Figures({ count, usd }: { count: number; usd: number }) {
  return (
    <>
      <span className="w-6 shrink-0 text-right text-muted text-sec tabular-nums">{count}</span>
      <Money usd={usd} dim className="w-12 shrink-0 text-right text-sec" />
    </>
  )
}

/**
 * The index as a file explorer, and the table's filter: the places of the groups where they sit in the
 * filesystem (a repository at its working directory, a remote as host / owner / name), compact folders, the
 * home as `~`. The heading is the key the tree is organised by. A click on an item selects it (the table
 * shows what is at or under it), a click on the selected item or on All clears; the chevron only opens or
 * closes. `hover` is the group of the row under the pointer (when a closed folder hides it, the folder is
 * marked). It folds to a strip.
 */
function Sidebar({
  open,
  onOpen,
  by,
  onBy,
  tree,
  total,
  sel,
  hover,
  onSelect,
}: {
  open: boolean
  onOpen: (open: boolean) => void
  by: By
  onBy: (by: By) => void
  tree: PlaceTree
  total: { count: number; usd: number }
  sel: string | null
  hover: string | null
  onSelect: (path: string | null) => void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const [closed, toggle, openFolders] = useClosed(by)
  const rows = useMemo(() => visibleRows(tree.nodes, closed), [tree.nodes, closed])
  const selNode = sel === null || sel === NONE_SEL ? null : nodeForPath(tree.nodes, sel)
  const hot = hover === null ? null : markedNode(tree.nodes, hover, closed)
  // the selection's ancestors are open, once for each selection
  const opened = useRef('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: once for each selection, not at every change of the folders
  useEffect(() => {
    if (!selNode || sel === null || opened.current === `${by}|${sel}`) return
    opened.current = `${by}|${sel}`
    const shut = ancestorIds(tree.nodes, sel).filter((id) => closed.has(id))
    if (shut.length > 0) openFolders(shut)
  }, [sel, by, selNode, tree.nodes])
  useEffect(() => {
    if (!open || !selNode) return
    const li = [...(listRef.current?.children ?? [])].find((c) => (c as HTMLElement).dataset.node === selNode.id)
    li?.scrollIntoView({ block: 'nearest' })
  }, [selNode, open])
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const all = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }
  const pick = (path: string) => onSelect(sel === path ? null : path)
  const none = tree.none
  const noneOn = sel === NONE_SEL
  return (
    <aside
      aria-label={`${BY_LABEL[by]} index`}
      className="relative shrink-0 overflow-hidden border-line border-r transition-[width] duration-150 motion-reduce:transition-none"
      style={{ width: open ? SIDEBAR_W : STRIP_W }}
    >
      {!open && (
        <div className="absolute inset-x-0 top-0 flex justify-center border-line border-b py-1">
          <IconButton label="Show the index" onClick={() => onOpen(true)}>
            <PanelLeftOpen size={15} />
          </IconButton>
        </div>
      )}
      <div
        aria-hidden={!open}
        inert={!open}
        className={cn('flex h-full flex-col', !open && 'invisible')}
        style={{ width: SIDEBAR_W - 1 }}
      >
        <div className="flex shrink-0 items-center gap-2 border-line border-b py-1 pr-1.5 pl-3">
          <span className="shrink-0 text-faint text-meta uppercase tracking-wide">Organise by</span>
          <Select<By>
            label="Organise by"
            value={by}
            onChange={onBy}
            options={BYS.map((v) => ({ value: v, label: BY_LABEL[v] }))}
            className="min-w-0 flex-1"
          />
          <IconButton label="Hide the index" onClick={() => onOpen(false)}>
            <PanelLeftClose size={15} />
          </IconButton>
        </div>
        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5" onKeyDown={onKeyDown}>
          <li className={cn('mb-1 flex items-center rounded-card', sel === null && SELECTED)}>
            <button
              type="button"
              data-nav
              onClick={() => onSelect(null)}
              aria-current={sel === null ? 'true' : undefined}
              title="Everything in this range"
              className={cn(ITEM, 'pl-2')}
            >
              <span className="min-w-0 flex-1 truncate">All</span>
              <Figures count={total.count} usd={total.usd} />
            </button>
          </li>
          {rows.map(({ node: n, depth }) => {
            const folder = n.children.length > 0
            const isOpen = folder && !closed.has(n.id)
            const Icon = folderIcon(n, by, isOpen)
            const on = selNode?.id === n.id
            return (
              <li
                key={n.id}
                data-node={n.id}
                data-key={n.group?.key}
                className={cn(
                  'relative flex items-center rounded-card',
                  hot === n.id && 'bg-surface-2',
                  on && SELECTED,
                )}
                style={{ paddingLeft: TREE_GUTTER + depth * TREE_INDENT }}
              >
                {Array.from({ length: depth }, (_, i) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: one guide per level
                    key={i}
                    aria-hidden
                    className="absolute inset-y-0 w-px bg-[color-mix(in_srgb,var(--text)_13%,transparent)]"
                    style={{ left: TREE_GUTTER + i * TREE_INDENT + 7 }}
                  />
                ))}
                {folder ? (
                  <button
                    type="button"
                    data-nav
                    onClick={() => toggle(n.id)}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Close' : 'Open'} ${n.label}`}
                    className="flex size-4 shrink-0 items-center justify-center text-muted hover:text-fg"
                  >
                    <ChevronRight size={12} aria-hidden className={cn('transition-transform', isOpen && 'rotate-90')} />
                  </button>
                ) : (
                  <span className="size-4 shrink-0" aria-hidden />
                )}
                <button
                  type="button"
                  data-nav
                  onClick={() => pick(n.path)}
                  aria-current={on ? 'true' : undefined}
                  title={n.id}
                  className={cn(ITEM, 'pl-0.5')}
                >
                  <Icon size={14} aria-hidden className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{n.label}</span>
                  <Figures count={n.count} usd={n.usd} />
                </button>
              </li>
            )
          })}
          {none && (
            <li
              data-node=""
              data-key=""
              className={cn(
                'mt-1 flex items-center rounded-card border-line border-t pt-1',
                hover === '' && 'bg-surface-2',
                noneOn && SELECTED,
              )}
            >
              <button
                type="button"
                data-nav
                onClick={() => pick(NONE_SEL)}
                aria-current={noneOn ? 'true' : undefined}
                title={none.name || 'no value'}
                className={cn(ITEM, 'pl-2')}
              >
                <span className={cn('min-w-0 flex-1 truncate', !noneOn && 'text-muted')}>(none)</span>
                <Figures count={none.count} usd={none.usd} />
              </button>
            </li>
          )}
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
  const { by, show } = parseView(sp.get('by'), sp.get('show'))
  const sel = parseIn(sp.get('in'))
  const sort = useMemo(() => parseSort(sp.get('sort'), sp.get('dir')), [sp])
  const q = sp.get('q') ?? ''
  const [sbOpen, setSbOpen] = useSidebarOpen()

  const set = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined || v === '') next.delete(k)
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
  // a new key keeps the selection for now; the table drops it when no group sits under it
  const setBy = (v: By) => set({ ...formatView(v, show), in: formatIn(sel) })

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
  const gutter = show === 'sessions' ? GUTTER_W : 0
  const pagePlotW = Math.max(240, pageW - (sbOpen ? SIDEBAR_W : STRIP_W) - SCROLLBAR - gutter - 2 * CELL_PAD)
  const slot = chooseSlot(RANGES[range].ms, useDebounced(pagePlotW, 250))

  // "Ending now", rounded up so that the query key holds still between refreshes.
  const now = useNow(300_000)
  const to = Math.ceil(now.getTime() / TEN_MIN) * TEN_MIN
  const query = useOverview({
    from: new Date(to - RANGES[range].ms).toISOString(),
    to: new Date(to).toISOString(),
    slot,
    by,
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

  const home = query.data
    ? groupsHome(
        query.data.groups.map((g) => g.key),
        query.data.by,
      )
    : undefined

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
          show
          <SegmentedControl<Show>
            label="Show"
            value={show}
            options={[
              { value: 'sessions', label: 'Sessions', title: 'One row per session' },
              { value: 'grouped', label: 'Grouped', title: 'Every group with all its sessions under it' },
              { value: 'groups', label: 'Groups', title: 'The groups alone, each with the graph of all its sessions' },
            ]}
            onChange={(v) => set(formatView(by, v))}
          />
        </div>
        <div className="flex min-w-[220px] flex-1 items-center justify-center gap-2">
          <SearchInput
            value={draft}
            onChange={setDraft}
            placeholder="Search sessions…"
            hint="/"
            inputRef={inputRef}
            label="Search sessions"
            className="w-full max-w-[420px]"
          />
          {sel !== null && (
            <span className="inline-flex h-7 max-w-[260px] shrink-0 items-center gap-1 rounded-card border border-line bg-surface-2 pr-1 pl-2 text-sec">
              <span className="text-muted">in</span>
              <span className="truncate font-medium text-fg" title={sel}>
                {displayPath(sel, home)}
              </span>
              <button
                type="button"
                onClick={() => select(null)}
                aria-label="Clear the selection"
                title="Clear the selection"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-card text-muted hover:bg-line hover:text-fg"
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          )}
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
              sel={sel}
              onSelect={select}
              onBy={setBy}
              sbOpen={sbOpen}
              onSbOpen={setSbOpen}
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
  sel,
  onSelect,
  onBy,
  sbOpen,
  onSbOpen,
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
  sel: string | null
  onSelect: (path: string | null) => void
  onBy: (by: By) => void
  sbOpen: boolean
  onSbOpen: (open: boolean) => void
  onSort: (k: SortKey) => void
}) {
  const gutter = show === 'sessions' ? GUTTER_W : 0
  const lead = gutter
  // The rows scroll; header and footer do not. The scrollbar takes width from the rows only, so the
  // header and the footer give up as much (padRight) and the columns and the date axis stay aligned.
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const innerW = useWidth(innerRef)
  const [padRight, setPadRight] = useState(0)
  // the plot is sized for where the index will be, not for the width it has while it slides
  const plotW = Math.max(240, pageW - (sbOpen ? SIDEBAR_W : STRIP_W) - padRight - lead - 2 * CELL_PAD)
  // the search narrows the groups; the tree shows these, the table what the selection leaves of them
  const found = useMemo(() => filterOverview(o, term, hits), [o, term, hits])
  const f = useMemo(() => selectOverview(found, sel, o.by), [found, sel, o.by])
  const rows = useMemo(() => buildRows(f, show, sort), [f, show, sort])
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

  // ---- the index: the places of the groups the search leaves; a key that changed may drop the selection ----
  // groups that share a name are told apart by the fewest trailing directories that differ
  const labelOf = useMemo(() => {
    const ls = placeLabels(o.groups.map((g) => ({ key: g.key, name: g.name })))
    return new Map(o.groups.map((g, i) => [g.key, ls[i]]))
  }, [o.groups])
  const items: IndexItem[] = useMemo(
    () => found.groups.map((g) => ({ key: g.key, name: g.name, count: found.shown.get(g.key) ?? 0, usd: g.usd })),
    [found],
  )
  const home = useMemo(
    () =>
      groupsHome(
        o.groups.map((g) => g.key),
        o.by,
      ),
    [o.groups, o.by],
  )
  const tree = useMemo(() => buildPlaceTree(items, o.by, { home }), [items, o.by, home])
  const total = useMemo(() => totalOf(items), [items])
  const seenBy = useRef(o.by)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of the key looks at the selection
  useEffect(() => {
    if (seenBy.current === o.by) return
    seenBy.current = o.by
    if (sel !== null && keepSelection(sel, o.groups, o.by) === null) onSelect(null)
  }, [o.by])

  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar
        open={sbOpen}
        onOpen={onSbOpen}
        by={by}
        onBy={onBy}
        tree={tree}
        total={total}
        sel={sel}
        hover={sbOpen && hover ? hover.group : null}
        onSelect={onSelect}
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
                  label={labelOf.get(r.g.key) ?? r.g.name}
                  lanes={byGroup.get(r.g.key) ?? []}
                  shown={searching ? found.shown.get(r.g.key) : undefined}
                  priciestHead={priciest(r.g)}
                  gutter={gutter}
                  tint={show === 'grouped'}
                  shared={shared}
                />
              ) : (
                <SessionRow
                  key={r.key}
                  l={r.l}
                  nested={r.nested}
                  groupName={labelOf.get(r.l.group) ?? r.groupName}
                  gutter={gutter}
                  shared={shared}
                />
              ),
            )}
            {!searching && sel === null && o.scripted.usd > 0 && <ScriptedRow o={o} gutter={gutter} />}
            {rows.length === 0 && (
              <div className="p-6 text-muted">
                {searching ? `No sessions match “${term}”` : 'Nothing'}
                {sel !== null && ` under ${displayPath(sel, home)}`}
                {searching ? '' : ' in this range'}.{' '}
                {sel !== null && (
                  <button type="button" onClick={() => onSelect(null)} className="text-accent hover:underline">
                    Clear the selection
                  </button>
                )}
              </div>
            )}
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
