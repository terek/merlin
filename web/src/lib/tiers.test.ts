import { describe, expect, test } from 'bun:test'
import { priceOf, tierOf, tierOfInput } from './tiers'

const P = (input: number, extra = {}) => ({ input, output: input * 5, cacheRead: input / 10, ...extra })
const prices = {
  'claude-fable-5-1': P(10),
  'claude-opus-5-5': P(4),
  'claude-sonnet-5-5': P(3),
  'claude-haiku-4-5-20251001': P(1),
  'claude-opus-4-6': P(5, { aliases: ['claude-opus-4.6'] }),
  'gpt-6-luna': P(0.1),
}

describe('tierOfInput', () => {
  test('thresholds are inclusive at both ends', () => {
    expect(tierOfInput(4)).toBe('heavy')
    expect(tierOfInput(3.99)).toBe('mid')
    expect(tierOfInput(1.01)).toBe('mid')
    expect(tierOfInput(1)).toBe('light')
    expect(tierOfInput(0.1)).toBe('light')
  })
})

describe('tierOf', () => {
  test('by input price', () => {
    expect(tierOf('claude-fable-5-1', prices)).toBe('heavy')
    expect(tierOf('claude-opus-5-5', prices)).toBe('heavy')
    expect(tierOf('claude-sonnet-5-5', prices)).toBe('mid')
    expect(tierOf('gpt-6-luna', prices)).toBe('light')
  })
  test('suffixes, dates and aliases resolve as the daemon does', () => {
    expect(tierOf('claude-opus-5-5[1m]', prices)).toBe('heavy')
    expect(tierOf('claude-haiku-4-5', prices)).toBe('light')
    expect(tierOf('claude-haiku-4-5-20251001', prices)).toBe('light')
    expect(tierOf('claude-sonnet-5-5-20260101', prices)).toBe('mid')
    expect(priceOf('claude-opus-4.6', prices)?.input).toBe(5)
  })
  test('the price wins over the family', () => {
    // a table that prices a Sonnet like a heavy model
    expect(tierOf('claude-sonnet-5-5', { 'claude-sonnet-5-5': P(6) })).toBe('heavy')
  })
  test('an unpriced model, or no table yet, falls back to the family by name', () => {
    for (const p of [undefined, {}, prices]) {
      expect(tierOf('claude-opus-9-9', p)).toBe('heavy')
      expect(tierOf('claude-fable-9', p)).toBe('heavy')
      expect(tierOf('claude-sonnet-9-1[1m]', p)).toBe('mid')
      expect(tierOf('claude-3-5-haiku-20241022', p)).toBe('light')
      expect(tierOf('haiku', p)).toBe('light')
      expect(tierOf('gpt-7-astra', p)).toBe('heavy')
      expect(tierOf('gpt-7.1-sol', p)).toBe('mid')
      expect(tierOf('gpt-7-luna', p)).toBe('light')
    }
  })
  test('unknown when nothing knows it', () => {
    expect(tierOf('mystery-1', prices)).toBe('unknown')
    expect(tierOf('', undefined)).toBe('unknown')
    expect(tierOf('<synthetic>', prices)).toBe('unknown')
    expect(tierOf('gpt-5.5', prices)).toBe('unknown')
  })
})
