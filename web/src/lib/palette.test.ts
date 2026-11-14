import { describe, expect, test } from 'bun:test'
import { classColor, compareModels, HATCH, modelColor } from './palette'

const mix = (hue: string, n: number) => `color-mix(in srgb, var(--${hue}) ${n}%, var(--surface))`

describe('modelColor', () => {
  test('hue by family', () => {
    expect(modelColor('claude-opus-5-5')).toBe('var(--series-1)')
    expect(modelColor('claude-sonnet-5-5')).toBe('var(--series-2)')
    expect(modelColor('claude-haiku-5-5')).toBe('var(--series-3)')
    expect(modelColor('claude-fable-5-2')).toBe('var(--series-4)')
    expect(modelColor('gpt-6.1-astra')).toBe('var(--model-astra)')
    expect(modelColor('gpt-6.1-sol')).toBe('var(--model-sol)')
    expect(modelColor('gpt-6.1-luna')).toBe('var(--model-luna)')
  })
  test('versions are lightness steps, the newest in full colour', () => {
    expect(modelColor('claude-haiku-5-5')).toBe('var(--series-3)')
    expect(modelColor('claude-haiku-4-5-20251001')).toBe(mix('series-3', 65))
    expect(modelColor('claude-3-5-haiku-20241022')).toBe(mix('series-3', 40))
    expect(modelColor('claude-3-haiku-20240307')).toBe(mix('series-3', 40))
    // a version newer than any known is the newest
    expect(modelColor('claude-opus-6')).toBe('var(--series-1)')
  })
  test('the same model has the same colour however it is spelt', () => {
    expect(modelColor('claude-sonnet-4-5')).toBe(modelColor('claude-sonnet-4-5-20250929'))
    expect(modelColor('claude-sonnet-4-5')).toBe(modelColor('claude-sonnet-4-5[1m]'))
  })
  test('no model is pink, the cache miss, or red or amber, the compactions', () => {
    const names = [
      'claude-fable-5-2',
      'claude-fable-5',
      'claude-opus-5-5',
      'claude-opus-4',
      'claude-sonnet-5-5',
      'claude-haiku-4-5',
      'claude-3-haiku',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'codex-auto-review',
      'haiku',
    ]
    for (const n of names) expect(modelColor(n)).not.toMatch(/series-5|--bad|--warn/)
  })
  test('unknown names are grey, (overhead) is the hatch', () => {
    expect(modelColor('codex-auto-review')).toBe('var(--series-other)')
    expect(modelColor('(overhead)')).toBe(HATCH)
  })
})

describe('compareModels', () => {
  test('heavy to light, then family, then the newest version first', () => {
    const names = [
      'claude-haiku-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-5-5',
      'claude-opus-4-1',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-fable-5-1',
    ]
    expect([...names].sort(compareModels)).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-opus-4-1',
      'claude-sonnet-5-5',
      'claude-sonnet-4-5',
      'claude-haiku-5-5',
      'claude-haiku-4-5',
    ])
  })
})

describe('classColor', () => {
  test('the Session page mapping, the cache miss pink, unsplit a grey of its own', () => {
    expect(classColor('output')).toBe('var(--series-4)')
    expect(classColor('cacheRead')).toBe('var(--series-3)')
    expect(classColor('cacheWrite')).toBe('var(--series-2)')
    expect(classColor('input')).toBe('var(--series-other)')
    expect(classColor('cacheMiss')).toBe('var(--series-5)')
    expect(classColor('(unsplit)')).not.toBe(classColor('input'))
    expect(classColor('read')).toBe(classColor('cacheRead'))
  })
})
