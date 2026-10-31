import { describe, expect, test } from 'bun:test'
import {
  formatCount,
  formatDuration,
  formatMoney,
  formatMoneyFull,
  formatPercent,
  formatTokens,
  plural,
} from './format'

describe('formatMoney', () => {
  test('zero and tiny', () => {
    expect(formatMoney(0)).toBe('$0')
    expect(formatMoney(0.000001)).toBe('<$0.01')
    expect(formatMoney(0.0099)).toBe('<$0.01')
    expect(formatMoney(0.0096)).toBe('<$0.01')
  })
  test('two decimals under $100', () => {
    expect(formatMoney(0.01)).toBe('$0.01')
    expect(formatMoney(0.0141)).toBe('$0.01')
    expect(formatMoney(12.345)).toBe('$12.35')
    expect(formatMoney(99.99)).toBe('$99.99')
  })
  test('no decimals from $100, with separators', () => {
    expect(formatMoney(99.995)).toBe('$100')
    expect(formatMoney(99.9951)).toBe('$100')
    expect(formatMoney(100)).toBe('$100')
    expect(formatMoney(1234.56)).toBe('$1,235')
    expect(formatMoney(1234567)).toBe('$1,234,567')
  })
  test('never "$100.00"', () => {
    expect(formatMoney(99.996)).toBe('$100')
  })
  test('negative and not finite', () => {
    expect(formatMoney(-12.5)).toBe('-$12.50')
    expect(formatMoney(Number.NaN)).toBe('$?')
  })
  test('full figure', () => {
    expect(formatMoneyFull(0.0141)).toBe('$0.014100')
    expect(formatMoneyFull(1234.5)).toBe('$1,234.500000')
  })
})

describe('formatTokens', () => {
  test('boundaries', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(812)).toBe('812')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(12345)).toBe('12.3k')
    expect(formatTokens(999_949)).toBe('999.9k')
    expect(formatTokens(999_950)).toBe('1M')
    expect(formatTokens(1_234_567)).toBe('1.2M')
    expect(formatTokens(999_949_999)).toBe('999.9M')
    expect(formatTokens(999_950_000)).toBe('1B')
  })
})

describe('formatDuration', () => {
  test('units', () => {
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(999.4)).toBe('999 ms')
    expect(formatDuration(999.6)).toBe('1 s')
    expect(formatDuration(1000)).toBe('1 s')
    expect(formatDuration(12_000)).toBe('12 s')
    expect(formatDuration(59_400)).toBe('59 s')
    expect(formatDuration(59_600)).toBe('1 min 00 s')
    expect(formatDuration(245_000)).toBe('4 min 05 s')
    expect(formatDuration(3_599_400)).toBe('59 min 59 s')
    expect(formatDuration(3_599_600)).toBe('1 h 00 min')
    expect(formatDuration(7_980_000)).toBe('2 h 13 min')
  })
  test('invalid', () => {
    expect(formatDuration(-1)).toBe('?')
  })
})

describe('misc', () => {
  test('count, percent, plural', () => {
    expect(formatCount(3355)).toBe('3,355')
    expect(formatPercent(0, 10)).toBe('0%')
    expect(formatPercent(1, 1000)).toBe('<1%')
    expect(formatPercent(1, 3)).toBe('33%')
    expect(formatPercent(1, 0)).toBe('0%')
    expect(plural(1, 'turn')).toBe('1 turn')
    expect(plural(1200, 'turn')).toBe('1,200 turns')
  })
})
