import { describe, expect, test } from 'bun:test'
import type { Hit, ScriptedLine, SessionSummary } from '../../api/types'
import {
  apiFilters,
  arrangeFamilies,
  buildDayGroups,
  cachedTitles,
  fieldLabel,
  groupHits,
  hitHash,
  hitPlace,
  moveSelection,
  readFilters,
  showsScripted,
  sinceDate,
  writeFilters,
} from './model'

function session(id: string, at: string, over: Partial<SessionSummary> = {}, usd = 1, root = id): SessionSummary {
  return {
    key: { harness: 'claude', id },
    project: '/home/dev/acme/web',
    projectKey: '-home-dev-acme-web',
    kind: 'interactive',
    lastActivityAt: at,
    state: 'ended',
    turns: 1,
    agents: 0,
    cost: { bestUSD: usd, flag: 'exact', reportedUSD: usd, uncoveredUSD: 0, overheadUSD: 0, inheritedUSD: 0 },
    lineage: {
      children: 0,
      root: { harness: 'claude', id: root },
      leaf: true,
      inheritedTurns: 0,
      firstOwnTurn: 0,
    },
    ...over,
  }
}

// Local noon of a day, so the local day is the same in every time zone.
const noon = (day: string, h = 12) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00`).toISOString()
const line = (day: string, usd: number, project = '/p/a', count = 2): ScriptedLine => ({
  project,
  day,
  count,
  totalUSD: usd,
  reportedUSD: usd,
  attributedUSD: 0,
})

describe('filters in the URL', () => {
  test('round trip', () => {
    const p = writeFilters(new URLSearchParams(), {
      project: '/p/a b',
      state: 'running',
      kind: 'background',
      since: '7d',
    })
    expect(readFilters(new URLSearchParams(p.toString()))).toEqual({
      project: '/p/a b',
      state: 'running',
      kind: 'background',
      since: '7d',
      q: '',
    })
  })
  test('unknown values count as not set; empty values are removed', () => {
    expect(readFilters(new URLSearchParams('state=ended&kind=sdk&since=1y')).state).toBe('')
    expect(readFilters(new URLSearchParams('kind=sdk')).kind).toBe('')
    const p = writeFilters(new URLSearchParams('state=running&other=1'), { state: '' })
    expect(p.toString()).toBe('other=1')
  })
  test('api filters', () => {
    const now = new Date(2026, 9, 2, 10)
    expect(sinceDate('7d', now)).toBe('2026-09-26')
    expect(sinceDate('30d', now)).toBe('2026-09-03')
    expect(sinceDate('', now)).toBeUndefined()
    expect(apiFilters({ project: '/p', state: 'recent', kind: '', since: '7d', q: 'x' }, now)).toEqual({
      project: '/p',
      state: 'recent',
      since: '2026-09-26',
    })
  })
  test('scripted lines hide under a state or kind filter', () => {
    expect(showsScripted({ project: '/p', state: '', kind: '', since: '7d', q: '' })).toBe(true)
    expect(showsScripted({ project: '', state: 'running', kind: '', since: '', q: '' })).toBe(false)
    expect(showsScripted({ project: '', state: '', kind: 'background', since: '', q: '' })).toBe(false)
  })
})

describe('buildDayGroups', () => {
  const list = [
    session('a', noon('2026-09-16', 15), {}, 2),
    session('b', noon('2026-09-16', 9), {}, 0.5),
    session('c', noon('2026-09-15'), {}, 4),
  ]
  test('groups by local day with sums including scripted lines', () => {
    const g = buildDayGroups(list, [line('2026-09-16', 0.25), line('2026-09-14', 1)], false)
    expect(g.map((x) => x.day)).toEqual(['2026-09-16', '2026-09-15', '2026-09-14'])
    expect(g[0].rows.map((r) => r.session.key.id)).toEqual(['a', 'b'])
    expect(g[0].totalUSD).toBeCloseTo(2.75)
    expect(g[1].totalUSD).toBeCloseTo(4)
    // a day with only scripted runs is a group of its own
    expect(g[2].rows).toHaveLength(0)
    expect(g[2].totalUSD).toBe(1)
    expect(g.every((x) => !x.incomplete)).toBe(true)
  })
  test('while pages follow the oldest day is incomplete and older scripted lines wait', () => {
    const g = buildDayGroups(list, [line('2026-09-15', 0.1), line('2026-09-14', 1)], true)
    expect(g.map((x) => [x.day, x.incomplete])).toEqual([
      ['2026-09-16', false],
      ['2026-09-15', true],
    ])
    expect(g[1].totalUSD).toBeCloseTo(4.1)
  })
  test('no activity time sorts last', () => {
    const g = buildDayGroups([session('z', '', { lastActivityAt: undefined }), ...list], [], false)
    expect(g[g.length - 1].day).toBe('')
  })
  test('empty', () => {
    expect(buildDayGroups([], [], false)).toEqual([])
  })
})

describe('arrangeFamilies', () => {
  const leaf = session('leaf', noon('2026-09-16', 15), {}, 1, 'root')
  const mid = session(
    'mid',
    noon('2026-09-16', 14),
    { lineage: { ...session('x', '').lineage, root: { harness: 'claude', id: 'root' }, leaf: false } },
    1,
    'root',
  )
  const other = session('other', noon('2026-09-16', 13))
  const root = session(
    'root',
    noon('2026-09-16', 12),
    { lineage: { ...session('x', '').lineage, root: { harness: 'claude', id: 'root' }, leaf: false } },
    1,
    'root',
  )
  test('leaf first, ancestors indented below, the family stands where its newest member stood', () => {
    const rows = arrangeFamilies([mid, other, leaf, root])
    expect(rows.map((r) => [r.session.key.id, r.level])).toEqual([
      ['leaf', 0],
      ['mid', 1],
      ['root', 1],
      ['other', 0],
    ])
  })
  test('without a leaf in the day the newest member leads', () => {
    const rows = arrangeFamilies([mid, other, root])
    expect(rows.map((r) => [r.session.key.id, r.level])).toEqual([
      ['mid', 0],
      ['root', 1],
      ['other', 0],
    ])
  })
  test('a lone member of a family is not indented', () => {
    expect(arrangeFamilies([mid]).map((r) => r.level)).toEqual([0])
  })
})

describe('moveSelection', () => {
  const ids = ['a', 'b', 'c']
  test('j and k', () => {
    expect(moveSelection(ids, null, 1)).toBe('a')
    expect(moveSelection(ids, null, -1)).toBe('c')
    expect(moveSelection(ids, 'a', 1)).toBe('b')
    expect(moveSelection(ids, 'c', 1)).toBe('c')
    expect(moveSelection(ids, 'a', -1)).toBe('a')
  })
  test('follows the id when rows move; starts over when the id is gone', () => {
    expect(moveSelection(['x', 'a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(moveSelection(['x', 'y'], 'b', 1)).toBe('x')
  })
  test('empty', () => {
    expect(moveSelection([], 'a', 1)).toBeNull()
  })
})

describe('search hits', () => {
  const hit = (id: string, field: Hit['field'], turn: number): Hit => ({
    session: { harness: 'claude', id },
    project: '/p',
    field,
    turn,
    snippet: 's',
  })
  test('grouped by session in API order', () => {
    const g = groupHits([hit('a', 'title', -1), hit('b', 'prompt', 3), hit('a', 'final', 2)])
    expect(g.map((x) => [x.session.id, x.hits.map((h) => h.index)])).toEqual([
      ['a', [0, 2]],
      ['b', [1]],
    ])
  })
  test('labels and links', () => {
    expect(fieldLabel('final')).toBe('answer')
    expect(fieldLabel('compaction')).toBe('summary')
    expect(fieldLabel('prompt')).toBe('prompt')
    expect(hitHash(hit('a', 'prompt', 4))).toBe('t4')
    expect(hitHash(hit('a', 'final', 0))).toBe('t0')
    expect(hitHash(hit('a', 'compaction', 1))).toBe('c1')
    expect(hitHash(hit('a', 'title', -1))).toBeUndefined()
  })
  test('a compaction hit is a compaction, not a turn', () => {
    expect(hitPlace(hit('a', 'compaction', 2))).toBe('compaction 2')
    expect(hitPlace(hit('a', 'prompt', 2))).toBe('turn 2')
    expect(hitPlace(hit('a', 'final', 0))).toBe('turn 0')
  })
  test('titles of cached sessions', () => {
    const m = cachedTitles([{ sessions: [session('s1', '2026-09-16T10:00:00Z', { title: 'Fix login' })] }])
    expect(m.get('claude/s1')).toBe('Fix login')
    expect(m.get('claude/s2')).toBeUndefined()
  })
})
