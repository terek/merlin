// The Overview page (experimental, docs/ui.md section 10b): where the agents' work went over a day, a week or
// a month, as one full-bleed table of sessions under the top bar. The sidebar's place tree is the scope: the
// table lists the sessions at or under its selection (and the search), and the summary at the bottom draws
// that scope's aggregate graph over the date axis, with its totals. The toolbar and the sortable column
// headers stay on top, the rows scroll. Every row is two blocks: the session column (the text line, and under
// it the row's graph on one shared linear time axis) and, behind a rule, the structured block (harness,
// turns, agents, spend, and under them the session's folder).

import { ArrowDown, ArrowUp } from 'lucide-react'
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useHarness } from '../../api/harnesses'
import { useOverview, useSearch } from '../../api/queries'
import type { Overview, OverviewLane, OverviewSpan } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatDuration, plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { resumeCommand, sessionPath } from '../../lib/paths'
import { scopeSearch } from '../../lib/scope'
import { copyText, HarnessIcon, Money, QueryBoundary, Skeleton } from '../../ui'
import { COLOR, CTX_FILL, elbowPath, WORKFLOW_DASH } from '../spend/TimeView'
import {
  ACTIVE_W,
  type Axis,
  activeMs,
  activityRuns,
  axisTicks,
  type Band,
  type Beads,
  type By,
  bandAt,
  bandLabel,
  blockWidth,
  buildPlaceTree,
  chooseSlot,
  customPhrase,
  customWindow,
  displayPath,
  fitLabels,
  fitTail,
  folderText,
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
  midnightXs,
  nextSort,
  oneLine,
  parseSort,
  placeItems,
  placeOf,
  presetRange,
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
  sumLanes,
  type Totals,
  tokenScale,
  totalsOf,
} from './model'
import { ScopeSlot, useScope } from './ScopeSlot'
import { SIDEBAR_W, Sidebar, STRIP_W, useSidebarOpen } from './Sidebar'
import { useDebounced, useMeasuredWidth, useWidth } from './useWidth'

/** The structured block's columns (px) and the cell padding the graph sits in. */
const COLS = { turns: 64, agents: 70, spend: 84 }
const CELL_PAD = 12
const GAP = 8
/** The sidebar beside the rows (px, its right border included), and the strip it folds to. */
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
        <span className="flex h-[1.5em] shrink-0 items-center self-start pt-px">{mark}</span>
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
  usdHref,
  className,
}: {
  turns: number
  agents: number
  usd: number
  /** Where the spend figure leads (Cost, for the same scope). */
  usdHref?: string
  className?: string
}) {
  const count = (n: number) => (n === 0 ? <span className="text-faint">0</span> : n.toLocaleString('en-US'))
  return (
    <div className={cn('flex items-baseline text-sec', className)} style={{ columnGap: GAP }}>
      <Num w={COLS.turns}>{count(turns)}</Num>
      <Num w={COLS.agents}>{count(agents)}</Num>
      <Num w={COLS.spend}>
        {usdHref ? (
          <Link to={usdHref} title="The spend of this scope on the Cost page" className="hover:underline">
            <Money usd={usd} />
          </Link>
        ) : (
          <Money usd={usd} />
        )}
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
function laneNote(l: OverviewLane, key: SortKey, slotMs: number, beads?: Beads): string {
  // with the Bead key the row names its bead (the folder is the line's own)
  const bead = beads && l.bead ? `Bead: ${l.bead}${beads[l.bead]?.title ? ` ${beads[l.bead].title}` : ''}` : ''
  return [bead, timelineNote(l, key, slotMs)].filter(Boolean).join('\n')
}

function timelineNote(l: OverviewLane, key: SortKey, slotMs: number): string {
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
  costHref,
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
  /** The Cost page for this scope. */
  costHref: string
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
        <BlockFigures
          className="font-medium"
          turns={totals.turns}
          agents={totals.agents}
          usd={totals.usd}
          usdHref={costHref}
        />
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

// ---- the page ----------------------------------------------------------------------------

export function OverviewPage() {
  useDocumentTitle('Overview')
  const scope = useScope()
  const { sp, set, select, range, custom, by, sel, q } = scope
  const sort = useMemo(() => parseSort(sp.get('sort'), sp.get('dir')), [sp])
  const [sbOpen, setSbOpen] = useSidebarOpen()

  const term = q.trim()
  const search = useSearch(term)
  const hits = useMemo(
    () => (search.data ? new Set(search.data.hits.map((h) => sessionKey(h.session.harness, h.session.id))) : undefined),
    [search.data],
  )

  // "Ending now", rounded up so that the query key holds still between refreshes.
  const now = useNow(300_000)
  const to = Math.ceil(now.getTime() / TEN_MIN) * TEN_MIN
  // a preset is its whole local days (today included), as the timeline draws it, ending now
  const days = custom ?? presetRange(range, now)
  const win = customWindow(days, to)
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
  return (
    <div ref={rootRef} className="flex h-full w-full flex-col bg-surface">
      <ScopeSlot scope={scope} home={home} beads={query.data?.beads} />
      <div className="flex min-h-0 flex-1 flex-col">
        <QueryBoundary
          query={query}
          isEmpty={(o) => o.lanes.length === 0 && o.scripted.sessions === 0}
          empty={<div className="p-6 text-muted">{`Nothing ran ${customPhrase(days, now)}.`}</div>}
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
              onBy={(v) => set({ by: v === 'dir' ? undefined : v, in: keepSelection(sel, o.lanes, v, o.beads) })}
              sbOpen={sbOpen}
              onSbOpen={setSbOpen}
              onSort={(k) => set(formatSort(nextSort(sort, k)))}
              costHref={`/cost${scopeSearch(sp)}`}
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
  costHref,
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
  costHref: string
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
  const scope = useMemo(() => selectLanes(found, sel, by, o.beads), [found, sel, by, o.beads])
  const rows = useMemo(() => sortLanes(scope, sort, home, { by, beads: o.beads }), [scope, sort, home, by, o.beads])
  const totals = useMemo(() => totalsOf(scope), [scope])
  const all = useMemo(() => totalsOf(found), [found])
  const tree = useMemo(() => buildPlaceTree(placeItems(found, by, o.beads), by, home), [found, by, home, o.beads])
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

  const where = sel === null ? '' : ` in ${displayPath(sel, home, by)}`
  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar
        open={sbOpen}
        onOpen={onSbOpen}
        by={by}
        onBy={onBy}
        tree={tree}
        beads={o.beads}
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
                place={placeOf(l, by, o.beads)}
                folder={folderText(l.dir, home)}
                note={laneNote(l, sort.key, o.slotMs, by === 'bead' ? o.beads : undefined)}
                axis={axis}
                pxPerTok={pxPerTok}
              />
            ))}
            {rows.length === 0 && (
              <div className="p-6 text-muted">
                {searching ? `No sessions match “${term}”` : 'Nothing'}
                {sel !== null && ` under ${displayPath(sel, home, by)}`}
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
          costHref={costHref}
          axis={axis}
          band={band}
          padRight={padRight}
        />
      </div>
    </div>
  )
}
