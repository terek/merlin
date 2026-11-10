// The spend graph's time view (timeline.ts has the numbers): wall-clock time across, a row per lane.
//
//   a row      the context of every call of its agent as an area above a baseline, on one token
//              scale for every row (a row is as tall as its largest context needs), and below the
//              baseline what it spent per slot of time, on one dollar scale for every row
//   held       a dotted line where an agent kept its context over a pause (its cache going cold), up
//              to the call that went on with it: strong while its turn or piece of work still ran
//              (waiting on a tool or an agent), faint between them (waiting for a message), with a
//              light tint under it (the context carried); the area always stops at the end of a turn
//              or a piece of work
//   marks      a diamond is a cache miss, a vertical mark a compaction (red on a cold cache)
//   main rows  the session's line: one continuous stretch of the baseline from its first moment to its
//              last (idle and breaks included), as heavy as the tier of the model in effect, over a
//              faint axis; a tick and number per turn;
//              the model's name where it changes; a dot for every prompt a person typed (hollow
//              if typed while a turn ran); a bracket with the total over each decision, its start reaching
//              down to the dot
//   agents     one light frame over an agent's work (its start down to the baseline, its top, a stem
//              at its end); an addressable agent keeps a row of its own, the others share rows when they
//              do not overlap
//   spines     from the baseline of the row that launched an agent (a fork, which takes the whole context,
//              forks the line: its elbow as heavy as the agent, what it copied hatched in its row; a clean
//              agent: thin and dimmed), an elbow onto its baseline, and along it over its
//              life, weighted by model tier, faint, full for the work in focus; the reports of that
//              work are dashed lines to the turns they came in
//   breaks     time in which nothing ran is squeezed into a narrow band, with its length on the axis
//   overhead   under a session's rows, a hatched band over each reported window for what the harness
//              reported and no message explains: labelled with its dollars, on no scale, as it belongs
//              to the whole window and not to any slot, turn or agent in it
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { SessionKey } from '../../api/types'
import { callLine, idleText } from '../../lib/compaction'
import { formatDuration, formatMoney, formatTokens } from '../../lib/format'
import { modelLabel } from '../../lib/models'
import {
  AXIS_H,
  BRACKET_H,
  buildFrame,
  dollarScale,
  type FrameRow,
  OVER_GAP,
  OVER_H,
  SLOT_PX,
  windowRow,
} from './layout'
import { DECISION_TINT_OPACITY, TURN_TINT_OPACITY } from './marks'
import { KIND_SERIES, type KindKey, missText, type Unit } from './model'
import type { Pin, UnitRef } from './SpendGraph'
import {
  addCall,
  barSpan,
  bracketed,
  branchRole,
  branchWeight,
  carrierWeight,
  clockTicks,
  detailAt,
  findSwarms,
  HOLD_MS,
  inheritedContext,
  type Lane,
  mergeBusy,
  modelMarks,
  type Point,
  pointAt,
  pxPerTurn,
  type Row,
  sliceWindow,
  slotLength,
  slotText,
  splitHeld,
  swarmOfUnit,
  TIER_WEIGHT,
  type Timeline,
  type TurnSpan,
  tierSegments,
  timeAxis,
  turnPlace,
  type Win,
} from './timeline'
import { type Overhead, shortTitle, type Tree } from './tree'
import { useWidth } from './useWidth'

/** How strongly a break's veil covers what crosses it: the page colour over the lines, so that they fade but stay visible. */
export const BREAK_VEIL = 0.6
/** The dots of a break on the time axis. */
export const BREAK_DOTS = '1 2'

/** Room left of the plot for the context scale. */
const LABEL_W = 34
/** Where a row's zero line starts: halfway into the gutter of the token scale, under its labels. */
const ZERO_X = LABEL_W / 2 + 3
const MR = 12
/** A spend bar is drawn at least this wide, centred on its calls. */
const BAR_MIN_PX = 2

export const COLOR: Record<KindKey | 'main', string> = {
  ...(Object.fromEntries(KIND_SERIES.map((s) => [s.key, s.color])) as Record<KindKey, string>),
}

/** Whether a run of points holds the point `p` (the run may start earlier, at the start of its turn or piece of work). */
const holds = (run: readonly Point[], p: Point | undefined) => !!p && p.t >= run[0].t && p.t <= run[run.length - 1].t

/** The radius of the elbow where a spine turns from the sender's row onto its own baseline. */
export const ELBOW_R = 6
/** A spine at rest; at full strength for the work in focus. */
export const SPINE_OPACITY = 0.35
/** The vertical part of a spine, whatever the weight of its horizontal part. */
export const SPINE_W = 1.25

/** How strongly the context an agent carries over a pause is tinted, under its dotted line. */
export const HELD_TINT = 0.08
/** The context area's fill and outline. */
export const CTX_FILL = 0.22
export const CTX_LINE = 1.25
/** The dotted line of held context: strong while a turn or piece of work ran, faint between. */
export const HELD_LINE = {
  strong: { opacity: 1, width: 1.5, dash: '1.5 2.5' },
  faint: { opacity: 0.4, width: 1.25, dash: '1.5 4' },
}
/** A compaction's mark: solid on a cold cache, dashed otherwise. */
export const COMPACT_MARK = {
  cold: { width: 2, dash: undefined as string | undefined },
  warm: { width: 1.5, dash: '3 2' },
}
/** A cache miss's diamond: its side and colour. */
export const MISS_SIZE = 8
export const MISS_COLOR = 'var(--series-5)'
/** The spend per slot under a baseline: one quiet grey; only a cache miss is coloured. */
export const SPEND_COLOR = 'var(--muted)'
/** A person's message: the dot's radius. */
export const DOT_R = 2.8
/** The dash of a report's line. */
export const REPORT_DASH = '2 2'
/** How strongly an agent's frame is drawn. */
export const FRAME_OPACITY = 0.55
/** The dash of a workflow's frame. */
export const WORKFLOW_DASH = '4 2'

/** The chip on the frame of a swarm: "+" on a collapsed one, "−" on the first agent of an expanded one. */
export const CHIP = 12

const f1 = (n: number) => n.toFixed(1)
const ms = (s: string | undefined) => (s ? Date.parse(s) : Number.NaN)
export const markColor = (call: { cache: string } | undefined) =>
  call?.cache === 'cold' ? 'var(--bad)' : call ? 'var(--warn)' : 'var(--faint)'

const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dateOf = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' })

/** A vertical from `y0` down (or up) to the baseline `y1`, turning right with a rounded elbow. */
export function elbowPath(x: number, y0: number, y1: number) {
  const r = Math.min(ELBOW_R, Math.abs(y1 - y0))
  const d = y1 >= y0 ? 1 : -1
  return `M${f1(x)} ${f1(y0)}V${f1(y1 - d * r)}Q${f1(x)} ${f1(y1)} ${f1(x + r)} ${f1(y1)}`
}

/** The hatching of the overhead bands, as a pattern. */
export function OverheadPattern({ id }: { id: string }) {
  return (
    <pattern id={id} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1={0} y1={0} x2={0} y2={5} stroke="var(--muted)" strokeWidth={1.25} strokeOpacity={0.55} />
    </pattern>
  )
}

/** The hatching of the context a fork copied, in its parent's colour. */
export function InheritPattern({ id, color }: { id: string; color: string }) {
  return (
    <pattern id={id} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1={0} y1={0} x2={0} y2={4} stroke={color} strokeWidth={1.1} strokeOpacity={0.6} />
    </pattern>
  )
}

/** A small triangle at an edge of the plot, pointing out of it: the line goes on beyond the window. */
const edgeChevron = (x: number, y: number, side: 'l' | 'r') =>
  side === 'l'
    ? `M${f1(x + 4)} ${f1(y - 4)}L${f1(x)} ${f1(y)}L${f1(x + 4)} ${f1(y + 4)}Z`
    : `M${f1(x - 4)} ${f1(y - 4)}L${f1(x)} ${f1(y)}L${f1(x - 4)} ${f1(y + 4)}Z`

/**
 * Consecutive points with no pause longer than HOLD_MS between them, and none of the times in
 * `starts` (where a turn or a piece of work starts) either. A run that follows a start begins at it:
 * a call is written when its answer is, so the first one was sent with that context from the start
 * on (unless it came more than HOLD_MS later, as when the prompt failed and was sent again).
 */
function runsOf(points: readonly Point[], starts: readonly number[] = []): Point[][] {
  const out: Point[][] = []
  for (const p of points) {
    const run = out[out.length - 1]
    const prev = run?.[run.length - 1]
    const start = starts.findLast((c) => c <= p.t && (!prev || c > prev.t))
    if (prev && p.t - prev.t <= HOLD_MS && start === undefined) run.push(p)
    else
      out.push(start !== undefined && start < p.t && p.t - start <= HOLD_MS ? [{ t: start, tokens: p.tokens }, p] : [p])
  }
  return out
}

/** A row of the frame with what the window shows in it: `row` holds the window's slice of each lane, `full` the whole session's. */
interface Layout extends FrameRow {
  full: Row
  /** Whether the row's session (or agents) have anything in the window. */
  live: boolean
}

export interface TimePlotProps {
  tree: Tree
  /** The tree's timeline, every day of it. */
  timeline: Timeline
  /** The window of time to show, of a tree too long for one view. */
  range: Win | undefined
  pinned: Pin | null
  cursor: Pin | undefined
  selectedUnit: UnitRef | null
  hoverUnit: UnitRef | null
  onCursor: (p: Pin | null) => void
  onHoverUnit: (u: UnitRef | null) => void
  onPin: (p: Pin | null) => void
  onSelectUnit: (u: UnitRef) => void
  onKey: (e: KeyboardEvent<HTMLDivElement>) => void
  /** The turn or piece of work under the cursor, pinned or selected (lines under the pointer's own); null if none. */
  turnLines: ReactNode
  /** The session the page is about: its main row is marked "this session". */
  current?: SessionKey
}

/** Where a branch leaves its parent's row: a dot (a fork, with the context it copied), a ring (a continuation). */
export const NODE_R = 4.5
export function BranchNode({
  x,
  y,
  color,
  ring = false,
  tip,
}: {
  x: number
  y: number
  color: string
  ring?: boolean
  tip?: string
}) {
  return (
    <circle
      cx={x}
      cy={y}
      r={NODE_R}
      fill={ring ? 'var(--surface)' : color}
      stroke={ring ? color : 'var(--surface)'}
      strokeWidth={ring ? 1.75 : 2}
      pointerEvents={tip ? 'all' : 'none'}
    >
      {tip && <title>{tip}</title>}
    </circle>
  )
}

export function TimePlot({
  tree,
  timeline,
  range,
  pinned,
  cursor,
  selectedUnit,
  hoverUnit,
  onCursor,
  onHoverUnit,
  onPin,
  onSelectUnit,
  onKey,
  turnLines,
  current,
}: TimePlotProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const [px, setPx] = useState<{ x: number; row: number } | null>(null)
  const [band, setBand] = useState<{ branch: number; k: number } | null>(null)
  const hatch = `hatch${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  const tl = useMemo(() => (range ? sliceWindow(timeline, range) : timeline), [timeline, range])
  // the overhead windows of the day
  const overheads = useMemo(
    () => tree.branches.map((b) => b.overhead.filter((o) => o.t1 >= tl.t0 && o.t0 <= tl.t1)),
    [tree, tl],
  )
  const X0 = LABEL_W
  const X1 = Math.max(X0 + 80, width - MR)
  const axis = useMemo(() => timeAxis(tl.spans, X0, X1), [tl, X1])
  // swarms (found on the whole timeline, so that a window keeps their ids) are one row each until opened
  const swarms = useMemo(() => findSwarms(timeline.lanes), [timeline])
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o)
      if (!n.delete(id)) n.add(id)
      return n
    })
  // a piece of work selected on the page opens the swarm it is in
  useEffect(() => {
    const sw = selectedUnit ? swarmOfUnit(timeline.lanes, swarms, selectedUnit.branch, selectedUnit.id) : undefined
    if (sw) setOpen((o) => (o.has(sw.id) ? o : new Set(o).add(sw.id)))
  }, [selectedUnit, timeline, swarms])
  // the vertical frame, of the whole session: it does not move with the window
  const frame = useMemo(
    () =>
      buildFrame(
        timeline,
        swarms,
        open,
        X0,
        X1,
        tree.branches.map((b) => b.overhead.length > 0),
      ),
    [timeline, swarms, open, X1, tree],
  )
  const { strips, height, cTicks, kCtx } = frame
  // the y-ranges a break's veil covers: the rows, never an overhead strip (cut around each one)
  const veilSpans: [number, number][] = []
  {
    let y = AXIS_H - 6
    for (const s of strips) {
      if (s.top > y) veilSpans.push([y, s.top])
      y = Math.max(y, s.bottom)
    }
    if (height > y) veilSpans.push([y, height])
  }
  // what the window shows in each row of it
  const layout = useMemo(() => {
    const sliced = new Map(tl.lanes.map((l) => [l.key, l]))
    return frame.layout.map((g): Layout => {
      const w = windowRow(g.row, sliced, swarms)
      return { ...g, row: w.row, full: g.row, live: w.live }
    })
  }, [frame, tl, swarms])
  const rows = useMemo(() => layout.map((g) => g.row), [layout])
  const slot = slotLength(axis, SLOT_PX)

  // ---- the spend per slot of every row, on one dollar scale
  const slots = useMemo(
    () =>
      rows.map((r) => {
        const m = new Map<number, Record<string, number>>()
        for (const l of r.lanes)
          for (const c of l.calls) {
            const k = Math.floor(c.t / slot)
            const s = m.get(k) ?? {}
            addCall(s, c)
            s.miss = (s.miss ?? 0) + c.reread
            m.set(k, s)
          }
        return m
      }),
    [rows, slot],
  )
  // where each bar is drawn: over the part of its slot in which the row was running, not all of it
  const bars = useMemo(
    () =>
      rows.map((r) => {
        const busy = mergeBusy(
          r.lanes.flatMap((l) =>
            l.main ? l.turns : l.units.map((u) => ({ t0: u.startMs, t1: Math.max(u.startMs, u.endMs) })),
          ),
        )
        const times = new Map<number, number[]>()
        for (const l of r.lanes)
          for (const c of l.calls) {
            const k = Math.floor(c.t / slot)
            const a = times.get(k)
            if (a) a.push(c.t)
            else times.set(k, [c.t])
          }
        const out = new Map<number, [number, number]>()
        for (const [k, ts] of times) out.set(k, barSpan([k * slot, (k + 1) * slot], ts, busy, BAR_MIN_PX / axis.scale))
        return out
      }),
    [rows, slot, axis],
  )
  const maxSlot = Math.max(1e-9, ...slots.flatMap((m) => [...m.values()].map((s) => s.total)))
  // the window's own dollar scale: the largest at which every row's bars fit the band it has
  const kUsd = dollarScale(
    layout,
    slots.map((m) => Math.max(0, ...[...m.values()].map((s) => s.total))),
  )
  // how much room a turn has on the main row(s) decides how much of the turns and decisions is drawn
  const detail = detailAt(
    Math.min(
      Number.POSITIVE_INFINITY,
      ...rows.filter((r) => r.main).map((r) => pxPerTurn(r.lanes[0].turns.map((s) => axis.x(s.t0)))),
    ),
  )
  const yCtx = (g: Layout, v: number) => g.base - v * kCtx

  // ---- who is where
  const mainRow = (branch: number) => layout.find((g) => g.row.main && g.row.branch === branch)
  const laneByName = new Map<string, { g: Layout; l: Lane }>()
  for (const g of layout) for (const l of g.full.lanes) if (l.agent?.name) laneByName.set(l.agent.name, { g, l })
  /** The row and lane that sent a piece of work: the one its inbox names, else its branch's main row. */
  const senderOf = (l: Lane, u: Unit): { g: Layout; l: Lane } | undefined => {
    const named = u.from ? laneByName.get(u.from) : undefined
    if (named) return named
    const g = mainRow(l.branch)
    return g ? { g, l: g.row.lanes[0] } : undefined
  }
  // a lane's context before the window cut it: where a fork branches from
  const fullLane = new Map(timeline.lanes.map((l) => [l.key, l]))
  const ownPoints = (key: string) => fullLane.get(key)?.series.find((x) => x.own)?.points ?? []
  /** When a forked session left its parent: the end of the last turn it copied (a continuation: when it began). */
  const forkMoment = (branch: number): number => {
    const b = tree.branches[branch]
    const link = b.detail.lineage.parent
    const next = b.parent !== undefined && link ? tree.branches[b.parent].model.cols[link.atTurn + 1] : undefined
    const t = ms(next?.turn.startedAt)
    return Number.isFinite(t) ? t - 1 : Number.POSITIVE_INFINITY
  }
  /** What a fork copied from its parent, and the parent's colour: the part of its first context that is not its own. */
  const inheritOf = (l: Lane): { tokens: number; color: string } | undefined => {
    const own = ownPoints(l.key)
    if (own.length === 0) return undefined
    if (l.main) {
      const b = tree.branches[l.branch]
      if (b.parent === undefined || b.kind !== 'fork') return undefined
      const tokens = inheritedContext(ownPoints(`${b.parent}/main`), forkMoment(l.branch), own[0].tokens)
      return tokens > 0 ? { tokens, color: COLOR.main } : undefined
    }
    const u = l.units[0]
    const from = l.kind === 'fork' && u && !u.woken ? senderOf(l, u) : undefined
    const tokens = from ? inheritedContext(ownPoints(from.l.key), u.startMs, own[0].tokens) : 0
    return from && tokens > 0 ? { tokens, color: COLOR[from.l.kind] } : undefined
  }
  const unitRef = (l: Lane, u: Unit): UnitRef => ({ branch: l.branch, id: u.id })
  const isOn = (l: Lane, u: Unit) => [hoverUnit, selectedUnit].some((r) => r && r.branch === l.branch && r.id === u.id)
  // a turn of no width can still be hovered
  const slackMs = 3 / axis.scale
  /** The turn running at `t`; none between two turns. */
  const turnOn = (l: Lane | undefined, t: number): Pin | null => {
    const p = l ? turnPlace(l.turns, t, slackMs) : undefined
    return l && p && 'turn' in p ? { branch: l.branch, col: p.turn.col.index } : null
  }
  /** When each of a unit's reports came in: the start of the turn it began. */
  const arrivals = (u: Unit) => {
    const b = tree.branches.find((x) => x.model.units.includes(u))
    return u.reports
      .map((r) => ms(b?.model.cols[r]?.turn.startedAt))
      .filter((t) => Number.isFinite(t) && (range || (t >= tl.t0 && t <= tl.t1)))
  }
  const overX = (o: Overhead): [number, number] => {
    const a = axis.x(Math.max(o.t0, tl.t0))
    return [a, Math.max(a + 3, axis.x(Math.min(o.t1, tl.t1)))]
  }
  const uX = (u: Unit): [number, number] => {
    const a = axis.x(u.startMs)
    return [a, Math.max(a + 3, axis.x(Number.isFinite(u.endMs) ? u.endMs : u.startMs))]
  }

  /** Where a swarm lane's frame is, left to right (with its chip to the left of it). */
  const frameX = (l: Lane): [number, number] => {
    const xs = l.units.map(uX)
    return [Math.min(...xs.map(([a]) => a)), Math.max(...xs.map(([, b]) => b))]
  }
  const chipX = (l: Lane) => Math.max(X0, frameX(l)[0] - CHIP - 3)
  /** The collapsed swarm lane of row `k` under `x`, over its frame and its chip. */
  const swarmAt = (k: number, x: number): Lane | undefined =>
    layout[k]?.row.lanes.find((l) => {
      if (!l.swarm?.collapsed) return false
      return x >= chipX(l) && x <= frameX(l)[1] + 4
    })
  /** The collapsed swarm under the pointer. */
  const hot = px ? swarmAt(px.row, px.x) : undefined
  /** The expanded swarm whose collapse chip is at (x, y) of row `k`. */
  const chipAt = (k: number, x: number, yy: number): string | undefined => {
    const g = layout[k]
    const l = g?.row.lanes.find((m) => m.swarm && !m.swarm.collapsed && m.swarm.first)
    return l && x >= chipX(l) && x <= chipX(l) + CHIP && yy >= g.top && yy <= g.top + CHIP + 2 ? l.swarm?.id : undefined
  }

  // ---- the pointer
  const hit = (clientX: number, clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const x = clientX - r.left
    const yy = clientY - r.top
    if (x < X0 - 4 || x > X1 + 4) return null
    if (strips.some((s) => yy >= s.top - OVER_GAP / 2 && yy <= s.bottom + 2)) return null
    const k = layout.findIndex((g, i) => yy < g.bottom + (layout[i + 1] ? (layout[i + 1].top - g.bottom) / 2 : 99))
    if (k < 0) return null
    return { x, row: k, t: axis.t(x) }
  }
  const read = (h: { x: number; row: number; t: number }) => {
    const g = layout[h.row]
    if (g.row.main) {
      return { pin: turnOn(g.row.lanes[0], h.t), unit: null }
    }
    // a collapsed swarm is read as a whole
    if (swarmAt(h.row, h.x)) return { pin: turnOn(mainRow(g.row.branch)?.row.lanes[0], h.t), unit: null }
    // the piece of work under the pointer, or the nearest within a few pixels
    let best: { lane: Lane; unit: Unit; d: number } | undefined
    for (const l of g.row.lanes)
      for (const u of l.units) {
        const [a, b] = uX(u)
        const d = h.x < a ? a - h.x : h.x > b ? h.x - b : 0
        if (d <= 6 && (!best || d < best.d)) best = { lane: l, unit: u, d }
      }
    if (!best) return { pin: null, unit: null }
    return { pin: turnOn(mainRow(best.lane.branch)?.row.lanes[0], h.t), unit: unitRef(best.lane, best.unit) }
  }
  /** The overhead band under the pointer. */
  const bandAt = (clientX: number, clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const x = clientX - r.left
    const yy = clientY - r.top
    const s = strips.find((s) => yy >= s.top - 2 && yy <= s.bottom + 2)
    const k = s
      ? overheads[s.branch].findIndex((o) => {
          const [a, b] = overX(o)
          return x >= a - 3 && x <= b + 3
        })
      : -1
    return s && k >= 0 ? { branch: s.branch, k } : null
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    setBand(bandAt(e.clientX, e.clientY, e.currentTarget))
    const h = hit(e.clientX, e.clientY, e.currentTarget)
    setPx(h ? { x: h.x, row: h.row } : null)
    const r = h ? read(h) : { pin: null, unit: null }
    onCursor(r.pin)
    onHoverUnit(r.unit)
  }

  // the crosshair: the pointer, or the turn the keyboard is on
  const crossX =
    px?.x ??
    (cursor
      ? (() => {
          const l = mainRow(cursor.branch)?.row.lanes[0]
          const s = l?.turns.find((x) => x.col.index === cursor.col)
          return s ? axis.x(s.t0) : undefined
        })()
      : undefined)
  const crossT = crossX !== undefined ? axis.t(crossX) : undefined

  // ---- drawing helpers
  const area = (g: Layout, run: Point[]) => {
    const pts = run.map((p, i) => {
      const x = f1(axis.x(p.t))
      const prev = run[i - 1]
      return `${prev ? `L${x} ${f1(yCtx(g, prev.tokens))}` : ''}L${x} ${f1(yCtx(g, p.tokens))}`
    })
    const xa = axis.x(run[0].t)
    const xb = Math.max(axis.x(run[run.length - 1].t), xa + 1.5)
    const yl = f1(yCtx(g, run[run.length - 1].tokens))
    return `M${f1(xa)} ${g.base}${pts.join('')}L${f1(xb)} ${yl}L${f1(xb)} ${g.base}Z`
  }
  const line = (g: Layout, run: Point[]) =>
    run
      .map((p, i) => {
        const x = f1(axis.x(p.t))
        const prev = run[i - 1]
        return prev
          ? `L${x} ${f1(yCtx(g, prev.tokens))}L${x} ${f1(yCtx(g, p.tokens))}`
          : `M${x} ${f1(yCtx(g, p.tokens))}`
      })
      .join('')

  const colors = [...new Set(Object.values(COLOR))]
  const hatchOf = (color: string) => `url(#${hatch}-${colors.indexOf(color)})`
  // text a break's veil must not fade: the labels written on rows are drawn after it
  const labels: ReactNode[] = []
  const drawLane = (g: Layout, l: Lane) => {
    const color = COLOR[l.kind]
    const inherited = inheritOf(l)
    const own = l.series.find((s) => s.own)
    // an agent waits between its turns or pieces of work (for a message), however short the wait
    const starts = l.main ? l.turns.map((t) => t.t0) : l.units.map((u) => u.startMs)
    const runs = own
      ? runsOf(
          own.points,
          starts.toSorted((a, b) => a - b),
        )
      : []
    const top = g.row.main ? g.top + BRACKET_H : g.top
    // what the agent was busy with: a main agent's turns, a one-shot agent's piece of work; an addressable agent's whole life, so that the
    // context it holds between its pieces of work joins them as strongly as a main agent's turns do
    const busy: { t0: number; t1: number }[] = l.main
      ? l.turns
      : l.kind === 'addressable' && Number.isFinite(l.t0)
        ? [{ t0: l.t0, t1: l.t1 }]
        : l.units
            .filter((u) => Number.isFinite(u.startMs))
            .map((u) => ({ t0: u.startMs, t1: Math.max(u.startMs, u.endMs) }))
    return (
      <g key={l.key}>
        {/* the agent's work: one light frame over all of it, as over a decision (its start down to the
            baseline, its top, a stem at its end), with its top heavier over the piece hovered or selected */}
        {l.units.length > 0 &&
          (() => {
            const xs = l.units.map(uX)
            const a = Math.min(...xs.map(([x]) => x))
            const b = Math.max(...xs.map(([, x]) => x))
            const dash = l.agent?.kind === 'workflow' ? WORKFLOW_DASH : undefined
            const label = l.title
            // an agent that left no record has no spend to print: $0 would be a claim
            const cost = l.agent?.unrecorded ? 'not recorded' : formatMoney(l.usd)
            const room = b - a - (l.kind === 'fork' ? 9 : 4) - 4
            // name · cost at the top left, the cost dropped first when room is short; the model bottom left, just
            // above the baseline, clear of the elbow that comes in from the sender
            const fits = (s: string) => room >= s.length * 5.6
            const withCost = [label, cost].filter(Boolean).join(' · ')
            const modelText = l.swarm?.collapsed ? l.swarm.modelText : l.model && modelLabel(l.model)
            const withModel = [label, modelText, cost].filter(Boolean).join(' · ')
            const text = fits(withCost) ? withCost : fits(label) ? label : ''
            const modelX = a + ELBOW_R + 2
            // always, where the frame is wide enough: above the baseline where the lane is tall enough not to run
            // into the top label, else just under it, over the quiet spend lines
            const modelFits = !!modelText && b - modelX - 2 >= modelText.length * 4.9
            const modelY = g.base - top >= (text ? 27 : 18) ? g.base - 6 : g.base + 9
            // a label left out (or the model, which is not in the top one) is still in the frame's tooltip
            const tip = text !== withModel || !modelFits
            if (text)
              labels.push(
                <text
                  key={`t${l.key}`}
                  x={a + (l.kind === 'fork' ? 9 : 4)}
                  y={top + 10}
                  fontSize={9.5}
                  fill="var(--muted)"
                  stroke="var(--surface)"
                  strokeWidth={3}
                  paintOrder="stroke"
                  pointerEvents="none"
                >
                  {text}
                </text>,
              )
            if (modelFits)
              labels.push(
                <text
                  key={`m${l.key}`}
                  x={modelX}
                  y={modelY}
                  fontSize={9}
                  fill="var(--muted)"
                  stroke="var(--surface)"
                  strokeWidth={3}
                  paintOrder="stroke"
                  pointerEvents="none"
                >
                  {modelText}
                </text>,
              )
            return (
              <g>
                <path
                  d={`M${f1(a)} ${g.base}V${top}H${f1(b)}V${top + 4}`}
                  fill="none"
                  stroke={color}
                  strokeOpacity={FRAME_OPACITY}
                  strokeWidth={1}
                  strokeDasharray={dash}
                />
                {l.units.map(
                  (u, k) =>
                    isOn(l, u) && (
                      <line
                        key={u.id}
                        x1={xs[k][0]}
                        x2={xs[k][1]}
                        y1={top}
                        y2={top}
                        stroke={color}
                        strokeWidth={3}
                        strokeDasharray={dash}
                      />
                    ),
                )}
                {tip && (
                  // a part of the label is not on the frame: the whole of it is the frame's tooltip
                  <rect
                    x={f1(a)}
                    y={top}
                    width={Math.max(4, b - a)}
                    height={Math.max(0, g.base - top)}
                    fill="transparent"
                  >
                    <title>{withModel}</title>
                  </rect>
                )}
                {l.kind === 'fork' && <path d={`M${f1(a)} ${top}h7l-7 7z`} fill={color} />}
                {l.swarm && (l.swarm.collapsed || l.swarm.first) && (
                  <g>
                    <rect
                      x={chipX(l)}
                      y={top + 1}
                      width={CHIP}
                      height={CHIP}
                      rx={3}
                      fill="var(--surface)"
                      stroke={color}
                      strokeOpacity={0.7}
                    />
                    <path
                      d={`M${f1(chipX(l) + 3)} ${top + 1 + CHIP / 2}h${CHIP - 6}${l.swarm.collapsed ? `M${f1(chipX(l) + CHIP / 2)} ${top + 4}v${CHIP - 6}` : ''}`}
                      stroke={color}
                      strokeWidth={1.25}
                      fill="none"
                    />
                    <title>
                      {l.swarm.collapsed ? `show the ${l.swarm.count} agents` : 'fold the swarm into one row'}
                    </title>
                  </g>
                )}
              </g>
            )
          })()}
        {/* the context: an area while the agent works, dotted while it holds it over a pause */}
        {runs.map((run, i) => (
          <g key={run[0].t}>
            {/* a fork's first context starts with the part it copied from its parent: hatched in the parent's colour */}
            {i === 0 && inherited && holds(run, ownPoints(l.key)[0]) && (
              <rect
                x={axis.x(run[0].t)}
                y={yCtx(g, inherited.tokens)}
                width={Math.max(1.5, axis.x(run[run.length - 1].t) - axis.x(run[0].t))}
                height={g.base - yCtx(g, inherited.tokens)}
                fill={hatchOf(inherited.color)}
              >
                <title>{`${formatTokens(inherited.tokens)} of context copied from the parent`}</title>
              </rect>
            )}
            <path d={area(g, run)} fill={color} fillOpacity={CTX_FILL} />
            <path d={line(g, run)} fill="none" stroke={color} strokeWidth={CTX_LINE} strokeLinejoin="round" />
            {runs[i + 1] && (
              <g>
                <title>{`${formatTokens(run[run.length - 1].tokens)} of context held for ${formatDuration(runs[i + 1][0].t - run[run.length - 1].t)}`}</title>
                {/* the context carried over the pause, lighter than where it was in use */}
                <rect
                  x={axis.x(run[run.length - 1].t)}
                  y={yCtx(g, run[run.length - 1].tokens)}
                  width={Math.max(0, axis.x(runs[i + 1][0].t) - axis.x(run[run.length - 1].t))}
                  height={g.base - yCtx(g, run[run.length - 1].tokens)}
                  fill={color}
                  fillOpacity={HELD_TINT}
                />
                {splitHeld(run[run.length - 1].t, runs[i + 1][0].t, busy).map((p) => (
                  <line
                    key={p.t0}
                    x1={axis.x(p.t0)}
                    x2={axis.x(p.t1)}
                    y1={yCtx(g, run[run.length - 1].tokens)}
                    y2={yCtx(g, run[run.length - 1].tokens)}
                    stroke={color}
                    strokeOpacity={(p.busy ? HELD_LINE.strong : HELD_LINE.faint).opacity}
                    strokeWidth={(p.busy ? HELD_LINE.strong : HELD_LINE.faint).width}
                    strokeDasharray={(p.busy ? HELD_LINE.strong : HELD_LINE.faint).dash}
                    strokeLinecap="round"
                  />
                ))}
              </g>
            )}
          </g>
        ))}
        {/* a collapsed swarm: the largest context of its agents, lightly filled; each agent's own is a thin line */}
        {l.swarm?.collapsed && l.swarm.envelope.length > 0 && (
          <path d={area(g, l.swarm.envelope)} fill={color} fillOpacity={0.12} />
        )}
        {/* its own sub-agents' contexts */}
        {l.series
          .filter((s) => !s.own)
          .flatMap((s) =>
            runsOf(s.points).map((run) => (
              <path
                key={`${s.agentId}/${run[0].t}`}
                d={line(g, run)}
                fill="none"
                stroke={color}
                strokeWidth={1}
                strokeOpacity={l.swarm?.collapsed ? 0.35 : 0.6}
              />
            )),
          )}
        {l.compactions.map((c) => {
          const x = axis.x(c.t)
          const pre = c.compaction.preTokens
          const cold = c.compaction.call?.cache === 'cold'
          return (
            <line
              key={`${c.agent?.id ?? ''}${c.compaction.at}`}
              x1={x}
              x2={x}
              y1={pre ? Math.max(top - 2, yCtx(g, pre) - 4) : top}
              y2={g.base}
              stroke={markColor(c.compaction.call)}
              strokeWidth={(cold ? COMPACT_MARK.cold : COMPACT_MARK.warm).width}
              strokeDasharray={(cold ? COMPACT_MARK.cold : COMPACT_MARK.warm).dash}
            >
              <title>
                {`compaction${c.agent ? ` of ${c.agent.name ?? c.agent.kind}` : ''}${pre ? ` at ${formatTokens(pre)}` : ''}${c.compaction.postTokens ? ` → ${formatTokens(c.compaction.postTokens)}` : ''}${c.compaction.call ? `: ${callLine(c.compaction.call, !!c.compaction.messageId)}` : ''}`}
              </title>
            </line>
          )
        })}
        {l.misses.map((m) => {
          const x = axis.x(m.t)
          const yy = yCtx(g, m.tokens)
          return (
            <rect
              key={`${m.t}/${m.reread.agentId ?? ''}`}
              x={x - MISS_SIZE / 2}
              y={yy - MISS_SIZE / 2}
              width={MISS_SIZE}
              height={MISS_SIZE}
              transform={`rotate(45 ${f1(x)} ${f1(yy)})`}
              fill={MISS_COLOR}
              stroke="var(--surface)"
              strokeWidth={1.5}
            >
              <title>{`cache miss: ${formatTokens(m.reread.tokens)} billed again ${missText(m.reread)}, ${formatMoney(m.reread.usd)}`}</title>
            </rect>
          )
        })}
      </g>
    )
  }

  const drawRow = (g: Layout) => {
    const main = g.row.main ? g.row.lanes[0] : undefined
    // the session's whole life, not the window's slice of it: its line runs through the window even where no turn does
    const whole = main && fullLane.get(main.key)
    const b = tree.branches[g.row.branch]
    // the decisions that get a bracket, and the turns drawn one by one
    const focusDec = (p: Pin | null | undefined) =>
      p && p.branch === g.row.branch ? b.model.cols[p.col]?.decision : undefined
    const shown = main
      ? bracketed(
          b.model.decisions.filter(
            (d) => d.usd > 0 && main?.turns.some((s) => s.col.index >= d.start && s.col.index <= d.end),
          ),
          detail,
          [focusDec(pinned), focusDec(cursor)],
        )
      : new Set<number>()
    const isFocusTurn = (c: number) => [pinned, cursor].some((p) => p && p.branch === g.row.branch && p.col === c)
    const turnsY = g.bottom - 3
    let lastTurnX = Number.NEGATIVE_INFINITY
    return (
      <g key={g.full.lanes[0].key}>
        {/* the decisions over a main row */}
        {main &&
          b.model.decisions.map((dec) => {
            const s0 =
              main.turns.find((s) => s.col.index === dec.start) ?? main.turns.find((s) => s.col.index >= dec.start)
            const s1 = [...main.turns].reverse().find((s) => s.col.index <= dec.end)
            if (!s0 || !s1 || dec.usd <= 0 || s1.col.index < s0.col.index || !shown.has(dec.index)) return null
            const xa = axis.x(s0.t0) + 1
            const xb = Math.max(xa + 3, axis.x(s1.t1) - 1)
            const yy = g.top + 12
            const held = pinned?.branch === g.row.branch && b.model.cols[pinned.col]?.decision === dec.index
            const on = held || (cursor?.branch === g.row.branch && b.model.cols[cursor.col]?.decision === dec.index)
            const text = formatMoney(dec.usd)
            if (xb - xa >= text.length * 6 + 4 || on)
              labels.push(
                <text
                  key={`d${dec.index}`}
                  x={(xa + xb) / 2}
                  y={yy - 3}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={on ? 600 : 400}
                  fill={on ? 'var(--text)' : 'var(--muted)'}
                  stroke="var(--surface)"
                  strokeWidth={3}
                  paintOrder="stroke"
                  pointerEvents="none"
                >
                  {text}
                </text>,
              )
            return (
              <g key={dec.index} pointerEvents="none">
                <path
                  d={`M${f1(axis.x(s0.t0))} ${g.base}V${yy}H${f1(xb)}V${yy + 3}`}
                  fill="none"
                  stroke={held ? 'var(--accent)' : on ? 'var(--text)' : 'var(--faint)'}
                  strokeWidth={held ? 3 : 1}
                />
              </g>
            )
          })}
        {g.row.lanes.map((l) => drawLane(g, l))}
        {/* where a main row's model changes (and where the window starts): its name, just above the baseline */}
        {main &&
          (() => {
            let end = Number.NEGATIVE_INFINITY
            const br = tree.branches[g.row.branch]
            const own = !!current && br.key.harness === current.harness && br.key.id === current.id
            const lead =
              tree.branches.length > 1 ? branchRole(br.kind, br.detail.lineage.parent?.atTurn, own) : undefined
            return modelMarks(main.runs, modelLabel).map((m, k) => {
              const x = axis.x(m.t) + 2
              if (x < end + 14) return null
              const role = k === 0 && lead ? `${lead} · ` : ''
              end = x + (role.length + m.text.length) * 4.9
              labels.push(
                <text
                  key={`mm${m.t}`}
                  x={x}
                  y={g.base - 6}
                  fontSize={9}
                  fill="var(--muted)"
                  stroke="var(--surface)"
                  strokeWidth={3}
                  paintOrder="stroke"
                  pointerEvents="none"
                >
                  {role && (
                    <tspan fill="var(--text)" fontWeight={600}>
                      {role}
                    </tspan>
                  )}
                  {m.text}
                </text>,
              )
              return null
            })
          })()}
        {/* a main session's line: one continuous stretch from its first moment to its last, as heavy as the model in effect (idle and breaks included) */}
        {whole &&
          Number.isFinite(whole.t0) &&
          Number.isFinite(whole.t1) &&
          tierSegments(whole.runs, whole.t0, whole.t1).map((sg, k, all) => {
            const x0 = Math.max(X0, axis.x(sg.t0))
            const x1 = Math.min(X1, k === all.length - 1 ? Math.max(axis.x(sg.t1), axis.x(sg.t0) + 1.5) : axis.x(sg.t1))
            if (!(x1 > x0)) return null
            return (
              <line
                key={sg.t0}
                pointerEvents="none"
                x1={x0}
                x2={x1}
                y1={g.base + 0.5}
                y2={g.base + 0.5}
                stroke={COLOR.main}
                strokeWidth={branchWeight(sg.tier)}
              />
            )
          })}
        {/* a main row's turns, and their numbers */}
        {main?.turns.map((s) => {
          const x = axis.x(s.t0)
          // in the band, only the turn in focus has a mark and a number of its own
          if (detail === 'band' && !isFocusTurn(s.col.index)) return null
          const label = detail === 'band' || x - lastTurnX >= String(s.col.index).length * 5.5 + 6
          if (label) lastTurnX = x
          return (
            <g key={s.col.index} pointerEvents="none">
              <line x1={x} x2={x} y1={g.base - 4} y2={g.base + 5} stroke="var(--text)" strokeWidth={1} />
              {label && (
                <text x={x} y={turnsY} textAnchor="middle" fontSize={9} fill="var(--faint)">
                  {s.col.index}
                </text>
              )}
            </g>
          )
        })}
        {/* a person's messages: a dot on the baseline, hollow for one typed while a turn ran */}
        {main?.turns.flatMap((s) =>
          [
            ...(s.col.human ? [{ t: s.t0, queued: false }] : []),
            // typed while the turn ran: it starts no turn, but it steered this one
            ...(s.col.turn.queued ?? [])
              .filter((q) => q.origin === 'human' || q.origin === 'command')
              .map((q) => ({ t: ms(q.at), queued: true })),
          ]
            .filter((m) => Number.isFinite(m.t))
            .map((m) => {
              const x = axis.x(m.t)
              return (
                <g key={`m${m.t}`} pointerEvents="none">
                  <circle
                    cx={x}
                    cy={g.base}
                    r={DOT_R}
                    fill={m.queued ? 'var(--surface)' : 'var(--text)'}
                    stroke={m.queued ? 'var(--text)' : 'var(--surface)'}
                    strokeWidth={m.queued ? 1.25 : 1}
                  />
                </g>
              )
            }),
        )}
      </g>
    )
  }

  // ---- spines, launches and reports between the rows
  // the work in focus: hovered or selected, or launched or reported in the turn under the cursor or pinned
  const focusTurns = [cursor, pinned].filter((p): p is Pin => !!p)
  const inFocus = (l: Lane, u: Unit) =>
    isOn(l, u) || focusTurns.some((p) => p.branch === l.branch && (u.launch === p.col || u.reports.includes(p.col)))
  /** A vertical from `y0` on the sender's row down (or up) to the baseline `y1`, turning right with an elbow. */
  const elbow = elbowPath
  /**
   * An agent's spine: from the sender's row at the moment of launch (a fork: from the top of the
   * parent's context then, a sub-agent: from its baseline) down, with an elbow, onto the agent's own
   * baseline, and along it for the agent's life, as heavy as the tier of the model it ran on.
   */
  const laneSpine = (g: Layout, l: Lane) => {
    const u0 = l.units.reduce<Unit | undefined>((m, u) => (!m || u.startMs < m.startMs ? u : m), undefined)
    const t0 = u0 && Number.isFinite(u0.startMs) ? u0.startMs : l.t0
    if (!Number.isFinite(t0)) return null
    const xa = axis.x(t0)
    const xb = Math.max(xa + 1.5, axis.x(l.t1))
    const early = range !== undefined && t0 < range.lo
    const from = u0 && !u0.woken && !early ? senderOf(l, u0) : undefined
    const color = COLOR[l.kind]
    // a fork carries its parent's context: structure, at full strength; a clean worker is light
    const on = l.kind === 'fork' || l.units.some((u) => inFocus(l, u)) || (!!hot && hot.key === l.key)
    // every agent leaves its sender's baseline; a fork takes the whole context and its elbow is as heavy as the agent
    const y0 = from && from.g !== g ? from.g.base : undefined
    const turn = y0 !== undefined ? Math.min(ELBOW_R, Math.abs(g.base - y0)) : 0
    return (
      <g key={`s${l.key}`} pointerEvents="none">
        {/* the spawn is light unless in focus; the agent's own line, as heavy as its model, is always drawn in full */}
        {y0 !== undefined && (
          <path
            d={elbow(xa, y0, g.base)}
            fill="none"
            opacity={on ? 1 : SPINE_OPACITY}
            stroke={color}
            strokeWidth={l.kind === 'fork' ? branchWeight(l.runs[0]?.tier) : SPINE_W}
            strokeLinecap="round"
          />
        )}
        {y0 !== undefined && l.kind === 'fork' && <BranchNode x={xa} y={y0} color={color} />}
        {tierSegments(l.runs, t0, l.t1).map((sg, k, all) => {
          const x0 = k === 0 ? xa + turn : axis.x(sg.t0)
          const x1 = Math.max(k === all.length - 1 ? xb : axis.x(sg.t1), x0)
          return (
            <line
              key={sg.t0}
              x1={x0}
              x2={x1}
              y1={g.base}
              y2={g.base}
              stroke={sg.tier === 'unknown' ? 'var(--muted)' : color}
              strokeWidth={TIER_WEIGHT[sg.tier]}
            />
          )
        })}
        {early && <path d={edgeChevron(X0, g.base, 'l')} fill={color} />}
      </g>
    )
  }
  /**
   * A forked or continued session's spine: the main line bending down from its parent's row when it began,
   * as heavy as the model it ran on, with a node where it leaves. It is skeleton, so it is never dimmed.
   */
  const branchSpine = (g: Layout) => {
    const b = tree.branches[g.row.branch]
    const parent = b.parent !== undefined ? mainRow(b.parent) : undefined
    const l = g.row.lanes[0]
    // a session over before the window has no spine in it; one that goes on through it comes in from the edge
    const end = fullLane.get(l.key)?.t1
    if (range && end !== undefined && end < range.lo) return null
    // when the session began, not its first moment in the window: a window cut after the branch has no branch in it
    const t0 = fullLane.get(l.key)?.t0 ?? l.t0
    if (!Number.isFinite(t0)) return null
    if (range && (t0 < range.lo || t0 >= range.hi)) {
      return t0 < range.lo ? <path key={`s${l.key}`} d={edgeChevron(X0, g.base, 'l')} fill={COLOR.main} /> : null
    }
    if (!parent) return null
    const x = axis.x(t0)
    const y = parent.base
    const d = elbow(x, y, g.base)
    // a fork is the parent's line forking: as heavy as the parent's line there
    const w =
      b.kind === 'fork'
        ? carrierWeight(fullLane.get(parent.row.lanes[0].key)?.runs ?? parent.row.lanes[0].runs, t0)
        : branchWeight(l.runs[0]?.tier)
    const link = b.detail.lineage.parent
    const name = `“${shortTitle(b.title)}”`
    const tip =
      b.kind === 'continuation'
        ? `Continued in ${name}`
        : b.kind === 'spawned'
          ? `Spawned in turn ${link?.atTurn ?? '?'}: ${name}`
          : link
            ? `Forked at turn ${link.atTurn}: ${link.sharedTurns} turns copied into ${name}`
            : `Forked into ${name}`
    return (
      <g key={`s${l.key}`}>
        <path
          d={d}
          fill="none"
          stroke="var(--surface)"
          strokeWidth={w + 4}
          strokeLinecap="round"
          pointerEvents="none"
        />
        <path d={d} fill="none" stroke={COLOR.main} strokeWidth={w} strokeLinecap="round" pointerEvents="none">
          <title>
            {b.kind === 'continuation'
              ? 'continued in a new session'
              : b.kind === 'spawned'
                ? 'spawned a new session'
                : 'forked into a new session'}
          </title>
        </path>
        {x >= X0 && x <= X1 && <BranchNode x={x} y={y} color={COLOR.main} ring={b.kind === 'continuation'} tip={tip} />}
      </g>
    )
  }
  // an agent's spine runs under the rows; a session's branch is skeleton and passes over them
  // the coordinate system of every row, under everything drawn on it: its token gridlines, labelled, and its zero
  const grid = layout.map((g) => (
    <g key={`grid${g.full.lanes[0].key}`}>
      {cTicks
        .filter((t) => t > 0 && t * kCtx <= g.ctxH - (g.row.main ? BRACKET_H : 0) - 2)
        .map((t) => (
          <g key={t}>
            <line x1={X0} x2={X1} y1={yCtx(g, t)} y2={yCtx(g, t)} stroke="var(--line)" strokeWidth={1} />
            <text x={X0 - 4} y={yCtx(g, t)} textAnchor="end" dominantBaseline="middle" fontSize={9} fill="var(--faint)">
              {formatTokens(t)}
            </text>
          </g>
        ))}
      {/* the row's zero: an axis, darker than the gridlines and reaching into the scale's gutter */}
      <line x1={ZERO_X} x2={X1} y1={g.base + 0.5} y2={g.base + 0.5} stroke="var(--faint)" strokeWidth={1} />
    </g>
  ))
  // the spend per slot, down from each baseline: a thin grey stroke per slot, under the lines drawn on the
  // baseline, its cache miss (context billed again in full) in the miss colour at the bottom
  const spend = layout.map((g, i) => (
    <g key={`usd${g.full.lanes[0].key}`} pointerEvents="none">
      {[...slots[i].entries()].map(([k, s]) => {
        const [ta, tb] = bars[i].get(k) ?? [k * slot, (k + 1) * slot]
        const x = f1((axis.x(ta) + axis.x(tb)) / 2)
        const miss = (s.miss ?? 0) * kUsd
        const rest = Math.max(0, s.total * kUsd - miss)
        const y = g.base + 1
        return (
          <g key={k}>
            <line x1={x} x2={x} y1={y} y2={y + Math.max(rest, 0.6)} stroke={SPEND_COLOR} strokeWidth={1} />
            {miss > 0 && (
              <line
                x1={x}
                x2={x}
                y1={y + rest}
                y2={y + rest + Math.max(miss, 0.6)}
                stroke={MISS_COLOR}
                strokeWidth={1.5}
              />
            )}
          </g>
        )
      })}
    </g>
  ))
  const spines = layout.map((g) => (g.row.main ? null : g.row.lanes.map((l) => laneSpine(g, l))))
  const branches = layout.map((g) => (g.row.main ? branchSpine(g) : null))
  // the reports of the work in focus, and the launch of its later pieces (the first one is the spine)
  const reported = new Set<string>()
  const connectors = layout.flatMap((g) =>
    g.row.main
      ? []
      : g.row.lanes.flatMap((l) =>
          l.units
            .filter((u) => inFocus(l, u))
            .map((u) => {
              // a collapsed swarm draws one report line per turn its agents' reports came in
              const seen = l.swarm?.collapsed ? reported : undefined
              const color = COLOR[l.kind]
              const on = isOn(l, u)
              // a collapsed swarm has one spine for all its launches
              const first = l.swarm?.collapsed || l.units.every((x) => x.startMs >= u.startMs)
              // work its own background tasks woke was sent by nobody: no line comes down to it
              const sender = u.woken || first ? undefined : senderOf(l, u)
              const from = sender?.g
              const to = mainRow(l.branch)
              const [a] = uX(u)
              const fy = from ? from.base : g.top
              return (
                <g key={`c${l.key}/${u.id}`} pointerEvents="none" opacity={on ? 1 : 0.7}>
                  {from && from !== g && (
                    <>
                      <line
                        x1={a}
                        x2={a}
                        y1={fy + (from.top < g.top ? 2 : -2)}
                        y2={from.top < g.top ? g.top - 3 : g.bottom + 3}
                        stroke={color}
                        strokeWidth={on ? 1.5 : 1}
                      />
                      {from.top < g.top && (
                        <path
                          d={`M${f1(a - 3)} ${g.top - 5}L${f1(a)} ${g.top}L${f1(a + 3)} ${g.top - 5}Z`}
                          fill={color}
                        />
                      )}
                    </>
                  )}
                  {to &&
                    arrivals(u)
                      .filter((t) => {
                        if (!seen) return true
                        const k = `${l.key}/${t}`
                        if (seen.has(k)) return false
                        seen.add(k)
                        return true
                      })
                      .map((t) => {
                        // a report in a turn outside the window: the line runs to the edge, with a chevron
                        const edge = range && t < range.lo ? 'l' : range && t >= range.hi ? 'r' : undefined
                        const xb = edge === 'l' ? X0 + 1 : edge === 'r' ? X1 - 1 : axis.x(t)
                        return (
                          <g key={t}>
                            <line
                              x1={xb}
                              x2={xb}
                              y1={g.top}
                              y2={to.base + 5}
                              stroke={color}
                              strokeWidth={on ? 1.5 : 1}
                              strokeDasharray={REPORT_DASH}
                            />
                            <path
                              d={
                                edge
                                  ? edgeChevron(xb, to.base + 3, edge)
                                  : `M${f1(xb - 3)} ${to.base + 6}L${f1(xb)} ${to.base + 1.5}L${f1(xb + 3)} ${to.base + 6}Z`
                              }
                              fill={color}
                            />
                          </g>
                        )
                      })}
                </g>
              )
            }),
        ),
  )

  // ---- pinned turn, its decision, the cursor
  const pinMarks = (() => {
    if (!pinned) return null
    const g = mainRow(pinned.branch)
    const l = g?.row.lanes[0]
    const s = l?.turns.find((x) => x.col.index === pinned.col)
    if (!g || !l || !s) return null
    const b = tree.branches[pinned.branch]
    const dec = b.model.decisions[b.model.cols[pinned.col].decision]
    const d0 = l.turns.find((x) => x.col.index >= dec.start)
    const d1 = [...l.turns].reverse().find((x) => x.col.index <= dec.end)
    const rowsOf = layout.filter((x) => x.row.branch === pinned.branch)
    const yTop = rowsOf[0].top
    const yBot = rowsOf[rowsOf.length - 1].bottom
    const xa = axis.x(s.t0)
    const xb = Math.max(xa + 2, axis.x(s.t1))
    return (
      <g pointerEvents="none">
        {d0 && d1 && (
          <rect
            x={axis.x(d0.t0)}
            y={yTop}
            width={Math.max(2, axis.x(d1.t1) - axis.x(d0.t0))}
            height={yBot - yTop}
            fill="var(--accent)"
            opacity={DECISION_TINT_OPACITY}
          />
        )}
        <rect
          x={xa}
          y={g.top}
          width={xb - xa}
          height={g.bottom - g.top}
          fill="var(--accent)"
          opacity={TURN_TINT_OPACITY}
        />
        <path d={`M${f1(xa - 4)} ${g.top - 1}h8l-4 6z`} fill="var(--accent)" />
      </g>
    )
  })()

  // the labels along the top, left to right, each where it does not run into the one before: clock
  // times (with the date where it changes), and how long each break was
  const multiDay = dateOf(tl.t0) !== dateOf(tl.t1)
  const ticks = clockTicks(axis, 70)
  const axisLabels = [
    ...ticks.map((t, i) => ({
      key: `t${t}`,
      x: axis.x(t),
      text: multiDay && (i === 0 || dateOf(t) !== dateOf(ticks[i - 1])) ? `${dateOf(t)} ${clock(t)}` : clock(t),
      gap: false,
    })),
    ...axis.breaks.map((b) => ({ key: `b${b.t0}`, x: (b.x0 + b.x1) / 2, text: gapText(b.t1 - b.t0), gap: true })),
  ]
    .sort((a, b) => a.x - b.x)
    .filter(
      ((end) => (l: { x: number; text: string }) => {
        const w = l.text.length * 5.8
        if (l.x - w / 2 < end.v + 8) return false
        end.v = l.x + w / 2
        return true
      })({ v: Number.NEGATIVE_INFINITY }),
    )

  // ---- what is under the pointer, in one line
  const under = (() => {
    if (crossT === undefined) return null
    const g = px ? layout[px.row] : cursor ? mainRow(cursor.branch) : undefined
    if (!g) return null
    const k = Math.floor(crossT / slot)
    const s = slots[layout.indexOf(g)].get(k)
    const ctx = g.row.lanes
      .flatMap((l) => {
        const own = l.series.find((x) => x.own)
        if (!own || crossT < l.t0 - HOLD_MS || crossT > l.t1 + HOLD_MS) return []
        const p = pointAt(own.points, crossT)
        // an agent between two of its pieces of work waits for a message
        const k = l.main ? -1 : l.units.findIndex((u) => u.startMs > crossT)
        const wait = k > 0 && l.units[k - 1].endMs < crossT ? crossT - l.units[k - 1].endMs : undefined
        return p ? [{ l, p, wait }] : []
      })
      .pop()
    const place = g.row.main ? turnPlace(g.row.lanes[0].turns, crossT, slackMs) : undefined
    const between = place && 'after' in place ? place : undefined
    return { g, s, ctx, between, swarm: px && px.row === layout.indexOf(g) ? hot : undefined }
  })()
  const betweenText = (p: { after: TurnSpan; next?: TurnSpan }) =>
    p.next
      ? `between turns ${p.after.col.index} and ${p.next.col.index}: main agent idle ${idleText(p.next.t0 - p.after.t1)}${p.next.col.human ? ', waiting for you' : ''}`
      : `after turn ${p.after.col.index}`

  return (
    <div>
      {/* one readout of a fixed height, so that nothing under the pointer moves the graph: the pointer's
          facts on the first line, the turn or piece of work under the next three */}
      <div className="h-[4.75rem] overflow-hidden text-sec text-muted" aria-live="polite">
        {!band && !under && !turnLines ? (
          <div className="text-faint">
            Hover, or press ← →, to read a turn; hover a piece of agent work to read what an agent was given. Click pins
            it and opens it below. Context per call above each baseline, spend per {slotText(slot)} below it, each on
            one scale (the tallest bar is {formatMoney(maxSlot)}).
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-x-3 overflow-hidden whitespace-nowrap">
              {band ? (
                <OverheadText o={overheads[band.branch][band.k]} />
              ) : under ? (
                <>
                  <span className="font-mono text-text">{clock(crossT ?? 0)}</span>
                  {under.between && <span>{betweenText(under.between)}</span>}
                  {under.swarm?.swarm && <SwarmText l={under.swarm} />}
                  {under.ctx && (
                    <span>
                      {under.ctx.l.main ? 'main agent' : under.ctx.l.title}:{' '}
                      <span className="font-mono text-text">{formatTokens(under.ctx.p.tokens)}</span> context
                      {under.ctx.wait !== undefined
                        ? `, held, waiting for a message ${idleText(under.ctx.wait)}`
                        : crossT !== undefined &&
                          crossT - under.ctx.p.t > HOLD_MS &&
                          `, held ${idleText(crossT - under.ctx.p.t)}`}
                    </span>
                  )}
                  <span>
                    this {slotText(slot)} on the row:{' '}
                    <span className="font-mono text-text">{formatMoney(under.s?.total ?? 0)}</span>
                  </span>
                </>
              ) : null}
            </div>
            {!band && turnLines}
          </>
        )}
      </div>
      <div
        ref={wrap}
        role="slider"
        tabIndex={0}
        aria-label="Context and spend of every agent over time"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, tree.branches[0]?.model.cols.length - 1)}
        aria-valuenow={cursor?.col ?? pinned?.col ?? 0}
        onPointerMove={onMove}
        onPointerLeave={(e) => {
          setPx(null)
          setBand(null)
          if (document.activeElement !== e.currentTarget) onCursor(null)
          onHoverUnit(null)
        }}
        onBlur={() => onCursor(null)}
        onClick={(e) => {
          const h = hit(e.clientX, e.clientY, e.currentTarget)
          if (!h) return
          const box = e.currentTarget.getBoundingClientRect()
          const chip = chipAt(h.row, h.x, e.clientY - box.top)
          const sw = swarmAt(h.row, h.x)
          if (chip || sw) {
            toggle(chip ?? sw?.swarm?.id ?? '')
            return
          }
          const r = read(h)
          if (r.unit) onSelectUnit(r.unit)
          else if (r.pin) onPin(r.pin)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // Enter opens the swarm under the pointer, else opens or closes the one holding the selected work
            const id =
              hot?.swarm?.id ??
              (selectedUnit ? swarmOfUnit(timeline.lanes, swarms, selectedUnit.branch, selectedUnit.id)?.id : undefined)
            if (id) {
              e.preventDefault()
              toggle(id)
              return
            }
          }
          setPx(null)
          onKey(e)
        }}
        className={`relative mt-1 rounded-badge ${hot ? 'cursor-pointer' : 'cursor-crosshair'}`}
      >
        <svg width={width} height={height} role="img" aria-label="Spend over time" className="block">
          {/* breaks: idle time left out, a light dotted stretch of the time axis (its length is written above it) */}
          {axis.breaks.map((b) => (
            <g key={b.t0}>
              <line
                x1={f1(b.x0 + 2)}
                x2={f1(b.x1 - 2)}
                y1={AXIS_H - 6.5}
                y2={AXIS_H - 6.5}
                stroke="var(--faint)"
                strokeWidth={1}
                strokeDasharray={BREAK_DOTS}
              />
              {/* room for the pointer to find its tooltip */}
              <rect x={b.x0} y={0} width={Math.max(0, b.x1 - b.x0)} height={AXIS_H - 2} fill="transparent" />
              <title>{`${formatDuration(b.t1 - b.t0)} in which nothing ran, left out`}</title>
            </g>
          ))}
          {ticks.map((t) => (
            <line
              key={t}
              x1={axis.x(t)}
              x2={axis.x(t)}
              y1={AXIS_H - 4}
              y2={height}
              stroke="var(--line)"
              strokeWidth={1}
              opacity={0.6}
            />
          ))}
          {axisLabels.map((l) => (
            <text
              key={l.key}
              x={l.x}
              y={11}
              textAnchor="middle"
              fontSize={l.gap ? 9.5 : 10}
              fill={l.gap ? 'var(--faint)' : 'var(--muted)'}
            >
              {l.text}
            </text>
          ))}
          <defs>
            <OverheadPattern id={hatch} />
            {colors.map((c, k) => (
              <InheritPattern key={c} id={`${hatch}-${k}`} color={c} />
            ))}
          </defs>
          {grid}
          {spend}
          {pinMarks}
          {spines}
          {layout.map(drawRow)}
          {branches}
          {strips.flatMap((s) =>
            overheads[s.branch].map((o, k) => {
              const [a, b] = overX(o)
              const on = band?.branch === s.branch && band.k === k
              const money = formatMoney(o.usd)
              const long = `${money} reported, not explained by messages`
              const room = b - a - 8
              const text = room >= long.length * 5.6 ? long : room >= money.length * 5.6 ? money : ''
              return (
                <g key={`o${s.branch}/${o.t0}`} pointerEvents="none">
                  <rect
                    x={a}
                    y={s.top}
                    width={b - a}
                    height={OVER_H}
                    rx={2}
                    fill={`url(#${hatch})`}
                    stroke="var(--muted)"
                    strokeOpacity={on ? 0.9 : 0.4}
                    strokeWidth={on ? 1.25 : 1}
                  />
                  {text && (
                    <text
                      x={a + 4}
                      y={s.top + OVER_H / 2 + 3.5}
                      fontSize={10}
                      fontWeight={on ? 600 : 400}
                      fill={on ? 'var(--text)' : 'var(--muted)'}
                      stroke="var(--surface)"
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {text}
                    </text>
                  )}
                </g>
              )
            }),
          )}
          {connectors}
          {/* a break's veil: the page colour over what crosses it, so that it fades without a band of its own */}
          {axis.breaks.flatMap((b) =>
            veilSpans.map(([y0, y1]) => (
              <rect
                key={`v${b.t0}-${y0}`}
                x={b.x0 + 3}
                y={y0}
                width={b.x1 - b.x0 - 6}
                height={y1 - y0}
                fill="var(--surface)"
                opacity={BREAK_VEIL}
                pointerEvents="none"
              />
            )),
          )}
          {labels}
          {crossX !== undefined && (
            <g pointerEvents="none">
              <line
                x1={crossX}
                x2={crossX}
                y1={AXIS_H - 4}
                y2={height}
                stroke="var(--text)"
                strokeWidth={1}
                opacity={0.35}
              />
            </g>
          )}
        </svg>
      </div>
    </div>
  )
}

/** What a collapsed swarm stands for, in one line. */
function SwarmText({ l }: { l: Lane }) {
  const sw = l.swarm
  if (!sw) return null
  const types = sw.types.length === 1 ? sw.types[0][0] : sw.types.map(([t, n]) => `${t} ×${n}`).join(', ')
  const models = sw.models.map(modelLabel).filter((m, i, all) => all.indexOf(m) === i)
  return (
    <span>
      swarm of <span className="font-mono text-text">{sw.count}</span> {types}
      {models.length > 0 && `, ${models.join(' and ')}`}:{' '}
      <span className="font-mono text-text">{formatMoney(l.usd)}</span>, {clock(l.t0)} to {clock(l.t1)} (
      {formatDuration(l.t1 - l.t0)}); click to open
    </span>
  )
}

/** What an overhead band stands for, in one line. */
function OverheadText({ o }: { o: Overhead }) {
  const when = (t: number) => `${dateOf(t)} ${clock(t)}`
  return (
    <span className="truncate">
      The harness reported <span className="font-mono text-text">{formatMoney(o.reportedUSD)}</span> from {when(o.t0)}{' '}
      to {when(o.t1)}; its messages add up to <span className="font-mono text-text">{formatMoney(o.coveredUSD)}</span>
      {Math.abs(o.rateDiffUSD) >= 0.005 && (
        <>
          {' '}
          and its own prices differ from Merlin's by{' '}
          <span className="font-mono text-text">{formatMoney(o.rateDiffUSD)}</span>
        </>
      )}
      , so <span className="font-mono text-text">{formatMoney(o.usd)}</span> went on calls it does not write down, in no
      one turn or agent
    </span>
  )
}

/** A break's length, short and rounded: "15m", "40m", "8h", "21h", "3d". */
function gapText(ms: number): string {
  // rounded: how long a pause was matters, not to the minute (the tooltip has it exactly)
  const m = ms / 60_000
  if (m < 57.5) return `${Math.max(5, Math.round(m / 5) * 5)}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}
