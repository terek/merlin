// The vertical frame of the time view: which rows there are, how tall each is, where the strips of
// overhead sit. It is laid out once for the whole session, so that it does not move as the window
// does: only opening or folding a swarm, or the width of the plot, changes it. What a window shows is
// drawn into that frame (`windowRow`), on a dollar scale of its own (`dollarScale`).
import { niceTicks } from '../context/chart'
import {
  collapseSwarms,
  type Lane,
  mergeSwarm,
  packLanes,
  type Row,
  type Swarm,
  slotLength,
  type Timeline,
  timeAxis,
} from './timeline'

export const AXIS_H = 24
export const BRACKET_H = 20
export const TURNS_H = 13
/** The largest context of the session is this tall. */
export const CTX_FULL = 84
export const CTX_MIN = 12
/** A row of an agent that left no record (no calls, so no context): its frame and label are whole. */
export const UNRECORDED_MIN_H = 22
/** A collapsed swarm's row is at least this tall: its label, and a few pixels of lines under it. */
export const SWARM_MIN_H = 24
/** The most expensive slot of the session is this tall. */
export const SPEND_FULL = 40
export const SPEND_MIN = 5
export const ROW_GAP = 10
export const BRANCH_GAP = 20
/** A spend bar is at least this wide. */
export const SLOT_PX = 4
/** The strip of overhead bands under a session's rows, and the gap above it. */
export const OVER_H = 14
export const OVER_GAP = 6

/** A row of the frame with its place. */
export interface FrameRow {
  /** The row with its lanes whole (the whole session's). */
  row: Row
  top: number
  /** The context's baseline: the area grows up from it, the spend down. */
  base: number
  ctxH: number
  spendH: number
  bottom: number
}

export interface Frame {
  layout: FrameRow[]
  strips: { branch: number; top: number; bottom: number }[]
  height: number
  /** The token scale: ticks, and pixels per token. */
  cTicks: number[]
  kCtx: number
}

/** The dollars of every slot of `slot` ms that the calls of `lanes` fall in. */
export function slotTotals(lanes: readonly Lane[], slot: number): Map<number, number> {
  const m = new Map<number, number>()
  for (const l of lanes)
    for (const c of l.calls) {
      const k = Math.floor(c.t / slot)
      m.set(k, (m.get(k) ?? 0) + c.usd)
    }
  return m
}

/** The room a row's spend bars have: its band, less what a main row keeps for its turn numbers and the bars' margin. */
export const barRoom = (g: Pick<FrameRow, 'spendH'> & { row: Pick<Row, 'main'> }) =>
  Math.max(0, g.spendH - (g.row.main ? TURNS_H : 0) - 2)

/**
 * The frame of the whole `timeline` over `x0`..`x1`: its rows (swarms collapsed unless in `open`,
 * packed on the axis of the whole session), the token scale of its largest context, each row's bands
 * from the whole session, and a strip of overhead under each branch in `overhead`. It does not depend on
 * any window.
 */
export function buildFrame(
  timeline: Timeline,
  swarms: readonly Swarm[],
  open: ReadonlySet<string>,
  x0: number,
  x1: number,
  overhead: readonly boolean[],
): Frame {
  const axis = timeAxis(timeline.spans, x0, x1)
  const rows = packLanes(collapseSwarms(timeline.lanes, swarms, open), axis.x)
  const slot = slotLength(axis, SLOT_PX)
  const maxes = rows.map((r) => Math.max(0, ...slotTotals(r.lanes, slot).values()))
  const maxSlot = Math.max(1e-9, ...maxes)
  const kUsd = SPEND_FULL / maxSlot
  const cTicks = niceTicks(timeline.peak || 1, 4)
  const kCtx = CTX_FULL / cTicks[cTicks.length - 1]
  const layout: FrameRow[] = []
  const strips: Frame['strips'] = []
  let y = AXIS_H
  rows.forEach((row, i) => {
    if (i > 0) y += row.main ? BRANCH_GAP : ROW_GAP
    const top = y
    const peak = Math.max(...row.lanes.map((l) => l.peak))
    // a swarm's row has room for its frame label and a few pixels of lines under it
    const minH = row.lanes.some((l) => l.swarm?.collapsed)
      ? SWARM_MIN_H
      : row.lanes.some((l) => l.agent?.unrecorded)
        ? UNRECORDED_MIN_H
        : CTX_MIN
    const ctxH = Math.max(minH, Math.ceil(peak * kCtx) + 3) + (row.main ? BRACKET_H : 0)
    const spendH = Math.max(SPEND_MIN, Math.ceil(maxes[i] * kUsd) + 2) + (row.main ? TURNS_H : 0)
    layout.push({ row, top, base: top + ctxH, ctxH, spendH, bottom: top + ctxH + spendH })
    y = top + ctxH + spendH
    // the session's overhead, under its last row
    if (rows[i + 1]?.branch !== row.branch && overhead[row.branch]) {
      strips.push({ branch: row.branch, top: y + OVER_GAP, bottom: y + OVER_GAP + OVER_H })
      y += OVER_GAP + OVER_H
    }
  })
  return { layout, strips, height: y + 6, cTicks, kCtx }
}

/** A lane with nothing in it: what stands in a main row for a session with nothing in the window. */
const emptied = (l: Lane): Lane => ({
  ...l,
  units: [],
  turns: [],
  calls: [],
  runs: [],
  model: '',
  series: [],
  misses: [],
  compactions: [],
  usd: 0,
  peak: 0,
  t0: Number.NaN,
  t1: Number.NaN,
})

/**
 * What a window shows of a frame's row: the lanes of the row that have something in it, each as the
 * window's slice of it (`sliced`, the lanes of the window by key). A collapsed swarm is the swarm of the
 * agents that are in it; the first agent of an expanded one in it carries the chip. A main row keeps a
 * lane of its own, empty if its session has nothing in the window (`live` is false then).
 */
export function windowRow(
  row: Row,
  sliced: ReadonlyMap<string, Lane>,
  swarms: readonly Swarm[],
): { row: Row; live: boolean } {
  const lanes = row.lanes.flatMap((l): Lane[] => {
    const sw = l.swarm
    if (!sw) {
      const s = sliced.get(l.key)
      return s ? [s] : []
    }
    const members = (swarms.find((s) => s.id === sw.id)?.keys ?? []).flatMap((k) => sliced.get(k) ?? [])
    if (sw.collapsed) return members.length ? [mergeSwarm(sw.id, members)] : []
    const s = sliced.get(l.key)
    if (!s) return []
    return [{ ...s, swarm: { ...sw, first: members[0]?.key === l.key } }]
  })
  if (row.main) {
    const main = sliced.get(row.lanes[0].key)
    return { row: { ...row, lanes: [main ?? emptied(row.lanes[0])] }, live: !!main }
  }
  return { row: { ...row, lanes }, live: lanes.length > 0 }
}

/**
 * Pixels per dollar for a window: the largest scale at which the biggest slot of every row fits its
 * band. `maxes[i]` is the biggest slot of row `i` in the window.
 */
export function dollarScale(layout: readonly FrameRow[], maxes: readonly number[]): number {
  let k = Number.POSITIVE_INFINITY
  layout.forEach((g, i) => {
    if (maxes[i] > 0) k = Math.min(k, barRoom(g) / maxes[i])
  })
  return Number.isFinite(k) ? k : SPEND_FULL
}
