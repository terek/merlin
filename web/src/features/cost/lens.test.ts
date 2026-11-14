import { describe, expect, test } from 'bun:test'
import type { CostRow } from '../../api/types'
import {
  agentSentence,
  changeAgainst,
  classSentence,
  concentration,
  migrateCostSearch,
  previousWindow,
  windowDays,
} from './lens'

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

describe('the period before', () => {
  test('as many days just before the window', () => {
    expect(previousWindow({ from: '2026-10-16', to: '2026-11-14' })).toEqual({ from: '2026-09-16', to: '2026-10-15' })
    expect(previousWindow({ from: '2026-11-14', to: '2026-11-14' })).toEqual({ from: '2026-11-13', to: '2026-11-13' })
    expect(windowDays({ from: '2026-10-16', to: '2026-11-14' })).toBe(30)
  })
  test('the change, in percent, and in dollars on hover', () => {
    const c = changeAgainst(522, 390, 30)
    expect(c?.text).toBe('+34% on the 30 days before')
    expect(c?.title).toContain('+$132')
    expect(changeAgainst(100, 200, 1)?.text).toBe('−50% on the day before')
    expect(changeAgainst(100, 100.2, 7)?.text).toBe('the same as the 7 days before')
  })
  test('no spend before, nothing to compare', () => {
    expect(changeAgainst(50, 0, 7)).toBeNull()
  })
})

const row = (key: string, totalUSD: number): CostRow => ({
  key,
  totalUSD,
  sessions: 1,
  reportedUSD: 0,
  attributedUSD: totalUSD,
})

describe('the computed sentences', () => {
  test('price classes', () => {
    const rows = [row('cacheWrite', 31), row('output', 30), row('cacheRead', 29), row('input', 10)]
    expect(classSentence(rows)).toBe(
      'Writing caches cost $31.00 (31%) and reading them $29.00 (29%); output is 30% and uncached input 10%.',
    )
    expect(classSentence([row('(unsplit)', 5)])).toBeNull()
  })
  test('agents', () => {
    expect(agentSentence([row('main', 65), row('agents', 35)])).toBe('Sub-agents spent 35% of it ($35.00).')
    expect(agentSentence([row('main', 65)])).toBeNull()
  })
})

describe('concentration', () => {
  test('the fewest sessions that make half', () => {
    expect(concentration([50, 20, 10, 10, 5, 5])).toEqual({ n: 1, of: 6 })
    expect(concentration([10, 10, 10, 10, 10, 10])).toEqual({ n: 3, of: 6 })
  })
  test('hidden under 5 sessions or without spend', () => {
    expect(concentration([5, 5, 5, 5])).toBeNull()
    expect(concentration([0, 0, 0, 0, 0])).toBeNull()
  })
})
