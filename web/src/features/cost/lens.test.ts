import { describe, expect, test } from 'bun:test'
import type { CostRow } from '../../api/types'
import {
  agentSentence,
  cascade,
  changeAgainst,
  classSentence,
  concentration,
  migrateCostSearch,
  previousWindow,
  sidebarExtras,
  sidebarGap,
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

describe('the cascade', () => {
  test('each segment starts where the one above ended', () => {
    const c = cascade([50, 30, 20], 100)
    expect(c.map((x) => [x.from, x.width])).toEqual([
      [0, 0.5],
      [0.5, 0.3],
      [0.8, 0.2],
    ])
  })
  test('a tiny share keeps a minimum width, and the segment stays inside the track', () => {
    const c = cascade([99.9, 0.05, 0.05], 100, 0.01)
    expect(c[1].width).toBe(0.01)
    expect(c[2].from).toBeGreaterThanOrEqual(0.99)
    expect(c[2].from + c[2].width).toBeLessThanOrEqual(1)
  })
  test('an empty total draws nothing', () => {
    expect(cascade([0, 0], 0)).toEqual([
      { from: 0, width: 0 },
      { from: 0, width: 0 },
    ])
  })
})

describe('the sidebar adds up', () => {
  test('places + scripted runs + not in any session = the total', () => {
    // the mock, 30 days, nothing selected
    const extras = sidebarExtras({ selected: false, scriptedUsd: 27.43, scriptedRuns: 3811, overheadUsd: 7.7 })
    expect(extras.map((e) => e.id)).toEqual(['scripted', 'overhead'])
    expect(Math.abs(sidebarGap(521.97, 486.84, extras))).toBeLessThan(0.01)
  })
  test('under a selection: no scripted line, the selection’s own overhead', () => {
    const extras = sidebarExtras({ selected: true, scriptedUsd: 27.43, scriptedRuns: 3811, overheadUsd: 1.67 })
    expect(extras.map((e) => e.id)).toEqual(['overhead'])
    expect(Math.abs(sidebarGap(91.88, 90.21, extras))).toBeLessThan(0.01)
  })
  test('nothing to add: no lines', () => {
    expect(sidebarExtras({ selected: false, scriptedUsd: 0, scriptedRuns: 0, overheadUsd: 0 })).toEqual([])
  })
})
