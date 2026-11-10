import { describe, expect, test } from 'bun:test'
import { CLASS_SERIES, KIND_SERIES, TIER_SERIES } from './model'
import { overheadIn, segmentsOf, sumRange } from './partition'
import type { Lane, Timeline } from './timeline'
import type { Overhead } from './tree'

type Call = Lane['calls'][number]

const call = (t: number, usd: number, extra: Partial<Call> = {}): Call => ({
  t,
  usd,
  byClass: { output: usd, read: 0, write: 0, reread: 0, input: 0 },
  kind: 'main',
  reread: 0,
  model: 'opus-x',
  tier: 'heavy',
  ...extra,
})

const timeline = (...calls: Call[][]): Timeline =>
  ({
    lanes: calls.map((c, i) => ({ key: `l${i}`, calls: c })),
    spans: [],
    peak: 0,
    t0: 0,
    t1: 100,
  }) as unknown as Timeline

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)

describe('sumRange', () => {
  const tl = timeline(
    [
      call(10, 2, { byClass: { output: 0.5, read: 1, write: 0.3, reread: 0.2, input: 0 }, reread: 0.2 }),
      call(20, 1, { kind: 'compact', tier: 'mid', model: 'sonnet-x' }),
    ],
    [call(30, 4, { kind: 'subagent', tier: 'light', model: 'haiku-x' }), call(40, 8, { kind: 'fork' })],
  )

  test('the three partitions of a range add up to the same dollars', () => {
    for (const [lo, hi] of [
      [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
      [0, 25],
      [15, 41],
      [30, 31],
    ]) {
      const r = sumRange(tl, lo, hi)
      expect(sum(r.kind)).toBeCloseTo(r.usd, 9)
      expect(sum(r.class)).toBeCloseTo(r.usd, 9)
      expect(sum(r.tier)).toBeCloseTo(r.usd, 9)
      expect(r.tiers.reduce((s, t) => s + t.usd, 0)).toBeCloseTo(r.usd, 9)
    }
  })

  test('a range is from lo up to, not including, hi', () => {
    expect(sumRange(tl, 10, 30).usd).toBe(3)
    expect(sumRange(tl, 30, 41).usd).toBe(12)
    expect(sumRange(tl, 50, 60).usd).toBe(0)
    expect(sumRange(tl).usd).toBe(15)
  })

  test('the cache miss is its own part by who and by class, and stays in its tier', () => {
    const r = sumRange(tl, 0, 15)
    expect(r.kind.main).toBeCloseTo(1.8, 9)
    expect(r.kind.reread).toBeCloseTo(0.2, 9)
    expect(r.class.reread).toBeCloseTo(0.2, 9)
    expect(r.tier.heavy).toBeCloseTo(2, 9)
  })

  test('output is what the other classes leave, so an estimate in the class is not counted twice', () => {
    const t = timeline([call(1, 1, { byClass: { output: 0.9, read: 0.5, write: 0, reread: 0, input: 0 } })])
    const r = sumRange(t)
    expect(r.class.read).toBe(0.5)
    expect(r.class.output).toBeCloseTo(0.5, 9)
    expect(sum(r.class)).toBeCloseTo(1, 9)
  })

  test('the models of a tier come with the range', () => {
    const r = sumRange(tl, 15, 45)
    expect(r.tiers.map((t) => t.tier)).toEqual(['heavy', 'mid', 'light'])
    expect(r.tiers[2].models.map((m) => m.model)).toEqual(['haiku-x'])
  })
})

describe('overheadIn', () => {
  const o = (t0: number, t1: number, usd: number): Overhead => ({
    t0,
    t1,
    usd,
    reportedUSD: usd,
    coveredUSD: 0,
    rateDiffUSD: 0,
  })

  test('the whole of it for no range, a share by overlap for a range', () => {
    const w = [o(0, 100, 10), o(200, 300, 4)]
    expect(overheadIn(w)).toBe(14)
    expect(overheadIn(w, 50, 150)).toBeCloseTo(5, 9)
    expect(overheadIn(w, 250, 1000)).toBeCloseTo(2, 9)
    expect(overheadIn(w, 120, 180)).toBe(0)
  })

  test('a window of no length is in when its moment is', () => {
    expect(overheadIn([o(5, 5, 1)], 0, 10)).toBe(1)
    expect(overheadIn([o(5, 5, 1)], 5, 10)).toBe(1)
    expect(overheadIn([o(5, 5, 1)], 6, 10)).toBe(0)
  })
})

describe('segmentsOf', () => {
  test('skips zero parts, keeps the series order and ends with the hatched overhead', () => {
    const r = sumRange(timeline([call(1, 3, { kind: 'fork' }), call(2, 1)]))
    const segs = segmentsOf(KIND_SERIES, r.kind, 0.5)
    expect(segs.map((s) => s.key)).toEqual(['main', 'fork', 'overhead'])
    expect(segs[2].hatched).toBe(true)
    expect(segmentsOf(CLASS_SERIES, r.class, 0).map((s) => s.key)).toEqual(['output'])
  })

  test('every partition with the overhead adds up to the same length', () => {
    const r = sumRange(timeline([call(1, 3, { kind: 'fork' }), call(2, 1, { tier: 'mid' })]))
    const totals = [
      segmentsOf(KIND_SERIES, r.kind, 0.5),
      segmentsOf(CLASS_SERIES, r.class, 0.5),
      segmentsOf(TIER_SERIES, r.tier, 0.5, r.tiers),
    ].map((s) => s.reduce((a, x) => a + x.usd, 0))
    expect(totals[0]).toBeCloseTo(4.5, 9)
    expect(totals[1]).toBeCloseTo(totals[0], 9)
    expect(totals[2]).toBeCloseTo(totals[0], 9)
  })

  test('a tier names its models', () => {
    const r = sumRange(timeline([call(1, 3)]))
    expect(segmentsOf(TIER_SERIES, r.tier, 0, r.tiers)[0].names?.length).toBe(1)
  })
})
