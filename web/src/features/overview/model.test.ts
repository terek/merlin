import { describe, expect, test } from 'bun:test'
import type { OverviewGroup, OverviewLane, OverviewSpan } from '../../api/types'
import {
  activityRuns,
  axisTicks,
  chooseSlot,
  compactionsBySlot,
  describeCompactions,
  formatOpen,
  heldContext,
  lanesIn,
  layoutSpans,
  MIN_SPINE,
  makeAxis,
  midnights,
  niceFloor,
  packIntervals,
  parseOpen,
  rowHeights,
  scalesFor,
  slotAt,
  slotRange,
  slotX,
  sortGroups,
  stepAreaPath,
  toggleOpen,
  xOf,
} from './model'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

function group(p: Partial<OverviewGroup> & { key: string }): OverviewGroup {
  return {
    name: p.key,
    sessions: 1,
    usd: 0,
    usdSlots: [0, 0, 0, 0],
    contextPeak: [0, 0, 0, 0],
    contextSum: [0, 0, 0, 0],
    active: [0, 0, 0, 0],
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

  test('a call is held to the next call within five minutes', () => {
    const v = heldContext(
      [
        { at: from + 2 * MIN, ctx: 100 },
        { at: from + 6 * MIN, ctx: 120 },
        { at: from + 14 * MIN, ctx: 90 },
      ],
      from,
      slotMs,
      4,
    )
    // 100 over 2-6 min, 120 from 6 and then ends at its call (the next is 8 min later), 90 at 14
    expect(v).toEqual([120, 90, 0, 0])
  })

  test('a long pause ends the hold at the call', () => {
    const v = heldContext(
      [
        { at: from + 1 * MIN, ctx: 50 },
        { at: from + 31 * MIN, ctx: 60 },
      ],
      from,
      slotMs,
      4,
    )
    expect(v).toEqual([50, 0, 0, 60])
  })

  test('held context carries over slot boundaries', () => {
    const v = heldContext(
      [
        { at: from + 8 * MIN, ctx: 70 },
        { at: from + 12 * MIN, ctx: 40 },
        { at: from + 26 * MIN, ctx: 10 },
      ],
      from,
      slotMs,
      4,
    )
    // 70 held 8-12 min: slots 0 and 1; 40 ends at its call (14 min later), 10 at 26
    expect(v).toEqual([70, 70, 10, 0])
  })

  test('a hold ending exactly on a slot start does not enter it', () => {
    const v = heldContext(
      [
        { at: from + 4 * MIN, ctx: 5 },
        { at: from + 10 * MIN, ctx: 7 },
        { at: from + 40 * MIN, ctx: 1 },
      ],
      from,
      slotMs,
      5,
    )
    expect(v).toEqual([5, 7, 0, 0, 1])
  })
})

describe('packIntervals', () => {
  test('overlapping boxes go to different lanes, the first fit wins', () => {
    const lanes = packIntervals(
      [
        { x0: 0, x1: 20 },
        { x0: 5, x1: 25 },
        { x0: 30, x1: 40 },
        { x0: 22, x1: 28 },
      ],
      3,
    )
    expect(lanes).toEqual([0, 1, 0, 2])
  })

  test('the gap counts', () => {
    expect(
      packIntervals(
        [
          { x0: 0, x1: 10 },
          { x0: 12, x1: 20 },
        ],
        3,
      ),
    ).toEqual([0, 1])
    expect(
      packIntervals(
        [
          { x0: 0, x1: 10 },
          { x0: 13, x1: 20 },
        ],
        3,
      ),
    ).toEqual([0, 0])
  })

  test('beyond the maximum the spines share the last lane', () => {
    const boxes = Array.from({ length: 5 }, () => ({ x0: 0, x1: 50 }))
    expect(Math.max(...packIntervals(boxes, 3, 3))).toBe(2)
  })
})

describe('layoutSpans', () => {
  const axis = makeAxis(T0, T0 + 7 * DAY, 10 * MIN, 1008)
  const span = (start: number, end: number, extra: Partial<OverviewSpan> = {}): OverviewSpan => ({
    kind: 'subagent',
    n: 1,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    session: { harness: 'claude', id: 's' },
    ...extra,
  })

  test('a short life keeps the minimum length', () => {
    const { items } = layoutSpans([span(T0 + DAY, T0 + DAY + 30_000)], axis)
    expect(items[0].x1 - items[0].x0).toBeGreaterThanOrEqual(MIN_SPINE)
  })

  test('a long life is its real length', () => {
    const { items } = layoutSpans([span(T0 + DAY, T0 + 2 * DAY)], axis)
    expect(items[0].x0).toBeCloseTo(144, 5)
    expect(items[0].x1).toBeCloseTo(288, 5)
  })

  test('spans that overlap in pixels take other sub-lanes; far apart ones share', () => {
    const { items, lanes } = layoutSpans(
      [
        span(T0 + DAY, T0 + DAY + 60 * MIN),
        span(T0 + DAY + 20 * MIN, T0 + DAY + 80 * MIN),
        span(T0 + 3 * DAY, T0 + 3 * DAY + MIN),
      ],
      axis,
    )
    expect(items.map((i) => i.lane)).toEqual([0, 1, 0])
    expect(lanes).toBe(2)
  })

  test('a swarm reserves room for its label', () => {
    const a = span(T0 + DAY, T0 + DAY + 180 * MIN, { n: 4 })
    const b = span(T0 + DAY + 210 * MIN, T0 + DAY + 300 * MIN)
    // b starts 3 px after a ends: room for the gap, not for the label
    expect(layoutSpans([a, b], axis).items.map((i) => i.lane)).toEqual([0, 1])
    expect(layoutSpans([{ ...a, n: 1 }, b], axis).items.map((i) => i.lane)).toEqual([0, 0])
  })

  test('a span from before the range is clipped at the left edge', () => {
    const { items } = layoutSpans([span(T0 - DAY, T0 + 2 * HOUR)], axis)
    expect(items[0].clipped).toBe(true)
    expect(items[0].x0).toBe(0)
  })

  test('no spans, no lanes', () => {
    expect(layoutSpans(undefined, axis)).toEqual({ items: [], lanes: 0 })
  })
})

describe('scales and heights', () => {
  const big = group({ key: 'big', contextSum: [100, 400, 0, 0], usdSlots: [0, 10, 0, 0] })
  const small = group({ key: 'small', contextSum: [0, 40, 0, 0], usdSlots: [0, 1, 0, 0] })

  test('one scale for all rows: the largest value reaches the limit', () => {
    const s = scalesFor([big, small], 'sum')
    expect(s.maxTok).toBe(400)
    expect(s.maxUsd).toBe(10)
    const h = rowHeights(big.contextSum, big.usdSlots, s)
    const l = rowHeights(small.contextSum, small.usdSlots, s)
    expect(h.up).toBe(60)
    expect(l.up).toBe(6)
    expect(h.down).toBeGreaterThan(l.down)
  })

  test('a row with nothing keeps a minimum', () => {
    const s = scalesFor([big], 'sum')
    expect(rowHeights([0, 0], [0, 0], s)).toEqual({ up: 5, down: 5 })
  })

  test('peak mode uses the deepest session', () => {
    const g = group({ key: 'g', contextSum: [900, 0, 0, 0], contextPeak: [300, 0, 0, 0] })
    expect(scalesFor([g], 'peak').maxTok).toBe(300)
    expect(scalesFor([g], 'sum').maxTok).toBe(900)
  })

  test('scripted spend takes part in the dollar scale', () => {
    expect(scalesFor([small], 'sum', [0, 5]).maxUsd).toBe(5)
  })

  test('niceFloor', () => {
    expect(niceFloor(0)).toBe(0)
    expect(niceFloor(7.5)).toBe(5)
    expect(niceFloor(180_000)).toBe(100_000)
    expect(niceFloor(24)).toBe(20)
  })
})

describe('sortGroups', () => {
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

  test('each key, with spend then key as the tiebreak', () => {
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

describe('compactions', () => {
  test('fold into one record per slot, other event types ignored', () => {
    const m = compactionsBySlot([
      { slot: 3, type: 'compaction', kind: 'cold', n: 1 },
      { slot: 9, type: 'compaction', kind: 'warm', n: 1 },
      { slot: 9, type: 'compaction', kind: 'unknown', n: 1 },
    ])
    expect(m.get(3)).toEqual({ cold: 1, warm: 0, other: 0 })
    expect(m.get(9)).toEqual({ cold: 0, warm: 1, other: 1 })
    expect(m.get(4)).toBeUndefined()
  })

  test('words', () => {
    expect(describeCompactions(undefined)).toBe('')
    expect(describeCompactions({ cold: 1, warm: 0, other: 0 })).toBe('cold compaction')
    expect(describeCompactions({ cold: 0, warm: 2, other: 1 })).toBe('2 warm compactions, compaction')
  })
})

describe('stepAreaPath', () => {
  const axis = makeAxis(T0, T0 + 8 * HOUR, HOUR, 80)

  test('one shape per run above zero, steps merged, outline without the baseline', () => {
    const { area, line } = stepAreaPath([0, 5, 5, 3, 0, 0, 2, 0], axis, 50, 2)
    expect(area.match(/M/g)).toHaveLength(2)
    expect(area).toContain('M10,50V40H30V44H40V50Z')
    expect(line).not.toContain('Z')
  })

  test('nothing above zero gives nothing', () => {
    expect(stepAreaPath([0, 0, 0], axis, 50, 2)).toEqual({ area: '', line: '' })
  })
})

describe('click lists', () => {
  const lane = (id: string, usd: number[], ctx: number[]): OverviewLane => ({
    harness: 'claude',
    id,
    usd: usd.reduce((a, b) => a + b, 0),
    usdSlots: usd,
    context: ctx,
    active: ctx.map((v) => (v > 0 ? 1 : 0)),
  })
  const lanes = [
    lane('a', [0, 1, 0, 0], [0, 10, 0, 0]),
    lane('b', [0, 3, 2, 0], [0, 10, 10, 0]),
    lane('c', [5, 0, 0, 0], [5, 0, 0, 0]),
  ]

  test('slotRange orders and clamps', () => {
    expect(slotRange(5, 2, 4)).toEqual({ from: 2, to: 3 })
    expect(slotRange(-3, 1, 4)).toEqual({ from: 0, to: 1 })
  })

  test('lanes active in a slot, priciest in it first', () => {
    const hits = lanesIn(lanes, slotRange(1, 1, 4))
    expect(hits.map((h) => [h.lane.id, h.usdIn])).toEqual([
      ['b', 3],
      ['a', 1],
    ])
  })

  test('a range adds up the slots', () => {
    const hits = lanesIn(lanes, slotRange(0, 2, 4))
    expect(hits.map((h) => [h.lane.id, h.usdIn])).toEqual([
      ['b', 5],
      ['c', 5],
      ['a', 1],
    ])
  })
})

describe('open list in the URL', () => {
  test('round trip, including the empty key and commas', () => {
    const keys = ['/home/dev/a,b', '', '-', '/x y']
    expect(parseOpen(formatOpen(keys))).toEqual(keys)
    expect(parseOpen(null)).toEqual([])
    expect(parseOpen('')).toEqual([])
  })

  test('toggle', () => {
    expect(toggleOpen(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleOpen(['a', 'b'], 'a')).toEqual(['b'])
  })
})
