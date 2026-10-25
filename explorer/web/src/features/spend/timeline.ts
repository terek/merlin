// The spend graph's time view: the tree on one wall-clock axis, with a lane for each session's main
// agent and one for each agent it launched.
//
//   a lane    the context of every call its agent made (the area), and what the lane spent (the bars
//             under it): its agent's calls, its agent's own sub-agents' calls, and for a main lane
//             the compaction calls
//   the axis  wall-clock time, with every stretch longer than GAP_MS in which nothing ran squeezed
//             into a fixed-width break
//
// Pure; TimeView.tsx draws what this returns.

import type { Agent, Compaction } from '../../api/types'
import {
  addMessage,
  agentSeries,
  type ClassKey,
  type Col,
  fitKey,
  fitPrices,
  type KindKey,
  newBucket,
  promptTokens,
  type Reread,
  type Unit,
} from './model'
import type { Tree } from './tree'

/** Idle time longer than this is squeezed into a break on the axis. */
export const GAP_MS = 10 * 60_000
/** The width of a break, at most. */
export const BREAK_PX = 22
/** With more breaks than this, a longer idle time is needed for one. */
export const MAX_BREAKS = 12
const GAPS = [10, 20, 30, 60, 120, 240, 480, 960].map((m) => m * 60_000)
/** Context an agent keeps over a pause longer than this is drawn as held, not as a run. */
export const HOLD_MS = 5 * 60_000

const ms = (s: string | undefined) => (s ? Date.parse(s) : Number.NaN)

/** One billed call, on the lane that pays for it. */
export interface Call {
  t: number
  usd: number
  /** Dollars by token class; the cache miss is `reread`. */
  byClass: Record<ClassKey, number>
  /** Who, for the split by who: the lane's kind, or `compact` for a compaction call. */
  kind: KindKey
  /** Dollars of `usd` that were a cache miss. */
  reread: number
}

/** A point of an agent's context: a call and the prompt it was sent with. */
export interface Point {
  t: number
  tokens: number
}

/** The context of one agent: the lane's own (drawn as the area), or one of its sub-agents (a thin line). */
export interface Series {
  agentId: string
  own: boolean
  points: Point[]
}

export interface Miss {
  t: number
  /** The context of the call that missed: where the mark sits. */
  tokens: number
  reread: Reread
}

export interface LaneCompaction {
  t: number
  compaction: Compaction
  /** The agent whose conversation it was; undefined for the main agent. */
  agent?: Agent
}

/** A turn of the main session in time. */
export interface TurnSpan {
  col: Col
  t0: number
  t1: number
}

export interface Lane {
  key: string
  branch: number
  /** The main agent of the branch's session, or an agent it launched. */
  main: boolean
  /** The agent of an agent lane. */
  agent?: Agent
  /** Its colour and its look: an addressable agent keeps a lane of its own. */
  kind: KindKey | 'main'
  title: string
  /** Its pieces of work (agent lanes). */
  units: Unit[]
  /** Its turns (main lanes). */
  turns: TurnSpan[]
  calls: Call[]
  series: Series[]
  misses: Miss[]
  compactions: LaneCompaction[]
  usd: number
  /** The largest context drawn on it. */
  peak: number
  t0: number
  t1: number
}

export interface Timeline {
  lanes: Lane[]
  /** Stretches of time in which something ran: what the axis is laid out on. */
  spans: [number, number][]
  peak: number
  t0: number
  t1: number
}

/** Everything that ran, as lanes: per branch its main lane, then its agents' lanes in launch order. */
export function buildTimeline(tree: Tree): Timeline {
  const lanes: Lane[] = []
  const spans: [number, number][] = []
  for (const b of tree.branches) {
    const m = b.model
    const own = b.own.map((i) => m.cols[i])
    const turns: TurnSpan[] = own.flatMap((c, k) => {
      const t0 = ms(c.turn.startedAt)
      if (!Number.isFinite(t0)) return []
      const next = own[k + 1] ? ms(own[k + 1].turn.startedAt) : Number.NaN
      const end = ms(c.turn.endedAt)
      const t1 = Number.isFinite(end) ? end : Number.isFinite(next) ? next : t0
      return [{ col: c, t0, t1: Math.max(t0, t1) }]
    })
    // a session copied from another starts with that one's messages: they are the parent's
    const since = turns.length ? turns[0].t0 : Number.NEGATIVE_INFINITY
    const main = mkLane(`${b.index}/main`, b.index, true, undefined, 'main', b.title)
    main.turns = turns
    const byRoot = new Map<string, Lane>()
    const agentLanes: Lane[] = []
    for (const r of m.rows) {
      const lane = mkLane(`${b.index}/${r.agent.id}`, b.index, false, r.agent, agentSeries(r.agent), '')
      lane.units = r.units
      lane.usd = 0
      byRoot.set(r.agent.id, lane)
      agentLanes.push(lane)
    }
    const rootOf = (a: Agent): Agent => {
      const seen = new Set<string>()
      let cur = a
      while (cur.parentAgentId !== null && !seen.has(cur.id)) {
        seen.add(cur.id)
        const p = m.agentsById.get(cur.parentAgentId)
        if (!p) break
        cur = p
      }
      return cur
    }

    const messages = b.detail.digest.messages ?? []
    const fits = fitPrices(messages)
    const last = new Map<string, (typeof messages)[number]>()
    const series = new Map<string, Series>()
    for (const msg of messages) {
      const key = msg.agentId ?? ''
      const prev = last.get(key)
      const tokens = promptTokens(msg)
      if (tokens > 0) last.set(key, msg)
      const t = ms(msg.at)
      if (!Number.isFinite(t) || t < since) continue
      const a = msg.agentId ? m.agentsById.get(msg.agentId) : undefined
      const root = a ? rootOf(a) : undefined
      const toMain = !a || !root || (root === a && a.kind === 'compact')
      const lane = toMain ? main : byRoot.get(root.id)
      if (!lane) continue
      const bucket = newBucket()
      addMessage(bucket, msg, fits.get(fitKey(msg)) ?? { input: 0, read: 0 }, prev)
      lane.calls.push({
        t,
        usd: msg.usd,
        byClass: bucket.byClass,
        kind: a?.kind === 'compact' ? 'compact' : lane.main ? 'main' : (lane.kind as KindKey),
        reread: bucket.reread,
      })
      lane.usd += msg.usd
      spans.push([t, t])
      // the context: the main agent's own calls, and every agent's on the lane it belongs to
      if (tokens <= 0 || (toMain && msg.agentId)) continue
      let s = series.get(key)
      if (!s) {
        s = { agentId: key, own: toMain || a === root, points: [] }
        series.set(key, s)
        lane.series.push(s)
      }
      s.points.push({ t, tokens })
      for (const r of bucket.rereads) lane.misses.push({ t, tokens, reread: r })
    }

    for (const c of b.detail.digest.compactions ?? []) {
      const t = ms(c.at)
      if (Number.isFinite(t) && t >= since) main.compactions.push({ t, compaction: c })
    }
    for (const a of m.agentsById.values()) {
      if (a.kind === 'compact') continue
      const lane = byRoot.get(rootOf(a).id)
      if (!lane) continue
      for (const c of a.compactions ?? []) {
        const t = ms(c.at)
        if (Number.isFinite(t)) lane.compactions.push({ t, compaction: c, agent: a })
      }
    }

    for (const lane of agentLanes) {
      lane.title = lane.agent?.name ?? lane.agent?.agentType ?? lane.agent?.kind ?? ''
      for (const u of lane.units) if (Number.isFinite(u.startMs)) spans.push([u.startMs, Math.max(u.startMs, u.endMs)])
    }
    // a turn ends with the last thing that ran in it: a turn the harness closed hours later (the
    // session was left open) would otherwise stretch the axis over time in which nothing ran
    const activity = [main, ...agentLanes]
      .flatMap((l) => [...l.calls.map((c) => c.t), ...l.units.flatMap((u) => [u.startMs, u.endMs])])
      .filter(Number.isFinite)
      .sort((x, y) => x - y)
    turns.forEach((s, k) => {
      const next = turns[k + 1]?.t0 ?? Number.POSITIVE_INFINITY
      let start = Number.NaN
      let end = s.t0
      for (const t of activity) {
        if (t <= s.t0 || t > s.t1 || t >= next) continue
        if (Number.isNaN(start)) start = t
        end = t
      }
      s.t1 = end
      // on the axis, its prompt and then what ran from its first call on: between the two is time in
      // which nothing ran, seconds as a rule, hours where the prompt failed (an expired login) and the
      // turn went on once the user was back. Pauses between its calls are its agent waiting on tools.
      spans.push([s.t0, s.t0])
      if (!Number.isNaN(start)) spans.push([start, end])
    })
    for (const lane of [main, ...agentLanes]) {
      lane.calls.sort((x, y) => x.t - y.t)
      lane.compactions.sort((x, y) => x.t - y.t)
      const times = [
        ...lane.calls.map((c) => c.t),
        ...lane.turns.flatMap((t) => [t.t0, t.t1]),
        ...lane.units.flatMap((u) => [u.startMs, u.endMs]),
      ].filter(Number.isFinite)
      lane.t0 = times.length ? Math.min(...times) : Number.NaN
      lane.t1 = times.length ? Math.max(...times) : Number.NaN
      lane.peak = Math.max(
        0,
        ...lane.series.flatMap((s) => s.points.map((p) => p.tokens)),
        ...lane.compactions.map((c) => (lane.main || c.agent === lane.agent ? (c.compaction.preTokens ?? 0) : 0)),
      )
    }
    lanes.push(main, ...agentLanes.filter((l) => l.calls.length > 0 || l.units.length > 0))
  }
  const all = spans.flat().filter(Number.isFinite)
  return {
    lanes,
    spans,
    peak: Math.max(0, ...lanes.map((l) => l.peak)),
    t0: all.length ? Math.min(...all) : 0,
    t1: all.length ? Math.max(...all) : 0,
  }
}

function mkLane(
  key: string,
  branch: number,
  main: boolean,
  agent: Agent | undefined,
  kind: Lane['kind'],
  title: string,
): Lane {
  return {
    key,
    branch,
    main,
    agent,
    kind,
    title,
    units: [],
    turns: [],
    calls: [],
    series: [],
    misses: [],
    compactions: [],
    usd: 0,
    peak: 0,
    t0: Number.NaN,
    t1: Number.NaN,
  }
}

// ---- the axis -------------------------------------------------------------------------

/** A stretch of the axis drawn to scale. */
export interface Piece {
  t0: number
  t1: number
  x0: number
  x1: number
}

/** Idle time squeezed out of the axis. */
export interface Break {
  t0: number
  t1: number
  x0: number
  x1: number
}

export interface TimeAxis {
  pieces: Piece[]
  breaks: Break[]
  /** Pixels per millisecond inside a piece. */
  scale: number
  x0: number
  x1: number
  x: (t: number) => number
  t: (x: number) => number
}

/**
 * Lays `spans` out between `x0` and `x1`: spans closer than `gapMs` are one piece, every piece is on
 * the same scale, and the time between two pieces is a break `breakPx` wide. Every piece is padded a
 * little, so that a lone call still has a place.
 */
export function timeAxis(
  spans: readonly [number, number][],
  x0: number,
  x1: number,
  gapMs = GAP_MS,
  maxBreaks = MAX_BREAKS,
): TimeAxis {
  const sorted = spans.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).sort((a, b) => a[0] - b[0])
  // the shortest gap from `gapMs` up that leaves no more than `maxBreaks` breaks
  let merged: [number, number][] = []
  for (const gap of [gapMs, ...GAPS.filter((g) => g > gapMs)]) {
    merged = []
    for (const [a, b] of sorted) {
      const top = merged[merged.length - 1]
      if (top && a - top[1] <= gap) top[1] = Math.max(top[1], b)
      else merged.push([a, Math.max(a, b)])
    }
    if (merged.length - 1 <= maxBreaks) break
  }
  if (merged.length === 0) merged.push([0, 1])
  // breaks take at most a tenth of the width
  const breakPx = Math.max(6, Math.min(BREAK_PX, ((x1 - x0) * 0.1) / Math.max(1, merged.length - 1)))
  const active = merged.reduce((s, [a, b]) => s + (b - a), 0)
  // a pad of 1% of the active time on each side of a piece (at least a minute)
  const pad = Math.max(60_000, active * 0.01)
  const padded = merged.map(([a, b]) => [a - pad, b + pad] as [number, number])
  const total = padded.reduce((s, [a, b]) => s + (b - a), 0)
  const room = Math.max(1, x1 - x0 - breakPx * (padded.length - 1))
  const scale = room / total
  const pieces: Piece[] = []
  const breaks: Break[] = []
  let x = x0
  padded.forEach(([a, b], i) => {
    if (i > 0) {
      breaks.push({ t0: padded[i - 1][1], t1: a, x0: x, x1: x + breakPx })
      x += breakPx
    }
    pieces.push({ t0: a, t1: b, x0: x, x1: x + (b - a) * scale })
    x += (b - a) * scale
  })
  const toX = (t: number): number => {
    if (t <= pieces[0].t0) return pieces[0].x0
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]
      if (t <= p.t1) return p.x0 + (t - p.t0) * scale
      const g = breaks[i]
      if (g && t < g.t1) return g.x0 + ((t - g.t0) / (g.t1 - g.t0)) * breakPx
    }
    return pieces[pieces.length - 1].x1
  }
  const toT = (px: number): number => {
    if (px <= pieces[0].x0) return pieces[0].t0
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]
      if (px <= p.x1) return p.t0 + (px - p.x0) / scale
      const g = breaks[i]
      if (g && px < g.x1) return g.t0 + ((px - g.x0) / breakPx) * (g.t1 - g.t0)
    }
    return pieces[pieces.length - 1].t1
  }
  return { pieces, breaks, scale, x0, x1, x: toX, t: toT }
}

const MIN = 60_000
const HOUR = 60 * MIN
const STEPS = [
  MIN,
  2 * MIN,
  5 * MIN,
  10 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  24 * HOUR,
]

/** Clock ticks at least `minPx` apart, on round local times, inside the pieces. */
export function clockTicks(axis: TimeAxis, minPx = 64): number[] {
  const step = STEPS.find((s) => s * axis.scale >= minPx) ?? STEPS[STEPS.length - 1]
  const out: number[] = []
  for (const p of axis.pieces) {
    // round to the step in local time
    const off = new Date(p.t0).getTimezoneOffset() * MIN
    for (let t = Math.ceil((p.t0 - off) / step) * step + off; t <= p.t1; t += step) out.push(t)
  }
  return out
}

const SLOTS = [15_000, 30_000, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR]

/** The shortest round slot of time that is at least `minPx` wide: the spend bars are one per slot. */
export const slotLength = (axis: TimeAxis, minPx: number) =>
  SLOTS.find((s) => s * axis.scale >= minPx) ?? SLOTS[SLOTS.length - 1]

/** "30 s", "5 min", "1 h" */
export const slotText = (ms: number) => (ms < MIN ? `${ms / 1000} s` : ms < HOUR ? `${ms / MIN} min` : `${ms / HOUR} h`)

// ---- packing --------------------------------------------------------------------------

/** A row of the plot: a main lane, an addressable agent's lane, or agent lanes that do not overlap. */
export interface Row {
  lanes: Lane[]
  branch: number
  main: boolean
}

/**
 * The rows, in order: per branch its main lane, then its agents, each in the first row where it does
 * not come within `gapPx` of another. An agent takes its row for its whole life, so an addressable
 * agent keeps its row over the pauses between its pieces of work.
 */
export function packLanes(lanes: readonly Lane[], x: (t: number) => number, gapPx = 6): Row[] {
  const rows: Row[] = []
  const branches = [...new Set(lanes.map((l) => l.branch))]
  for (const br of branches) {
    const mine = lanes.filter((l) => l.branch === br)
    for (const l of mine.filter((l) => l.main)) rows.push({ lanes: [l], branch: br, main: true })
    const rest = mine.filter((l) => !l.main).sort((a, b) => a.t0 - b.t0)
    const packed: { row: Row; end: number }[] = []
    for (const l of rest) {
      const a = x(l.t0)
      const slot = packed.find((p) => p.end + gapPx <= a)
      if (slot) {
        slot.row.lanes.push(l)
        slot.end = x(l.t1)
      } else {
        const row: Row = { lanes: [l], branch: br, main: false }
        packed.push({ row, end: x(l.t1) })
        rows.push(row)
      }
    }
  }
  return rows
}

/**
 * The parts of a pause from `t0` to `t1`, each inside a busy stretch or not: an agent holding its
 * context while its turn (or piece of work) still runs, against holding it between them. `busy` is
 * sorted by start.
 */
export function splitHeld(t0: number, t1: number, busy: readonly { t0: number; t1: number }[]) {
  const out: { t0: number; t1: number; busy: boolean }[] = []
  let at = t0
  for (const b of busy) {
    if (b.t1 <= at) continue
    if (b.t0 >= t1) break
    if (b.t0 > at) out.push({ t0: at, t1: b.t0, busy: false })
    const end = Math.min(b.t1, t1)
    out.push({ t0: Math.max(at, b.t0), t1: end, busy: true })
    at = end
  }
  if (at < t1) out.push({ t0: at, t1, busy: false })
  return out
}

/**
 * Where `t` falls among a main lane's turns: in one (`slack` past its end still counts, so that a
 * turn of no width can be hovered), between two, or after the last.
 */
export function turnPlace(
  turns: readonly TurnSpan[],
  t: number,
  slack = 0,
): { turn: TurnSpan } | { after: TurnSpan; next?: TurnSpan } | undefined {
  let k = -1
  for (let i = 0; i < turns.length; i++) if (turns[i].t0 <= t) k = i
  // before the first turn: the first one, as before
  if (k < 0) return turns[0] ? { turn: turns[0] } : undefined
  const s = turns[k]
  return t <= s.t1 + slack ? { turn: s } : { after: s, next: turns[k + 1] }
}
