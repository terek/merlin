import { expect, test } from 'bun:test'
import { prBadge, prName } from './session'

test('PR names and badges', () => {
  const pr = (n: number | undefined, url: string) => ({ number: n, url })
  expect(prName(pr(12, 'https://git.example.test/o/r/pull/12'))).toBe('#12')
  expect(prName(pr(undefined, 'https://git.example.test/o/r/pull/7/'))).toBe('7')
  expect(prBadge(undefined)).toBe('')
  expect(prBadge([pr(12, 'u12')])).toBe('PR #12')
  expect(prBadge([pr(12, 'u12'), pr(13, 'u13')])).toBe('2 PRs')
})
