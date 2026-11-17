import { describe, expect, test } from 'bun:test'
import type { LimitLockout, LimitWindow } from '../../api/types'
import { makeAxis } from './model'
import {
  limitName,
  lockoutBand,
  lockoutMs,
  lockoutText,
  qualifies,
  refusalsBySession,
  refusalTicks,
  scopeWindows,
  windowRange,
  windowSpan,
} from './windows'

const win = (o: Partial<LimitWindow>): LimitWindow => ({
  harness: 'codex',
  limit: 'codex',
  windowMinutes: 300,
  startsAt: '2026-11-10T10:00:00Z',
  resetsAt: '2026-11-10T15:00:00Z',
  firstSeenAt: '2026-11-10T10:10:00Z',
  lastSeenAt: '2026-11-10T14:00:00Z',
  refusals: 0,
  ...o,
})

describe('qualifies', () => {
  test('refusals, or 90 percent', () => {
    expect(qualifies(win({ refusals: 1 }))).toBe(true)
    expect(qualifies(win({ maxPercent: 90 }))).toBe(true)
    expect(qualifies(win({ maxPercent: 89 }))).toBe(false)
    expect(qualifies(win({}))).toBe(false)
  })
})

describe('scopeWindows', () => {
  const a = win({ maxPercent: 100, startsAt: '2026-11-10T10:00:00Z', resetsAt: '2026-11-10T15:00:00Z' })
  const b = win({ harness: 'claude', refusals: 3, startsAt: '2026-11-11T10:00:00Z', resetsAt: '2026-11-11T15:00:00Z' })
  const c = win({ maxPercent: 20 })
  const from = Date.parse('2026-11-10T00:00:00Z')
  const to = Date.parse('2026-11-12T00:00:00Z')
  test('qualifying and overlapping, newest first', () => {
    expect(scopeWindows([a, b, c], from, to)).toEqual([b, a])
  })
  test('one harness', () => {
    expect(scopeWindows([a, b], from, to, 'codex')).toEqual([a])
  })
  test('outside the range', () => {
    expect(scopeWindows([a], Date.parse('2026-11-10T15:00:00Z'), to)).toEqual([])
  })
})

describe('windowRange', () => {
  test('the instants and the harness', () => {
    const r = windowRange(win({}))
    expect(r.fromMs).toBe(Date.parse('2026-11-10T10:00:00Z'))
    expect(r.toMs).toBe(Date.parse('2026-11-10T15:00:00Z'))
    expect(r.harness).toBe('codex')
  })
  test('without a start the span begins at the first reading', () => {
    expect(windowSpan(win({ startsAt: undefined })).fromMs).toBe(Date.parse('2026-11-10T10:10:00Z'))
  })
})

describe('lockout', () => {
  const w: LimitLockout = {
    harness: 'codex',
    startedAt: '2026-11-10T14:20:00Z',
    endedAt: '2026-11-10T15:00:00Z',
    resetsAt: '2026-11-10T15:00:00Z',
    end: 'reset',
  }
  test('reset minus the first refusal, rounded as the session graph writes breaks', () => {
    expect(lockoutMs(w)).toBe(40 * 60_000)
    expect(lockoutText(40 * 60_000)).toBe('40m')
    expect(lockoutText(8 * 3_600_000 + 12 * 60_000)).toBe('8h')
    expect(lockoutText(2 * 3_600_000)).toBe('2h')
    expect(lockoutText(3 * 86_400_000)).toBe('3d')
    expect(lockoutText(2 * 60_000)).toBe('5m')
  })
  test('none without a refusal', () => {
    expect(lockoutMs({ ...w, startedAt: 'invalid' })).toBeUndefined()
  })
  test('the band is clipped to the range', () => {
    const from = Date.parse('2026-11-10T14:30:00Z')
    expect(lockoutBand(w, from, Date.parse('2026-11-11T00:00:00Z'))).toEqual({
      fromMs: from,
      toMs: Date.parse('2026-11-10T15:00:00Z'),
    })
    expect(lockoutBand(w, Date.parse('2026-11-10T16:00:00Z'), Date.parse('2026-11-11T00:00:00Z'))).toBeNull()
  })
})

describe('limitName', () => {
  test('words for the two limits', () => {
    expect(limitName({ windowMinutes: 300 })).toBe('5h')
    expect(limitName({ windowMinutes: 10080 })).toBe('Weekly')
    expect(limitName({ windowMinutes: 1440 })).toBe('24h')
  })
})

describe('refusalTicks', () => {
  const axis = makeAxis(0, 1000 * 60_000, 60_000, 1000)
  test('inside the axis, sorted, closer than 3 px merged', () => {
    const m = 60_000
    expect(refusalTicks([500 * m, 10 * m, 11 * m, 12 * m, 14 * m, 2000 * m, -5 * m], axis)).toEqual([10, 14, 500])
  })
})

describe('refusalsBySession', () => {
  test('groups by session; scripted runs have none', () => {
    const m = refusalsBySession([
      { at: '2026-11-10T14:00:00Z', harness: 'claude', session: { harness: 'claude', id: 'a' } },
      { at: '2026-11-10T14:05:00Z', harness: 'claude', session: { harness: 'claude', id: 'a' } },
      { at: '2026-11-10T14:06:00Z', harness: 'claude', scripted: true },
    ])
    expect(m.get('claude/a')?.length).toBe(2)
    expect(m.size).toBe(1)
  })
})
