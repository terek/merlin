import { describe, expect, test } from 'bun:test'
import type { OverviewGroup, OverviewLane, OverviewSpan } from '../../api/types'
import {
  activityRuns,
  axisTicks,
  CTX_MAX,
  chooseSlot,
  describeSpawns,
  fitLabels,
  formatKeys,
  heldContext,
  laneAt,
  lanesByGroup,
  lastLabel,
  MERGE_GAP,
  MIN_SPINE,
  makeAxis,
  midnights,
  parseKeys,
  slotAt,
  slotX,
  sortGroups,
  sortLanes,
  spawnsNear,
  spineLanes,
  stepAreaPath,
  toggleKey,
  tokenScale,
  visibleLanes,
  xOf,
} from './model'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

function group(p: Partial<OverviewGroup> & { key: string }): OverviewGroup {
  return {
    name: p.key,
    sessions: 1,
    turns: 0,
    agents: 0,
    usd: 0,
    usdSlots: [0, 0, 0, 0],
    contextPeak: [0, 0, 0, 0],
    contextSum: [0, 0, 0, 0],
    idlePeak: [0, 0, 0, 0],
    idleSum: [0, 0, 0, 0],
    active: [0, 0, 0, 0],
    spans: [],
    ...p,
  }
}

function lane(p: Partial<OverviewLane> & { id: string }): OverviewLane {
  return {
    harness: 'claude',
    group: '',
    usd: 0,
    turns: 0,
    agents: 0,
    slot0: 0,
    usdSlots: [],
    context: [],
    idle: [],
    active: [],
    spans: [],
    ...p,
  }
}

const T0 = new Date(2026, 10, 4, 0, 0).getTime()

describe('chooseSlot', () => {
  test('the smallest slot that gives at most one slot per pixel', () => {
    expect(chooseSlot(7 * DAY, 1200)).toBe('10m') // 504 s per pixel
    expect(chooseSlot(DAY, 1200)).toBe('2m') // 72 s per pixel
    expect(chooseSlot(30 * DAY, 1200)).toBe('1h') // 2160 s per pixel
    expect(chooseSlot(DAY, 100)).toBe('15m')
  })

  test('never finer than the API allows, never coarser than a day', () => {
    expect(chooseSlot(HOUR, 5000)).toBe('1m')
    expect(chooseSlot(365 * DAY, 100)).toBe('1d')
  })
})

describe('axis', () => {
  const axis = makeAxis(T0, T0 + 7 * DAY, 10 * MIN, 1008)

  test('time maps linearly to x', () => {
    expect(axis.slots).toBe(1008)
    expect(axis.slotW).toBe(1)
    expect(xOf(axis, T0)).toBe(0)
    expect(xOf(axis, T0 + 3.5 * DAY)).toBe(504)
    expect(xOf(axis, T0 + 7 * DAY)).toBe(1008)
    expect(slotX(axis, 144)).toBe(144)
  })

  test('slotAt maps pixels to slots and nothing outside the plot', () => {
    expect(slotAt(axis, 0)).toBe(0)
    expect(slotAt(axis, 143.9)).toBe(143)
    expect(slotAt(axis, 1007.5)).toBe(1007)
    expect(slotAt(axis, -1)).toBe(-1)
    expect(slotAt(axis, 1008)).toBe(-1)
  })

  test('midnights and day ticks sit one day apart, however empty the days', () => {
    const ms = midnights(T0, T0 + 7 * DAY)
    expect(ms).toHaveLength(7)
    const ticks = axisTicks(axis)
    expect(ticks.every((t) => t.day)).toBe(true)
    expect(ticks[1].x - ticks[0].x).toBeCloseTo(144, 5)
    expect(ticks[0].label).toBe('Wed 4')
  })

  test('a day has hour ticks, labelled at a step that keeps them apart', () => {
    const day = makeAxis(T0, T0 + DAY, 2 * MIN, 1200)
    const ticks = axisTicks(day)
    expect(ticks).toHaveLength(24)
    expect(ticks[1].x - ticks[0].x).toBeCloseTo(50, 5)
    expect(ticks.filter((t) => t.labelled).length).toBeLessThan(24)
    expect(ticks[0]).toMatchObject({ day: true, labelled: true })
  })
})

describe('heldContext', () => {
  const from = T0
  const slotMs = 10 * MIN
  const run = (calls: { at: number; ctx: number }[], slots: number) => heldContext(calls, from, slotMs, slots)

  test('a call is held to the next call within five minutes', () => {
    const { context, idle } = run(
      [
        { at: from + 2 * MIN, ctx: 100 },
        { at: from + 6 * MIN, ctx: 120 },
        { at: from + 14 * MIN, ctx: 90 },
      ],
      4,
    )
    // 100 over 2-6 min, 120 from 6 up to the 14 min call (8 min later: idle), 90 at 14 and nothing after
    expect(context).toEqual([120, 90, 0, 0])
    expect(idle).toEqual([0, 0, 0, 0])
  })

  test('a pause of 5 to 60 minutes holds the context as idle, never in a slot with context', () => {
    const { context, idle } = run(
      [
        { at: from + 1 * MIN, ctx: 50 },
        { at: from + 31 * MIN, ctx: 60 },
      ],
      5,
    )
    expect(context).toEqual([50, 0, 0, 60, 0])
    expect(idle).toEqual([0, 50, 50, 0, 0])
  })

  test('a pause over an hour holds nothing, and neither does the time after the last call', () => {
    const { context, idle } = heldContext(
      [
        { at: from + 1 * MIN, ctx: 50 },
        { at: from + 90 * MIN, ctx: 60 },
      ],
      from,
      slotMs,
      12,
    )
    expect(context.filter((v) => v > 0)).toHaveLength(2)
    expect(idle.every((v) => v === 0)).toBe(true)
  })

  test('held context carries over slot boundaries', () => {
    const { context } = run(
      [
        { at: from + 8 * MIN, ctx: 70 },
        { at: from + 12 * MIN, ctx: 40 },
        { at: from + 26 * MIN, ctx: 10 },
      ],
      4,
    )
    // 70 held 8-12 min: slots 0 and 1; 40 ends at its call, 10 at 26
    expect(context).toEqual([70, 70, 10, 0])
  })

  test('a hold ending exactly on a slot start does not enter it', () => {
    const { context } = run(
      [
        { at: from + 4 * MIN, ctx: 5 },
        { at: from + 10 * MIN, ctx: 7 },
        { at: from + 40 * MIN, ctx: 1 },
      ],
      5,
    )
    expect(context).toEqual([5, 7, 0, 0, 1])
  })
})

describe('lane arrays are trimmed', () => {
  test('laneAt indexes from slot0 and is zero outside', () => {
    const arr = [4, 5, 6]
    expect(laneAt(arr, 10, 10)).toBe(4)
    expect(laneAt(arr, 10, 12)).toBe(6)
    expect(laneAt(arr, 10, 9)).toBe(0)
    expect(laneAt(arr, 10, 13)).toBe(0)
  })

  test("the paths and runs start at the lane's first slot", () => {
    const axis = makeAxis(T0, T0 + 8 * HOUR, HOUR, 80)
    expect(stepAreaPath([5, 5], axis, 50, 2, 3)).toBe('M30,50V40H50V50Z')
    expect(activityRuns([1, 1, 0, 2], 4)).toEqual([
      { from: 4, to: 6, weight: 1 },
      { from: 7, to: 8, weight: 2 },
    ])
  })
})

describe('tokenScale', () => {
  test('the largest context or idle context of any group reaches the limit', () => {
    const a = group({ key: 'a', contextSum: [100, 400, 0, 0], idleSum: [0, 0, 800, 0], contextPeak: [50, 200, 0, 0] })
    const b = group({ key: 'b', contextSum: [0, 40, 0, 0] })
    const s = tokenScale([a, b], 'sum')
    expect(s.maxTok).toBe(800)
    expect(s.pxPerTok).toBeCloseTo(CTX_MAX / 800, 9)
    expect(tokenScale([a, b], 'peak').maxTok).toBe(200)
  })

  test('nothing carried, no scale', () => {
    expect(tokenScale([group({ key: 'a' })], 'sum')).toEqual({ maxTok: 0, pxPerTok: 0 })
  })
})

describe('sorting', () => {
  const a = group({
    key: 'a',
    usd: 10,
    sessions: 5,
    priciest: { harness: 'claude', id: 'x', usd: 2 },
    lastActivityAt: '2026-11-01T00:00:00Z',
  })
  const b = group({
    key: 'b',
    usd: 5,
    sessions: 9,
    priciest: { harness: 'claude', id: 'y', usd: 4 },
    lastActivityAt: '2026-11-03T00:00:00Z',
  })
  const c = group({ key: 'c', usd: 5, sessions: 1, lastActivityAt: '2026-11-02T00:00:00Z' })

  test('groups by each key, with spend then key as the tiebreak', () => {
    expect(sortGroups([c, b, a], 'spend').map((g) => g.key)).toEqual(['a', 'b', 'c'])
    expect(sortGroups([a, b, c], 'sessions').map((g) => g.key)).toEqual(['b', 'a', 'c'])
    expect(sortGroups([a, b, c], 'priciest').map((g) => g.key)).toEqual(['b', 'a', 'c'])
    expect(sortGroups([a, b, c], 'recent').map((g) => g.key)).toEqual(['b', 'c', 'a'])
  })

  test('does not change its input', () => {
    const input = [c, a]
    sortGroups(input, 'spend')
    expect(input.map((g) => g.key)).toEqual(['c', 'a'])
  })

  const l1 = lane({ id: '1', usd: 5, lastActivityAt: '2026-11-01T00:00:00Z' })
  const l2 = lane({ id: '2', usd: 9, lastActivityAt: '2026-11-02T00:00:00Z' })
  const l3 = lane({ id: '3', usd: 9, lastActivityAt: '2026-11-03T00:00:00Z' })

  test('sessions by spend (id breaks a tie), or by last activity for sort=recent', () => {
    expect(sortLanes([l1, l3, l2], 'spend').map((l) => l.id)).toEqual(['2', '3', '1'])
    expect(sortLanes([l1, l2, l3], 'sessions').map((l) => l.id)).toEqual(['2', '3', '1'])
    expect(sortLanes([l1, l2, l3], 'priciest').map((l) => l.id)).toEqual(['2', '3', '1'])
    expect(sortLanes([l1, l2, l3], 'recent').map((l) => l.id)).toEqual(['3', '2', '1'])
  })

  test('lanes by group; the first five are shown, the rest counted', () => {
    const m = lanesByGroup([lane({ id: 'a', group: 'x' }), lane({ id: 'b', group: '' }), lane({ id: 'c', group: 'x' })])
    expect(m.get('x')?.map((l) => l.id)).toEqual(['a', 'c'])
    expect(m.get('')?.map((l) => l.id)).toEqual(['b'])
    const seven = [1, 2, 3, 4, 5, 6, 7]
    expect(visibleLanes(seven, false)).toEqual({ shown: [1, 2, 3, 4, 5], more: 2 })
    expect(visibleLanes(seven, true)).toEqual({ shown: seven, more: 0 })
    expect(visibleLanes([1, 2, 3], false)).toEqual({ shown: [1, 2, 3], more: 0 })
  })
})

describe('activityRuns', () => {
  test('weights 1, 2 and 3 or more, merged while equal', () => {
    expect(activityRuns([1, 1, 2, 5, 0, 1])).toEqual([
      { from: 0, to: 2, weight: 1 },
      { from: 2, to: 3, weight: 2 },
      { from: 3, to: 4, weight: 3 },
      { from: 5, to: 6, weight: 1 },
    ])
  })
})

describe('stepAreaPath', () => {
  const axis = makeAxis(T0, T0 + 8 * HOUR, HOUR, 80)

  test('one shape per run above zero, steps merged', () => {
    const area = stepAreaPath([0, 5, 5, 3, 0, 0, 2, 0], axis, 50, 2)
    expect(area.match(/M/g)).toHaveLength(2)
    expect(area).toContain('M10,50V40H30V44H40V50Z')
  })

  test('nothing above zero gives nothing', () => {
    expect(stepAreaPath([0, 0, 0], axis, 50, 2)).toBe('')
  })

  test('idle and context are separate shapes of the same grammar', () => {
    expect(stepAreaPath([0, 0, 3, 3], axis, 20, 1)).toBe('M20,20V17H40V20Z')
  })
})

describe('spineLanes', () => {
  // 1 px = 10 minutes
  const axis = makeAxis(T0, T0 + 7 * DAY, 10 * MIN, 1008)
  const span = (startMin: number, lenMin: number, kind: OverviewSpan['kind'] = 'subagent'): OverviewSpan => ({
    kind,
    start: new Date(T0 + DAY + startMin * MIN).toISOString(),
    end: new Date(T0 + DAY + (startMin + lenMin) * MIN).toISOString(),
    session: { harness: 'claude', id: 's' },
  })

  test('a burst is one run with a vertical per spawn', () => {
    // 10 spawns a minute apart, each living 5 minutes: they land on the same pixel and merge
    const spans = Array.from({ length: 10 }, (_, i) => span(i, 5))
    const [k] = spineLanes(spans, axis)
    expect(k.kind).toBe('subagent')
    expect(k.runs).toHaveLength(1)
    expect(k.runs[0].n).toBe(10)
    expect(k.runs[0].x1 - k.runs[0].x0).toBeGreaterThanOrEqual(MIN_SPINE)
  })

  test('verticals: the first spawn of a run is its elbow, the others are ticks (one per half pixel)', () => {
    // spawns at +0, +40 min (4 px), +80 min (8 px): each 10 px long, so they merge into one run
    const [k] = spineLanes([span(0, 5), span(40, 5), span(80, 5), span(81, 5)], axis)
    expect(k.runs).toHaveLength(1)
    expect(k.ticks).toHaveLength(2)
    expect(k.ticks[0] - k.runs[0].x0).toBeCloseTo(4, 5)
  })

  test('a gap under the merge distance joins runs, a wider one separates them', () => {
    // a life of 100 min is 10 px: [144, 154]; the next starts MERGE_GAP px after, or a little more
    const close = spineLanes([span(0, 100), span((10 + MERGE_GAP) * 10, 100)], axis)[0]
    expect(close.runs).toHaveLength(1)
    const far = spineLanes([span(0, 100), span((10 + MERGE_GAP + 1) * 10, 100)], axis)[0]
    expect(far.runs).toHaveLength(2)
    expect(far.ticks).toHaveLength(0)
  })

  test('each kind has its own runs, in draw order', () => {
    const ks = spineLanes([span(0, 5, 'workflow'), span(0, 5, 'fork'), span(0, 5), span(0, 5, 'continuation')], axis)
    expect(ks.map((k) => k.kind)).toEqual(['subagent', 'fork', 'workflow', 'continuation'])
  })

  test('a branched session has a vertical at its start and no run', () => {
    const [k] = spineLanes([span(0, 1440, 'session-fork'), span(2000, 5, 'session-fork')], axis)
    expect(k.runs).toEqual([])
    expect(k.ticks).toHaveLength(2)
  })

  test('a real long life is its real length; a short one keeps the minimum', () => {
    const [k] = spineLanes([span(0, 1440), span(2000, 1)], axis)
    expect(k.runs[0].x1 - k.runs[0].x0).toBeCloseTo(144, 5)
    expect(k.runs[1].x1 - k.runs[1].x0).toBeCloseTo(MIN_SPINE, 5)
  })

  test('a spawn from before the range starts at the left edge and has no vertical', () => {
    const early: OverviewSpan = {
      ...span(0, 0),
      start: new Date(T0 - DAY).toISOString(),
      end: new Date(T0 + 2 * HOUR).toISOString(),
    }
    const [k] = spineLanes([early], axis)
    expect(k.runs[0]).toMatchObject({ x0: 0, clipped: true })
    expect(k.ticks).toHaveLength(0)
  })

  test('no spans, no lane', () => {
    expect(spineLanes(undefined, axis)).toEqual([])
  })
})

describe('spawnsNear', () => {
  const axis = makeAxis(T0, T0 + 7 * DAY, 10 * MIN, 1008)
  const at = (min: number, kind: OverviewSpan['kind'], title?: string): OverviewSpan => ({
    kind,
    start: new Date(T0 + min * MIN).toISOString(),
    end: new Date(T0 + (min + 5) * MIN).toISOString(),
    session: { harness: 'claude', id: 's' },
    title,
  })

  test('counts the spawns within a few pixels, by kind, with a few titles', () => {
    const spans = [
      at(1440, 'subagent', 'a'),
      at(1441, 'subagent', 'b'),
      at(1445, 'fork'),
      at(1450, 'subagent', 'c'),
      at(1452, 'subagent', 'd'),
      at(3000, 'subagent', 'far'),
    ]
    const hit = spawnsNear(spans, axis, 144.2, 4)
    expect(hit?.total).toBe(5)
    expect(hit?.kinds).toEqual([
      { kind: 'subagent', n: 4 },
      { kind: 'fork', n: 1 },
    ])
    expect(hit?.titles).toEqual(['a', 'b', 'c'])
    expect(describeSpawns(hit as NonNullable<typeof hit>)).toBe('4 sub-agents, 1 fork')
  })

  test('nothing near', () => {
    expect(spawnsNear([at(3000, 'fork')], axis, 10)).toBeNull()
    expect(spawnsNear(undefined, axis, 10)).toBeNull()
  })
})

describe('group keys in the URL', () => {
  test('round trip, including the empty key and commas', () => {
    const keys = ['/home/dev/a,b', '', '-', '/x y']
    expect(parseKeys(formatKeys(keys))).toEqual(keys)
    expect(parseKeys(null)).toEqual([])
    expect(parseKeys('')).toEqual([])
  })

  test('toggle', () => {
    expect(toggleKey(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleKey(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('fitLabels', () => {
  const tick = (x: number, label: string) => ({ x, label, day: false, labelled: true })
  test('drops a label that would touch the previous or pass the right edge', () => {
    const out = fitLabels([tick(0, '19:00'), tick(20, '20:00'), tick(80, '21:00'), tick(190, '22:00')], 200)
    expect(out.map((t) => t.labelled)).toEqual([true, false, true, false])
  })
})

describe('lastLabel', () => {
  const now = new Date(2026, 10, 12, 15, 0).getTime()
  const ago = (ms: number) => new Date(now - ms).toISOString()
  test('compact forms', () => {
    expect(lastLabel(ago(20_000), now)).toBe('now')
    expect(lastLabel(ago(5 * MIN), now)).toBe('5 min')
    expect(lastLabel(ago(2 * HOUR), now)).toBe('2 h')
    expect(lastLabel(new Date(2026, 10, 11, 9, 0).toISOString(), now)).toBe('yesterday')
    expect(lastLabel(new Date(2026, 10, 9, 9, 0).toISOString(), now)).toBe('9 Nov')
    expect(lastLabel(undefined, now)).toBe('–')
  })
})
