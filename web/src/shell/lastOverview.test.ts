import { describe, expect, test } from 'bun:test'
import { lastOverview, lastScope, lensLinks, rememberOverview, rememberScope } from './lastOverview'

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

describe('the scope of the two lenses', () => {
  test('the page being read gives its scope to both tabs', () => {
    expect(lensLinks('/', '?range=30d&in=%2Fw&sort=spend')).toEqual({
      overview: '/?range=30d&in=%2Fw',
      cost: '/cost?range=30d&in=%2Fw',
    })
    expect(lensLinks('/cost', '?q=x&stack=source').cost).toBe('/cost?q=x')
  })
  test('another page carries the last scope seen', () => {
    const s = memory()
    rememberScope('/cost', '?range=1d&by=repo&stack=source', s)
    rememberScope('/moments', '?range=30d', s)
    expect(lensLinks('/moments', '', s)).toEqual({ overview: '/?range=1d&by=repo', cost: '/cost?range=1d&by=repo' })
    expect(lastScope(s)).toBe('?range=1d&by=repo')
  })
  test('no scope seen is no scope', () => {
    expect(lensLinks('/moments', '', memory())).toEqual({ overview: '/', cost: '/cost' })
  })
})
