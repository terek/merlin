// The parts of a session row that the list and the session open in place both draw (docs/ui.md section 10b): the
// row's graph on the list's linear time axis, the text line (harness mark, head, description) and the folder
// cell with its copy button. Extracted from OverviewPage so that the focus's head is the same components.

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OverviewLane, OverviewSpan } from '../../api/types'
import { cn } from '../../lib/cn'
import { copyText } from '../../ui'
import { COLOR, CTX_FILL, elbowPath, WORKFLOW_DASH } from '../spend/TimeView'
import {
  ACTIVE_W,
  type Axis,
  activityRuns,
  fitTail,
  isBranch,
  LANE_DEPTH,
  lifeSpan,
  midnightXs,
  oneLine,
  slotX,
  spineLanes,
  stepAreaPath,
  xOf,
} from './model'
import { useWidth } from './useWidth'
import { type LockoutSpan, refusalTicks } from './windows'

/** The padding a row's cell keeps on each side of the graph (px). */
export const CELL_PAD = 12

/** The idle context's fill: the main colour, severely tinted. */
export const IDLE_FILL = 0.2
/** The thin vertical of a spawn. */
const TICK_W = 0.75
const TICK_OPACITY = 0.6
/** The spawn tick of an agent that peaked at 200k or more: heavier and fully opaque. */
const DEEP_TICK_W = 1.5
const RUN_W = 2
const PAD_TOP = 1
/** A limit refusal on a row: a red vertical from the top of the row to the baseline. */
const REFUSAL_W = 1.25

/** The colour a span is drawn in: the Session page's, by kind; a branched session is the main colour. */
export const spanColor = (k: OverviewSpan['kind']): string =>
  k === 'session-fork' || k === 'continuation'
    ? COLOR.main
    : k === 'teammate'
      ? COLOR.addressable
      : k === 'fork'
        ? COLOR.fork
        : COLOR.subagent

// ---- the graph of a session row, and of the summary ----------------------------------------

export interface RowData {
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
  /** The times (ms) at which a limit refused this session's calls. */
  refusals?: readonly number[]
  /** The lockouts of the session's harness: drawn behind the row, over the session's life only. */
  lockouts?: readonly LockoutSpan[]
}

export const laneData = (
  l: OverviewLane,
  refusals?: readonly number[],
  lockouts?: readonly LockoutSpan[],
): RowData => ({
  refusals,
  lockouts,
  lives: [l],
  ctx: l.context,
  idle: l.idle,
  active: l.active,
  offset: l.slot0,
  spans: l.spans,
  lane: l,
})

export function RowGraph({ data, axis, pxPerTok }: { data: RowData; axis: Axis; pxPerTok: number }) {
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
  const refused = useMemo(() => (data.refusals ? refusalTicks(data.refusals, axis) : []), [data.refusals, axis])
  const life = useMemo(
    () => (data.lane ? lifeSpan(data.lane.startedAt, data.lane.lastActivityAt, axis) : null),
    [data.lane, axis],
  )

  // the lockouts, cut to the session's life: a session merely open in the same hours does not turn red
  const locked = useMemo(() => {
    const l = data.lane
    if (!l || !life || !data.lockouts?.length) return []
    const a = Date.parse(l.startedAt ?? '')
    const b = l.lastActivityAt ? Date.parse(l.lastActivityAt) : a
    return data.lockouts.flatMap((s) => {
      const x0 = Math.max(life[0], xOf(axis, Math.max(s.fromMs, a)))
      const x1 = Math.min(life[1], xOf(axis, Math.min(s.toMs, b)))
      return x1 > x0 ? [[x0, x1] as const] : []
    })
  }, [data.lane, data.lockouts, life, axis])

  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decoration; the row's text is the content
    <svg width={axis.width} height={height} className="pointer-events-none block select-none" aria-hidden>
      {locked.map(([x0, x1]) => (
        <rect key={x0} x={x0} y={0} width={x1 - x0} height={base} fill="var(--bad-soft)" />
      ))}
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
      {refused.length > 0 && (
        <path
          d={refused.map((x) => `M${x},0V${base}`).join('')}
          stroke="var(--bad)"
          strokeWidth={REFUSAL_W}
          fill="none"
        />
      )}
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
            {ks.deepTicks.length > 0 && (
              <path
                d={ks.deepTicks.map((x) => `M${x},${base}V${laneY}`).join('')}
                stroke={color}
                strokeWidth={DEEP_TICK_W}
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

/**
 * The text line of a row, in the session column: the harness mark, a bold head and a muted description on the
 * left (cut with an ellipsis, the whole text in the title; they give way to the folder) and the folder, always
 * printed, at the very right.
 */
export function SessionText({
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
export function FolderCell({ text, path, command }: { text: string; path: string; command: string }) {
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
