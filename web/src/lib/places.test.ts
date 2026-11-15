import { describe, expect, test } from 'bun:test'
import { placeLabels, remoteLabels, repoName } from './places'

describe('repoName', () => {
  test('follows repos.Name', () => {
    expect(repoName('/w/acme/.git')).toBe('acme')
    expect(repoName('/w/acme/.bare')).toBe('acme')
    expect(repoName('/srv/git/app.git')).toBe('app')
    expect(repoName('/w/acme')).toBe('acme')
    expect(repoName('/w/.git')).toBe('w')
    expect(repoName('')).toBe('')
  })
  test('never answers .git', () => {
    for (const k of ['/.git', '.git', '/a/.git', '/a/b/.bare']) expect(repoName(k)).not.toBe('.git')
  })
})

describe('placeLabels', () => {
  const l = (items: [string, string][]) => placeLabels(items.map(([key, name]) => ({ key, name })))
  test('unique names stay short', () => {
    expect(
      l([
        ['/w/acme/.git', 'acme'],
        ['/w/beta/.git', 'beta'],
      ]),
    ).toEqual(['acme', 'beta'])
  })
  test('bare layouts: several checkouts named main', () => {
    expect(
      l([
        ['/w/acme/main', 'main'],
        ['/w/acme/feature', 'feature'],
        ['/w/ops/main', 'main'],
      ]),
    ).toEqual(['acme/main', 'feature', 'ops/main'])
  })
  test('repositories with one name show their directory', () => {
    expect(
      l([
        ['/home/a/web/.git', 'web'],
        ['/home/b/web/.git', 'web'],
        ['/home/b/api/.bare', 'api'],
      ]),
    ).toEqual(['a/web', 'b/web', 'api'])
  })
  test('grows until the labels differ', () => {
    expect(
      l([
        ['/x/one/app/main', 'main'],
        ['/x/two/app/main', 'main'],
      ]),
    ).toEqual(['one/app/main', 'two/app/main'])
  })
  test('the group of none and remotes keep their name', () => {
    expect(
      l([
        ['', 'no repository'],
        ['github.com/acme/app', 'github.com/acme/app'],
      ]),
    ).toEqual(['no repository', 'github.com/acme/app'])
  })
})

describe('remoteLabels', () => {
  test('drops the host, keeps what differs', () => {
    expect(
      remoteLabels(['github.com/acme/app', 'host.example:2222/a/b', '/srv/git/app', 'github.com/acme/web']),
    ).toEqual(['acme/app', 'a/b', 'git/app', 'acme/web'])
  })
  test('a collision keeps the whole string, only for the rows that collide', () => {
    expect(remoteLabels(['github.com/acme/app', 'mirror.example/acme/app', 'github.com/acme/web'])).toEqual([
      'github.com/acme/app',
      'mirror.example/acme/app',
      'acme/web',
    ])
    expect(remoteLabels(['/a/srv/app', '/b/srv/app'])).toEqual(['/a/srv/app', '/b/srv/app'])
  })
  test('the none row stays empty', () => {
    expect(remoteLabels(['', 'github.com/acme/app'])).toEqual(['', 'acme/app'])
  })
})
