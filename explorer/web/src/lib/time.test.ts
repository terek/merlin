import { describe, expect, test } from 'bun:test'
import { dayLabel, daysBefore, fullTime, localDay, relTime, shortDate, spanMs } from './time'

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s)

describe('relTime', () => {
  const now = at(2026, 9, 16, 14, 30)
  test('minutes and hours today', () => {
    expect(relTime(at(2026, 9, 16, 14, 30, 10), now)).toBe('just now')
    expect(relTime(at(2026, 9, 16, 14, 29), now)).toBe('1 min ago')
    expect(relTime(at(2026, 9, 16, 14, 27), now)).toBe('3 min ago')
    expect(relTime(at(2026, 9, 16, 13, 31), now)).toBe('59 min ago')
    expect(relTime(at(2026, 9, 16, 13, 30), now)).toBe('1 h ago')
    expect(relTime(at(2026, 9, 16, 0, 5), now)).toBe('14 h ago')
  })
  test('across midnight', () => {
    const just = at(2026, 9, 16, 0, 10)
    expect(relTime(at(2026, 9, 15, 23, 50), just)).toBe('20 min ago')
    expect(relTime(at(2026, 9, 15, 22, 50), just)).toBe('yesterday 22:50')
    expect(relTime(at(2026, 9, 15, 14, 2), now)).toBe('yesterday 14:02')
  })
  test('older dates', () => {
    expect(relTime(at(2026, 9, 12, 8), now)).toBe('12 Sep')
    expect(relTime(at(2026, 1, 3, 8), now)).toBe('3 Jan')
  })
  test('across a year end', () => {
    const jan = at(2027, 1, 1, 0, 5)
    expect(relTime(at(2026, 12, 31, 23, 50), jan)).toBe('15 min ago')
    expect(relTime(at(2026, 12, 31, 12, 0), jan)).toBe('yesterday 12:00')
    expect(relTime(at(2026, 12, 30, 12, 0), jan)).toBe('30 Dec 2026')
    expect(relTime(at(2027, 1, 1, 0, 0), at(2027, 1, 1, 9, 0))).toBe('9 h ago')
  })
  test('the future', () => {
    expect(relTime(at(2026, 9, 16, 14, 30, 30), now)).toBe('just now')
    expect(relTime(at(2026, 9, 16, 14, 59), now)).toBe('just now')
    expect(relTime(at(2026, 9, 16, 15, 30), now)).toBe('just now')
    expect(relTime(at(2026, 9, 16, 15, 31), now)).toBe('16 Sep')
    expect(relTime(at(2026, 9, 17, 9, 0), now)).toBe('17 Sep')
  })
})

describe('days', () => {
  test('localDay and daysBefore', () => {
    expect(localDay(at(2026, 3, 5, 23, 59))).toBe('2026-03-05')
    expect(localDay(daysBefore(at(2026, 3, 1, 12), 1))).toBe('2026-02-28')
    expect(localDay(daysBefore(at(2027, 1, 2, 12), 3))).toBe('2026-12-30')
  })
  test('dayLabel', () => {
    const now = at(2026, 9, 16, 9)
    expect(dayLabel(at(2026, 9, 16, 0, 1), now)).toBe('Today')
    expect(dayLabel(at(2026, 9, 15, 23, 59), now)).toBe('Yesterday')
    expect(dayLabel(at(2026, 9, 14, 12), now)).toBe('Mon 14 Sep')
    expect(dayLabel(at(2025, 9, 14, 12), now)).toBe('Sun 14 Sep 2025')
  })
  test('shortDate and fullTime', () => {
    expect(shortDate(at(2026, 9, 2), at(2026, 10, 1))).toBe('2 Sep')
    expect(fullTime(at(2026, 9, 16, 10, 0, 8))).toBe('Wed 16 Sep 2026, 10:00:08')
  })
  test('spanMs', () => {
    expect(spanMs('2026-09-16T10:00:00Z', '2026-09-16T10:00:09Z')).toBe(9000)
    expect(spanMs(undefined, '2026-09-16T10:00:09Z')).toBeUndefined()
    expect(spanMs('2026-09-16T10:00:09Z', '2026-09-16T10:00:00Z')).toBe(0)
  })
})
