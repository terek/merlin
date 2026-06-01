import { describe, expect, test } from 'bun:test'
import { RollingBuffer } from '../../src/rolling-buffer.ts'

describe('RollingBuffer', () => {
  test('starts empty', () => {
    const buf = new RollingBuffer()
    expect(buf.getLines()).toEqual([])
    expect(buf.length).toBe(0)
  })

  test('push adds entries', () => {
    const buf = new RollingBuffer()
    buf.push('line 1')
    buf.push('line 2')
    expect(buf.getLines()).toEqual(['line 1', 'line 2'])
    expect(buf.length).toBe(2)
  })

  test('getLines returns a copy', () => {
    const buf = new RollingBuffer()
    buf.push('a')
    const lines = buf.getLines()
    lines.push('injected')
    expect(buf.getLines()).toEqual(['a'])
  })

  test('evicts oldest when over capacity', () => {
    const buf = new RollingBuffer(3)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.push('d')
    expect(buf.getLines()).toEqual(['b', 'c', 'd'])
    expect(buf.length).toBe(3)
  })

  test('tail returns last N lines', () => {
    const buf = new RollingBuffer()
    buf.push('a')
    buf.push('b')
    buf.push('c')
    expect(buf.tail(2)).toEqual(['b', 'c'])
  })

  test('tail with N > length returns all', () => {
    const buf = new RollingBuffer()
    buf.push('a')
    expect(buf.tail(5)).toEqual(['a'])
  })

  test('clear empties the buffer', () => {
    const buf = new RollingBuffer()
    buf.push('a')
    buf.push('b')
    buf.clear()
    expect(buf.getLines()).toEqual([])
    expect(buf.length).toBe(0)
  })
})
