import { describe, expect, test } from 'bun:test'
import { availableToShow, initialVersion, releaseUrl, seeAvailable, seeVersion, shouldReload } from './version'

describe('seeVersion', () => {
  test('the first version is remembered, not an update', () => {
    expect(seeVersion(initialVersion, '1.0.0')).toEqual({ loaded: '1.0.0', updatedTo: null, available: null })
  })
  test('the same version again changes nothing', () => {
    const s = seeVersion(initialVersion, '1.0.0')
    expect(seeVersion(s, '1.0.0')).toBe(s)
  })
  test('a different version is an update, a dev build too', () => {
    const s = seeVersion(initialVersion, '1.0.0')
    expect(seeVersion(s, '1.1.0-dev')).toEqual({ loaded: '1.0.0', updatedTo: '1.1.0-dev', available: null })
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

describe('seeAvailable', () => {
  test('an update event sets it, the same one again changes nothing', () => {
    const s = seeAvailable(initialVersion, '1.1.0')
    expect(s.available).toEqual({ version: '1.1.0', state: 'available' })
    expect(seeAvailable(s, '1.1.0')).toBe(s)
  })
  test('a newer one replaces it; an empty version clears it', () => {
    let s = seeAvailable(initialVersion, '1.1.0')
    s = seeAvailable(s, '1.2.0')
    expect(s.available?.version).toBe('1.2.0')
    expect(seeAvailable(s, '').available).toBeNull()
    expect(seeAvailable(initialVersion, '')).toBe(initialVersion)
  })
  test('it does not disturb the loaded and updated versions', () => {
    let s = seeVersion(initialVersion, '1.0.0')
    s = seeAvailable(s, '1.1.0')
    expect(s).toEqual({ loaded: '1.0.0', updatedTo: null, available: { version: '1.1.0', state: 'available' } })
    expect(seeVersion(s, '1.0.0')).toBe(s)
    expect(seeVersion(s, '1.1.0')).toEqual({
      loaded: '1.0.0',
      updatedTo: '1.1.0',
      available: { version: '1.1.0', state: 'available' },
    })
  })
})

describe('availableToShow', () => {
  const loaded = seeVersion(initialVersion, '1.0.0')
  test('shows a newer release', () => {
    expect(availableToShow(seeAvailable(loaded, '1.1.0'))).toEqual({ version: '1.1.0', state: 'available' })
  })
  test('shows nothing without one', () => {
    expect(availableToShow(loaded)).toBeNull()
    expect(availableToShow(seeAvailable(seeAvailable(loaded, '1.1.0'), ''))).toBeNull()
  })
  test('hides while the updated-reload notice is up', () => {
    expect(availableToShow(seeVersion(seeAvailable(loaded, '1.1.0'), '1.1.0'))).toBeNull()
    expect(availableToShow(seeVersion(seeAvailable(loaded, '1.2.0'), '1.1.0'))).toBeNull()
  })
  test('hides the version the daemon runs', () => {
    expect(availableToShow(seeAvailable(loaded, '1.0.0'))).toBeNull()
  })
})

describe('update state', () => {
  const loaded = seeVersion(initialVersion, '1.0.0')
  test('state and reason are carried; a change replaces them', () => {
    const s = seeAvailable(loaded, '1.1.0', 'blocked', 'run: sudo merlin upgrade')
    expect(s.available).toEqual({ version: '1.1.0', state: 'blocked', reason: 'run: sudo merlin upgrade' })
    expect(seeAvailable(s, '1.1.0', 'blocked', 'run: sudo merlin upgrade')).toBe(s)
    expect(seeAvailable(s, '1.1.0', 'ready').available).toEqual({ version: '1.1.0', state: 'ready' })
  })
  test('the hidden rules hold for every state', () => {
    const s = seeAvailable(loaded, '1.1.0', 'ready')
    expect(availableToShow(s)?.state).toBe('ready')
    expect(availableToShow(seeVersion(s, '1.1.0'))).toBeNull()
    expect(availableToShow(seeAvailable(loaded, '1.0.0', 'ready'))).toBeNull()
  })
  test('an empty version clears the state', () => {
    expect(seeAvailable(seeAvailable(loaded, '1.1.0', 'ready'), '').available).toBeNull()
  })
})

describe('shouldReload', () => {
  const loaded = seeVersion(initialVersion, '1.0.0')
  test('only the installing tab, only for the version it asked for', () => {
    const updated = seeVersion(loaded, '1.1.0')
    expect(shouldReload(updated, '1.1.0')).toBe(true)
    expect(shouldReload(updated, null)).toBe(false)
    expect(shouldReload(updated, '1.2.0')).toBe(false)
    expect(shouldReload(loaded, '1.1.0')).toBe(false)
  })
})

describe('releaseUrl', () => {
  test('tags carry a v', () => {
    expect(releaseUrl('0.4.2')).toBe('https://github.com/terek/merlin/releases/tag/v0.4.2')
    expect(releaseUrl('v0.4.2')).toBe('https://github.com/terek/merlin/releases/tag/v0.4.2')
  })
})
