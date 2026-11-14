import { describe, expect, test } from 'bun:test'
import { scopeSearch } from './scope'

describe('scopeSearch', () => {
  test('keeps the scope and drops the rest', () => {
    expect(scopeSearch('?range=30d&sort=spend&dir=desc&by=repo&in=%2Fw%2Facme&q=x&stack=source')).toBe(
      '?range=30d&by=repo&in=%2Fw%2Facme&q=x',
    )
  })
  test('a custom range', () => {
    expect(scopeSearch('?from=2026-10-20&to=2026-11-03&range=7d')).toBe('?range=7d&from=2026-10-20&to=2026-11-03')
  })
  test('nothing in scope is nothing', () => {
    expect(scopeSearch('')).toBe('')
    expect(scopeSearch('?sort=spend')).toBe('')
  })
})
