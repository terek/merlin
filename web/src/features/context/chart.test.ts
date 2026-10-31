import { describe, expect, test } from 'bun:test'
import type { Compaction, CompactionCall, Turn } from '../../api/types'
import {
  compactionMarks,
  contextPoints,
  linear,
  type Mark,
  nearestMark,
  nearestPoint,
  niceTicks,
  type Point,
  pricedLabels,
  segments,
  spacedLabels,
  stepCursor,
} from './chart'

const turn = (index: number, contextTokens?: number, extra: Partial<Turn> = {}): Turn => ({
  index,
  epoch: 0,
  origin: 'human',
  userText: `prompt ${index}\nsecond line`,
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 0 },
  costWithAgents: 0,
  contextTokens,
  ...extra,
})

const pt = (index: number, tokens = 10, abandoned = false): Point => ({ index, tokens, abandoned, prompt: '' })

describe('contextPoints', () => {
  test('skips turns without a value, keeps zero-free order and the first prompt line', () => {
    const p = contextPoints([turn(0, 100), turn(1), turn(2, 300, { abandoned: true })])
    expect(p.map((x) => x.index)).toEqual([0, 2])
    expect(p[0].prompt).toBe('prompt 0')
    expect(p[1].abandoned).toBe(true)
    expect(contextPoints(undefined)).toEqual([])
  })
})

describe('niceTicks', () => {
  test('rounds up to a covering, round step', () => {
    expect(niceTicks(195_000, 4)).toEqual([0, 50_000, 100_000, 150_000, 200_000])
    expect(niceTicks(600, 4)).toEqual([0, 200, 400, 600])
    expect(niceTicks(23, 4)).toEqual([0, 10, 20, 30])
    expect(niceTicks(0)).toEqual([0, 1])
  })
})

describe('linear', () => {
  test('maps and inverts', () => {
    const s = linear(0, 100, 10, 210)
    expect(s(50)).toBe(110)
    expect(s.invert(110)).toBe(50)
    expect(linear(5, 5, 0, 10)(5)).toBe(5)
  })
})

describe('segments', () => {
  test('splits kept and abandoned runs and keeps the line continuous', () => {
    const s = segments([pt(0), pt(1), pt(2, 5, true), pt(3, 5, true), pt(4)])
    expect(s.map((x) => [x.abandoned, x.points.map((p) => p.index)])).toEqual([
      [false, [0, 1]],
      [true, [1, 2, 3]],
      [false, [3, 4]],
    ])
  })
})

describe('compactionMarks', () => {
  const c = (turnIdx: number, pre = 100, post = 20): Compaction => ({
    at: 't',
    turn: turnIdx,
    preTokens: pre,
    postTokens: post,
  })
  test('sits between turns, clamped and sorted', () => {
    const m = compactionMarks([c(300), c(-1), c(700)], 0, 600)
    expect(m.map((x) => x.at)).toEqual([0, 300.5, 600])
    expect(m[1].pre).toBe(100)
  })
})

describe('spacedLabels', () => {
  test('drops labels that would collide', () => {
    expect(spacedLabels([0, 10, 60, 70, 130], 50)).toEqual([true, false, true, false, true])
  })
})

describe('cursor', () => {
  const pts = [pt(0), pt(2), pt(5), pt(9)]
  test('nearest point', () => {
    expect(nearestPoint(pts, 3)?.index).toBe(2)
    expect(nearestPoint(pts, 4)?.index).toBe(5)
    expect(nearestPoint(pts, -4)?.index).toBe(0)
    expect(nearestPoint(pts, 99)?.index).toBe(9)
    expect(nearestPoint([], 1)).toBeUndefined()
  })
  test('stepping skips turns without a value and clamps', () => {
    expect(stepCursor(pts, 2, 1)?.index).toBe(5)
    expect(stepCursor(pts, 2, -1)?.index).toBe(0)
    expect(stepCursor(pts, 0, -1)?.index).toBe(0)
    expect(stepCursor(pts, 9, 5)?.index).toBe(9)
    expect(stepCursor(pts, null, -1)?.index).toBe(9)
  })
})

describe('nearestMark', () => {
  const marks = [
    { at: 10.5, turn: 10 },
    { at: 40.5, turn: 40 },
    { at: 90.5, turn: 90 },
  ]
  test('the nearest one, the earlier on a tie', () => {
    expect(nearestMark(marks, 12)?.turn).toBe(10)
    expect(nearestMark(marks, 41)?.turn).toBe(40)
    expect(nearestMark(marks, 100)?.turn).toBe(90)
    expect(nearestMark(marks, 25.5)?.turn).toBe(10)
  })
  test('none', () => {
    expect(nearestMark([], 3)).toBeUndefined()
  })
})

describe('pricedLabels', () => {
  const call = (cache: 'warm' | 'cold', usd: number): CompactionCall => ({
    model: 'claude-fable-5-1',
    idleMs: cache === 'cold' ? 7_200_000 : 60_000,
    cache,
    billing: cache === 'cold' ? 'input' : 'cache-read',
    inputTokens: 100_000,
    outputTokens: 2_000,
    usd,
    warmUSD: cache === 'cold' ? usd / 10 : usd,
  })
  const mark = (at: number, c?: CompactionCall): Mark => ({ at, turn: Math.floor(at), call: c })
  const px = (at: number) => at * 10

  test('a cold call wins the room over a warm one next to it, even a dearer one', () => {
    const warm = mark(10.5, call('warm', 3))
    const cold = mark(12.5, call('cold', 2))
    expect([...pricedLabels([warm, cold], px, 38)]).toEqual([cold])
  })
  test('among calls of one kind the dearer one wins; far apart all are labelled', () => {
    const a = mark(10.5, call('warm', 0.5))
    const b = mark(11.5, call('warm', 0.9))
    const c = mark(30.5, call('warm', 0.1))
    expect(pricedLabels([a, b, c], px, 38)).toEqual(new Set([b, c]))
  })
  test('a mark without a call is never labelled', () => {
    expect(pricedLabels([mark(5.5)], px, 38).size).toBe(0)
  })
})
