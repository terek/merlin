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
import { modelLabel } from '../../lib/models'
import { type Prices, TIERS, type Tier, tierOf } from '../../lib/tiers'
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
  type Split,
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
  /** The model the message was billed on, as recorded. */
  model: string
  /** Its tier by price (lib/tiers.ts), for the split by model tier. */
  tier: Tier
}

/**
 * A stretch of a lane's calls on one model: from the first call of a run of consecutive calls on the same
 * model to the last (`t0 === t1` for one call). What a lane's model looks like over time.
 */
export interface ModelRun {
  t0: number
  t1: number
  model: string
  tier: Tier
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
  /** Its calls grouped by consecutive model, in time order (`modelRuns`). */
  runs: ModelRun[]
  /** The model of most of its calls (by count; the earlier on a tie); empty without calls. */
  model: string
  series: Series[]
  misses: Miss[]
  compactions: LaneCompaction[]
  usd: number
  /** The largest context drawn on it. */
  peak: number
  t0: number
  t1: number
  /** Set on an agent lane that belongs to a swarm (`collapseSwarms`), and on the lane standing for a collapsed one. */
  swarm?: SwarmInfo
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
export function buildTimeline(tree: Tree, prices?: Prices): Timeline {
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
        model: msg.model,
        tier: tierOf(msg.model, prices),
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
      lane.runs = modelRuns(lane.calls)
      lane.model = mainModel(lane.calls)
      measure(lane)
    }
    lanes.push(main, ...agentLanes.filter((l) => l.calls.length > 0 || l.units.length > 0))
  }
  return withBounds(lanes, spans)
}

/** Consecutive calls (in time order) on the same model, as runs. */
export function modelRuns(calls: readonly Pick<Call, 't' | 'model' | 'tier'>[]): ModelRun[] {
  const out: ModelRun[] = []
  for (const c of calls) {
    const last = out[out.length - 1]
    if (last && last.model === c.model) last.t1 = c.t
    else out.push({ t0: c.t, t1: c.t, model: c.model, tier: c.tier })
  }
  return out
}

/** The model most of the calls were on (by count, the earlier on a tie); '' for no calls. */
export function mainModel(calls: readonly Pick<Call, 'model'>[]): string {
  const n = new Map<string, number>()
  for (const c of calls) if (c.model) n.set(c.model, (n.get(c.model) ?? 0) + 1)
  let best = ''
  let most = 0
  for (const [m, k] of n)
    if (k > most) {
      best = m
      most = k
    }
  return best
}

/** Sets a lane's first and last moment and its largest context from what is on it. */
function measure(lane: Lane): Lane {
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
  return lane
}

function withBounds(lanes: Lane[], spans: [number, number][]): Timeline {
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
    runs: [],
    model: '',
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
  // the shortest gap from `gapMs` up that leaves no more than `maxBreaks` breaks
  let merged: [number, number][] = []
  for (const gap of [gapMs, ...GAPS.filter((g) => g > gapMs)]) {
    merged = mergeSpans(spans, gap)
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

/** `spans` in order, those no more than `gap` apart joined into one. */
function mergeSpans(spans: readonly [number, number][], gap: number): [number, number][] {
  const sorted = spans.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [a, b] of sorted) {
    const top = merged[merged.length - 1]
    if (top && a - top[1] <= gap) top[1] = Math.max(top[1], b)
    else merged.push([a, Math.max(a, b)])
  }
  return merged
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

/**
 * Adds a call to a bar's parts: by token class, by model tier (the whole call, cache miss included: the tier
 * is about the model, not about what went wrong), or by who with the cache miss apart; and to its total.
 */
export function addCall(bar: Record<string, number>, c: Call, split: Split) {
  if (split === 'class') for (const [key, v] of Object.entries(c.byClass)) bar[key] = (bar[key] ?? 0) + v
  else if (split === 'tier') bar[c.tier] = (bar[c.tier] ?? 0) + c.usd
  else {
    bar[c.kind] = (bar[c.kind] ?? 0) + c.usd - c.reread
    bar.reread = (bar.reread ?? 0) + c.reread
  }
  bar.total = (bar.total ?? 0) + c.usd
}

/** What one tier spent: its dollars, and on which models, the most expensive first. */
export interface TierSpend {
  tier: Tier
  usd: number
  models: { model: string; usd: number }[]
}

/** What the timeline's calls spent by model tier (only tiers with dollars), in the order of `TIERS`. */
export function tierSpend(tl: Timeline): TierSpend[] {
  const by = new Map<Tier, Map<string, number>>()
  for (const l of tl.lanes)
    for (const c of l.calls) {
      const m = by.get(c.tier) ?? new Map<string, number>()
      m.set(c.model, (m.get(c.model) ?? 0) + c.usd)
      by.set(c.tier, m)
    }
  return TIERS.flatMap((tier) => {
    const m = by.get(tier)
    if (!m) return []
    const models = [...m]
      .map(([model, usd]) => ({ model, usd }))
      .sort((a, b) => b.usd - a.usd || (a.model < b.model ? -1 : 1))
    const usd = models.reduce((s, x) => s + x.usd, 0)
    return usd > 0 ? [{ tier, usd, models }] : []
  })
}

// ---- days -----------------------------------------------------------------------------

/**
 * What ran between two nights: the overview snaps to it. Everything at or after `lo` and before `hi`
 * belongs to it.
 */
export interface Day {
  /** Local midnight of the calendar day it is shown as. */
  date: number
  /** Its first and last moment of activity. */
  t0: number
  t1: number
  lo: number
  hi: number
}

/** Local midnight of the day `n` days after the one `t` is on. */
const midnight = (t: number, n = 0) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime()
}
/**
 * Where the cut after a day is looked for: from 18:00 that day to 12:00 the next, and above all in
 * its core, from midnight to 08:00.
 */
const NIGHT_FROM = 18
const NIGHT_TO = 36
const CORE_FROM = 24
const CORE_TO = 32

/**
 * The days of a timeline. Each night it is cut at the stretch in which nothing ran that covers most
 * of the night's core (then most of its window). The time after the last activity counts as such a
 * stretch, so that work running past midnight with nothing after it stays with its evening. A part
 * is shown as the calendar day its first-to-last activity overlaps most; when two land on one day,
 * the first goes back to the day it started on (an evening's work that ran deep into the night), or,
 * when it started on that same day, the two are one.
 */
export function splitDays(tl: Timeline): Day[] {
  // a turn is never cut: its prompt and the calls that answered it are on the same day
  const turns = tl.lanes.flatMap((l) => l.turns.map((s) => [s.t0, s.t1] as [number, number]))
  const merged = mergeSpans([...tl.spans, ...turns], 0)
  if (merged.length === 0) return []
  const first = merged[0][0]
  const last = merged[merged.length - 1][1]
  const cuts = new Set<number>()
  for (let d = midnight(first); d <= last; d = midnight(d, 1)) {
    const at = (h: number) => (h < 24 ? d : midnight(d, 1)) + (h % 24) * HOUR
    const [w0, w1, c0, c1] = [at(NIGHT_FROM), at(NIGHT_TO), at(CORE_FROM), at(CORE_TO)]
    if (w1 <= first || w0 >= last) continue
    // how much of the core, then of the window, idle time from a to b covers
    const cover = (a: number, b: number) =>
      Math.max(0, Math.min(c1, b) - Math.max(c0, a)) * 1e3 + Math.max(0, Math.min(w1, b) - Math.max(w0, a)) / HOUR
    let best = cover(last, Number.POSITIVE_INFINITY)
    let cut = -1
    for (let i = 1; i < merged.length; i++) {
      const c = cover(merged[i - 1][1], merged[i][0])
      if (c > best) {
        best = c
        cut = i
      }
    }
    if (cut > 0) cuts.add(cut)
  }
  const days: Day[] = []
  let from = 0
  for (let i = 1; i <= merged.length; i++) {
    if (i < merged.length && !cuts.has(i)) continue
    const t0 = merged[from][0]
    const t1 = merged[i - 1][1]
    let date = midnight(t0)
    let most = -1
    for (let d = midnight(t0); d <= t1; d = midnight(d, 1)) {
      const o = Math.min(t1, midnight(d, 1)) - Math.max(t0, d)
      if (o > most) {
        most = o
        date = d
      }
    }
    const hi = i === merged.length ? Number.POSITIVE_INFINITY : (t1 + merged[i][0]) / 2
    // two parts on one calendar day: the first is an evening run past midnight, and goes back to the
    // day it started on, unless that day is taken; then they are one day
    const prev = days[days.length - 1]
    const back = prev ? midnight(prev.t0) : 0
    if (prev?.date === date && back < date && (days[days.length - 2]?.date ?? 0) < back) prev.date = back
    if (prev?.date === date) Object.assign(prev, { t1, hi })
    else days.push({ date, t0, t1, lo: from === 0 ? Number.NEGATIVE_INFINITY : (merged[from - 1][1] + t0) / 2, hi })
    from = i
  }
  return days
}

/** The day `t` is on: an index into `days`, or -1. */
export function dayAt(days: readonly Day[], t: number): number {
  let lo = 0
  let hi = days.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t < days[mid].lo) hi = mid - 1
    else if (t >= days[mid].hi) lo = mid + 1
    else return mid
  }
  return -1
}

// ---- windows ----------------------------------------------------------------------------

/** The stretch of time the plot shows: everything that starts at or after `lo` and before `hi`. */
export interface Win {
  lo: number
  hi: number
}

/** The shortest window the brush makes. */
export const MIN_WINDOW_MS = 5 * MIN
/** An idle stretch longer than this ends a work episode. */
export const EPISODE_GAP_MS = 2 * HOUR
/** A window that is not the day's own is padded at most this much on each side. */
const MAX_PAD_MS = 30 * MIN

/**
 * What of a timeline is in the window `[lo, hi)`: its lanes with only the calls, turns, contexts and
 * marks that start inside it. A turn that runs past the edge is kept whole when it starts inside; a
 * piece of agent work is kept when it overlaps the window (cut at the left edge when it started
 * before it), so that the lines to and from it can be drawn to the edge. A session's main lane stays
 * while anything of its session is left.
 */
export function sliceTimeline(tl: Timeline, lo: number, hi: number, whole = true): Timeline {
  const on = (t: number) => t >= lo && t < hi
  const workSpans = new Set(tl.lanes.flatMap((l) => l.units.map((u) => `${u.startMs}/${Math.max(u.startMs, u.endMs)}`)))
  const lanes = tl.lanes.map((l) => {
    const calls = l.calls.filter((c) => on(c.t))
    return measure({
      ...l,
      calls,
      runs: modelRuns(calls),
      model: mainModel(calls),
      turns: l.turns.filter((s) => on(s.t0)),
      units: l.units.filter(
        (u) => Number.isFinite(u.startMs) && u.startMs < hi && (Number.isFinite(u.endMs) ? u.endMs : u.startMs) >= lo,
      ),
      series: l.series.map((s) => ({ ...s, points: s.points.filter((p) => on(p.t)) })).filter((s) => s.points.length),
      misses: l.misses.filter((m) => on(m.t)),
      compactions: l.compactions.filter((c) => on(c.t)),
      usd: l.calls.reduce((s, c) => s + (on(c.t) ? c.usd : 0), 0),
    })
  })
  const busy = new Set(
    lanes.filter((l) => l.calls.length > 0 || l.units.length > 0 || l.turns.length > 0).map((l) => l.branch),
  )
  return withBounds(
    lanes.filter((l) => (l.main ? busy.has(l.branch) : l.calls.length > 0 || l.units.length > 0)),
    tl.spans.flatMap(([a, b]) => {
      if (a >= hi || b < lo) return []
      // work that goes on past the window does not stretch its axis; a turn that starts inside is whole
      return [[Math.max(a, lo), whole && !workSpans.has(`${a}/${b}`) ? b : Math.min(b, hi)] as [number, number]]
    }),
  )
}

/**
 * The window the plot really shows for the brushed `w`: the same, grown at either edge so that a turn
 * it cuts is whole, which is how far the axis would reach. Both edges follow the one rule: a turn is
 * made whole only when that grows neither side by more than the window's own width, so that a long turn
 * can still be zoomed into (it is then cut at the edges). Not repeated: what the grown parts reach into
 * is not added.
 */
export function effectiveWindow(tl: Timeline, w: Win): Win {
  const workSpans = new Set(tl.lanes.flatMap((l) => l.units.map((u) => `${u.startMs}/${Math.max(u.startMs, u.endMs)}`)))
  const width = w.hi - w.lo
  let lo = w.lo
  let hi = w.hi
  for (const [a, b] of tl.spans) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < w.lo || a >= w.hi || workSpans.has(`${a}/${b}`)) continue
    if (w.lo - a > width || b - w.hi > width) continue
    lo = Math.min(lo, a)
    // a window is open at the right and a turn ends on its last call: one millisecond more keeps that call
    hi = Math.max(hi, b + 1)
  }
  return lo === w.lo && hi === w.hi ? w : { lo, hi }
}

/** The part of a timeline the plot shows for the brushed `w`: all of its effective window, nothing past it. */
export const sliceWindow = (tl: Timeline, eff: Win) => sliceTimeline(tl, eff.lo, eff.hi, false)

/** The part of a timeline on one day. */
export const sliceDay = (tl: Timeline, day: Day) => sliceTimeline(tl, day.lo, day.hi)

/** The first and last moment a window can have: a little beyond the tree's activity. */
export const boundsOf = (tl: Timeline): { t0: number; t1: number } => ({ t0: tl.t0 - 1, t1: tl.t1 + 1 })

/** How much of a tree is activity: the time in which something ran, idle stretches left out. */
export function activeMs(tl: Timeline): number {
  return mergeSpans(tl.spans, GAP_MS).reduce((s, [a, b]) => s + (b - a), 0)
}

/** A window around `[t0, t1]`, a little wider (2%, between a minute and half an hour). */
export function windowAround(t0: number, t1: number): Win {
  const pad = Math.min(MAX_PAD_MS, Math.max(MIN, (t1 - t0) * 0.02))
  return { lo: t0 - pad, hi: t1 + pad }
}

/** The window that snaps to a day: its activity with a little pad, never into the next day's. */
export function snapDay(day: Day): Win {
  const w = windowAround(day.t0, day.t1)
  return { lo: Math.max(day.lo, w.lo), hi: Math.min(day.hi, w.hi) }
}

/** The day a window is (index into `days`), or -1. */
export function windowDay(w: Win, days: readonly Day[]): number {
  return days.findIndex((d) => {
    const s = snapDay(d)
    return Math.abs(s.lo - w.lo) < 1000 && Math.abs(s.hi - w.hi) < 1000
  })
}

/** A window inside `b`, at least `min` wide, keeping its width where it can. */
export function clampWindow(w: Win, b: { t0: number; t1: number }, min = MIN_WINDOW_MS): Win {
  const width = Math.max(min, w.hi - w.lo)
  if (width >= b.t1 - b.t0) return { lo: b.t0, hi: b.t1 }
  const lo = Math.min(Math.max(w.lo, b.t0), b.t1 - width)
  return { lo, hi: lo + width }
}

/** The window from dragging out a new range between two moments. */
export function dragWindow(a: number, b: number, bounds: { t0: number; t1: number }): Win {
  return clampWindow({ lo: Math.min(a, b), hi: Math.max(a, b) }, bounds)
}

/** The window with one edge moved to `t`, the other kept, and not narrower than the minimum. */
export function resizeWindow(w: Win, edge: 'lo' | 'hi', t: number, bounds: { t0: number; t1: number }): Win {
  if (edge === 'lo') return { lo: Math.max(bounds.t0, Math.min(t, w.hi - MIN_WINDOW_MS)), hi: w.hi }
  return { lo: w.lo, hi: Math.min(bounds.t1, Math.max(t, w.lo + MIN_WINDOW_MS)) }
}

/** The window moved to be centred on `t`, same width. */
export function centerWindow(w: Win, t: number, bounds: { t0: number; t1: number }): Win {
  const half = (w.hi - w.lo) / 2
  return clampWindow({ lo: t - half, hi: t + half }, bounds)
}

/**
 * The window that has `t` in view: the same one when it does; when it is a day, the day `t` is on;
 * otherwise one of the same width centred on `t`.
 */
export function revealWindow(w: Win, t: number, days: readonly Day[], bounds: { t0: number; t1: number }): Win {
  if (!Number.isFinite(t) || (t >= w.lo && t < w.hi)) return w
  if (windowDay(w, days) >= 0) {
    const k = dayAt(days, t)
    if (k >= 0) return snapDay(days[k])
  }
  return centerWindow(w, t, bounds)
}

/** The window one step to `dir` (-1 or 1): the previous or next day when it is a day, else its own width. */
export function stepWindow(w: Win, dir: -1 | 1, days: readonly Day[], bounds: { t0: number; t1: number }): Win {
  const k = windowDay(w, days)
  if (k >= 0) return snapDay(days[Math.max(0, Math.min(days.length - 1, k + dir))])
  const width = w.hi - w.lo
  return clampWindow({ lo: w.lo + dir * width, hi: w.hi + dir * width }, bounds)
}

/** A run of work with no idle stretch over EPISODE_GAP_MS in it and no night cut. */
export interface Episode {
  t0: number
  t1: number
  usd: number
}

/** The work episodes of a timeline, in order. */
export function episodes(tl: Timeline, days: readonly Day[], gap = EPISODE_GAP_MS): Episode[] {
  const turns = tl.lanes.flatMap((l) => l.turns.map((s) => [s.t0, s.t1] as [number, number]))
  const pieces = mergeSpans([...tl.spans, ...turns], 0)
  const cuts = days.slice(1).map((d) => d.lo)
  const out: Episode[] = []
  for (const [a, b] of pieces) {
    const last = out[out.length - 1]
    if (last && a - last.t1 <= gap && !cuts.some((c) => c > last.t1 && c <= a)) last.t1 = Math.max(last.t1, b)
    else out.push({ t0: a, t1: b, usd: 0 })
  }
  for (const l of tl.lanes)
    for (const c of l.calls) {
      const e = out.find((x) => c.t >= x.t0 && c.t <= x.t1)
      if (e) e.usd += c.usd
    }
  return out
}

/**
 * The window to show first: the day of the last work episode, unless that episode spent under 1% of
 * the tree (a resume that only compacted, say), then of the last that spent more. With `at` (a turn
 * asked for), the day of the episode that holds that moment. An episode alone is too narrow a default
 * (a day of three sittings would open on its last half hour); a tree with no night in it, whose one
 * "day" runs for days, opens on the episode instead.
 */
export function defaultWindow(tl: Timeline, days: readonly Day[], at?: number): Win {
  const eps = episodes(tl, days)
  if (eps.length === 0) return { lo: tl.t0, hi: tl.t1 + 1 }
  const total = eps.reduce((s, e) => s + e.usd, 0)
  const asked = at !== undefined && Number.isFinite(at) ? eps.find((e) => at >= e.t0 && at <= e.t1) : undefined
  const pick = asked ?? eps.findLast((e) => e.usd >= total * 0.01) ?? eps[eps.length - 1]
  const k = dayAt(days, pick.t0)
  const day = k >= 0 ? days[k] : undefined
  return day && day.t1 - day.t0 <= 30 * HOUR ? snapDay(day) : windowAround(pick.t0, pick.t1)
}

/** `?from=` and `?to=`: milliseconds, or anything Date.parse reads. */
export function parseTime(s: string | null): number | undefined {
  if (!s) return undefined
  const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s)
  return Number.isFinite(t) ? t : undefined
}

// ---- the overview strip -------------------------------------------------------------------

/** Pixel columns of `step` between the axis' ends. */
const columns = (axis: TimeAxis, step: number) => Math.max(1, Math.ceil((axis.x1 - axis.x0) / step))
const columnOf = (axis: TimeAxis, step: number, n: number, t: number) =>
  Math.max(0, Math.min(n - 1, Math.floor((axis.x(t) - axis.x0) / step)))

/**
 * The context of the tree's main agents in columns of `step` pixels: the largest of the main lanes'
 * context in each, a call's context held until the next call unless the pause is longer than HOLD_MS.
 */
export function contextEnvelope(tl: Timeline, axis: TimeAxis, step: number): number[] {
  const n = columns(axis, step)
  const out = new Array<number>(n).fill(0)
  for (const l of tl.lanes) {
    if (!l.main) continue
    const pts = l.series.find((s) => s.own)?.points ?? []
    pts.forEach((p, i) => {
      const next = pts[i + 1]
      const a = columnOf(axis, step, n, p.t)
      const b = next && next.t - p.t <= HOLD_MS ? columnOf(axis, step, n, next.t) : a
      for (let c = a; c <= b; c++) out[c] = Math.max(out[c], p.tokens)
    })
  }
  return out
}

/** What the tree spent in each column of `step` pixels, in a bar's parts (`addCall`). */
export function spendDensity(tl: Timeline, axis: TimeAxis, step: number, split: Split): Record<string, number>[] {
  const n = columns(axis, step)
  const out = Array.from({ length: n }, () => ({}) as Record<string, number>)
  for (const l of tl.lanes) for (const c of l.calls) addCall(out[columnOf(axis, step, n, c.t)], c, split)
  return out
}

/**
 * The window a click on the calendar day starting at local midnight `m` snaps to: the day `splitDays`
 * made of it when there is one that is about a day long, else that calendar day's own activity (cut
 * at its midnights); undefined when nothing ran on it.
 */
export function snapTarget(tl: Timeline, days: readonly Day[], m: number): Win | undefined {
  const day = days.find((d) => d.date === m && d.t1 - d.t0 <= 30 * HOUR)
  if (day) return snapDay(day)
  const next = midnight(m, 1)
  const hit = tl.spans.filter(([a, b]) => a < next && b >= m)
  if (hit.length === 0) return undefined
  const first = Math.min(...hit.map(([a]) => Math.max(a, m)))
  const last = Math.max(...hit.map(([, b]) => Math.min(b, next)))
  return windowAround(first, last)
}

/** Local midnight of the day `t` is on. */
export const dayStart = (t: number) => midnight(t)

/** The local midnights from just after `t0` up to `t1`. */
export function midnightsBetween(t0: number, t1: number): number[] {
  const out: number[] = []
  for (let m = midnight(t0, 1); m <= t1; m = midnight(m, 1)) out.push(m)
  return out
}

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

// ---- swarms -----------------------------------------------------------------------------

/** Fewer one-shot agents launched together than this are not a swarm. */
export const SWARM_MIN = 4
/** Agents of a swarm overlap or come within this of one another. */
export const SWARM_GAP_MS = 10_000

/** One swarm of the full timeline: its agents' lanes, found by `findSwarms`. */
export interface Swarm {
  /** Stable: the branch, the sender, the turn of launch and the first agent. */
  id: string
  keys: string[]
}

/** What a lane knows of the swarm it belongs to, or stands for. */
export interface SwarmInfo {
  id: string
  /** The lane stands for the whole swarm (otherwise it is one agent of an expanded one). */
  collapsed: boolean
  /** The first agent of an expanded swarm: it carries the collapse chip. */
  first: boolean
  count: number
  /** Agent types with how many of each, the most first. */
  types: [string, number][]
  /** Models of the calls, the most expensive first. */
  models: string[]
  /** "Haiku 5.5" when all calls ran on one model, else "mixed"; empty without calls. */
  modelText: string
  /** Of a collapsed swarm: the largest context of its agents over time (`swarmEnvelope`). */
  envelope: Point[]
}

const isOneShot = (l: Lane) =>
  !l.main &&
  l.agent?.kind === 'subagent' &&
  l.kind === 'subagent' &&
  l.units.length === 1 &&
  !l.units[0].woken &&
  Number.isFinite(l.t0) &&
  Number.isFinite(l.t1)

/**
 * The swarms of a timeline's lanes: at least `min` one-shot agents (sub-agents: not addressable, not a
 * fork, not a workflow) launched by the same sender in the same turn of the main row, whose lives overlap
 * or come within `gapMs` of one another (a chain: each joins what it overlaps). Find them on the whole
 * timeline, before a window cuts it, so that a swarm keeps its id.
 */
export function findSwarms(lanes: readonly Lane[], min = SWARM_MIN, gapMs = SWARM_GAP_MS): Swarm[] {
  const groups = new Map<string, Lane[]>()
  for (const l of lanes) {
    if (!isOneShot(l)) continue
    const key = `${l.branch}/${l.units[0].from ?? 'main'}/${l.units[0].launch}`
    groups.set(key, [...(groups.get(key) ?? []), l])
  }
  const out: Swarm[] = []
  for (const [key, mine] of groups) {
    mine.sort((a, b) => a.t0 - b.t0)
    let run: Lane[] = []
    let end = Number.NEGATIVE_INFINITY
    const flush = () => {
      if (run.length >= min) out.push({ id: `${key}/${run[0].agent?.id ?? run[0].key}`, keys: run.map((l) => l.key) })
      run = []
    }
    for (const l of mine) {
      if (run.length > 0 && l.t0 > end + gapMs) flush()
      run.push(l)
      end = run.length === 1 ? l.t1 : Math.max(end, l.t1)
    }
    flush()
  }
  return out
}

/** Types, models and the label of a swarm's agents. */
function summarize(id: string, members: readonly Lane[], collapsed: boolean, first: boolean): SwarmInfo {
  const count = members.length
  const types = new Map<string, number>()
  for (const l of members) {
    const t = l.agent?.agentType ?? l.agent?.name ?? 'agent'
    types.set(t, (types.get(t) ?? 0) + 1)
  }
  const usd = new Map<string, number>()
  for (const l of members) for (const c of l.calls) if (c.model) usd.set(c.model, (usd.get(c.model) ?? 0) + c.usd)
  const models = [...usd].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([m]) => m)
  const labels = new Set(models.map(modelLabel))
  return {
    id,
    collapsed,
    first,
    count,
    types: [...types].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    models,
    modelText: labels.size === 0 ? '' : labels.size === 1 ? [...labels][0] : 'mixed',
    envelope: collapsed ? swarmEnvelope(members) : [],
  }
}

/** The tier most of the calls' dollars went on (the heavier on a tie); unknown without calls. */
export function dominantTier(calls: readonly Pick<Call, 'tier' | 'usd'>[]): Tier {
  const by = new Map<Tier, number>()
  for (const c of calls) by.set(c.tier, (by.get(c.tier) ?? 0) + c.usd)
  let best: Tier = 'unknown'
  let most = -1
  for (const [t, v] of by) if (v > most || (v === most && heavierTier(best, t) === t)) [best, most] = [t, v]
  return best
}

/**
 * The largest context any of the agents carries at each moment, as a step run: each agent counts from
 * its first call to its last, and the run drops when the last one is over.
 */
export function swarmEnvelope(members: readonly Lane[]): Point[] {
  const own = members.map((l) => (l.series.find((s) => s.own) ?? l.series[0])?.points ?? []).filter((p) => p.length > 0)
  const times = [...new Set(own.flatMap((p) => [...p.map((x) => x.t), p[p.length - 1].t + 1]))].sort((a, b) => a - b)
  const out: Point[] = []
  for (const t of times) {
    let v = 0
    for (const p of own) if (t >= p[0].t && t <= p[p.length - 1].t) v = Math.max(v, pointAt(p, t)?.tokens ?? 0)
    if (out.length === 0 ? v > 0 : out[out.length - 1].tokens !== v) out.push({ t, tokens: v })
  }
  return out
}

/** One lane standing for a whole swarm's agents (a window may have cut some of them). */
export function mergeSwarm(id: string, members: readonly Lane[]): Lane {
  const info = summarize(id, members, true, false)
  const calls = members.flatMap((l) => l.calls).sort((a, b) => a.t - b.t)
  const t0 = Math.min(...members.map((l) => l.t0))
  const t1 = Math.max(...members.map((l) => l.t1))
  const units = members.flatMap((l) => l.units)
  const types = info.types
  const lane = mkLane(`${members[0].branch}/swarm:${id}`, members[0].branch, false, undefined, 'subagent', '')
  lane.title = types.length === 1 ? `${info.count} × ${types[0][0]}` : `${info.count} agents`
  lane.units = units
  lane.calls = calls
  lane.model = info.models.length === 1 ? info.models[0] : mainModel(calls)
  // one run on the swarm's dominant tier: its spine is as heavy as most of its spend
  lane.runs = Number.isFinite(t0) ? [{ t0, t1, model: lane.model, tier: dominantTier(calls) }] : []
  lane.series = envelopeSeries(members)
  lane.misses = members.flatMap((l) => l.misses).sort((a, b) => a.t - b.t)
  lane.compactions = members.flatMap((l) => l.compactions).sort((a, b) => a.t - b.t)
  lane.usd = members.reduce((s, l) => s + l.usd, 0)
  lane.peak = Math.max(0, ...members.map((l) => l.peak))
  lane.t0 = t0
  lane.t1 = t1
  lane.swarm = info
  return lane
}

/** The agents' contexts as lines (not owned: no area), every one of every agent. */
const envelopeSeries = (members: readonly Lane[]): Series[] =>
  members.flatMap((l) => l.series.map((s) => ({ ...s, own: false })))

/**
 * `lanes` with each swarm in `swarms` that still has two agents in them (a window cuts agents away)
 * turned into one lane, or, when its id is in `expanded`, left as the individual lanes with the swarm
 * noted on each (the first one carries the collapse chip). The swarm's lane takes its first agent's place.
 */
export function collapseSwarms(
  lanes: readonly Lane[],
  swarms: readonly Swarm[],
  expanded: ReadonlySet<string>,
): Lane[] {
  const byKey = new Map(lanes.map((l) => [l.key, l]))
  const swap = new Map<string, Lane | null>()
  for (const s of swarms) {
    const members = s.keys.flatMap((k) => byKey.get(k) ?? [])
    if (members.length < 2) continue
    if (expanded.has(s.id)) {
      const info = summarize(s.id, members, false, false)
      for (const [i, m] of members.entries()) swap.set(m.key, { ...m, swarm: { ...info, first: i === 0 } })
    } else {
      for (const [i, m] of members.entries()) swap.set(m.key, i === 0 ? mergeSwarm(s.id, members) : null)
    }
  }
  return lanes.flatMap((l) => {
    const r = swap.get(l.key)
    return r === undefined ? [l] : r ? [r] : []
  })
}

/** The swarm a piece of work belongs to, by its id: the id of the swarm among `swarms`, if any. */
export function swarmOfUnit(lanes: readonly Lane[], swarms: readonly Swarm[], branch: number, unitId: string) {
  const lane = lanes.find((l) => l.branch === branch && l.units.some((u) => u.id === unitId))
  return lane ? swarms.find((s) => s.keys.includes(lane.key)) : undefined
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

// ---- spend bars -----------------------------------------------------------------------

/**
 * Where a spend bar is drawn, in time. Spend is binned into slots of `[a, b)`, but a bar over the
 * whole slot would start before the call it stands for (even before its agent was launched) and run
 * past the end of a turn. It is drawn over the part of the slot in which the row was running: the
 * slot intersected with the `busy` stretches (sorted, not overlapping) that hold one of its `calls`,
 * from the first to the last of them; a call outside every stretch counts as a stretch of no length.
 * When that is narrower than `minMs` it is widened to it, centred on the calls.
 */
export function barSpan(
  slot: readonly [number, number],
  calls: readonly number[],
  busy: readonly { t0: number; t1: number }[],
  minMs = 0,
): [number, number] {
  const [a, b] = slot
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  for (const t of calls) {
    first = Math.min(first, t)
    last = Math.max(last, t)
    // the last stretch that starts at or before t
    let l = 0
    let h = busy.length - 1
    let k = -1
    while (l <= h) {
      const mid = (l + h) >> 1
      if (busy[mid].t0 <= t) {
        k = mid
        l = mid + 1
      } else h = mid - 1
    }
    const s = k >= 0 && t <= busy[k].t1 ? busy[k] : { t0: t, t1: t }
    lo = Math.min(lo, Math.max(a, s.t0))
    hi = Math.max(hi, Math.min(b, s.t1))
  }
  if (!Number.isFinite(first)) return [a, a]
  if (hi < lo) [lo, hi] = [first, last]
  if (hi - lo < minMs) {
    const mid = (first + last) / 2
    return [mid - minMs / 2, mid + minMs / 2]
  }
  return [lo, hi]
}

/** Stretches sorted by start, with those that overlap or touch joined. */
export function mergeBusy(busy: readonly { t0: number; t1: number }[], gap = 0): { t0: number; t1: number }[] {
  const out: { t0: number; t1: number }[] = []
  for (const s of [...busy].filter((x) => Number.isFinite(x.t0) && Number.isFinite(x.t1)).sort((x, y) => x.t0 - y.t0)) {
    const top = out[out.length - 1]
    if (top && s.t0 - top.t1 <= gap) top.t1 = Math.max(top.t1, s.t1)
    else out.push({ t0: s.t0, t1: Math.max(s.t0, s.t1) })
  }
  return out
}

// ---- level of detail ------------------------------------------------------------------

/** Above this many pixels per turn, every decision and turn is drawn. */
export const FULL_TURN_PX = 40
/** Below it, turns are one merged band on the baseline instead of a mark each. */
export const BAND_TURN_PX = 12
/** How many decisions keep their bracket when there are too many turns for all of them. */
export const TOP_DECISIONS = 8
/** Turn stretches closer than this merge in the band. */
export const BAND_GAP_PX = 3

export type Detail = 'full' | 'top' | 'band'

/** The median distance between the starts of consecutive turns: the room each has on the axis. */
export function pxPerTurn(xs: readonly number[]): number {
  const d = xs
    .slice(1)
    .map((x, i) => x - xs[i])
    .sort((p, q) => p - q)
  return d.length ? d[d.length >> 1] : Number.POSITIVE_INFINITY
}

/** How much of the turns and decisions is drawn at `px` pixels per turn. */
export const detailAt = (px: number): Detail => (px > FULL_TURN_PX ? 'full' : px >= BAND_TURN_PX ? 'top' : 'band')

/**
 * The decisions that get a bracket: all of them in full detail; otherwise the `k` most expensive and
 * those in `focus` (the hovered and the pinned turn's). The others show only their prompt dot.
 */
export function bracketed(
  decisions: readonly { index: number; usd: number }[],
  detail: Detail,
  focus: readonly (number | undefined)[] = [],
  k = TOP_DECISIONS,
): Set<number> {
  if (detail === 'full') return new Set(decisions.map((d) => d.index))
  const top = [...decisions].sort((a, b) => b.usd - a.usd || a.index - b.index).slice(0, k)
  const out = new Set(top.map((d) => d.index))
  for (const f of focus) if (f !== undefined) out.add(f)
  return out
}

// ---- topology and model tier ----------------------------------------------------------

/** The last point at or before `t`. */
export function pointAt(points: readonly Point[], t: number): Point | undefined {
  let lo = 0
  let hi = points.length - 1
  let best: Point | undefined
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].t <= t) {
      best = points[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}

/**
 * The context a fork copied from its parent: the parent's context at the moment of the fork
 * (`parent`: its own points, in time order), capped at the fork's first context, which holds it. 0 when
 * the parent has no call by then (it is outside the window) or the fork has no call.
 */
export function inheritedContext(parent: readonly Point[], t: number, first: number): number {
  const p = pointAt(parent, t)
  return p && first > 0 ? Math.min(p.tokens, first) : 0
}

/** The stroke width in pixels of a model tier: what it costs to run, as weight. */
export const TIER_WEIGHT: Record<Tier, number> = { heavy: 3.5, mid: 2, light: 1, unknown: 1 }

/** The weight of a branch's spine: its first model's tier; the middle weight when that is missing or unknown. */
export const branchWeight = (tier: Tier | undefined): number =>
  tier && tier !== 'unknown' ? TIER_WEIGHT[tier] : TIER_WEIGHT.mid

/**
 * The weight of a session's carrier line at `t`: the tier of the model in effect then (the last run that
 * started by `t`; before the first run, the first run's), the middle weight when there is none or it is unknown.
 */
export const carrierWeight = (runs: readonly ModelRun[], t: number): number =>
  branchWeight((runs.findLast((r) => r.t0 <= t) ?? runs[0])?.tier)

/**
 * What a session of a tree is to the others, said in a few words: the trunk is the original, a fork names
 * the turn it left at, a continuation is just continued. The session the page is about is marked.
 */
export function branchRole(
  kind: 'fork' | 'continuation' | undefined,
  atTurn: number | undefined,
  current: boolean,
): string {
  const role = kind === undefined ? 'original' : kind === 'continuation' ? 'continued' : `fork of turn ${atTurn ?? '?'}`
  return current ? `${role} · this session` : role
}

/** Tiers from the heaviest to the lightest, to compare them. */
const TIER_RANK: Record<Tier, number> = { heavy: 3, mid: 2, light: 1, unknown: 0 }

/** The heavier of two tiers. */
export const heavierTier = (a: Tier, b: Tier): Tier => (TIER_RANK[b] > TIER_RANK[a] ? b : a)

/** A stretch of time on one tier. */
export interface TierSegment {
  t0: number
  t1: number
  tier: Tier
}

/**
 * A spine from `t0` to `t1` cut by the model `runs` of its lane: a segment per run, from where the run
 * starts to where the next one does (a gap between two runs keeps the weight of the one before; the
 * first run's tier reaches back to `t0`). Without runs it is one stretch of the unknown tier.
 */
export function tierSegments(runs: readonly ModelRun[], t0: number, t1: number): TierSegment[] {
  if (!(t1 >= t0)) return []
  if (runs.length === 0) return [{ t0, t1, tier: 'unknown' }]
  const out: TierSegment[] = []
  runs.forEach((r, i) => {
    const a = i === 0 ? t0 : Math.max(t0, r.t0)
    const b = Math.min(t1, runs[i + 1] ? Math.max(t0, runs[i + 1].t0) : t1)
    if (b > a) out.push({ t0: a, t1: b, tier: r.tier })
  })
  if (out.length === 0) out.push({ t0, t1, tier: runs[0].tier })
  return out
}

/**
 * The tier a main-row turn ran on: the heaviest of the runs that hold a call of it (`t0` to `t1`), else
 * the run that was current at its start (the first one before any), else unknown.
 */
export function turnTier(runs: readonly ModelRun[], t0: number, t1: number): Tier {
  let tier: Tier | undefined
  for (const r of runs) if (r.t1 >= t0 && r.t0 <= t1) tier = tier ? heavierTier(tier, r.tier) : r.tier
  if (tier) return tier
  const before = runs.findLast((r) => r.t0 <= t0)
  return (before ?? runs[0])?.tier ?? 'unknown'
}

/** Stretches with a weight, sorted, those no more than `gap` apart joined; a joined stretch takes the heaviest weight. */
export function mergeWeighted<T extends { t0: number; t1: number; weight: number }>(
  items: readonly T[],
  gap = 0,
): { t0: number; t1: number; weight: number }[] {
  const out: { t0: number; t1: number; weight: number }[] = []
  for (const s of [...items]
    .filter((x) => Number.isFinite(x.t0) && Number.isFinite(x.t1))
    .sort((x, y) => x.t0 - y.t0)) {
    const top = out[out.length - 1]
    if (top && s.t0 - top.t1 <= gap) {
      top.t1 = Math.max(top.t1, s.t1)
      top.weight = Math.max(top.weight, s.weight)
    } else out.push({ t0: s.t0, t1: Math.max(s.t0, s.t1), weight: s.weight })
  }
  return out
}

/**
 * Where a lane's model label goes: the start of its first run, and every run on another model than the
 * one before. `label` names a model; two runs that read the same are one.
 */
export function modelMarks(runs: readonly ModelRun[], label: (m: string) => string): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = []
  for (const r of runs) {
    const text = label(r.model)
    if (r.model && text !== out[out.length - 1]?.text) out.push({ t: r.t0, text })
  }
  return out
}
