import { describe, expect, test } from 'bun:test'
import type { Agent, AgentTurn, Message, SessionDetail, Turn } from '../../api/types'
import type { Col } from './model'
import { buildTimeline, GAP_MS, type Lane, packLanes, slotLength, splitHeld, timeAxis, turnPlace } from './timeline'
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
