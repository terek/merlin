import { describe, expect, test } from 'bun:test'
import { type MappingAxis, timeBoundaries } from './mappingBoundaries'

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const start = new Date(2026, 10, 2).getTime()
const linear = (lo: number, hi: number, width = 800): MappingAxis => ({
  lo,
  hi,
  x: (t) => ((t - lo) / (hi - lo)) * width,
})

describe('connections between the linear summary and compressed locator', () => {
  test('connects only real timestamps in the overlap, using local day boundaries', () => {
    const source = linear(start, start + 7 * day)
    const target = linear(start - 2 * day, start + 4 * day + hour)
    const marks = timeBoundaries(source, target)
    expect(marks.length).toBeGreaterThan(2)
    for (const mark of marks) {
      expect(mark.t).toBeGreaterThanOrEqual(start)
      expect(mark.t).toBeLessThanOrEqual(target.hi)
      expect(new Date(mark.t).getHours()).toBe(0)
      expect(mark.source).toBe(source.x(mark.t))
      expect(mark.target).toBe(target.x(mark.t))
    }
    expect(timeBoundaries(source, linear(start + 8 * day, start + 9 * day))).toEqual([])
    expect(timeBoundaries(source, linear(start - day, start))).toEqual([])
  })

  test('uses clock hours for an intraday overlap and finer boundaries for short sessions', () => {
    const marks = timeBoundaries(linear(start, start + 8 * hour), linear(start + 30 * minute, start + 7 * hour))
    expect(marks.length).toBeGreaterThan(2)
    expect(marks.every((m) => new Date(m.t).getMinutes() === 0)).toBe(true)
    const short = timeBoundaries(linear(start, start + hour), linear(start + 2 * minute, start + 8 * minute))
    expect(short.length).toBeGreaterThan(1)
    expect(short.every((m) => m.t >= start + 2 * minute && m.t <= start + 8 * minute)).toBe(true)
  })

  test('thins on both axes when a long pause is compressed into a few pixels', () => {
    const source = linear(start, start + 8 * day)
    const target: MappingAxis = {
      lo: start,
      hi: start + 8 * day,
      x: (t) => (t < start + 4 * day ? (t - start) / day : 4 + ((t - start - 4 * day) / day) * 150),
    }
    const marks = timeBoundaries(source, target)
    expect(marks.length).toBeGreaterThan(1)
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i].source - marks[i - 1].source).toBeGreaterThanOrEqual(24)
      expect(marks[i].target - marks[i - 1].target).toBeGreaterThanOrEqual(24)
    }
    const narrow = timeBoundaries(linear(start, start + 8 * day, 30), linear(start, start + 8 * day))
    expect(narrow.length).toBeLessThanOrEqual(2)
  })

  test('caps long ranges and uses real endpoints when no finer clock boundary exists', () => {
    expect(timeBoundaries(linear(start, start + 100 * day, 5000), linear(start, start + 100 * day, 5000))).toHaveLength(
      8,
    )
    const lo = start + 2000
    const hi = start + 20_000
    const marks = timeBoundaries(linear(lo, hi), linear(lo, hi))
    expect(marks.map((m) => m.t)).toEqual([lo, hi])
    expect(timeBoundaries(linear(Number.NaN, hi), linear(lo, hi))).toEqual([])
  })
})
