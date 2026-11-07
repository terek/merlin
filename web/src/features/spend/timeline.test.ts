import { describe, expect, test } from 'bun:test'
import type { Agent, AgentTurn, Message, SessionDetail, Turn } from '../../api/types'
import type { Col } from './model'
import {
  addCall,
  barSpan,
  boundsOf,
  bracketed,
  buildTimeline,
  centerWindow,
  clampWindow,
  contextEnvelope,
  dayAt,
  defaultWindow,
  detailAt,
  dragWindow,
  episodes,
  GAP_MS,
  heavierTier,
  inheritedContext,
  type Lane,
  MIN_WINDOW_MS,
  type ModelRun,
  mergeBusy,
  mergeWeighted,
  modelMarks,
  packLanes,
  parseTime,
  pxPerTurn,
  resizeWindow,
  revealWindow,
  sliceDay,
  sliceTimeline,
  slotLength,
  snapDay,
  snapTarget,
  spendDensity,
  splitDays,
  splitHeld,
  stepWindow,
  TIER_WEIGHT,
  type Timeline,
  tierSegments,
  tierSpend,
  timeAxis,
  turnPlace,
  turnTier,
  windowDay,
} from './timeline'
import { buildTree } from './tree'

const T0 = Date.UTC(2026, 0, 1, 10, 0)
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

const turn = (index: number, start: number, end: number, extra: Partial<Turn> = {}): Turn => ({
  index,
  epoch: 0,
  origin: 'human',
  userText: `prompt ${index}`,
  startedAt: at(start),
  endedAt: at(end),
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 0 },
  costWithAgents: 0,
  ...extra,
})

const msg = (id: string, min: number, context: number, extra: Partial<Message> = {}): Message => ({
  id,
  at: at(min),
  model: 'model-a',
  usd: 0.01 + context / 1e6,
  input: 10,
  cacheRead: context - 10,
  output: 100,
  ...extra,
})

const agentTurn = (index: number, start: number, end: number, rootTurn: number): AgentTurn => ({
  index,
  startedAt: at(start),
  endedAt: at(end),
  origin: index === 0 ? 'spawn' : 'peer',
  rootTurn,
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 0 },
})

const agent = (id: string, extra: Partial<Agent>): Agent => ({
  id,
  kind: 'subagent',
  name: id,
  parentAgentId: null,
  depth: 1,
  linkage: 'tool-result',
  status: 'completed',
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 0 },
  subtreeUSD: 0,
  ...extra,
})

const session = (
  id: string,
  digest: { turns: Turn[]; messages: Message[]; agents?: Agent[] },
  inherited: number[] = [],
) =>
  ({
    summary: { key: { harness: 'claude', id }, title: `session ${id}` },
    cost: { overheadUSD: 0 },
    lineage: { children: [], inheritedTurns: inherited },
    digest: { agents: [], compactions: [], ...digest },
  }) as unknown as SessionDetail

describe('timeAxis', () => {
  const H = 60 * 60_000
  // an hour of work, three hours of nothing, half an hour of work
  const axis = timeAxis(
    [
      [T0, T0 + H],
      [T0 + 4 * H, T0 + 4.5 * H],
    ],
    100,
    1100,
  )

  test('idle time longer than the gap is a break; the rest is on one scale', () => {
    expect(axis.pieces).toHaveLength(2)
    expect(axis.breaks).toHaveLength(1)
    const [a, b] = axis.pieces
    expect((a.x1 - a.x0) / (a.t1 - a.t0)).toBeCloseTo((b.x1 - b.x0) / (b.t1 - b.t0), 9)
    expect(axis.breaks[0].x0).toBeCloseTo(a.x1, 9)
    expect(axis.breaks[0].x1).toBeCloseTo(b.x0, 9)
    expect(b.x1).toBeCloseTo(1100, 6)
  })

  test("x and t are each other's inverse, and x grows with t", () => {
    for (const t of [T0, T0 + 0.5 * H, T0 + 2 * H, T0 + 4.2 * H]) expect(axis.t(axis.x(t))).toBeCloseTo(t, 0)
    const xs = [0, 0.5, 1, 2, 3, 4, 4.5].map((h) => axis.x(T0 + h * H))
    expect([...xs].sort((p, q) => p - q)).toEqual(xs)
  })

  test('spans closer than the gap are one piece', () => {
    const one = timeAxis(
      [
        [T0, T0 + H],
        [T0 + H + GAP_MS / 2, T0 + 2 * H],
      ],
      0,
      500,
    )
    expect(one.breaks).toHaveLength(0)
  })

  test('with many pauses, only the longer ones become breaks', () => {
    // 30 bursts of work, 15 minutes apart, and one pause of a day
    const spans: [number, number][] = Array.from({ length: 30 }, (_, i) => [
      T0 + i * 20 * 60_000,
      T0 + i * 20 * 60_000 + 5 * 60_000,
    ])
    spans.push([T0 + 30 * H, T0 + 31 * H])
    const many = timeAxis(spans, 0, 1000)
    expect(many.breaks).toHaveLength(1)
    expect(many.breaks[0].t1 - many.breaks[0].t0).toBeGreaterThan(20 * H)
  })

  test('a spend slot is a round length at least the asked width', () => {
    const s = slotLength(axis, 4)
    expect([15_000, 30_000, 60_000, 120_000, 300_000, 600_000]).toContain(s)
    expect(s * axis.scale).toBeGreaterThanOrEqual(4)
  })
})

describe('buildTimeline', () => {
  // the main agent works in turn 0 (10:00-10:20, the harness closed it at 14:00) and turn 1 (12:00);
  // "worker" is an addressable agent with two pieces of work and a sub-agent of its own
  const worker = agent('worker', {
    addressable: true,
    spawnTurn: 0,
    startedAt: at(1),
    endedAt: at(125),
    turns: [agentTurn(0, 1, 10, 0), agentTurn(1, 121, 125, 1)],
  })
  const helper = agent('helper', { parentAgentId: 'worker', depth: 2, startedAt: at(3), endedAt: at(5) })
  const detail = session('s', {
    turns: [turn(0, 0, 240), turn(1, 120, 126)],
    messages: [
      msg('m0', 0, 20_000, { turn: 0 }),
      msg('m1', 20, 30_000, { turn: 0 }),
      msg('w0', 2, 10_000, { agentId: 'worker', agentTurn: 0 }),
      msg('h0', 4, 5_000, { agentId: 'helper' }),
      msg('w1', 9, 50_000, { agentId: 'worker', agentTurn: 0 }),
      msg('m2', 120, 40_000, { turn: 1 }),
      msg('w2', 122, 60_000, { agentId: 'worker', agentTurn: 1 }),
    ],
    agents: [worker, helper],
  })
  const tl = buildTimeline(buildTree([detail]))
  const [main, lane] = tl.lanes

  test('a main lane, then a lane per agent the session launched', () => {
    expect(tl.lanes.map((l) => [l.main, l.agent?.id, l.kind])).toEqual([
      [true, undefined, 'main'],
      [false, 'worker', 'addressable'],
    ])
  })

  test('an agent lane pays for its own sub-agents, and draws their context apart', () => {
    expect(main.calls.map((c) => c.kind)).toEqual(['main', 'main', 'main'])
    expect(lane.calls).toHaveLength(4)
    expect(lane.usd).toBeCloseTo(0.04 + 0.125, 9)
    expect(lane.series.map((s) => [s.agentId, s.own, s.points.map((p) => p.tokens)])).toEqual([
      ['worker', true, [10_000, 50_000, 60_000]],
      ['helper', false, [5_000]],
    ])
    expect(lane.peak).toBe(60_000)
    expect(tl.peak).toBe(60_000)
  })

  test('a turn ends with the last thing that ran in it, not when the harness closed it', () => {
    expect(main.turns.map((s) => [s.col.index, s.t0, s.t1])).toEqual([
      [0, Date.parse(at(0)), Date.parse(at(20))],
      [1, Date.parse(at(120)), Date.parse(at(122))],
    ])
  })

  test('the axis has a break where nothing ran', () => {
    const axis = timeAxis(tl.spans, 0, 1000)
    expect(axis.breaks).toHaveLength(1)
    expect(axis.breaks[0].t0).toBeLessThan(Date.parse(at(22)))
    expect(axis.breaks[0].t1).toBeGreaterThan(Date.parse(at(118)))
  })

  test('a turn whose first call came hours after its prompt has a break inside it', () => {
    // the prompt fails at once, and the turn goes on two hours later; the 15 minutes between its
    // calls are its agent waiting on a tool, and stay
    const stalled = session('st', {
      turns: [turn(0, 0, 135)],
      messages: [msg('s0', 120, 20_000, { turn: 0 }), msg('s1', 135, 30_000, { turn: 0 })],
    })
    const own = buildTimeline(buildTree([stalled]))
    const axis = timeAxis(own.spans, 0, 1000)
    expect(own.lanes[0].turns.map((s) => [s.t0, s.t1])).toEqual([[Date.parse(at(0)), Date.parse(at(135))]])
    expect(axis.breaks).toHaveLength(1)
    expect(axis.breaks[0].t1).toBeLessThan(Date.parse(at(120)))
    expect(axis.breaks[0].t1 - axis.breaks[0].t0).toBeGreaterThan(100 * 60_000)
  })

  test('a forked session draws only what it ran itself', () => {
    const fork = session(
      'f',
      {
        turns: [turn(0, 0, 20), turn(1, 300, 310)],
        messages: [msg('c0', 0, 20_000, { turn: 0 }), msg('c1', 301, 70_000, { turn: 1 })],
      },
      [0],
    )
    const own = buildTimeline(buildTree([fork])).lanes[0]
    expect(own.calls.map((c) => c.t)).toEqual([Date.parse(at(301))])
    expect(own.turns.map((s) => s.col.index)).toEqual([1])
  })
})

describe('model tiers on a timeline', () => {
  const prices = {
    'opus-x': { input: 5, output: 25, cacheRead: 0.5 },
    'haiku-x': { input: 1, output: 5, cacheRead: 0.1 },
  }
  const detail = session('t', {
    turns: [turn(0, 0, 30)],
    messages: [
      msg('m0', 0, 20_000, { turn: 0, model: 'opus-x' }),
      msg('m1', 1, 21_000, { turn: 0, model: 'opus-x' }),
      msg('w0', 2, 10_000, { agentId: 'w', agentTurn: 0, model: 'haiku-x' }),
      msg('w1', 3, 11_000, { agentId: 'w', agentTurn: 0, model: 'claude-sonnet-9[1m]' }),
      msg('w2', 4, 12_000, { agentId: 'w', agentTurn: 0, model: 'haiku-x' }),
      msg('w3', 5, 13_000, { agentId: 'w', agentTurn: 0, model: 'haiku-x' }),
      msg('m2', 10, 22_000, { turn: 0, model: 'opus-x' }),
      msg('m3', 11, 22_000, { turn: 0, model: 'mystery' }),
    ],
    agents: [
      agent('w', { addressable: true, spawnTurn: 0, startedAt: at(2), endedAt: at(6), turns: [agentTurn(0, 2, 6, 0)] }),
    ],
  })
  const [main, worker] = buildTimeline(buildTree([detail]), prices).lanes

  test('a call knows its model and its tier', () => {
    expect(main.calls.map((c) => [c.model, c.tier])).toEqual([
      ['opus-x', 'heavy'],
      ['opus-x', 'heavy'],
      ['opus-x', 'heavy'],
      ['mystery', 'unknown'],
    ])
    // a model the table does not price falls back to its family by name
    expect(worker.calls.map((c) => c.tier)).toEqual(['light', 'mid', 'light', 'light'])
  })

  test('without prices every call falls back to the family rule', () => {
    const own = buildTimeline(buildTree([detail])).lanes
    expect(own[0].calls.map((c) => c.tier)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    expect(own[1].calls.map((c) => c.tier)).toEqual(['unknown', 'mid', 'unknown', 'unknown'])
  })

  test('a lane has its runs of consecutive calls on one model, and its main model', () => {
    expect(worker.runs.map((r) => [r.model, r.tier, r.t0, r.t1])).toEqual([
      ['haiku-x', 'light', Date.parse(at(2)), Date.parse(at(2))],
      ['claude-sonnet-9[1m]', 'mid', Date.parse(at(3)), Date.parse(at(3))],
      ['haiku-x', 'light', Date.parse(at(4)), Date.parse(at(5))],
    ])
    expect(worker.model).toBe('haiku-x')
    expect(main.runs.map((r) => [r.model, r.t0, r.t1])).toEqual([
      ['opus-x', Date.parse(at(0)), Date.parse(at(10))],
      ['mystery', Date.parse(at(11)), Date.parse(at(11))],
    ])
    expect(main.model).toBe('opus-x')
  })

  test('a slice recomputes them from the calls it keeps', () => {
    const tl = buildTimeline(buildTree([detail]), prices)
    const s = sliceTimeline(tl, Date.parse(at(3)), Date.parse(at(4)))
    expect(s.lanes.find((l) => !l.main)?.runs.map((r) => r.model)).toEqual(['claude-sonnet-9[1m]'])
    expect(s.lanes.find((l) => !l.main)?.model).toBe('claude-sonnet-9[1m]')
  })

  test('the tier spend lists each tier with its models, most expensive first', () => {
    const tl = buildTimeline(buildTree([detail]), prices)
    const ts = tierSpend(tl)
    expect(ts.map((x) => x.tier)).toEqual(['heavy', 'mid', 'light', 'unknown'])
    expect(ts[0].models.map((m) => m.model)).toEqual(['opus-x'])
    expect(ts[0].usd).toBeCloseTo(ts[0].models[0].usd, 9)
    expect(ts[2].models.map((m) => m.model)).toEqual(['haiku-x'])
  })

  test('the split by tier puts the whole call, cache miss included, in its tier', () => {
    const bar: Record<string, number> = {}
    const c = { usd: 1, reread: 0.4, tier: 'mid', kind: 'main', byClass: {} } as unknown as Lane['calls'][number]
    addCall(bar, c, 'tier')
    addCall(bar, { ...c, usd: 2, reread: 0, tier: 'heavy' }, 'tier')
    expect(bar).toEqual({ mid: 1, heavy: 2, total: 3 })
  })
})

describe('packLanes', () => {
  const lane = (key: string, kind: Lane['kind'], t0: number, t1: number, main = false): Lane =>
    ({
      key,
      branch: 0,
      main,
      kind,
      t0,
      t1,
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
      title: key,
    }) as Lane

  test('agents that do not overlap share a row, whatever their kind; the main lane comes first', () => {
    const rows = packLanes(
      [
        lane('main', 'main', 0, 100, true),
        lane('a', 'subagent', 0, 10),
        lane('b', 'addressable', 5, 50),
        lane('c', 'subagent', 20, 30),
        lane('d', 'fork', 60, 70),
      ],
      (t) => t * 10,
    )
    expect(rows.map((r) => r.lanes.map((l) => l.key))).toEqual([['main'], ['a', 'c', 'd'], ['b']])
  })
})

describe('splitHeld', () => {
  const busy = [
    { t0: 0, t1: 10 },
    { t0: 20, t1: 30 },
  ]
  test('a pause is split where a turn ends and the next begins', () => {
    expect(splitHeld(5, 25, busy)).toEqual([
      { t0: 5, t1: 10, busy: true },
      { t0: 10, t1: 20, busy: false },
      { t0: 20, t1: 25, busy: true },
    ])
  })
  test('a pause wholly between turns, or after the last, is idle', () => {
    expect(splitHeld(12, 18, busy)).toEqual([{ t0: 12, t1: 18, busy: false }])
    expect(splitHeld(28, 40, busy)).toEqual([
      { t0: 28, t1: 30, busy: true },
      { t0: 30, t1: 40, busy: false },
    ])
  })
})

describe('turnPlace', () => {
  const span = (index: number, t0: number, t1: number) => ({ col: { index } as Col, t0, t1 })
  const turns = [span(0, 0, 10), span(1, 50, 50), span(2, 50, 60)]
  test('in a turn, between two, after the last; a turn of no width within the slack', () => {
    const where = (t: number, slack = 0) => {
      const p = turnPlace(turns, t, slack)
      return p && 'turn' in p ? p.turn.col.index : p ? [p.after.col.index, p.next?.col.index] : undefined
    }
    expect(where(5)).toBe(0)
    expect(where(30)).toEqual([0, 1])
    expect(where(11, 2)).toBe(0)
    expect(where(55)).toBe(2)
    expect(where(70)).toEqual([2, undefined])
  })
})

describe('splitDays', () => {
  // local times, in a month with no change of clocks
  const h = (day: number, hour: number) => new Date(2026, 0, day, 0).getTime() + hour * 60 * 60_000
  const of = (...spans: [number, number][]): Timeline => ({ lanes: [], spans, peak: 0, t0: 0, t1: 0 })
  const dates = (tl: Timeline) => splitDays(tl).map((d) => new Date(d.date).getDate())

  test('two working days are two days, cut at the night between them', () => {
    const days = splitDays(of([h(5, 9), h(5, 17)], [h(6, 8), h(6, 12)]))
    expect(days.map((d) => new Date(d.date).getDate())).toEqual([5, 6])
    expect(days[0].hi).toBe(days[1].lo)
    expect(days[0].hi).toBeGreaterThan(h(5, 17))
    expect(days[0].hi).toBeLessThan(h(6, 8))
  })

  test('work past midnight with nothing after it stays with its evening', () => {
    expect(dates(of([h(5, 20), h(5, 23)], [h(5, 23.7), h(6, 1.5)]))).toEqual([5])
  })

  test('the night is cut at its longest pause, not at midnight', () => {
    // 20:00 to 01:30 with a pause at 23:00, then the next morning
    const days = splitDays(of([h(5, 20), h(5, 23)], [h(5, 23.7), h(6, 1.5)], [h(6, 10), h(6, 12)]))
    expect(days.map((d) => new Date(d.date).getDate())).toEqual([5, 6])
    expect(days[0].t1).toBe(h(6, 1.5))
  })

  test('a part is the calendar day it overlaps most; of two on one day, the first goes back a day', () => {
    // from 22:00 to 06:00 with no pause: the 6th
    expect(dates(of([h(5, 22), h(6, 6)], [h(8, 9), h(8, 10)]))).toEqual([6, 8])
    // the same, then the afternoon after a long pause: the night goes back to the 5th
    expect(dates(of([h(5, 22), h(6, 6)], [h(6, 15), h(6, 18)]))).toEqual([5, 6])
    // an early hour, a long pause, then the day: one day
    const days = splitDays(of([h(6, 4), h(6, 5)], [h(6, 10), h(6, 18)]))
    expect(days.map((d) => [new Date(d.date).getDate(), d.t0, d.t1])).toEqual([[6, h(6, 4), h(6, 18)]])
  })

  test('days with nothing are left out', () => {
    expect(dates(of([h(5, 9), h(5, 10)], [h(9, 9), h(9, 10)]))).toEqual([5, 9])
    expect(dates(of())).toEqual([])
  })

  test('a session that starts late in the evening is cut at its sleep, however short', () => {
    // 23:15 to 02:20, five hours of sleep, then the day
    expect(dates(of([h(1, 23.25), h(2, 2.33)], [h(2, 7.4), h(2, 22.7)]))).toEqual([1, 2])
  })

  test('a morning after a short sleep is not glued to the evening before', () => {
    expect(dates(of([h(5, 15), h(6, 4)], [h(6, 7), h(6, 7.5)]))).toEqual([5, 6])
  })

  test('a session on one day is one day', () => {
    expect(dates(of([h(5, 8), h(5, 9)], [h(5, 13), h(5, 14)], [h(5, 19), h(5, 21)]))).toEqual([5])
  })
})

describe('sliceTimeline', () => {
  // turn 0 on one day, turn 1 the next, and an agent launched in turn 1
  const helper = agent('helper', { spawnTurn: 1, startedAt: at(1442), endedAt: at(1450) })
  const detail = session('d', {
    turns: [turn(0, 0, 30), turn(1, 1440, 1460)],
    messages: [
      msg('a0', 1, 20_000, { turn: 0 }),
      msg('a1', 25, 90_000, { turn: 0 }),
      msg('b0', 1441, 30_000, { turn: 1 }),
      msg('h0', 1445, 10_000, { agentId: 'helper' }),
    ],
    agents: [helper],
  })
  const tl = buildTimeline(buildTree([detail]))
  const days = splitDays(tl)

  test('each day has only its own turns, calls, lanes and scale', () => {
    expect(days).toHaveLength(2)
    const [one, two] = days.map((d) => sliceDay(tl, d))
    expect(one.lanes.map((l) => l.key)).toEqual(['0/main'])
    expect(one.lanes[0].turns.map((s) => s.col.index)).toEqual([0])
    expect(one.peak).toBe(90_000)
    expect(two.lanes.map((l) => l.main)).toEqual([true, false])
    expect(two.lanes[0].turns.map((s) => s.col.index)).toEqual([1])
    expect(two.lanes[0].usd).toBeCloseTo(0.01 + 0.03, 9)
    expect(two.peak).toBe(30_000)
    expect(two.t0).toBeGreaterThanOrEqual(Date.parse(at(1440)))
    expect(dayAt(days, Date.parse(at(1441)))).toBe(1)
  })
})

describe('windows', () => {
  const h = (day: number, hour: number) => new Date(2026, 0, day, 0).getTime() + hour * 60 * 60_000
  const call = (t: number, usd = 1) => ({ t, usd }) as unknown as Lane['calls'][number]
  /** A timeline with one main lane that made a call of `usd` at each of the given times. */
  const tlOf = (...calls: [number, number?][]): Timeline => {
    const lane = {
      key: '0/main',
      branch: 0,
      main: true,
      units: [],
      turns: [],
      series: [],
      misses: [],
      compactions: [],
      calls: calls.map(([t, usd]) => call(t, usd)),
      usd: 0,
      peak: 0,
      t0: 0,
      t1: 0,
    } as unknown as Lane
    const times = calls.map(([t]) => t)
    return {
      lanes: [lane],
      spans: times.map((t) => [t, t] as [number, number]),
      peak: 0,
      t0: Math.min(...times),
      t1: Math.max(...times),
    }
  }
  const bounds = { t0: h(5, 0), t1: h(8, 0) }

  test('slicing by a range keeps what starts inside it', () => {
    const tl = tlOf([h(5, 9)], [h(5, 10)], [h(5, 11)])
    const s = sliceTimeline(tl, h(5, 9.5), h(5, 10.5))
    expect(s.lanes[0].calls.map((c) => c.t)).toEqual([h(5, 10)])
    expect(s.lanes[0].usd).toBe(1)
    expect(s.spans).toEqual([[h(5, 10), h(5, 10)]])
  })

  test('a piece of agent work that overlaps the window is kept, the others not', () => {
    const unit = (a: number, b: number) => ({ startMs: a, endMs: b, id: `${a}` }) as unknown as Lane['units'][number]
    const tl = tlOf([h(5, 9)])
    tl.lanes.push({
      ...tl.lanes[0],
      key: '0/a',
      main: false,
      calls: [],
      units: [unit(h(5, 8), h(5, 10)), unit(h(5, 1), h(5, 2))],
    })
    tl.spans.push([h(5, 8), h(5, 10)], [h(5, 1), h(5, 2)])
    const s = sliceTimeline(tl, h(5, 9), h(5, 12))
    expect(s.lanes[1].units).toHaveLength(1)
    // the span is cut at the left edge
    expect(s.spans).toContainEqual([h(5, 9), h(5, 10)])
    // work that runs on past the window is cut at its end
    expect(sliceTimeline(tl, h(5, 8.5), h(5, 9.5)).spans).toContainEqual([h(5, 8.5), h(5, 9.5)])
    expect(s.spans).toHaveLength(2)
  })

  test('an open range is the whole', () => {
    const tl = tlOf([h(5, 9)], [h(6, 9)])
    const s = sliceTimeline(tl, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
    expect(s.lanes[0].calls).toHaveLength(2)
  })

  test('episodes break at an idle stretch over two hours and at a night cut', () => {
    // 9:00-10:00, then 11:30 (an hour and a half later: the same), then 15:00 (over two hours: new)
    const tl = tlOf([h(5, 9)], [h(5, 10)], [h(5, 11.5)], [h(5, 15)], [h(5, 15.5)])
    const eps = episodes(tl, splitDays(tl))
    expect(eps.map((e) => [e.t0, e.t1])).toEqual([
      [h(5, 9), h(5, 11.5)],
      [h(5, 15), h(5, 15.5)],
    ])
    expect(eps.map((e) => e.usd)).toEqual([3, 2])
    // a night cut ends an episode even if the pause is short
    const night = tlOf([h(5, 22), 1], [h(5, 23.8), 1], [h(6, 1), 1], [h(6, 2), 1])
    const days = [
      { date: h(5, 0), t0: h(5, 22), t1: h(5, 23.8), lo: Number.NEGATIVE_INFINITY, hi: h(5, 24.5) },
      { date: h(6, 0), t0: h(6, 1), t1: h(6, 2), lo: h(5, 24.5), hi: Number.POSITIVE_INFINITY },
    ]
    expect(episodes(night, days)).toHaveLength(2)
    expect(episodes(night, [days[0]])).toHaveLength(1)
  })

  test('the first window is the day of the last episode, or of the one before when that spent next to nothing', () => {
    // three sittings on one day: the day, not its last sitting
    const one = tlOf([h(5, 9), 5], [h(5, 10), 5], [h(5, 20), 1])
    const d1 = splitDays(one)
    expect(defaultWindow(one, d1)).toEqual(snapDay(d1[0]))
    // the last day spent next to nothing: the day before
    const two = tlOf([h(5, 9), 5], [h(5, 17), 5], [h(6, 9), 0.01])
    const d2 = splitDays(two)
    expect(d2.length).toBe(2)
    expect(defaultWindow(two, d2)).toEqual(snapDay(d2[0]))
    // asked for a moment: the day of the episode it is in
    const busy = tlOf([h(5, 9), 5], [h(6, 9), 5])
    const d3 = splitDays(busy)
    expect(defaultWindow(busy, d3)).toEqual(snapDay(d3[1]))
    expect(defaultWindow(busy, d3, h(5, 9))).toEqual(snapDay(d3[0]))
    expect(defaultWindow({ lanes: [], spans: [], peak: 0, t0: 0, t1: 0 }, [])).toEqual({ lo: 0, hi: 1 })
  })

  test('a day snaps to its activity with a pad that stays inside the day', () => {
    const tl = tlOf([h(5, 9)], [h(5, 17)], [h(6, 8)], [h(6, 12)])
    const days = splitDays(tl)
    const w = snapDay(days[0])
    expect(w.lo).toBeLessThan(h(5, 9))
    expect(w.hi).toBeGreaterThan(h(5, 17))
    expect(w.hi).toBeLessThanOrEqual(days[0].hi)
    expect(windowDay(w, days)).toBe(0)
    expect(windowDay({ lo: w.lo + 3_600_000, hi: w.hi }, days)).toBe(-1)
  })

  test('a date label snaps to the day made of it, else to the activity of that calendar day', () => {
    const tl = tlOf([h(5, 9)], [h(5, 17)], [h(6, 8)], [h(6, 12)])
    const days = splitDays(tl)
    expect(snapTarget(tl, days, h(5, 0))).toEqual(snapDay(days[0]))
    expect(snapTarget(tl, [], h(6, 0))?.lo).toBeLessThan(h(6, 8))
    expect(snapTarget(tl, [], h(6, 0))?.lo).toBeGreaterThanOrEqual(h(6, 8) - 30 * 60_000)
    expect(snapTarget(tl, [], h(7, 0))).toBeUndefined()
  })

  test('windows stay inside the bounds and are never narrower than the minimum', () => {
    expect(clampWindow({ lo: h(4, 0), hi: h(4, 5) }, bounds)).toEqual({ lo: bounds.t0, hi: bounds.t0 + 5 * 3_600_000 })
    expect(clampWindow({ lo: h(7, 23), hi: h(9, 0) }, bounds)).toEqual({
      lo: bounds.t1 - 25 * 3_600_000,
      hi: bounds.t1,
    })
    const tiny = clampWindow({ lo: h(6, 0), hi: h(6, 0) + 1000 }, bounds)
    expect(tiny.hi - tiny.lo).toBe(MIN_WINDOW_MS)
    expect(clampWindow({ lo: 0, hi: 1e15 }, bounds)).toEqual({ lo: bounds.t0, hi: bounds.t1 })
    const d = dragWindow(h(6, 10), h(6, 8), bounds)
    expect(d).toEqual({ lo: h(6, 8), hi: h(6, 10) })
    expect(resizeWindow(d, 'hi', h(6, 7), bounds)).toEqual({ lo: h(6, 8), hi: h(6, 8) + MIN_WINDOW_MS })
    expect(resizeWindow(d, 'lo', h(6, 9), bounds)).toEqual({ lo: h(6, 9), hi: h(6, 10) })
    expect(resizeWindow(d, 'lo', h(1, 0), bounds).lo).toBe(bounds.t0)
    expect(centerWindow(d, h(7, 0), bounds)).toEqual({ lo: h(6, 23), hi: h(7, 1) })
  })

  test('a turn out of view moves the window: to its day when it is a day, else by centring', () => {
    const tl = tlOf([h(5, 9)], [h(5, 17)], [h(6, 8)], [h(6, 12)])
    const days = splitDays(tl)
    const b = boundsOf(tl)
    const w = snapDay(days[0])
    expect(revealWindow(w, h(5, 12), days, b)).toBe(w)
    expect(revealWindow(w, h(6, 9), days, b)).toEqual(snapDay(days[1]))
    const free = { lo: h(5, 9), hi: h(5, 11) }
    const r = revealWindow(free, h(6, 9), days, b)
    expect(r.hi - r.lo).toBe(2 * 3_600_000)
    expect(r.lo).toBeLessThan(h(6, 9))
    expect(r.hi).toBeGreaterThan(h(6, 9))
    expect(revealWindow(free, Number.NaN, days, b)).toBe(free)
  })

  test('the keys step a day at a time, or a window width', () => {
    const tl = tlOf([h(5, 9)], [h(5, 17)], [h(6, 8)], [h(6, 12)])
    const days = splitDays(tl)
    const b = boundsOf(tl)
    expect(stepWindow(snapDay(days[0]), 1, days, b)).toEqual(snapDay(days[1]))
    expect(stepWindow(snapDay(days[0]), -1, days, b)).toEqual(snapDay(days[0]))
    expect(stepWindow({ lo: h(5, 10), hi: h(5, 12) }, 1, days, b)).toEqual({ lo: h(5, 12), hi: h(5, 14) })
  })

  test('the strip: context is the largest of the main lanes, spend lands in its column', () => {
    const tl = tlOf([h(5, 9), 2], [h(5, 9.01), 3])
    tl.lanes[0].series = [
      {
        agentId: '',
        own: true,
        points: [
          { t: h(5, 9), tokens: 100 },
          { t: h(5, 9.01), tokens: 300 },
        ],
      },
    ]
    const axis = timeAxis(tl.spans, 0, 100)
    const env = contextEnvelope(tl, axis, 2)
    expect(env).toHaveLength(50)
    expect(Math.max(...env)).toBe(300)
    const bars = spendDensity(tl, axis, 2, 'kind')
    expect(bars.reduce((s, b) => s + (b.total ?? 0), 0)).toBe(5)
  })

  test('from and to read ISO times and milliseconds', () => {
    expect(parseTime('1767268800000')).toBe(1767268800000)
    expect(parseTime('2026-01-01T12:00:00Z')).toBe(Date.UTC(2026, 0, 1, 12))
    expect(parseTime('nonsense')).toBeUndefined()
    expect(parseTime(null)).toBeUndefined()
  })
})

describe('barSpan', () => {
  const slot: [number, number] = [0, 300_000]
  test('a bar covers the turn inside the slot, not the slot', () => {
    // a turn from 100 s to 160 s, calls at 110 s and 150 s
    expect(barSpan(slot, [110_000, 150_000], [{ t0: 100_000, t1: 160_000 }])).toEqual([100_000, 160_000])
  })
  test('it is cut at the slot', () => {
    expect(barSpan(slot, [280_000], [{ t0: 200_000, t1: 500_000 }])).toEqual([200_000, 300_000])
    expect(barSpan(slot, [10_000], [{ t0: -90_000, t1: 50_000 }])).toEqual([0, 50_000])
  })
  test('stretches without a call in the slot do not widen it', () => {
    const busy = [
      { t0: 0, t1: 20_000 },
      { t0: 100_000, t1: 120_000 },
      { t0: 200_000, t1: 220_000 },
    ]
    expect(barSpan(slot, [110_000], busy)).toEqual([100_000, 120_000])
  })
  test('calls outside every stretch are the span from the first to the last', () => {
    expect(barSpan(slot, [40_000, 90_000], [])).toEqual([40_000, 90_000])
  })
  test('a tiny bar is widened, centred on the calls', () => {
    expect(barSpan(slot, [100_000], [], 4_000)).toEqual([98_000, 102_000])
    expect(barSpan(slot, [100_000, 101_000], [{ t0: 100_000, t1: 101_000 }], 4_000)).toEqual([98_500, 102_500])
  })
})

test('mergeBusy joins stretches that overlap', () => {
  expect(
    mergeBusy([
      { t0: 5, t1: 9 },
      { t0: 0, t1: 6 },
      { t0: 20, t1: 21 },
    ]),
  ).toEqual([
    { t0: 0, t1: 9 },
    { t0: 20, t1: 21 },
  ])
})

describe('level of detail', () => {
  test('the median room per turn picks the level', () => {
    expect(pxPerTurn([0, 10, 20, 30, 200])).toBe(10)
    expect(pxPerTurn([5])).toBe(Number.POSITIVE_INFINITY)
    expect(detailAt(80)).toBe('full')
    expect(detailAt(40)).toBe('top')
    expect(detailAt(12)).toBe('top')
    expect(detailAt(11.9)).toBe('band')
  })
  test('the dearest decisions and the ones in focus keep their bracket', () => {
    const decs = Array.from({ length: 20 }, (_, i) => ({ index: i, usd: i === 3 ? 0.5 : 1 + i }))
    expect(bracketed(decs, 'full').size).toBe(20)
    const some = bracketed(decs, 'top', [3, undefined])
    expect([...some].sort((a, b) => a - b)).toEqual([3, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(bracketed(decs, 'band', []).size).toBe(8)
  })
})

describe('topology and model tier', () => {
  const run = (t0: number, t1: number, model: string, tier: ModelRun['tier']): ModelRun => ({ t0, t1, model, tier })
  const pts = [
    { t: 10, tokens: 1000 },
    { t: 20, tokens: 5000 },
  ]
  test('a fork inherits the parent context at the launch, capped at its first context', () => {
    expect(inheritedContext(pts, 15, 9000)).toBe(1000)
    expect(inheritedContext(pts, 25, 9000)).toBe(5000)
    expect(inheritedContext(pts, 25, 3000)).toBe(3000)
    expect(inheritedContext(pts, 5, 3000)).toBe(0)
    expect(inheritedContext(pts, 25, 0)).toBe(0)
  })
  test('weights by tier, heavy to light', () => {
    expect(TIER_WEIGHT.heavy).toBeGreaterThan(TIER_WEIGHT.mid)
    expect(TIER_WEIGHT.mid).toBeGreaterThan(TIER_WEIGHT.light)
    expect(heavierTier('light', 'mid')).toBe('mid')
    expect(heavierTier('heavy', 'unknown')).toBe('heavy')
  })
  test('a spine is cut by the runs, a gap keeps the weight before it', () => {
    const runs = [run(10, 20, 'a', 'heavy'), run(40, 50, 'b', 'light')]
    expect(tierSegments(runs, 0, 60)).toEqual([
      { t0: 0, t1: 40, tier: 'heavy' },
      { t0: 40, t1: 60, tier: 'light' },
    ])
    expect(tierSegments(runs, 0, 30)).toEqual([{ t0: 0, t1: 30, tier: 'heavy' }])
    expect(tierSegments([], 0, 5)).toEqual([{ t0: 0, t1: 5, tier: 'unknown' }])
    expect(tierSegments(runs, 5, 5)).toEqual([{ t0: 5, t1: 5, tier: 'heavy' }])
  })
  test('a turn takes the heaviest tier of its calls, else the run it was in', () => {
    const runs = [run(10, 20, 'a', 'mid'), run(21, 30, 'b', 'heavy'), run(100, 110, 'c', 'light')]
    expect(turnTier(runs, 5, 15)).toBe('mid')
    expect(turnTier(runs, 15, 25)).toBe('heavy')
    expect(turnTier(runs, 50, 60)).toBe('heavy')
    expect(turnTier(runs, 0, 5)).toBe('mid')
    expect(turnTier([], 0, 5)).toBe('unknown')
  })
  test('merged stretches take the heaviest weight', () => {
    expect(
      mergeWeighted(
        [
          { t0: 10, t1: 12, weight: 1 },
          { t0: 0, t1: 5, weight: 2 },
          { t0: 6, t1: 8, weight: 3.5 },
        ],
        1,
      ),
    ).toEqual([
      { t0: 0, t1: 8, weight: 3.5 },
      { t0: 10, t1: 12, weight: 1 },
    ])
  })
  test('model labels sit where the model changes, once per name', () => {
    const runs = [run(1, 2, 'x-1', 'heavy'), run(3, 4, 'x-1-dated', 'heavy'), run(5, 6, 'y', 'light')]
    expect(modelMarks(runs, (m) => m.replace('-dated', ''))).toEqual([
      { t: 1, text: 'x-1' },
      { t: 5, text: 'y' },
    ])
  })
})
