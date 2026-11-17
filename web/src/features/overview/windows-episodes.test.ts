import { describe, expect, test } from 'bun:test'
import type { LimitLockout, Limits, LimitWindow } from '../../api/types'
import { formatCustom, parseCustom } from './model'
import {
  episodeText,
  limitName,
  lockoutBand,
  lockoutMs,
  lockoutSpans,
  scopeWindows,
  sessionLockouts,
  waitUntil,
  windowLockouts,
  windowRange,
  windowSpan,
  windowTimes,
} from './windows'

const at = (s: string) => Date.parse(s)
const refused = '2026-11-06T10:00:00Z'
const resumed = '2026-11-06T12:00:00Z'
const reset = '2026-12-01T00:00:00Z'
// API shape of the hand-written spend-cap refusal: both startsAt and windowMinutes are absent.
const cap: LimitWindow = JSON.parse(`{
  "harness":"claude", "account":"invented-account-a", "accountLabel":"Account 1",
  "limit":"overage", "kind":"spend_cap", "resetsAt":"${reset}",
  "firstSeenAt":"${refused}", "lastSeenAt":"${refused}",
  "refusals":1, "firstRefusalAt":"${refused}"
}`)
const episode: LimitLockout = {
  harness: 'claude',
  account: 'invented-account-a',
  accountLabel: 'Account 1',
  limit: 'overage',
  kind: 'spend_cap',
  startedAt: refused,
  resetsAt: reset,
  endedAt: resumed,
  workResumedAt: resumed,
  end: 'resumed',
}

describe('spend caps and explicit episodes', () => {
  test('unknown bounds have words and observed span, never a month-long window', () => {
    expect(limitName(cap)).toBe('Spend cap')
    expect(limitName({ limit: 'overage' })).toBe('Overage limit')
    expect(limitName({})).toBe('Unnamed limit')
    expect(limitName({ windowMinutes: Number.NaN })).toBe('Unnamed limit')
    expect(windowSpan(cap)).toEqual({ fromMs: at(refused), toMs: at(refused) })
    expect(windowTimes(cap)).toContain('refused')
    expect(windowTimes(cap)).toContain('reset Dec 1')
    expect(windowTimes(cap)).not.toContain('NaN')
    expect(cap.startsAt).toBeUndefined() // UI disables range links.
  })
  test('two-hour recovery ends the band and wait, regardless of the future reset', () => {
    expect(lockoutMs(episode)).toBe(2 * 3_600_000)
    const spans = lockoutSpans([episode], 'claude', 0, at(reset), cap.account)
    expect(spans[0]?.toMs).toBe(at(resumed))
    expect(waitUntil(spans, { fromMs: at(refused) - 60_000, toMs: at(refused) })).toBe(at(resumed))
    expect(episodeText(episode)).toBe('Account 1: calls resumed after 2h')
  })
  test('future reset stays open only through now, with neutral wording', () => {
    const open: LimitLockout = { ...episode, end: 'open', endedAt: undefined, workResumedAt: undefined }
    const now = at('2026-11-06T11:00:00Z')
    expect(lockoutBand(open, 0, at(reset), now)).toEqual({ fromMs: at(refused), toMs: now })
    expect(lockoutSpans([open], 'claude', 0, at(reset), cap.account, now)[0]?.open).toBe(true)
    expect(lockoutMs(open, now)).toBe(3_600_000)
    expect(episodeText(open, now)).toContain('or sooner (open)')
    expect(episodeText(open, now)).not.toContain('calls resumed')
  })
  test('another account or harness resumes work without ending the account lockout', () => {
    const l: LimitLockout = { ...episode, end: 'open', endedAt: undefined }
    expect(lockoutBand(l, 0, at(reset), at('2026-11-07T12:00:00Z'))?.toMs).toBe(at(resumed))
    expect(episodeText(l)).toContain('locked out since')
    const limits: Limits = {
      windows: [cap],
      refusals: [],
      lockouts: [l],
      sessionAccounts: [
        { session: { harness: 'claude', id: 'a' }, account: 'invented-account-a' },
        { session: { harness: 'claude', id: 'b' }, account: 'invented-account-b' },
      ],
    }
    expect(sessionLockouts(limits, { harness: 'claude', id: 'a' })).toHaveLength(1)
    expect(sessionLockouts(limits, { harness: 'claude', id: 'b' })).toEqual([])
    expect(sessionLockouts(limits, { harness: 'claude', id: 'unknown' })).toEqual([])
    expect(sessionLockouts(limits, { harness: 'codex', id: 'a' })).toEqual([])
  })
  test('unknown bounds show for a refusal or observed blocked span, never solely for future reset', () => {
    expect(scopeWindows([cap], at(refused), at(resumed), undefined, undefined, [episode])).toHaveLength(1)
    expect(scopeWindows([cap], at('2026-11-06T11:00:00Z'), at(resumed), undefined, undefined, [episode])).toHaveLength(
      1,
    )
    expect(scopeWindows([cap], at('2026-11-10T00:00:00Z'), at(reset), undefined, undefined, [episode])).toEqual([])
  })
  test('unnamed Codex episodes remain drawable', () => {
    const unnamed = { ...episode, harness: 'codex', account: undefined, limit: undefined, kind: undefined }
    expect(lockoutSpans([unnamed], 'codex', 0, at(reset))).toHaveLength(1)
    expect(limitName(unnamed)).toBe('Unnamed limit')
  })
  test('matching keeps multiple episodes and respects account, kind, model and reset jitter', () => {
    const second = { ...episode, startedAt: '2026-11-07T12:00:00Z' }
    expect(
      windowLockouts(cap, [
        episode,
        second,
        { ...episode, account: undefined },
        { ...episode, kind: undefined },
        { ...episode, limit: 'seven_day_opus' },
      ]),
    ).toEqual([episode, second])
    expect(windowLockouts(cap, [{ ...episode, resetsAt: '2026-12-01T00:09:00Z' }])).toHaveLength(1)
    expect(windowLockouts(cap, [{ ...episode, resetsAt: '2026-12-01T00:11:00Z' }])).toHaveLength(0)
  })
  test('window scopes round-trip the known or explicitly unknown account and clear it for day scopes', () => {
    const known = { ...cap, startsAt: refused, windowMinutes: 300 }
    const range = windowRange(known)
    const f = formatCustom(range)
    expect(f.account).toBe('invented-account-a')
    expect(parseCustom(f.from ?? null, f.to ?? null, f.harness, f.account)).toEqual(range)
    expect(formatCustom(windowRange({ ...known, account: undefined })).account).toBe('unknown')
    expect(formatCustom({ from: '2026-11-06', to: '2026-11-06' }).account).toBeUndefined()
    expect(formatCustom(null).account).toBeUndefined()
  })
})
