import { describe, expect, test } from 'bun:test'
import type { Agent, Message, SessionDetail, Turn } from '../../api/types'
import { barRoom, buildFrame, dollarScale, slotTotals, windowRow } from './layout'
import { buildTimeline, findSwarms, sliceWindow, slotLength, timeAxis } from './timeline'
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

// a main lane through two hours, and agents at different times: one early, one late, one long-lived
const detail = session('v', {
  turns: [turn(0, 0, 20), turn(1, 100, 125)],
  messages: [
    msg('a0', 1, 20_000, { turn: 0 }),
    msg('a1', 15, 90_000, { turn: 0 }),
    msg('b0', 101, 30_000, { turn: 1 }),
    msg('b1', 120, 50_000, { turn: 1, usd: 2 }),
    msg('e0', 5, 40_000, { agentId: 'early' }),
    msg('l0', 110, 60_000, { agentId: 'late' }),
    msg('l1', 112, 62_000, { agentId: 'late' }),
  ],
  agents: [
    agent('early', { spawnTurn: 0, startedAt: at(4), endedAt: at(8) }),
    agent('late', { spawnTurn: 1, startedAt: at(108), endedAt: at(114) }),
  ],
})
const timeline = buildTimeline(buildTree([detail]))
const frameFor = (open: ReadonlySet<string> = new Set()) =>
  buildFrame(timeline, findSwarms(timeline.lanes), open, 34, 900, [false])
const windows = [
  { lo: T0, hi: T0 + 30 * 60_000 },
  { lo: T0 + 95 * 60_000, hi: T0 + 130 * 60_000 },
  { lo: T0 + 40 * 60_000, hi: T0 + 90 * 60_000 },
]

describe('buildFrame', () => {
  const frame = frameFor()

  test('has a row for every lane of the session, in order, whatever a window shows', () => {
    expect(frame.layout[0].row.main).toBe(true)
    expect(frame.layout.flatMap((g) => g.row.lanes.map((l) => l.key)).sort()).toEqual(['0/early', '0/late', '0/main'])
  })

  test('rows are stacked: tops, bases, bottoms and the height are consistent and window-free', () => {
    const g = frame.layout
    for (let i = 1; i < g.length; i++) expect(g[i].top).toBeGreaterThan(g[i - 1].bottom)
    for (const r of g) {
      expect(r.base).toBe(r.top + r.ctxH)
      expect(r.bottom).toBe(r.base + r.spendH)
    }
    expect(frame.height).toBeGreaterThan(g[g.length - 1].bottom)
    // the same call gives the same numbers: nothing about a window goes in
    const again = frameFor()
    expect(again.layout.map((r) => [r.top, r.base, r.bottom])).toEqual(g.map((r) => [r.top, r.base, r.bottom]))
    expect(again.height).toBe(frame.height)
  })

  test('the token scale and the heights follow the whole session', () => {
    expect(frame.cTicks[frame.cTicks.length - 1] * frame.kCtx).toBeCloseTo(84, 6)
    // the main row holds the largest context (90k), so its area is the tallest
    expect(frame.layout[0].ctxH).toBeGreaterThan(frame.layout[1].ctxH)
  })

  test('an overhead strip stands under each session that has overhead, in the height', () => {
    const plain = frame
    const withOver = buildFrame(timeline, findSwarms(timeline.lanes), new Set(), 34, 900, [true])
    expect(plain.strips).toHaveLength(0)
    expect(withOver.strips).toHaveLength(1)
    expect(withOver.height).toBeGreaterThan(plain.height)
  })
})

describe('windowRow', () => {
  const frame = frameFor()
  const swarms = findSwarms(timeline.lanes)
  const byKey = (w: { lo: number; hi: number }) => new Map(sliceWindow(timeline, w).lanes.map((l) => [l.key, l]))

  test('rows do not depend on the window: lanes come and go, rows stay', () => {
    for (const w of windows) {
      const rows = frame.layout.map((g) => windowRow(g.row, byKey(w), swarms))
      expect(rows).toHaveLength(frame.layout.length)
      rows.forEach((r, i) => {
        expect(r.row.branch).toBe(frame.layout[i].row.branch)
        expect(r.row.main).toBe(frame.layout[i].row.main)
      })
    }
  })

  test('a lane with nothing in the window draws nothing; a main row keeps an empty lane', () => {
    const early = windowRow(frame.layout[1].row, byKey(windows[1]), swarms)
    const late = windowRow(frame.layout[1].row, byKey(windows[0]), swarms)
    const keysIn = (r: { row: { lanes: { key: string }[] } }) => r.row.lanes.map((l) => l.key)
    expect(keysIn(early)).not.toContain('0/early')
    expect(keysIn(late)).not.toContain('0/late')
    const quiet = windowRow(frame.layout[0].row, byKey({ lo: T0 + 40 * 60_000, hi: T0 + 90 * 60_000 }), swarms)
    expect(quiet.live).toBe(false)
    expect(quiet.row.lanes).toHaveLength(1)
    expect(quiet.row.lanes[0].calls).toHaveLength(0)
  })

  test('the lanes in the window are its slices', () => {
    const r = windowRow(frame.layout[0].row, byKey(windows[1]), swarms)
    expect(r.live).toBe(true)
    expect(r.row.lanes[0].calls.map((c) => c.t)).toEqual(
      timeline.lanes[0].calls.filter((c) => c.t >= windows[1].lo && c.t < windows[1].hi).map((c) => c.t),
    )
  })
})

describe('dollarScale', () => {
  const frame = frameFor()
  const swarms = findSwarms(timeline.lanes)

  test('every row’s tallest bar fits its band, in every window, and the tightest row fills it', () => {
    for (const w of windows) {
      const tl = sliceWindow(timeline, w)
      const sliced = new Map(tl.lanes.map((l) => [l.key, l]))
      const axis = timeAxis(tl.spans, 34, 900)
      const slot = slotLength(axis, 4)
      const maxes = frame.layout.map((g) => {
        const r = windowRow(g.row, sliced, swarms).row
        return Math.max(0, ...slotTotals(r.lanes, slot).values())
      })
      const k = dollarScale(frame.layout, maxes)
      expect(k).toBeGreaterThan(0)
      const fill: number[] = []
      frame.layout.forEach((g, i) => {
        expect(maxes[i] * k).toBeLessThanOrEqual(barRoom(g) + 1e-9)
        if (maxes[i] > 0) fill.push(maxes[i] * k - barRoom(g))
      })
      if (fill.length) expect(Math.max(...fill)).toBeCloseTo(0, 9)
    }
  })

  test('without spend in the window there is still a scale', () => {
    expect(
      dollarScale(
        frame.layout,
        frame.layout.map(() => 0),
      ),
    ).toBeGreaterThan(0)
  })
})
