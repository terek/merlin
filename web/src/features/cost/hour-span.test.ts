import { describe, expect, test } from 'bun:test'
import type { CostRow } from '../../api/types'
import { hourSpan, makeHourBuckets } from './model'

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
const row = (key: string, usd: number): CostRow => ({
  key,
  sessions: 1,
  totalUSD: usd,
  reportedUSD: usd,
  attributedUSD: 0,
})

describe('hourSpan', () => {
  test('the hour holding the start to the hour holding the last instant, both included', () => {
    expect(hourSpan(at(13, 19, 20), at(14, 0, 0))).toEqual({ first: '2026-11-13T19', last: '2026-11-13T23' })
    expect(hourSpan(at(13, 19), at(14, 0, 30))).toEqual({ first: '2026-11-13T19', last: '2026-11-14T00' })
  })
})

describe('the by-hour chart of a limit window', () => {
  const rows = [row('2026-11-13T19', 1), row('2026-11-13T22', 2), row('2026-11-13T05', 9)]
  test('only the window clock hours', () => {
    const b = makeHourBuckets(
      rows,
      { since: '2026-11-13', until: '2026-11-13', clock: { fromMs: at(13, 19, 20), toMs: at(14, 0) } },
      1,
    )
    expect(b.map((x) => x.key)).toEqual([19, 20, 21, 22, 23].map((h) => `2026-11-13T${h}`))
    expect(b.reduce((n, x) => n + x.total, 0)).toBe(3)
  })
  test('across midnight', () => {
    const b = makeHourBuckets(
      [],
      { since: '2026-11-13', until: '2026-11-14', clock: { fromMs: at(13, 22), toMs: at(14, 2) } },
      1,
    )
    expect(b.map((x) => x.key)).toEqual(['2026-11-13T22', '2026-11-13T23', '2026-11-14T00', '2026-11-14T01'])
  })
  test('without a clock, whole days', () => {
    expect(makeHourBuckets([], { since: '2026-11-13', until: '2026-11-13' }, 1).length).toBe(24)
  })
})
