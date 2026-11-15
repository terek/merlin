import { describe, expect, test } from 'bun:test'
import { peakText } from './model'

describe('peakText', () => {
  test('whole thousands below a million, one decimal from there', () => {
    expect(peakText(408_100)).toBe('408k')
    expect(peakText(194_499)).toBe('194k')
    expect(peakText(999_499)).toBe('999k')
    expect(peakText(999_500)).toBe('1M')
    expect(peakText(1_120_000)).toBe('1.1M')
  })
})
