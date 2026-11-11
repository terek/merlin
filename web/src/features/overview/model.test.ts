import { describe, expect, test } from 'bun:test'
import type { OverviewGroup, OverviewLane } from '../../api/types'
import {
  activityRuns,
  BREAK_W,
  breakLabel,
  buildAxis,
  describeMarks,
  formatOpen,
  lanesIn,
  marksBySlot,
  niceFloor,
  parseOpen,
  quietSlots,
  rowHeights,
  scalesFor,
  slotAt,
  slotRange,
  sortGroups,
  stepAreaPath,
  toggleOpen,
} from './model'

const HOUR = 3_600_000

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

describe('buildAxis', () => {
  test('without quiet runs the slots share the width', () => {
    const a = buildAxis([false, false, false, false], HOUR, 4 * HOUR, 400)
    expect(a.slotW).toBe(100)
    expect(a.x).toEqual([0, 100, 200, 300, 400])
    expect(a.segments).toHaveLength(1)
  })

  test('a quiet run longer than the threshold becomes a narrow break', () => {
    const quiet = [false, true, true, true, true, true, false]
    const a = buildAxis(quiet, HOUR, 4 * HOUR, 226)
    expect(a.segments.map((s) => s.kind)).toEqual(['slots', 'break', 'slots'])
    expect(a.slotW).toBe(100)
    expect(a.segments[1].x1 - a.segments[1].x0).toBe(BREAK_W)
    expect(a.shown).toEqual([true, false, false, false, false, false, true])
    expect(a.x[6]).toBe(100 + BREAK_W)
    expect(a.width).toBe(226)
  })

  test('a quiet run at or under the threshold stays', () => {
    const a = buildAxis([false, true, true, true, true, false], HOUR, 4 * HOUR, 600)
    expect(a.segments).toHaveLength(1)
    expect(a.shown.every(Boolean)).toBe(true)
  })

  test('a plot with nothing in it is not one big break', () => {
    const a = buildAxis([true, true, true, true, true, true], HOUR, 2 * HOUR, 300)
    expect(a.segments).toHaveLength(1)
    expect(a.segments[0].kind).toBe('slots')
  })

  test('slotAt maps pixels to slots and not into breaks', () => {
    const a = buildAxis([false, true, true, true, true, true, false], HOUR, 4 * HOUR, 226)
    expect(slotAt(a, 0)).toBe(0)
    expect(slotAt(a, 99)).toBe(0)
    expect(slotAt(a, 110)).toBe(-1)
    expect(slotAt(a, 130)).toBe(6)
    expect(slotAt(a, 400)).toBe(-1)
    expect(slotAt(a, -1)).toBe(-1)
  })
})

describe('quietSlots', () => {
  test('a slot is quiet only when no group and no scripted run was in it', () => {
    const g = group({ key: 'a', active: [1, 0, 0, 0], usdSlots: [1, 0, 0, 0] })
    const q = quietSlots({ slots: 4, groups: [g], scripted: { sessions: 3, usd: 1, usdSlots: [0, 0, 0.5, 0] } })
    expect(q).toEqual([false, true, false, true])
  })
})

describe('breakLabel', () => {
  test('hours under two days, days above', () => {
    expect(breakLabel(5 * HOUR)).toBe('5 h')
    expect(breakLabel(47 * HOUR)).toBe('47 h')
    expect(breakLabel(72 * HOUR)).toBe('3 d')
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
    expect(h.up).toBe(56)
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
    const runs = activityRuns([1, 1, 2, 5, 0, 1], [true, true, true, true, true, true])
    expect(runs).toEqual([
      { from: 0, to: 2, weight: 1 },
      { from: 2, to: 3, weight: 2 },
      { from: 3, to: 4, weight: 3 },
      { from: 5, to: 6, weight: 1 },
    ])
  })

  test('slots inside a break are skipped', () => {
    expect(activityRuns([1, 1, 1], [true, false, true])).toEqual([
      { from: 0, to: 1, weight: 1 },
      { from: 2, to: 3, weight: 1 },
    ])
  })
})

describe('marks', () => {
  test('events fold into one record per slot', () => {
    const m = marksBySlot([
      { slot: 3, type: 'agent', kind: 'subagent', n: 4 },
      { slot: 3, type: 'agent', kind: 'fork', n: 1 },
      { slot: 3, type: 'compaction', kind: 'cold', n: 1 },
      { slot: 9, type: 'session', kind: 'fork', n: 1 },
      { slot: 9, type: 'session', kind: 'continuation', n: 2 },
      { slot: 9, type: 'compaction', kind: 'warm', n: 1 },
      { slot: 9, type: 'compaction', kind: 'unknown', n: 1 },
    ])
    expect(m.get(3)).toEqual({ fork: 0, continuation: 0, agents: 5, cold: 1, warm: 0, other: 0 })
    expect(m.get(9)).toEqual({ fork: 1, continuation: 2, agents: 0, cold: 0, warm: 1, other: 1 })
    expect(m.get(4)).toBeUndefined()
  })

  test('words', () => {
    expect(describeMarks(undefined)).toBe('')
    expect(describeMarks({ fork: 0, continuation: 0, agents: 1, cold: 1, warm: 0, other: 0 })).toBe(
      '1 agent launched, cold compaction',
    )
    expect(describeMarks({ fork: 1, continuation: 2, agents: 0, cold: 0, warm: 2, other: 0 })).toBe(
      'a session forked, 2 sessions continued, 2 warm compactions',
    )
  })
})

describe('stepAreaPath', () => {
  test('one shape per run, none for zeros, a break ends a run', () => {
    const axis = buildAxis([false, false, true, true, true, true, true, false], HOUR, 4 * HOUR, 86)
    expect(axis.slotW).toBe(20)
    const d = stepAreaPath([0, 5, 0, 0, 0, 0, 0, 2], axis, 50, 2)
    expect(d.match(/M/g)).toHaveLength(2)
    expect(d).toContain('L20,40L40,40')
    expect(stepAreaPath([0, 0, 0, 0, 0, 0, 0, 0], axis, 50, 2)).toBe('')
  })
})

describe('click lists', () => {
  const lane = (id: string, usd: number[], ctx: number[]): OverviewLane => ({
    harness: 'claude',
    id,
    usd: usd.reduce((a, b) => a + b, 0),
    usdSlots: usd,
    context: ctx,
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
