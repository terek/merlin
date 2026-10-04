import { describe, expect, test } from 'bun:test'
import type { Hit, ScriptedLine, SessionSummary, TreeSummary } from '../../api/types'
import {
  apiFilters,
  buildDayGroups,
  cachedTitles,
  countLabel,
  fieldLabel,
  groupHits,
  hitHash,
  hitPlace,
  moveSelection,
  openMember,
  readFilters,
  showsScripted,
  sinceDate,
  treeFlag,
  treeState,
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

/** A tree of the given members (root first), opening `open` (default the last). */
function tree(members: SessionSummary[], open = members[members.length - 1]): TreeSummary {
  const at = members.map((m) => m.lastActivityAt ?? '').sort()
  return {
    root: members[0].key,
    open: open.key,
    lastActivityAt: at[at.length - 1] || undefined,
    bestUSD: members.reduce((n, m) => n + m.cost.bestUSD, 0),
    sessions: members,
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
    tree([session('a', noon('2026-09-16', 15), {}, 2)]),
    tree([session('b', noon('2026-09-16', 9), {}, 0.5)]),
    tree([session('c', noon('2026-09-15'), {}, 4)]),
  ]
  test('groups trees by the local day of their last activity; scripted lines join their day', () => {
    const g = buildDayGroups(list, [line('2026-09-16', 0.25), line('2026-09-14', 1)], false)
    expect(g.map((x) => x.day)).toEqual(['2026-09-16', '2026-09-15', '2026-09-14'])
    expect(g[0].trees.map((t) => t.root.id)).toEqual(['a', 'b'])
    expect(g[0].scripted).toHaveLength(1)
    // a day with only scripted runs is a group of its own
    expect(g[2].trees).toHaveLength(0)
    expect(g.every((x) => !x.incomplete)).toBe(true)
  })
  test('a tree stands on the day of its newest member only', () => {
    const old = session('old', noon('2026-09-10'), { lineage: { ...session('x', '').lineage, leaf: false } }, 3)
    const g = buildDayGroups([tree([old, session('new', noon('2026-09-16'), {}, 1, 'old')])], [], false)
    expect(g.map((x) => [x.day, x.trees.length])).toEqual([['2026-09-16', 1]])
  })
  test('while pages follow the oldest day is incomplete and older scripted lines wait', () => {
    const g = buildDayGroups(list, [line('2026-09-15', 0.1), line('2026-09-14', 1)], true)
    expect(g.map((x) => [x.day, x.incomplete])).toEqual([
      ['2026-09-16', false],
      ['2026-09-15', true],
    ])
  })
  test('no activity time sorts last', () => {
    const g = buildDayGroups([tree([session('z', '', { lastActivityAt: undefined })]), ...list], [], false)
    expect(g[g.length - 1].day).toBe('')
  })
  test('empty', () => {
    expect(buildDayGroups([], [], false)).toEqual([])
  })
})

describe('trees', () => {
  const root = session('root', noon('2026-09-15'), {
    state: 'idle',
    cost: { ...session('x', '').cost, flag: 'partial' },
    lineage: { ...session('x', '').lineage, leaf: false },
  })
  const leaf = session('leaf', noon('2026-09-16'), {}, 1, 'root')
  test('the row shows the open member, the busiest state and the weakest cost backing', () => {
    const t = tree([root, leaf])
    expect(openMember(t).key.id).toBe('leaf')
    expect(treeState(t)).toBe('idle')
    expect(treeState(tree([leaf]))).toBe('ended')
    expect(treeFlag(t)).toBe('partial')
    expect(treeFlag(tree([leaf]))).toBe('exact')
  })
  test('counts', () => {
    expect(countLabel(3, 3)).toBe('3 sessions')
    expect(countLabel(5, 3)).toBe('5 sessions in 3 trees')
    expect(countLabel(1, 1)).toBe('1 session')
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
  const hit = (id: string, field: Hit['field'], turn: number, root = id): Hit => ({
    session: { harness: 'claude', id },
    root: { harness: 'claude', id: root },
    project: '/p',
    field,
    turn,
    snippet: 's',
  })
  test('grouped by tree in API order', () => {
    const g = groupHits([
      hit('a', 'title', -1),
      hit('b', 'prompt', 3),
      hit('a2', 'final', 2, 'a'),
      hit('a', 'final', 1),
    ])
    expect(g.map((x) => [x.root.id, x.session.id, x.sessions, x.hits.map((h) => h.index)])).toEqual([
      ['a', 'a', 2, [0, 2, 3]],
      ['b', 'b', 1, [1]],
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
    const m = cachedTitles([{ trees: [tree([session('s1', '2026-09-16T10:00:00Z', { title: 'Fix login' })])] }])
    expect(m.get('claude/s1')).toBe('Fix login')
    expect(m.get('claude/s2')).toBeUndefined()
  })
})
