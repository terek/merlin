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
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useHarness } from '../../api/harnesses'
import { useCost, useOverview, useSearch } from '../../api/queries'
import type { Overview, OverviewLane, OverviewSpan } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatDuration, plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { resumeCommand, sessionPath } from '../../lib/paths'
import { useShortcut } from '../../shell/useShortcut'
import {
  copyText,
  HarnessIcon,
  IconButton,
  Money,
  QueryBoundary,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
} from '../../ui'
import { COLOR, CTX_FILL, elbowPath, SPEND_COLOR, WORKFLOW_DASH } from '../spend/TimeView'
import {
  ACTIVE_W,
  type Axis,
  activeMs,
  activityRuns,
  ancestorIds,
  axisTicks,
  type Band,
  type Brush,
  BYS,
  type By,
  bandAt,
  bandLabel,
  blockWidth,
  brushRange,
  buildPlaceTree,
  type CustomRange,
  chooseSlot,
  customLabel,
  customPhrase,
  customWindow,
  dailySpend,
  dayIndexAt,
  displayPath,
  drawBrush,
  firstSpendDay,
  fitLabels,
  fitTail,
  folderText,
  formatCustom,
  formatSort,
  type HeldCall,
  heldContext,
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
  moveBrush,
  NONE_SEL,
  nextSort,
  nodeForPath,
  oneLine,
  type PlaceNode,
  type PlaceTree,
  parseBy,
  parseCustom,
  parseIn,
  parseSort,
  placeItems,
  placeOf,
  presetRange,
  RANGES,
  type Range,
  rangeBrush,
  resizeBrush,
  type Sort,
  type SortKey,
  searchLanes,
  selectLanes,
  sessionKey,
  sessionStretchUrl,
  slotX,
  sortLanes,
  spineLanes,
  stepAreaPath,
  stripOf,
  stripTicks,
  sumLanes,
  type Totals,
  tokenScale,
  totalsOf,
  visibleRows,
} from './model'
import { useDebounced, useMeasuredWidth, useWidth } from './useWidth'

/** The structured block's columns (px) and the cell padding the graph sits in. */
const COLS = { turns: 64, agents: 70, spend: 84 }
const CELL_PAD = 12
const GAP = 8
/** The sidebar beside the rows (px, its right border included), and the strip it folds to. */
const SIDEBAR_W = 260
const STRIP_W = 37
const LAYOUT: Layout = { pad: CELL_PAD, gap: GAP, ...COLS }
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
 * The text line of a row, in the session column: the harness mark, a bold head and a muted description on the
 * left (cut with an ellipsis, the whole text in the title; they give way to the folder) and the folder, always
 * printed, at the very right.
 */
function SessionText({
  mark,
  head,
  headText,
  desc,
  note,
  folder,
}: {
  mark: ReactNode
  head: ReactNode
  headText: string
  desc: string
  /** What the timeline sort orders by, for the title (the row shows no column for it). */
  note: string
  folder: ReactNode
}) {
  const text = oneLine(desc)
  const title = text ? `${headText}: ${text}` : headText
  return (
    <div className="flex items-baseline gap-3 pt-1 text-sec">
      <div className="flex min-w-0 flex-[1_1_0%] items-baseline gap-1.5">
        <span className="shrink-0 self-center">{mark}</span>
        <div className="min-w-0 flex-1 truncate" title={note ? `${title}\n${note}` : title}>
          {head}
          {text && <span className="ml-2 text-muted">{text}</span>}
        </div>
      </div>
      {folder}
    </div>
  )
}

/** The block's one line: turns, agents and spend. */
function BlockFigures({
  turns,
  agents,
  usd,
  className,
}: {
  turns: number
  agents: number
  usd: number
  className?: string
}) {
  const count = (n: number) => (n === 0 ? <span className="text-faint">0</span> : n.toLocaleString('en-US'))
  return (
    <div className={cn('flex items-baseline text-sec', className)} style={{ columnGap: GAP }}>
      <Num w={COLS.turns}>{count(turns)}</Num>
      <Num w={COLS.agents}>{count(agents)}</Num>
      <Num w={COLS.spend}>
        <Money usd={usd} />
      </Num>
    </div>
  )
}

let measure: CanvasRenderingContext2D | null | undefined

/** How long the folder reads "Copied" (ms). */
const COPIED_MS = 1200

/**
 * The folder, at the right end of a row's text line: the session's directory as a display path, muted, at
 * most 40 % of the line and at least 96 px wide. When it does not fit its end stays (`…/work/merlin/web`;
 * `fitTail` measures with the cell's own font); the full path is in the title. With a resume `command` it is
 * a button: a click copies the command and the text reads "Copied" for a moment; it does not open the session.
 * The full text sizes the cell (invisibly), so that it grows back when there is room.
 */
function FolderCell({ text, path, command }: { text: string; path: string; command: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const w = useWidth(ref)
  const [shown, setShown] = useState(text)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the cell's width changes
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (measure === undefined) measure = document.createElement('canvas').getContext('2d')
    if (!measure) return setShown(text)
    const cs = getComputedStyle(el)
    measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const ctx = measure
    const room = el.clientWidth
    setShown(fitTail(text, (s) => ctx.measureText(s).width <= room))
  }, [text, w])
  const copy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    await copyText(command)
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }
  const tone = copied ? 'text-ok' : text === '(none)' ? 'text-faint' : 'text-muted'
  return (
    <span ref={ref} className="relative max-w-[45%] shrink-0 overflow-hidden whitespace-nowrap text-meta">
      <span className="invisible block pr-0.5">{text}</span>
      {command ? (
        <button
          type="button"
          onClick={copy}
          title={`Copy: ${command}`}
          className={cn('absolute inset-0 cursor-pointer text-right hover:text-fg', tone)}
        >
          {copied ? 'Copied' : shown}
        </button>
      ) : (
        <span title={path} className={cn('absolute inset-0 text-right', tone)}>
          {shown}
        </span>
      )}
    </span>
  )
}

/**
 * A session row, two blocks side by side: the session column (the text line with the folder at its right end,
 * and under it the graph) and, behind a thin rule, the structured block (the figures on one line, centred in
 * the row). The row's hover is CSS, so that moving the pointer does not render it; `data-place` lets the table
 * find the place a hovered row is in. A click on the graph opens the session at the day (the hour) under the
 * pointer; the head and the rest of the text line open it whole.
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
  const navigate = useNavigate()
  const command = resumeCommand(l.dir, l.id, useHarness(l.harness).resume)
  const urlAt = (e: React.MouseEvent<HTMLAnchorElement>) =>
    sessionStretchUrl(l, axis, e.clientX - e.currentTarget.getBoundingClientRect().left)
  return (
    <div data-place={place} className={cn('flex border-line border-t first:border-t-0', HOVER)}>
      <div className="min-w-0 flex-1 pb-1" style={{ paddingInline: CELL_PAD }}>
        <SessionText
          mark={<HarnessIcon harness={l.harness} size={13} />}
          head={
            <Link to={sessionPath(l)} className="font-semibold text-fg hover:underline">
              {head}
            </Link>
          }
          headText={head}
          desc={laneDescription(l)}
          note={note}
          folder={<FolderCell text={folder} path={l.dir || 'No folder'} command={command} />}
        />
        <a
          href={sessionPath(l)}
          tabIndex={-1}
          aria-label={`Open ${head} at a day`}
          className="block cursor-pointer"
          style={{ width: axis.width }}
          onMouseMove={(e) => {
            e.currentTarget.title = `Open this session at ${bandLabel(axis, e.clientX - e.currentTarget.getBoundingClientRect().left)}`
          }}
          onClick={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            if (e.metaKey || e.ctrlKey || e.shiftKey) window.open(urlAt(e), '_blank', 'noopener')
            else navigate(urlAt(e))
          }}
          onAuxClick={(e) => {
            if (e.button !== 1) return
            e.preventDefault()
            window.open(urlAt(e), '_blank', 'noopener')
          }}
        >
          <RowGraph data={laneData(l)} axis={axis} pxPerTok={pxPerTok} />
        </a>
      </div>
      <div
        className="flex shrink-0 flex-col justify-center border-line border-l"
        style={{ width: BLOCK_W, paddingInline: CELL_PAD }}
      >
        <BlockFigures turns={l.turns} agents={l.agents} usd={l.usd} />
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
        'relative inline-flex items-center justify-center whitespace-nowrap text-meta uppercase tracking-wide hover:text-fg',
        w === undefined ? 'min-w-0 flex-1' : 'shrink-0',
        rule && RULE,
        on ? 'text-fg' : 'text-faint',
      )}
      style={w === undefined ? { height: LINE_H } : { width: w, height: LINE_H }}
    >
      <ArrowSlot on={on} desc={sort.desc} />
      <span className="min-w-0 truncate">{label}</span>
      <ArrowSlot on={false} desc={sort.desc} />
    </button>
  )
}

/** The height of one line of the header (px): the text lines and the pictogram are as high. */
const LINE_H = 28
/** The pictogram's design size (px): it shrinks to the header cell when that is narrower. */
const PICTO_W = 340
/** Where the drawn session starts and ends, and its baseline: the text baseline of the START and END labels. */
const PICTO_X0 = 64
const PICTO_X1 = 276
const PICTO_BASE = 18

/**
 * The drawn session's slots, made as a real one is: calls (context in px, one slot of 1 px each) at irregular
 * gaps through `heldContext`, so that the context holds between calls closer than the hold time and spikes where
 * they are further apart; a pause in the middle that holds its context as idle. A fixed pseudo-random
 * sequence: the same drawing every time.
 */
function pictoLane(): { ctx: number[]; idle: number[]; active: number[] } {
  const n = PICTO_X1 - PICTO_X0
  let seed = 11
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const calls: HeldCall[] = []
  const burst = (from: number, to: number, lo: number, hi: number) => {
    for (let t = from; t < to; t += 1 + Math.floor(rnd() * rnd() * rnd() * 11)) {
      const k = (t - from) / (to - from)
      calls.push({ at: t * 60_000, ctx: Math.max(2, (lo + (hi - lo) * k) * (0.55 + 0.45 * rnd())) })
    }
  }
  burst(0, 78, 6, 13)
  burst(120, n - 1, 10, 16)
  const { context, idle } = heldContext(calls, 0, 60_000, n)
  return { ctx: context, idle, active: context.map((v) => (v > 0 ? 1 : 0)) }
}
const PICTO = pictoLane()

/**
 * The header's one line, a pictogram of a session (not data), drawn with the row graph's own helpers and
 * constants from synthetic slots: context in narrow per-slot spikes and steps, a pale idle stretch, the thin
 * grey baseline and on it the session line in its lightest weight; the baseline sits on the text baseline of
 * the labels. Three sort buttons: START just before the session's left end, END just after its right end and
 * LENGTH (time with a call running) in the middle, knocked out of the drawing so that it reads. It is as high
 * as a text line, centred in the header cell, and shrinks (horizontally) when the cell is narrower than its
 * design.
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
        style={{ ...at, top: LINE_H / 2, transform: `translateY(-50%) ${shift}` }}
      >
        <ArrowSlot on={on} desc={sort.desc} />
        {label}
        <ArrowSlot on={false} desc={sort.desc} />
      </button>
    )
  }
  const axis = makeAxis(0, PICTO.ctx.length * 60_000, 60_000, PICTO.ctx.length)
  const runs = activityRuns(PICTO.active)
  const nonScaling = { vectorEffect: 'non-scaling-stroke' } as const
  return (
    <div className="relative mx-auto" style={{ width: `min(100%, ${PICTO_W}px)`, height: LINE_H }}>
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: a pictogram; the buttons are the content */}
      <svg
        width="100%"
        height={LINE_H}
        viewBox={`0 0 ${PICTO_W} ${LINE_H}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0"
        aria-hidden
      >
        <g transform={`translate(${PICTO_X0} 0)`}>
          <path d={stepAreaPath(PICTO.idle, axis, PICTO_BASE, 1)} fill={COLOR.main} fillOpacity={IDLE_FILL} />
          <path d={stepAreaPath(PICTO.ctx, axis, PICTO_BASE, 1)} fill={COLOR.main} fillOpacity={CTX_FILL} />
          <line x1={0} x2={axis.width} y1={PICTO_BASE} y2={PICTO_BASE} stroke="var(--line)" {...nonScaling} />
          {runs.map((r) => (
            <line
              key={r.from}
              x1={slotX(axis, r.from)}
              x2={slotX(axis, r.to)}
              y1={PICTO_BASE}
              y2={PICTO_BASE}
              stroke={COLOR.main}
              strokeWidth={ACTIVE_W[1]}
              {...nonScaling}
            />
          ))}
        </g>
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
  const folderOn = sort.key === 'key'
  return (
    <div className="flex shrink-0 border-line border-b bg-surface" style={{ paddingRight: padRight }}>
      <div className="relative min-w-0 flex-1" style={{ paddingInline: CELL_PAD }}>
        <TimelineSort {...th} />
        <button
          type="button"
          onClick={() => onSort('key')}
          title="Sort by folder, in the order of the folder tree"
          aria-label="Sort by folder"
          className={cn(
            'absolute top-0 inline-flex items-center whitespace-nowrap text-meta uppercase tracking-wide hover:text-fg',
            folderOn ? 'text-fg' : 'text-faint',
          )}
          style={{ right: CELL_PAD, height: LINE_H }}
        >
          <ArrowSlot on={folderOn} desc={sort.desc} />
          Folder
        </button>
      </div>
      <div className="flex shrink-0 items-center border-line border-l" style={{ width: BLOCK_W }}>
        <div className="flex w-full" style={{ paddingInline: CELL_PAD, columnGap: GAP }}>
          <Th {...th} col="turns" label="Turns" w={COLS.turns} title="Sort by turns" />
          <Th {...th} col="agents" label="Agents" w={COLS.agents} rule title="Sort by agents launched" />
          <Th {...th} col="spend" label="Spend" w={COLS.spend} rule title="Sort by spend" />
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
      <div
        className="flex shrink-0 flex-col justify-center border-line border-l"
        style={{ width: BLOCK_W, paddingInline: CELL_PAD }}
      >
        <BlockFigures className="font-medium" turns={totals.turns} agents={totals.agents} usd={totals.usd} />
        <div className="truncate pt-0.5 text-meta">
          <span className="text-muted" title={title}>
            {plural(totals.sessions, 'session')}
          </span>
          {scripted && (
            <span className="text-faint" title="Scripted runs (sdk) are in no place">
              {' · '}
              {plural(scripted.sessions, 'scripted run')} · <Money usd={scripted.usd} dim />
            </span>
          )}
        </div>
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
  /** 0: a heading, always open: no chevron. */
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
      {level === 0 ? null : open === undefined ? (
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
        className={cn(
          ITEM,
          level === 0 ? 'pl-1' : 'pl-0.5',
          level === 0 && 'font-semibold',
          muted && !selected && 'text-muted',
        )}
      >
        <Icon size={14} aria-hidden className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Figures count={count} usd={usd} />
      </button>
    </li>
  )
}

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
  const [stored, toggle, openFolders] = useClosed(by)
  // the top level (All, else the top places) is always open: what was stored for it does not count
  const none = tree.none
  const rooted = !!none
  const closed = useMemo(
    () => (rooted ? stored : new Set([...stored].filter((id) => !tree.nodes.some((n) => n.id === id)))),
    [stored, rooted, tree.nodes],
  )
  const rows = useMemo(() => visibleRows(tree.nodes, closed), [tree.nodes, closed])
  const selNode = sel === null || sel === NONE_SEL ? null : nodeForPath(tree.nodes, sel)
  const hot = hover === null ? null : markedNode(tree.nodes, hover, closed)
  // with sessions of no value the places hang under an All heading, so that (none) is their sibling; without
  // them the places are the top level and nothing else is added
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
          {rows.map(({ node: n, depth }) => {
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
          {none && (
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

// ---- the locator: an arbitrary range on the whole history ---------------------------------

/** The locator's height (px): the day bars over the light axis. */
const LOC_H = 29
const LOC_BAR = 15
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
      className="min-w-0 flex-1 rounded-badge"
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
        <rect x={0} y={0} width={width} height={LOC_BAR + 2} fill="var(--surface-2)" opacity={0.5} rx={3} />
        {spend.map((v, i) =>
          v > 0 ? (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: days are positions
              key={i}
              x={i * dw + dw * 0.15}
              y={LOC_BAR + 1 - Math.max(1, (v / peak) * LOC_BAR)}
              width={Math.max(1, dw * 0.7)}
              height={Math.max(1, (v / peak) * LOC_BAR)}
              fill={SPEND_COLOR}
            />
          ) : null,
        )}
        <line x1={0} x2={width} y1={LOC_BAR + 2.5} y2={LOC_BAR + 2.5} stroke="var(--line)" />
        {ticks.map((t) => (
          <g key={t.x}>
            <line x1={t.x} x2={t.x} y1={LOC_BAR + 2.5} y2={LOC_BAR + (t.month ? 6 : 5)} stroke="var(--line)" />
            <text x={t.x + 2} y={LOC_H - 2} fontSize={10} fill={t.month ? 'var(--muted)' : 'var(--faint)'}>
              {t.label}
            </text>
          </g>
        ))}
        <g pointerEvents="none">
          <rect x={0} y={0} width={x0} height={LOC_BAR + 2} fill="var(--surface)" opacity={0.55} />
          <rect
            x={x1}
            y={0}
            width={Math.max(0, width - x1)}
            height={LOC_BAR + 2}
            fill="var(--surface)"
            opacity={0.55}
          />
          <rect
            x={x0}
            y={0.75}
            width={Math.max(2, x1 - x0)}
            height={LOC_BAR + 0.5}
            fill="var(--accent)"
            fillOpacity={0.08}
            stroke="var(--accent)"
            strokeWidth={1.5}
            rx={2}
          />
          {[x0, x1].map((x, i) => (
            <rect
              key={i === 0 ? 'lo' : 'hi'}
              x={x - 2}
              y={LOC_BAR / 2 - 4}
              width={4}
              height={LOC_BAR / 2 + 2}
              rx={2}
              fill="var(--accent)"
            />
          ))}
        </g>
      </svg>
    </div>
  )
}

// ---- the page ----------------------------------------------------------------------------

export function OverviewPage() {
  useDocumentTitle('Overview')
  const [sp, setSp] = useSearchParams()
  const range = oneOf<Range>(sp.get('range'), ['1d', '7d', '30d'], '7d')
  // a custom range (both days, in order) wins over `range`
  const custom = parseCustom(sp.get('from'), sp.get('to'))
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

  // ---- the locator: it opens over the search box; the page applies its range when a drag ends ----
  const [locOpen, setLocOpen] = useState(false)
  const [locSeen, setLocSeen] = useState(false)
  const [live, setLive] = useState<CustomRange | null>(null)
  const openLocator = (v: boolean) => {
    setLocOpen(v)
    if (v) setLocSeen(true)
  }
  useShortcut('Escape', () => openLocator(false), { enabled: locOpen })

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
    if (locOpen) {
      // the search box is hidden under the locator: close it, and focus the box once it is back
      openLocator(false)
      setTimeout(() => inputRef.current?.focus(), 170)
      return
    }
    inputRef.current?.focus()
    inputRef.current?.select()
  })
  const term = q.trim()
  const search = useSearch(term)
  const hits = useMemo(
    () => (search.data ? new Set(search.data.hits.map((h) => sessionKey(h.session.harness, h.session.id))) : undefined),
    [search.data],
  )

  // "Ending now", rounded up so that the query key holds still between refreshes.
  const now = useNow(300_000)
  const to = Math.ceil(now.getTime() / TEN_MIN) * TEN_MIN
  const win = custom ? customWindow(custom, to) : { fromMs: to - RANGES[range].ms, toMs: to }
  const rangeMs = win.toMs - win.fromMs

  // The plot's width picks the slot (about one per pixel); the width is followed live, the slot only
  // once the width has held still, so a drag of the window does not refetch at every pixel.
  const rootRef = useRef<HTMLDivElement>(null)
  const measured = useMeasuredWidth(rootRef)
  const pageW = measured ?? 900
  const pagePlotW = Math.max(240, pageW - (sbOpen ? SIDEBAR_W : STRIP_W) - SCROLLBAR - BLOCK_W - 2 * CELL_PAD)
  // the first measurement is used as it is; the debounce only holds back the slot of later resizes
  const settledW = useDebounced(measured === null ? null : pagePlotW, 250)
  const slot = chooseSlot(rangeMs, settledW ?? pagePlotW)

  // nothing is asked for before the width is known: one request, at the right slot
  const query = useOverview(
    {
      from: new Date(win.fromMs).toISOString(),
      to: new Date(win.toMs).toISOString(),
      slot,
    },
    measured !== null,
  )

  // The home the paths show as `~`: the one the sessions' folders share.
  const home = useMemo(() => inferHome(query.data?.lanes.flatMap((l) => (l.dir ? [l.dir] : [])) ?? []), [query.data])

  // The page fills the window and scrolls inside: the document drops its reserved scrollbar gutter meanwhile.
  useEffect(() => {
    document.documentElement.dataset.fullbleed = ''
    return () => {
      delete document.documentElement.dataset.fullbleed
    }
  }, [])

  const shown = live ?? custom
  const grow = 'transition-[flex-grow,min-width] duration-150 motion-reduce:transition-none'
  return (
    <div ref={rootRef} className="flex h-[calc(100vh-44px)] w-full flex-col bg-surface">
      <div className="flex min-h-[46px] shrink-0 items-center border-line border-b px-3 py-2">
        <SegmentedControl<Range | 'custom'>
          label="Range"
          value={shown ? 'custom' : range}
          options={[
            { value: '1d', label: '1d', title: 'The last day' },
            { value: '7d', label: '7d', title: 'The last week' },
            { value: '30d', label: '30d', title: 'The last 30 days' },
            {
              value: 'custom',
              // a fixed width while the locator is open or a range is shown, so the label changing
              // length under a drag ("Feb 9 → 8d", "Feb 19 → 18d") does not shift the strip beside it
              label: (() => {
                const text = shown ? customLabel(shown, now) : 'Custom'
                if (!shown && !locOpen) return text
                return (
                  <span className={cn('inline-block text-center', text.includes(',') ? 'min-w-[20ch]' : 'min-w-[14ch]')}>
                    {text}
                  </span>
                )
              })(),
              title: 'Pick any range of days on the whole history',
            },
          ]}
          onChange={(v) => {
            if (v === 'custom') return openLocator(!locOpen)
            openLocator(false)
            set({ range: v === '7d' ? undefined : v, ...formatCustom(null) })
          }}
        />
        <div
          className={cn('flex items-center justify-center gap-2 overflow-hidden', grow, locOpen && 'opacity-0')}
          style={{ flexGrow: locOpen ? 0 : 1, flexBasis: 0, minWidth: locOpen ? 0 : 220 }}
          inert={locOpen}
        >
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
        <div
          className={cn('overflow-hidden', grow)}
          style={{ flexGrow: locOpen ? 1 : 0, flexBasis: 0, minWidth: 0 }}
          inert={!locOpen}
        >
          <div className="flex items-center gap-2 pl-4">
            {locSeen && (
              <Locator
                value={custom ?? presetRange(range, now)}
                now={now}
                onLive={setLive}
                onCommit={(r) => set({ range: undefined, ...formatCustom(r) })}
              />
            )}
            <IconButton label="Close the locator" onClick={() => openLocator(false)}>
              <X size={15} />
            </IconButton>
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <QueryBoundary
          query={query}
          isEmpty={(o) => o.lanes.length === 0 && o.scripted.sessions === 0}
          empty={
            <div className="p-6 text-muted">
              {custom ? `Nothing ran ${customPhrase(custom, now)}.` : 'Nothing ran in this range.'}
            </div>
          }
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
