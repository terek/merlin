import { describe, expect, test } from 'bun:test'
import { arcPath, spansOf } from './ring'

describe('spansOf', () => {
  test('linear shares from 0 to 1 in order', () => {
    const s = spansOf([1, 1, 2])
    expect(s.map((x) => x.from)).toEqual([0, 0.25, 0.5])
    expect(s[2].to).toBe(1)
  })
  test('a lone part is the whole turn, and nothing is nothing', () => {
    expect(spansOf([3])).toEqual([{ from: 0, to: 1 }])
    expect(spansOf([0, 0])).toEqual([
      { from: 0, to: 0 },
      { from: 0, to: 0 },
    ])
  })
})

describe('arcPath', () => {
  test('a whole turn is a full ring of two circles', () => {
    expect(arcPath(50, 50, 40, 50, { from: 0, to: 1 }, 1).match(/M/g)).toHaveLength(2)
  })
  test('a quarter starts at 12 o clock and ends at 3', () => {
    const d = arcPath(50, 50, 40, 50, { from: 0, to: 0.25 })
    expect(d.startsWith('M50 0A50 50 0 0 1 100 50L90 50')).toBe(true)
  })
  test('a gap pulls the ends in, and a part shorter than it stays a hairline', () => {
    expect(arcPath(50, 50, 40, 50, { from: 0, to: 0.25 }, 2)).not.toBe(arcPath(50, 50, 40, 50, { from: 0, to: 0.25 }))
    expect(arcPath(50, 50, 40, 50, { from: 0.1, to: 0.1001 }, 4)).toContain('A')
  })
  test('more than half a turn takes the large arc', () => {
    expect(arcPath(50, 50, 40, 50, { from: 0, to: 0.75 })).toContain('0 1 1')
  })
})
