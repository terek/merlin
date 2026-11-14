import { describe, expect, test } from 'bun:test'
import { migrateCostSearch } from './lens'

const today = new Date(2026, 10, 14, 15, 0)
const mig = (s: string, first: string | null = null) => {
  const r = migrateCostSearch(new URLSearchParams(s), today, first)
  return r instanceof URLSearchParams ? r.toString() : r
}

describe('migrateCostSearch', () => {
  test('new addresses are left alone', () => {
    expect(mig('range=30d&by=repo&in=%2Fw&q=x&stack=source')).toBeNull()
    expect(mig('from=2026-11-01&to=2026-11-03')).toBeNull()
    expect(mig('')).toBeNull()
  })
  test('project is a folder selection', () => {
    expect(mig('project=%2FUsers%2Fdev%2Fmerlin')).toBe('by=dir&in=%2FUsers%2Fdev%2Fmerlin')
  })
  test('90d is 90 whole days ending today', () => {
    expect(mig('range=90d&stack=source')).toBe('stack=source&from=2026-08-17&to=2026-11-14')
  })
  test('all starts at the first day with spend, once it is known', () => {
    expect(mig('range=all')).toBe('wait')
    expect(mig('range=all', '2026-05-02')).toBe('from=2026-05-02&to=2026-11-14')
  })
  test('the cuts go; a lone from is one day', () => {
    expect(mig('repocut=remote&beadcut=bead&range=7d')).toBe('range=7d')
    expect(mig('from=2026-11-03')).toBe('from=2026-11-03&to=2026-11-03')
  })
  test('all together', () => {
    expect(mig('project=%2Fw%2Fa&range=90d&repocut=repo')).toBe('by=dir&in=%2Fw%2Fa&from=2026-08-17&to=2026-11-14')
  })
})
