import { describe, expect, test } from 'bun:test'
import { lastOverview, rememberOverview } from './lastOverview'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('lastOverview', () => {
  test('falls back to / with nothing remembered', () => {
    expect(lastOverview(memory())).toBe('/')
  })
  test('remembers the Overview with its query', () => {
    const s = memory()
    rememberOverview('/', '?range=30d&q=x', s)
    expect(lastOverview(s)).toBe('/?range=30d&q=x')
  })
  test('ignores other pages', () => {
    const s = memory()
    rememberOverview('/', '?range=1d', s)
    rememberOverview('/cost', '?range=7d', s)
    rememberOverview('/sessions', '', s)
    expect(lastOverview(s)).toBe('/?range=1d')
  })
  test('a foreign or broken stored value falls back', () => {
    expect(lastOverview({ getItem: () => 'https://x.example/' })).toBe('/')
    expect(lastOverview({ getItem: () => '/cost' })).toBe('/')
    expect(
      lastOverview({
        getItem: () => {
          throw new Error('blocked')
        },
      }),
    ).toBe('/')
  })
})
