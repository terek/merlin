import { describe, expect, test } from 'bun:test'
import { initialVersion, releaseUrl, seeVersion } from './version'

describe('seeVersion', () => {
  test('the first version is remembered, not an update', () => {
    expect(seeVersion(initialVersion, '1.0.0')).toEqual({ loaded: '1.0.0', updatedTo: null })
  })
  test('the same version again changes nothing', () => {
    const s = seeVersion(initialVersion, '1.0.0')
    expect(seeVersion(s, '1.0.0')).toBe(s)
  })
  test('a different version is an update, a dev build too', () => {
    const s = seeVersion(initialVersion, '1.0.0')
    expect(seeVersion(s, '1.1.0-dev')).toEqual({ loaded: '1.0.0', updatedTo: '1.1.0-dev' })
  })
  test('a second update replaces the first; going back clears it', () => {
    let s = seeVersion(seeVersion(initialVersion, '1.0.0'), '1.1.0')
    s = seeVersion(s, '1.2.0')
    expect(s.updatedTo).toBe('1.2.0')
    expect(seeVersion(s, '1.0.0').updatedTo).toBeNull()
  })
  test('an empty version is ignored', () => {
    expect(seeVersion(initialVersion, '')).toBe(initialVersion)
  })
})

describe('releaseUrl', () => {
  test('tags carry a v', () => {
    expect(releaseUrl('0.4.2')).toBe('https://github.com/terek/merlin/releases/tag/v0.4.2')
    expect(releaseUrl('v0.4.2')).toBe('https://github.com/terek/merlin/releases/tag/v0.4.2')
  })
})
