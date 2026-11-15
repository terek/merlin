import { describe, expect, test } from 'bun:test'
import type { LimitWindow } from '../../api/types'
import { median, sentenceMoney, sessionLabel, worthSentences } from './worth'

const win = (o: Partial<LimitWindow>): LimitWindow => ({
  harness: 'codex',
  limit: 'codex',
  windowMinutes: 300,
  resetsAt: '2026-11-10T15:00:00Z',
  firstSeenAt: '2026-11-10T10:00:00Z',
  lastSeenAt: '2026-11-10T14:00:00Z',
  refusals: 0,
  ...o,
})

describe('median', () => {
  test('odd, even, none', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBeNaN()
  })
})

describe('sentenceMoney', () => {
  test('whole dollars from $10', () => {
    expect(sentenceMoney(11.2)).toBe('$11')
    expect(sentenceMoney(0.11)).toBe('$0.11')
    expect(sentenceMoney(1234.5)).toBe('$1,235')
  })
})

describe('sessionLabel', () => {
  test('name, title, then the id', () => {
    expect(sessionLabel({ id: 'abcdef123456', name: 'billing', title: 't' })).toBe('billing')
    expect(sessionLabel({ id: 'abcdef123456', title: 'a title' })).toBe('a title')
    expect(sessionLabel({ id: 'abcdef123456' })).toBe('abcdef12')
  })
})

describe('worthSentences', () => {
  test('Codex: the median dollars per percent', () => {
    const ws = [0.1, 0.12, 0.11, 0.1, 0.13, 0.11].map((usdPerPercent) => win({ usdPerPercent }))
    expect(worthSentences(ws)).toEqual([
      'A Codex 5h window is worth about $11 at API prices (1% ≈ $0.11, median of the 6 windows in this range).',
    ])
  })
  test('Claude: the median spend of the hits', () => {
    const ws = [30, 40, 54, 60].map((seenUSD) =>
      win({ harness: 'claude', limit: 'five_hour', refusals: 5, seenUSD, firstRefusalAt: '2026-11-10T14:00:00Z' }),
    )
    expect(worthSentences(ws)).toEqual([
      'Claude Code ran out after at least $47 (median of 4 hits; spend this machine recorded).',
    ])
  })
  test('a weekly Claude limit is named; no data, no sentence', () => {
    const ws = [
      win({ harness: 'claude', limit: 'seven_day', windowMinutes: 10080, refusals: 2, seenUSD: 300 }),
      win({ windowMinutes: 10080 }),
    ]
    expect(worthSentences(ws)).toEqual([
      'Claude Code ran out of its weekly limit after at least $300 (median of 1 hit; spend this machine recorded).',
    ])
  })
})
