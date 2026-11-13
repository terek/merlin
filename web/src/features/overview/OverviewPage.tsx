// The Overview page (experimental, docs/ui.md section 10b): where the agents' work went over a day, a week or
// a month, as one full-bleed table of sessions under the top bar. The sidebar's place tree is the scope: the
// table lists the sessions at or under its selection (and the search), and the summary at the bottom draws
// that scope's aggregate graph over the date axis, with its totals. The toolbar and the sortable column
// headers stay on top, the rows scroll. Every row is two blocks: the session column (the text line, and under
// it the row's graph on one shared linear time axis) and, behind a rule, the structured block (harness,
// turns, agents, spend, and under them the session's folder).

import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderX,
  Globe,
  HardDrive,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react'
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useOverview, useSearch } from '../../api/queries'
import type { Overview, OverviewLane, OverviewSpan } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatDuration, plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
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
  activeMs,
  activityRuns,
  ancestorIds,
  axisTicks,
  type Band,
  BYS,
  type By,
  bandAt,
  blockWidth,
  buildPlaceTree,
  chooseSlot,
  displayPath,
  fitLabels,
  fitTail,
  folderText,
  formatSort,
  inferHome,
  isBranch,
  keepSelection,
  LANE_DEPTH,
  type Layout,
  laneDescription,
  laneHead,
  laneScale,
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
  parseBy,
  parseIn,
  parseSort,
  placeItems,
  placeOf,
  RANGES,
  type Range,
  type Sort,
  type SortKey,
  searchLanes,
  selectLanes,
  sessionKey,
  slotX,
  sortLanes,
  spineLanes,
  stepAreaPath,
  sumLanes,
  type Totals,
  tokenScale,
  totalsOf,
  visibleRows,
} from './model'
import { useDebounced, useWidth } from './useWidth'

/** The structured block's columns (px: harness, then the numbers) and the cell padding the graph sits in. */
const HARNESS_W = 44
const COLS = { turns: 64, agents: 70, spend: 84 }
const CELL_PAD = 12
const GAP = 8
/** The sidebar beside the rows (px, its right border included), and the strip it folds to. */
const SIDEBAR_W = 260
const STRIP_W = 37
const LAYOUT: Layout = { harness: HARNESS_W, pad: CELL_PAD, gap: GAP, ...COLS }
/** The structured block's width: its rule, padding and columns. */
const BLOCK_W = blockWidth(LAYOUT)
/** The hovered row's background: the text colour, faintly, over the row's own. */
const HOVER = 'hover:bg-[color-mix(in_srgb,var(--text)_5%,var(--surface))]'
/** A header cell's rule on its left: tiny, between the sort arrows. */
const RULE =
  'before:absolute before:top-1/2 before:left-[-4px] before:h-[55%] before:w-px before:-translate-y-1/2 before:bg-line'

/** The scrollbar width the page assumes before it has measured one. */
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

/** The title of the sidebar's (none): the sessions with no value for the key. */
const NONE_TITLE: Record<By, string> = {
  dir: 'Sessions with no folder',
  checkout: 'Sessions in no worktree',
  repo: 'Sessions in no repository',
  remote: 'Sessions with no remote',
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

// ---- the graph of a session row, and of the summary ----------------------------------------

interface RowData {
  ctx: number[]
  idle: number[]
  active: number[]
  /** The slot of index 0 of the arrays (a lane's are trimmed). */
  offset: number
  /** The sessions whose lifetimes the graph covers: day lines are drawn only inside them. */
  lives: readonly OverviewLane[]
  spans: OverviewSpan[]
  /** A session row: its lifetime is drawn as the faint baseline, and the line, spine and nodes on it. */
  lane?: OverviewLane
}

const laneData = (l: OverviewLane): RowData => ({
  lives: [l],
  ctx: l.context,
  idle: l.idle,
  active: l.active,
  offset: l.slot0,
  spans: l.spans,
  lane: l,
})

function RowGraph({ data, axis, pxPerTok }: { data: RowData; axis: Axis; pxPerTok: number }) {
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

function Num({ w, children }: { w: number; children: ReactNode }) {
  return (
    <span className="shrink-0 text-right tabular-nums" style={{ width: w }}>
      {children}
    </span>
  )
}

/**
 * The text line of a row, in the session column: a bold head and a muted description on one line (cut with
 * an ellipsis, the whole text in the title).
 */
function SessionText({
  head,
  headText,
  desc,
  note,
}: {
  head: ReactNode
  headText: string
  desc: string
  /** What the timeline sort orders by, for the title (the row shows no column for it). */
  note: string
}) {
  const text = oneLine(desc)
  const title = text ? `${headText}: ${text}` : headText
  return (
    <div className="min-w-0 truncate pt-1 text-sec" title={note ? `${title}\n${note}` : title}>
      {head}
      {text && <span className="ml-2 text-muted">{text}</span>}
    </div>
  )
}

/** The block's first line: the harness mark (or the summary's session count), then turns, agents and spend. */
function BlockFigures({
  harness,
  label,
  labelTitle,
  turns,
  agents,
  usd,
  className,
}: {
  harness?: string
  /** Text for the harness column instead (the summary's session count); it may run on into Turns' room. */
  label?: string
  labelTitle?: string
  turns: number
  agents: number
  usd: number
  className?: string
}) {
  const count = (n: number) => (n === 0 ? <span className="text-faint">0</span> : n.toLocaleString('en-US'))
  return (
    <div className={cn('flex items-baseline pt-1 text-sec', className)} style={{ columnGap: GAP }}>
      {label ? (
        <span
          className="shrink-0 whitespace-nowrap text-meta text-muted"
          style={{ width: HARNESS_W }}
          title={labelTitle}
        >
          {label}
        </span>
      ) : (
        <div className="flex shrink-0 items-center self-center" style={{ width: HARNESS_W }}>
          {harness && <HarnessIcon harness={harness} size={14} />}
        </div>
      )}
      <Num w={COLS.turns}>{count(turns)}</Num>
      <Num w={COLS.agents}>{count(agents)}</Num>
      <Num w={COLS.spend}>
        <Money usd={usd} />
      </Num>
    </div>
  )
}

let measure: CanvasRenderingContext2D | null | undefined

/**
 * The folder cell: one muted line under the numbers, the session's folder as a display path. When it does not
 * fit its end stays (`…/work/merlin/web`; `fitTail` measures with the cell's own font); the full path is in the
 * title.
 */
function KeyCell({ text, title }: { text: string; title: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(text)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (measure === undefined) measure = document.createElement('canvas').getContext('2d')
    if (!measure) return setShown(text)
    const cs = getComputedStyle(el)
    measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const ctx = measure
    const room = el.clientWidth - 1
    setShown(fitTail(text, (s) => ctx.measureText(s).width <= room))
  }, [text])
  return (
    <div
      ref={ref}
      title={title}
      className={cn(
        'min-w-0 flex-1 overflow-hidden whitespace-nowrap pb-1 text-meta',
        text === '(none)' ? 'text-faint' : 'text-muted',
      )}
    >
      {shown}
    </div>
  )
}

/**
 * A session row, two blocks side by side: the session column (the text line and under it the graph) and,
 * behind a thin rule, the structured block (the figures and under them the folder). The row's hover is CSS, so
 * that moving the pointer does not render it; `data-place` lets the table find the place a hovered row is in.
 */
const SessionRow = memo(function SessionRow({
  l,
  place,
  folder,
  note,
  axis,
  pxPerTok,
}: {
  l: OverviewLane
  /** The session's value of the sidebar's key. */
  place: string
  /** Its folder, as shown. */
  folder: string
  note: string
  axis: Axis
  pxPerTok: number
}) {
  const head = laneHead(l)
  return (
    <div data-place={place} className={cn('flex border-line border-t first:border-t-0', HOVER)}>
      <div className="min-w-0 flex-1 pb-1" style={{ paddingInline: CELL_PAD }}>
        <SessionText
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
          note={note}
        />
        <RowGraph data={laneData(l)} axis={axis} pxPerTok={pxPerTok} />
      </div>
      <div className="flex shrink-0 flex-col border-line border-l" style={{ width: BLOCK_W, paddingInline: CELL_PAD }}>
        <BlockFigures harness={l.harness} turns={l.turns} agents={l.agents} usd={l.usd} />
        <KeyCell text={folder} title={l.dir || 'No folder'} />
      </div>
    </div>
  )
})

/** What the timeline sort orders a session by, for the row's title (the table shows no column for it). */
function laneNote(l: OverviewLane, key: SortKey, slotMs: number): string {
  if (key === 'start') return l.startedAt ? `Started ${new Date(l.startedAt).toLocaleString()}` : ''
  if (key === 'last') return l.lastActivityAt ? `Last active ${new Date(l.lastActivityAt).toLocaleString()}` : ''
  if (key === 'active') return `Active ${formatDuration(activeMs(l.active, slotMs))} in this range`
  return ''
}

// ---- the sticky top: column headers ------------------------------------------------------

/** The room the sort arrow takes on each side of a header's label (the same on both, so the label is centred). */
const ARROW_SLOT = 12

/** A sort arrow in its slot: only the active header draws it, the slot is there either way. */
function ArrowSlot({ on, desc, show = true }: { on: boolean; desc: boolean; show?: boolean }) {
  const Arrow = desc ? ArrowDown : ArrowUp
  return (
    <span className="inline-flex shrink-0 items-center justify-center" style={{ width: ARROW_SLOT }} aria-hidden>
      {on && show && <Arrow size={11} />}
    </span>
  )
}

/**
 * A sortable header cell: the label is centred, with a slot of the same width on both sides; the arrow of
 * the active sort sits in the left one, so the label does not move when the sort changes.
 */
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
  /** The cell's width; without it the cell fills the line. */
  w?: number
  sort: Sort
  onSort: (k: SortKey) => void
  title: string
  /** A tiny rule on the cell's left edge (every cell but the first). */
  rule?: boolean
}) {
  const on = sort.key === col
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      title={title}
      aria-label={`Sort by ${label.toLowerCase()}`}
      className={cn(
        'relative inline-flex items-center justify-center whitespace-nowrap py-1.5 text-meta uppercase tracking-wide hover:text-fg',
        w === undefined ? 'min-w-0 flex-1' : 'shrink-0',
        rule && RULE,
        on ? 'text-fg' : 'text-faint',
      )}
      style={w === undefined ? undefined : { width: w }}
    >
      <ArrowSlot on={on} desc={sort.desc} />
      <span className="min-w-0 truncate">{label}</span>
      <ArrowSlot on={false} desc={sort.desc} />
    </button>
  )
}

/** The pictogram's design size (px): it shrinks to the header cell when that is narrower. */
const PICTO_W = 340
const PICTO_H = 42
/** Where the drawn session starts and ends, its baseline, the spine lane under it and the faint axis. */
const PICTO_X0 = 64
const PICTO_X1 = 276
const PICTO_BASE = 22
const PICTO_LANE = PICTO_BASE + LANE_DEPTH
const PICTO_AXIS = 38
/** The context in steps (px of height) the session rises and falls through, and where it rests (idle). */
const PICTO_STEP = 11
const PICTO_CTX = [3, 5, 4, 8, 6, 10, 13, 9, 7, 0, 0, 0, 0, 0, 0, 8, 12, 9, 4]
const PICTO_IDLE = [0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 8, 7, 6, 6, 5, 0, 0, 0, 0]
/** The session line: runs of steps with a weight (the row graph's `ACTIVE_W`). */
const PICTO_RUNS: [number, number, 1 | 2 | 3][] = [
  [0, 5, 2],
  [5, 8, 3],
  [8, 9, 1],
  [15, 18, 2],
  [18, 19, 1],
]

/**
 * The Session header's second line, a pictogram of a session (not data), in the row graph's own vocabulary
 * and constants: context rising and falling in steps, a pale idle stretch in the middle, the session line,
 * and under it the spine lane with a few spawns (thin verticals, mirrored-J runs in the kinds' colours), over
 * a faint axis with ticks. Three sort buttons: START just before the session's left end, END just after its
 * right end and LENGTH (time with a call running) in the middle, knocked out of the drawing so that it reads.
 * It is centred in the header cell and shrinks (horizontally) when the cell is narrower than its design.
 */
function TimelineSort({ sort, onSort }: { sort: Sort; onSort: (k: SortKey) => void }) {
  const mid = (PICTO_X0 + PICTO_X1) / 2
  const pct = (x: number) => `${(x / PICTO_W) * 100}%`
  const btn = (col: SortKey, label: string, title: string, at: { left?: string; right?: string }, shift: string) => {
    const on = sort.key === col
    return (
      <button
        key={col}
        type="button"
        onClick={() => onSort(col)}
        title={title}
        aria-label={title}
        className={cn(
          'absolute inline-flex items-center whitespace-nowrap bg-surface px-[3px] text-meta uppercase leading-none tracking-wide hover:text-fg',
          on ? 'text-fg' : 'text-faint',
        )}
        style={{ ...at, top: PICTO_BASE, transform: `translateY(-50%) ${shift}` }}
      >
        <ArrowSlot on={on} desc={sort.desc} />
        {label}
        <ArrowSlot on={false} desc={sort.desc} />
      </button>
    )
  }
  const axis = makeAxis(0, PICTO_CTX.length * 60_000, 60_000, PICTO_CTX.length * PICTO_STEP)
  const stepX = (i: number) => PICTO_X0 + 2 + i * PICTO_STEP
  const nonScaling = { vectorEffect: 'non-scaling-stroke' } as const
  // the spine lane: [kind colour, x of the first spawn, end of the run (undefined: a lone tick)]
  const spawns: [string, number, number | undefined][] = [
    [COLOR.subagent, PICTO_X0 + 34, PICTO_X0 + 92],
    [COLOR.subagent, PICTO_X0 + 66, undefined],
    [COLOR.fork, PICTO_X0 + 118, PICTO_X0 + 146],
    [COLOR.addressable, PICTO_X0 + 160, PICTO_X0 + 200],
  ]
  return (
    <div className="relative mx-auto" style={{ width: `min(100%, ${PICTO_W}px)`, height: PICTO_H }}>
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: a pictogram; the buttons are the content */}
      <svg
        width="100%"
        height={PICTO_H}
        viewBox={`0 0 ${PICTO_W} ${PICTO_H}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0"
        aria-hidden
      >
        <line x1={0} x2={PICTO_W} y1={PICTO_AXIS} y2={PICTO_AXIS} stroke="var(--line)" {...nonScaling} />
        {[18, 92, 166, 240, 314].map((x) => (
          <line
            key={x}
            x1={x}
            x2={x}
            y1={PICTO_AXIS - 3}
            y2={PICTO_AXIS}
            stroke="var(--faint)"
            opacity={0.7}
            {...nonScaling}
          />
        ))}
        <g transform={`translate(${PICTO_X0 + 2} 0)`}>
          <path d={stepAreaPath(PICTO_IDLE, axis, PICTO_BASE, 1)} fill={COLOR.main} fillOpacity={IDLE_FILL} />
          <path d={stepAreaPath(PICTO_CTX, axis, PICTO_BASE, 1)} fill={COLOR.main} fillOpacity={CTX_FILL} />
        </g>
        <line x1={PICTO_X0} x2={PICTO_X1} y1={PICTO_BASE} y2={PICTO_BASE} stroke="var(--line)" {...nonScaling} />
        {PICTO_RUNS.map(([a, b, w]) => (
          <line
            key={a}
            x1={stepX(a)}
            x2={stepX(b)}
            y1={PICTO_BASE}
            y2={PICTO_BASE}
            stroke={COLOR.main}
            strokeWidth={ACTIVE_W[w]}
            {...nonScaling}
          />
        ))}
        {spawns.map(([color, x, end]) =>
          end === undefined ? (
            <path
              key={x}
              d={`M${x},${PICTO_BASE}V${PICTO_LANE}`}
              stroke={color}
              strokeWidth={TICK_W}
              opacity={TICK_OPACITY}
              fill="none"
              {...nonScaling}
            />
          ) : (
            <g key={x}>
              <path
                d={elbowPath(x, PICTO_BASE, PICTO_LANE)}
                fill="none"
                stroke={color}
                strokeWidth={RUN_W - 0.5}
                strokeLinecap="round"
                opacity={0.85}
                {...nonScaling}
              />
              <line
                x1={x + Math.min(6, LANE_DEPTH)}
                x2={end}
                y1={PICTO_LANE}
                y2={PICTO_LANE}
                stroke={color}
                strokeWidth={RUN_W}
                {...nonScaling}
              />
            </g>
          ),
        )}
      </svg>
      {btn('start', 'Start', 'Sort by when the session started', { right: pct(PICTO_W - PICTO_X0 + 3) }, '')}
      {btn('last', 'End', 'Sort by its last activity', { left: pct(PICTO_X1 + 3) }, '')}
      {btn(
        'active',
        'Length',
        'Sort by time with a call running (in this range)',
        { left: pct(mid) },
        'translateX(-50%)',
      )}
    </div>
  )
}

function Header({ sort, onSort, padRight }: { sort: Sort; onSort: (k: SortKey) => void; padRight: number }) {
  const th = { sort, onSort }
  return (
    <div className="flex shrink-0 border-line border-b bg-surface" style={{ paddingRight: padRight }}>
      <div className="flex min-w-0 flex-1 flex-col" style={{ paddingInline: CELL_PAD }}>
        <div className="py-1.5 text-center text-faint text-meta uppercase tracking-wide">Session</div>
        <TimelineSort {...th} />
      </div>
      <div className="flex shrink-0 flex-col border-line border-l" style={{ width: BLOCK_W }}>
        <div className="flex" style={{ paddingInline: CELL_PAD, columnGap: GAP }}>
          <div className="shrink-0" style={{ width: HARNESS_W }} title="Harness" />
          <Th {...th} col="turns" label="Turns" w={COLS.turns} rule title="Sort by turns" />
          <Th {...th} col="agents" label="Agents" w={COLS.agents} rule title="Sort by agents launched" />
          <Th {...th} col="spend" label="Spend" w={COLS.spend} rule title="Sort by spend" />
        </div>
        <div className="flex items-center" style={{ paddingInline: CELL_PAD, minHeight: PICTO_H }}>
          <Th {...th} col="key" label="Folder" title="Sort by folder, in the order of the folder tree" />
        </div>
      </div>
    </div>
  )
}

// ---- the sticky bottom: the summary of the scope ------------------------------------------

/**
 * The summary, one row of the same two blocks, sticky at the bottom: under the session column the scope's
 * aggregate graph (its sessions' context and idle context summed, on a token scale of its own, the day lines
 * inside their lifetimes) and right under it the date axis (the same x as the graphs; the day or hour under
 * the pointer gets a light band). In the structured block the number of sessions where the harness column is,
 * then the totals; with no search and no selection, a faint line of the scripted runs under them.
 */
function Summary({
  lanes,
  slots,
  totals,
  title,
  scripted,
  axis,
  band,
  padRight,
}: {
  /** The sessions in scope. */
  lanes: readonly OverviewLane[]
  slots: number
  totals: Totals
  /** The count's title: what the scope is. */
  title: string
  scripted?: Overview['scripted']
  axis: Axis
  /** The stretch of the axis under the pointer: a light band, its label in the body colour. */
  band: Band | null
  padRight: number
}) {
  const data = useMemo((): RowData => {
    const sum = sumLanes(lanes, slots)
    return { ctx: sum.context, idle: sum.idle, active: [], offset: 0, lives: lanes, spans: [] }
  }, [lanes, slots])
  const scale = useMemo(() => tokenScale([data.ctx, data.idle]), [data])
  const ticks = fitLabels(axisTicks(axis), axis.width)
  const inBand = (x: number) => !!band && x >= band.x0 - 0.5 && x < band.x1 - 0.5
  // the count may run over the room of the turns figure; when it would reach it, the short form
  const n = totals.sessions
  const full = plural(n, 'session')
  const room = HARNESS_W + GAP + COLS.turns - totals.turns.toLocaleString('en-US').length * 7 - 4
  const count = full.length * 6.2 <= room ? full : `${n} sess.`
  return (
    <div className="flex border-line border-t bg-surface" style={{ paddingRight: padRight }}>
      <div className="min-w-0 flex-1 overflow-hidden pt-1" style={{ paddingInline: CELL_PAD }}>
        <RowGraph data={data} axis={axis} pxPerTok={scale.pxPerTok} />
        <svg width={axis.width} height={22} className="block" role="img" aria-label="Time axis">
          {band && <rect x={band.x0} y={0} width={band.x1 - band.x0} height={22} fill="var(--surface-2)" />}
          <line x1={0} x2={axis.width} y1={0.5} y2={0.5} stroke="var(--line)" />
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
      <div className="shrink-0 border-line border-l" style={{ width: BLOCK_W, paddingInline: CELL_PAD }}>
        <BlockFigures
          className="font-medium"
          label={count}
          labelTitle={title}
          turns={totals.turns}
          agents={totals.agents}
          usd={totals.usd}
        />
        {scripted && (
          <div className="truncate pt-1 text-faint text-meta" title="Scripted runs (sdk) are in no place">
            {plural(scripted.sessions, 'scripted run')} · <Money usd={scripted.usd} dim />
          </div>
        )}
      </div>
    </div>
  )
}

// ---- the sidebar: the places as a file tree, and the scope -------------------------------

const TREE_INDENT = 12
const TREE_GUTTER = 8

/** The ids of the folders the user closed under this key: kept per key, and fine without storage. */
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
  // the key changed: its own closed folders
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

/** Whether the sidebar is open: the user's choice, kept in the browser (open without it). */
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
  if (n.place && (by === 'repo' || by === 'checkout' || by === 'remote')) return FolderGit2
  return open ? FolderOpen : Folder
}

const ITEM = 'flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left text-body'
const SELECTED = 'bg-accent-soft font-medium text-accent'

/**
 * The faint vertical guides of the levels above an item `indent` steps in: one through the chevron of each
 * ancestor that has its own indent step.
 */
function Guides({ indent }: { indent: number }) {
  return Array.from({ length: indent }, (_, j) => j).map((i) => (
    <span
      key={i}
      aria-hidden
      className="absolute inset-y-0 w-px bg-[color-mix(in_srgb,var(--text)_13%,transparent)]"
      style={{ left: TREE_GUTTER + i * TREE_INDENT + 7 }}
    />
  ))
}

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
 * One line of the tree. `level` 0 is a section heading (semibold); its children start flush under it, and each
 * level below them is one indent step further. The chevron only opens or closes; the label selects.
 */
function TreeLine({
  level,
  open,
  onToggle,
  icon: Icon,
  label,
  title,
  count,
  usd,
  selected,
  hot,
  muted,
  onPick,
  node,
}: {
  level: number
  /** Whether its folder is open; undefined for a line with nothing under it (no chevron). */
  open?: boolean
  onToggle?: () => void
  icon: typeof Folder
  label: string
  title: string
  count: number
  usd: number
  selected: boolean
  hot: boolean
  muted?: boolean
  onPick: () => void
  /** Its node id, for scrolling the selection into view. */
  node?: string
}) {
  const indent = Math.max(0, level - 1)
  return (
    <li
      data-node={node}
      className={cn('relative flex items-center rounded-card', hot && 'bg-surface-2', selected && SELECTED)}
      style={{ paddingLeft: TREE_GUTTER + indent * TREE_INDENT }}
    >
      <Guides indent={indent} />
      {open === undefined ? (
        <span className="size-4 shrink-0" aria-hidden />
      ) : (
        <button
          type="button"
          data-nav
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? 'Close' : 'Open'} ${label}`}
          className="flex size-4 shrink-0 items-center justify-center text-muted hover:text-fg"
        >
          <ChevronRight size={12} aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
        </button>
      )}
      <button
        type="button"
        data-nav
        onClick={onPick}
        aria-current={selected ? 'true' : undefined}
        title={title}
        className={cn(ITEM, 'pl-0.5', level === 0 && 'font-semibold', muted && !selected && 'text-muted')}
      >
        <Icon size={14} aria-hidden className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Figures count={count} usd={usd} />
      </button>
    </li>
  )
}

/** The closed-folder id of the All heading (no place has an empty id). */
const ALL_ID = ''

/**
 * The sidebar: a file explorer of the places under the key it is organised by, and the table's scope. The places
 * sit where they are in the filesystem (a repository at its working directory, a remote as host / owner / name),
 * compact folders, the home as `~`. A click on a line selects it (the table shows what is at or under it), a
 * click on the selected line or on All clears; the chevron only opens or closes. `hover` is the place of the row
 * under the pointer (when a closed folder hides it, the folder is marked). It folds to a strip.
 */
function Sidebar({
  open,
  onOpen,
  by,
  onBy,
  tree,
  all,
  sel,
  hover,
  onSelect,
}: {
  open: boolean
  onOpen: (open: boolean) => void
  by: By
  onBy: (by: By) => void
  tree: PlaceTree
  /** The figures of everything the search leaves. */
  all: Totals
  sel: string | null
  hover: string | null
  onSelect: (path: string | null) => void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const [closed, toggle, openFolders] = useClosed(by)
  const rows = useMemo(() => visibleRows(tree.nodes, closed), [tree.nodes, closed])
  const selNode = sel === null || sel === NONE_SEL ? null : nodeForPath(tree.nodes, sel)
  const hot = hover === null ? null : markedNode(tree.nodes, hover, closed)
  // with sessions of no value the places hang under an All heading, so that (none) is their sibling; without
  // them the places are the top level and nothing else is added
  const none = tree.none
  const rooted = !!none
  const allOpen = !rooted || !closed.has(ALL_ID)
  // the selection's ancestors are open, once for each selection
  const opened = useRef('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: once for each selection, not at every change of the folders
  useEffect(() => {
    if (!selNode || sel === null || opened.current === `${by}|${sel}`) return
    opened.current = `${by}|${sel}`
    const shut = [ALL_ID, ...ancestorIds(tree.nodes, sel)].filter((id) => closed.has(id))
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
  const lift = rooted ? 1 : 0
  return (
    <aside
      aria-label={`${BY_LABEL[by]} tree`}
      className="relative shrink-0 overflow-hidden border-line border-r transition-[width] duration-150 motion-reduce:transition-none"
      style={{ width: open ? SIDEBAR_W : STRIP_W }}
    >
      {!open && (
        <div className="absolute inset-x-0 top-0 flex justify-center border-line border-b py-1">
          <IconButton label="Show the sidebar" onClick={() => onOpen(true)}>
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
          <IconButton label="Hide the sidebar" onClick={() => onOpen(false)}>
            <PanelLeftClose size={15} />
          </IconButton>
        </div>
        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5" onKeyDown={onKeyDown}>
          {rooted && (
            <TreeLine
              level={0}
              open={allOpen}
              onToggle={() => toggle(ALL_ID)}
              icon={HardDrive}
              label="All"
              title="Every place"
              count={all.sessions}
              usd={all.usd}
              selected={sel === null}
              hot={false}
              onPick={() => onSelect(null)}
            />
          )}
          {allOpen &&
            rows.map(({ node: n, depth }) => {
              const folder = n.children.length > 0
              const isOpen = folder && !closed.has(n.id)
              return (
                <TreeLine
                  key={n.id}
                  node={n.id}
                  level={depth + lift}
                  open={folder ? isOpen : undefined}
                  onToggle={() => toggle(n.id)}
                  icon={folderIcon(n, by, isOpen)}
                  label={n.label}
                  title={n.id}
                  count={n.count}
                  usd={n.usd}
                  selected={selNode?.id === n.id}
                  hot={hot === n.id}
                  onPick={() => pick(n.path)}
                />
              )
            })}
          {none && allOpen && (
            <TreeLine
              level={1}
              icon={FolderX}
              label="(none)"
              title={NONE_TITLE[by]}
              count={none.count}
              usd={none.usd}
              selected={sel === NONE_SEL}
              hot={hover === ''}
              muted
              onPick={() => pick(NONE_SEL)}
            />
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
  const by = parseBy(sp.get('by'))
  const sel = parseIn(sp.get('in'))
  const sort = useMemo(() => parseSort(sp.get('sort'), sp.get('dir')), [sp])
  const q = sp.get('q') ?? ''
  const [sbOpen, setSbOpen] = useSidebarOpen()

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
  const pagePlotW = Math.max(240, pageW - (sbOpen ? SIDEBAR_W : STRIP_W) - SCROLLBAR - BLOCK_W - 2 * CELL_PAD)
  const slot = chooseSlot(RANGES[range].ms, useDebounced(pagePlotW, 250))

  // "Ending now", rounded up so that the query key holds still between refreshes.
  const now = useNow(300_000)
  const to = Math.ceil(now.getTime() / TEN_MIN) * TEN_MIN
  const query = useOverview({
    from: new Date(to - RANGES[range].ms).toISOString(),
    to: new Date(to).toISOString(),
    slot,
  })

  // The home the paths show as `~`: the one the sessions' folders share.
  const home = useMemo(() => inferHome(query.data?.lanes.flatMap((l) => (l.dir ? [l.dir] : [])) ?? []), [query.data])

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
          isEmpty={(o) => o.lanes.length === 0 && o.scripted.sessions === 0}
          empty={<div className="p-6 text-muted">Nothing ran in this range.</div>}
          skeleton={<Skeleton className="m-3 h-64" />}
        >
          {(o) => (
            <Table
              o={o}
              by={by}
              sort={sort}
              term={term}
              hits={hits}
              home={home}
              pageW={pageW}
              sel={sel}
              onSelect={select}
              // a new key keeps the selection where some session sits under it there
              onBy={(v) => set({ by: v === 'dir' ? undefined : v, in: keepSelection(sel, o.lanes, v) })}
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

/** The pointer over the rows: x from the left of the rows (whole px), and the place of the row under it. */
interface Hover {
  x: number
  place: string | null
}

function Table({
  o,
  by,
  sort,
  term,
  hits,
  home,
  pageW,
  sel,
  onSelect,
  onBy,
  sbOpen,
  onSbOpen,
  onSort,
}: {
  o: Overview
  by: By
  sort: Sort
  term: string
  hits?: ReadonlySet<string>
  home: string | undefined
  pageW: number
  sel: string | null
  onSelect: (path: string | null) => void
  onBy: (by: By) => void
  sbOpen: boolean
  onSbOpen: (open: boolean) => void
  onSort: (k: SortKey) => void
}) {
  // The rows scroll; header and summary do not. The scrollbar takes width from the rows only, so the
  // header and the summary give up as much (padRight) and the columns and the date axis stay aligned.
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const innerW = useWidth(innerRef)
  const [padRight, setPadRight] = useState(0)
  // the plot is sized for where the sidebar will be, not for the width it has while it slides
  const plotW = Math.max(240, pageW - (sbOpen ? SIDEBAR_W : STRIP_W) - padRight - BLOCK_W - 2 * CELL_PAD)
  // the search narrows the sessions; the tree shows these, the table and the summary what the selection leaves
  const found = useMemo(() => searchLanes(o.lanes, term, hits), [o.lanes, term, hits])
  const scope = useMemo(() => selectLanes(found, sel, by), [found, sel, by])
  const rows = useMemo(() => sortLanes(scope, sort, home), [scope, sort, home])
  const totals = useMemo(() => totalsOf(scope), [scope])
  const all = useMemo(() => totalsOf(found), [found])
  const tree = useMemo(() => buildPlaceTree(placeItems(found, by), by, home), [found, by, home])
  const pxPerTok = useMemo(() => laneScale(o.lanes).pxPerTok, [o.lanes])
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

  // ---- hover: one state, the pointer's x and the place under it ----
  const [hover, setHover] = useState<Hover | null>(null)
  // the only thing the pointer lights besides its row: the day (the hour) on the summary's axis
  const hx = hover ? hover.x : null
  const band = hx === null || hx >= innerW - BLOCK_W ? null : bandAt(axis, hx - CELL_PAD)
  const onMove = (e: React.MouseEvent) => {
    const left = innerRef.current?.getBoundingClientRect().left ?? 0
    const x = Math.floor(e.clientX - left)
    const place = (e.target as Element).closest('[data-place]')?.getAttribute('data-place') ?? null
    setHover((h) => (h && h.x === x && h.place === place ? h : { x, place }))
  }

  const where = sel === null ? '' : ` in ${displayPath(sel, home)}`
  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar
        open={sbOpen}
        onOpen={onSbOpen}
        by={by}
        onBy={onBy}
        tree={tree}
        all={all}
        sel={sel}
        hover={sbOpen && hover ? hover.place : null}
        onSelect={onSelect}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header sort={sort} onSort={onSort} padRight={padRight} />
        <div
          ref={scrollRef}
          id="overview-rows"
          className="min-h-0 flex-1 overflow-y-auto"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          <div ref={innerRef} className="relative">
            {rows.map((l) => (
              <SessionRow
                key={`${l.harness}/${l.id}`}
                l={l}
                place={placeOf(l, by)}
                folder={folderText(l.dir, home)}
                note={laneNote(l, sort.key, o.slotMs)}
                axis={axis}
                pxPerTok={pxPerTok}
              />
            ))}
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
        <Summary
          lanes={scope}
          slots={o.slots}
          totals={totals}
          title={`${plural(totals.sessions, searching ? 'matching session' : 'session')}${where}`}
          scripted={!searching && sel === null && o.scripted.sessions > 0 ? o.scripted : undefined}
          axis={axis}
          band={band}
          padRight={padRight}
        />
      </div>
    </div>
  )
}
