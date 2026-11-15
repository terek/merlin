import { describe, expect, test } from 'bun:test'
import type { LimitWindow } from '../../api/types'
import { affectedLockouts, lockoutAffects, lockoutSpans, lockoutTitle, waitUntil } from './windows'

const at = (h: number, m = 0) =>
  Date.parse(`2026-11-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)
const iso = (h: number) => new Date(at(h)).toISOString()
const win = (o: Partial<LimitWindow>): LimitWindow => ({
  harness: 'claude',
  limit: 'five_hour',
  windowMinutes: 300,
  resetsAt: iso(15),
  firstSeenAt: iso(10),
  lastSeenAt: iso(14),
  refusals: 2,
  firstRefusalAt: iso(12),
  ...o,
})

describe('lockoutSpans', () => {
  test('one window is one span from the first refusal to the reset', () => {
    const s = lockoutSpans([win({})], 'claude', 0, at(23))
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ fromMs: at(12), toMs: at(15), untilMs: at(15) })
  })

  test('clips to the range but keeps the real end', () => {
    const s = lockoutSpans([win({})], 'claude', at(13), at(14))
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ fromMs: at(13), toMs: at(14), untilMs: at(15) })
    expect(lockoutSpans([win({})], 'claude', at(16), at(18))).toEqual([])
  })

  test('overlapping and touching lockouts merge, naming both windows', () => {
    const weekly = win({ windowMinutes: 10080, limit: 'seven_day', firstRefusalAt: iso(14), resetsAt: iso(20) })
    const s = lockoutSpans([weekly, win({})], 'claude', 0, at(23))
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ fromMs: at(12), toMs: at(20), untilMs: at(20) })
    expect(s[0].windows.map((w) => w.windowMinutes)).toEqual([300, 10080])
    const touching = win({ firstRefusalAt: iso(15), resetsAt: iso(18) })
    expect(lockoutSpans([win({}), touching], 'claude', 0, at(23))).toHaveLength(1)
  })

  test('separate lockouts stay apart, sorted', () => {
    const later = win({ firstRefusalAt: iso(18), resetsAt: iso(20) })
    const s = lockoutSpans([later, win({})], 'claude', 0, at(23))
    expect(s.map((x) => x.fromMs)).toEqual([at(12), at(18)])
  })

  test('other harnesses and windows without a lockout are ignored', () => {
    const codex = win({ harness: 'codex' })
    const none = win({ firstRefusalAt: undefined, refusals: 0 })
    expect(lockoutSpans([codex, none], 'claude', 0, at(23))).toEqual([])
    expect(lockoutSpans([codex, none], 'codex', 0, at(23))).toHaveLength(1)
  })
})

describe('lockoutTitle', () => {
  test('names the limits and the end', () => {
    const one = lockoutTitle({ untilMs: at(15), windows: [win({})] })
    expect(one).toMatch(/^Locked out by the 5h limit until \w{3} \d+, \d\d:\d\d$/)
    const two = lockoutTitle({ untilMs: at(15), windows: [win({}), win({ windowMinutes: 10080 })] })
    expect(two).toMatch(/^Locked out by the 5h and Weekly limits until /)
  })
})

describe('affected lockouts', () => {
  const lock = { fromMs: at(12), toMs: at(15) }
  test('a session alive in the lockout is affected', () => {
    expect(lockoutAffects(lock, { fromMs: at(10), toMs: at(13) })).toBe(true)
    expect(lockoutAffects(lock, { fromMs: at(13), toMs: at(14) })).toBe(true)
  })
  test('a session that stopped at the refusal is affected, even a little before it', () => {
    expect(lockoutAffects(lock, { fromMs: at(10), toMs: at(11, 58) })).toBe(true)
    expect(lockoutAffects(lock, { fromMs: at(10), toMs: at(11, 30) })).toBe(false)
  })
  test('a session that ended before or began after is not affected', () => {
    expect(lockoutAffects(lock, { fromMs: at(8), toMs: at(10) })).toBe(false)
    expect(lockoutAffects(lock, { fromMs: at(15), toMs: at(16) })).toBe(false)
  })
  test('a refused call inside it counts, whatever the life', () => {
    expect(lockoutAffects(lock, null, [at(13)])).toBe(true)
    expect(lockoutAffects(lock, { fromMs: at(8), toMs: at(10) }, [at(16)])).toBe(false)
  })
  test('the filter keeps the whole spans', () => {
    const other = { fromMs: at(20), toMs: at(22) }
    expect(affectedLockouts([lock, other], { fromMs: at(13), toMs: at(14) })).toEqual([lock])
    expect(affectedLockouts(undefined, null)).toEqual([])
  })
})

describe('waitUntil', () => {
  const lock = { fromMs: at(12), toMs: at(15) }
  test('a session that ended at the first refusal waits for the reset', () => {
    expect(waitUntil([lock], { fromMs: at(9), toMs: at(12) })).toBe(at(15))
    expect(waitUntil([lock], { fromMs: at(9), toMs: at(11, 57) })).toBe(at(15))
  })
  test('a session that stopped well before it, or carried on past the reset, has no wait', () => {
    expect(waitUntil([lock], { fromMs: at(9), toMs: at(11) })).toBeUndefined()
    expect(waitUntil([lock], { fromMs: at(9), toMs: at(16) })).toBeUndefined()
  })
  test('a refused call of the session in it makes it start within the session', () => {
    expect(waitUntil([lock], { fromMs: at(13), toMs: at(13, 30) })).toBeUndefined()
    expect(waitUntil([lock], { fromMs: at(13), toMs: at(13, 30) }, [at(13, 10)])).toBe(at(15))
  })
  test('the latest end of several wins', () => {
    expect(waitUntil([lock, { fromMs: at(12, 2), toMs: at(18) }], { fromMs: at(9), toMs: at(12) })).toBe(at(18))
  })
})
