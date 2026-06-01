import { describe, expect, test } from 'bun:test'
import { applyOps, generatePatch, snapshot } from '@merlin/sync'

describe('JSON Patch utilities', () => {
  test('generatePatch returns empty for identical objects', () => {
    const obj = { a: 1, b: 'hello' }
    expect(generatePatch(obj, obj)).toEqual([])
  })

  test('generatePatch detects property addition', () => {
    const old = { a: 1 } as any
    const curr = { a: 1, b: 2 }
    const ops = generatePatch(old, curr)
    expect(ops.length).toBe(1)
    expect(ops[0].op).toBe('add')
  })

  test('generatePatch detects property change', () => {
    const old = { a: 1 }
    const curr = { a: 2 }
    const ops = generatePatch(old, curr)
    expect(ops.length).toBe(1)
    expect(ops[0].op).toBe('replace')
  })

  test('generatePatch detects property removal', () => {
    const old = { a: 1, b: 2 }
    const curr = { a: 1 } as any
    const ops = generatePatch(old, curr)
    expect(ops.length).toBe(1)
    expect(ops[0].op).toBe('remove')
  })

  test('applyOps applies patch correctly', () => {
    const obj = { a: 1, b: 'hello' }
    const ops = [{ op: 'replace' as const, path: '/a', value: 42 }]
    const result = applyOps(obj, ops)
    expect(result.a).toBe(42)
    expect(result.b).toBe('hello')
  })

  test('applyOps does not mutate original', () => {
    const obj = { a: 1 }
    const ops = [{ op: 'replace' as const, path: '/a', value: 2 }]
    applyOps(obj, ops)
    expect(obj.a).toBe(1)
  })

  test('applyOps with empty ops returns same value', () => {
    const obj = { a: 1 }
    expect(applyOps(obj, [])).toBe(obj)
  })

  test('snapshot creates a deep clone', () => {
    const obj = { a: { b: [1, 2, 3] } }
    const clone = snapshot(obj)
    expect(clone).toEqual(obj)
    clone.a.b.push(4)
    expect(obj.a.b).toHaveLength(3)
  })

  test('round-trip: generate then apply produces same result', () => {
    const old = { name: 'alice', items: [1, 2] }
    const curr = { name: 'bob', items: [1, 2, 3] }
    const ops = generatePatch(old, curr)
    const result = applyOps(old, ops)
    expect(result).toEqual(curr)
  })
})
