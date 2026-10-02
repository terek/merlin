import { describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import {
  applyEvent,
  isUnfiltered,
  matchesFilters,
  patchDetailState,
  patchSessionPages,
  patchSessionStateInPages,
  type SessionPages,
} from './cache'
import type { SessionDetail, SessionList, SessionSummary, State } from './types'

const sum = (id: string, at: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  key: { harness: 'claude', id },
  project: '/home/dev/acme/web',
  projectKey: '-home-dev-acme-web',
  kind: 'interactive',
  lastActivityAt: at,
  state: 'ended',
  turns: 1,
  agents: 0,
  cost: { bestUSD: 0.1, flag: 'exact', reportedUSD: 0.1, uncoveredUSD: 0, overheadUSD: 0, inheritedUSD: 0 },
  lineage: {
    children: 0,
    root: { harness: 'claude', id },
    leaf: true,
    inheritedTurns: 0,
    firstOwnTurn: 0,
  },
  ...extra,
})

const page = (sessions: SessionSummary[], total: number, nextCursor?: string): SessionList => ({
  sessions,
  total,
  nextCursor,
  scripted: [],
})

const pages = (...p: SessionList[]): SessionPages => ({
  pages: p,
  pageParams: p.map((_, i) => (i ? `c${i}` : undefined)),
})
const ids = (d: SessionPages | undefined, i = 0) => d?.pages[i].sessions.map((s) => s.key.id)

describe('matchesFilters', () => {
  const s = sum('a', '2026-09-16T10:00:00Z', { state: 'busy' })
  test('kind defaults to interactive and background', () => {
    expect(matchesFilters({}, s)).toBe(true)
    expect(matchesFilters({}, sum('x', '2026-09-16T10:00:00Z', { kind: 'sdk' }))).toBe(false)
    expect(matchesFilters({ kind: 'background' }, s)).toBe(false)
    expect(matchesFilters({ kind: 'interactive,background' }, s)).toBe(true)
  })
  test('state', () => {
    expect(matchesFilters({ state: 'running' }, s)).toBe(true)
    expect(matchesFilters({ state: 'recent' }, s)).toBe(false)
    expect(matchesFilters({ state: 'recent,ended' }, { ...s, state: 'ended' })).toBe(true)
    expect(matchesFilters({ state: 'idle' }, s)).toBe(false)
  })
  test('project by directory or key', () => {
    expect(matchesFilters({ project: '/home/dev/acme/web' }, s)).toBe(true)
    expect(matchesFilters({ project: '-home-dev-acme-web' }, s)).toBe(true)
    expect(matchesFilters({ project: '/other' }, s)).toBe(false)
  })
  test('since / until bound the last activity', () => {
    expect(matchesFilters({ since: '2026-09-16T10:00:00Z' }, s)).toBe(true)
    expect(matchesFilters({ since: '2026-09-16T10:00:01Z' }, s)).toBe(false)
    expect(matchesFilters({ until: '2026-09-16T10:00:00Z' }, s)).toBe(false)
    expect(matchesFilters({ since: '2000-01-01', until: '2100-01-01' }, s)).toBe(true)
  })
  test('unfiltered', () => {
    expect(isUnfiltered({})).toBe(true)
    expect(isUnfiltered({ limit: 50 })).toBe(true)
    expect(isUnfiltered({ state: 'running' })).toBe(false)
  })
})

describe('patchSessionPages', () => {
  const a = sum('a', '2026-09-16T10:00:00Z')
  const b = sum('b', '2026-09-16T09:00:00Z')
  const c = sum('c', '2026-09-16T08:00:00Z')

  test('replaces a row in place and moves it to the top of the first page', () => {
    const data = pages(page([a, b, c], 3))
    const next = patchSessionPages(data, {}, { ...c, lastActivityAt: '2026-09-16T11:00:00Z', turns: 5 })
    expect(ids(next)).toEqual(['c', 'a', 'b'])
    expect(next?.pages[0].sessions[0].turns).toBe(5)
    expect(next?.pages[0].total).toBe(3)
  })

  test('replaces a row on a later page without reordering', () => {
    const data = pages(page([a], 3, 'next'), page([b, c], 3))
    const next = patchSessionPages(data, {}, { ...c, turns: 9 })
    expect(ids(next, 0)).toEqual(['a'])
    expect(ids(next, 1)).toEqual(['b', 'c'])
    expect(next?.pages[1].sessions[1].turns).toBe(9)
  })

  test('inserts a new session where its time puts it, and counts it', () => {
    const data = pages(page([a, c], 2))
    const next = patchSessionPages(data, {}, b)
    expect(ids(next)).toEqual(['a', 'b', 'c'])
    expect(next?.pages[0].total).toBe(3)
    const top = patchSessionPages(data, {}, sum('n', '2026-09-16T12:00:00Z'))
    expect(ids(top)).toEqual(['n', 'a', 'c'])
  })

  test('a new session older than the first page of several is not inserted, but counted', () => {
    const data = pages(page([a, b], 3, 'next'), page([c], 3))
    const next = patchSessionPages(data, {}, sum('old', '2026-09-01T00:00:00Z'))
    expect(ids(next, 0)).toEqual(['a', 'b'])
    expect(next?.pages[0].total).toBe(4)
    expect(next?.pages[1].total).toBe(4)
  })

  test('a session outside the filters is ignored; one that leaves them is removed', () => {
    const running = { state: 'running' }
    const data = pages(page([sum('r', '2026-09-16T10:00:00Z', { state: 'busy' }), b], 2))
    expect(patchSessionPages(data, running, sum('x', '2026-09-16T12:00:00Z'))).toBe(data)
    const next = patchSessionPages(data, running, sum('r', '2026-09-16T10:05:00Z', { state: 'ended' }))
    expect(ids(next)).toEqual(['b'])
    expect(next?.pages[0].total).toBe(1)
  })

  test('empty or missing data is returned as it is', () => {
    expect(patchSessionPages(undefined, {}, a)).toBeUndefined()
    const empty = { pages: [], pageParams: [] }
    expect(patchSessionPages(empty, {}, a)).toBe(empty)
  })

  test('does not mutate its input', () => {
    const data = pages(page([a, b], 2))
    const copy = JSON.stringify(data)
    patchSessionPages(data, {}, { ...b, lastActivityAt: '2026-09-16T11:00:00Z' })
    expect(JSON.stringify(data)).toBe(copy)
  })
})

describe('state patches', () => {
  const a = sum('a', '2026-09-16T10:00:00Z', { state: 'idle' })
  test('sets the state of a row', () => {
    const next = patchSessionStateInPages(pages(page([a], 1)), {}, a.key, 'busy')
    expect(next?.pages[0].sessions[0].state).toBe('busy')
  })
  test('a row that no longer matches the state filter drops out', () => {
    const next = patchSessionStateInPages(pages(page([a], 1)), { state: 'running' }, a.key, 'ended')
    expect(ids(next)).toEqual([])
  })
  test('unknown key or same state: unchanged', () => {
    const data = pages(page([a], 1))
    expect(patchSessionStateInPages(data, {}, { harness: 'claude', id: 'zz' }, 'busy')).toBe(data)
    expect(patchSessionStateInPages(data, {}, a.key, 'idle')).toBe(data)
  })
  test('detail', () => {
    const d = { summary: a } as SessionDetail
    expect(patchDetailState(d, 'busy')?.summary.state).toBe('busy')
    expect(patchDetailState(d, 'idle')).toBe(d)
    expect(patchDetailState(undefined, 'busy')).toBeUndefined()
  })
})

describe('applyEvent', () => {
  const setup = () => {
    const qc = new QueryClient()
    const a = sum('a', '2026-09-16T10:00:00Z', { state: 'idle' })
    const b = sum('b', '2026-09-16T09:00:00Z')
    qc.setQueryData(['sessions', { limit: 50 }], pages(page([a, b], 2)))
    qc.setQueryData(['sessions', { limit: 50, state: 'running' }], pages(page([a], 1)))
    qc.setQueryData(['session', 'claude', 'b'], { summary: b } as SessionDetail)
    const calls: string[] = []
    const changed: string[] = []
    const sink = {
      invalidate: (k: readonly unknown[]) => void calls.push(JSON.stringify(k)),
      changed: (k: { id: string }) => void changed.push(k.id),
    }
    return { qc, a, b, calls, changed, sink }
  }

  test('session-updated patches every list and the detail, and invalidates', () => {
    const { qc, b, calls, changed, sink } = setup()
    const nb = { ...b, lastActivityAt: '2026-09-16T12:00:00Z', state: 'busy' as State }
    applyEvent(qc, 'session-updated', { key: b.key, session: nb }, sink)
    const all = qc.getQueryData<SessionPages>(['sessions', { limit: 50 }])
    expect(ids(all)).toEqual(['b', 'a'])
    const running = qc.getQueryData<SessionPages>(['sessions', { limit: 50, state: 'running' }])
    expect(ids(running)).toEqual(['b', 'a'])
    expect(running?.pages[0].total).toBe(2)
    expect(qc.getQueryData<SessionDetail>(['session', 'claude', 'b'])?.summary.state).toBe('busy')
    expect(calls).toEqual(['["session","claude","b"]', '["projects"]', '["cost"]'])
    expect(changed).toEqual(['b'])
  })

  test('session-state patches lists and detail without refetching', () => {
    const { qc, a, b, calls, sink } = setup()
    applyEvent(qc, 'session-state', { key: a.key, state: 'ended', previous: 'idle' }, sink)
    expect(qc.getQueryData<SessionPages>(['sessions', { limit: 50 }])?.pages[0].sessions[0].state).toBe('ended')
    expect(ids(qc.getQueryData<SessionPages>(['sessions', { limit: 50, state: 'running' }]))).toEqual([])
    applyEvent(qc, 'session-state', { key: b.key, state: 'busy', previous: 'ended' }, sink)
    expect(qc.getQueryData<SessionDetail>(['session', 'claude', 'b'])?.summary.state).toBe('busy')
    expect(calls).toEqual([])
  })

  test('session-missing invalidates lists and the detail', () => {
    const { qc, b, calls, sink } = setup()
    applyEvent(qc, 'session-missing', { key: b.key }, sink)
    expect(calls).toEqual(['["sessions"]', '["session","claude","b"]'])
  })

  test('scan-progress does nothing to the cache', () => {
    const { qc, calls, sink } = setup()
    applyEvent(qc, 'scan-progress', { pending: 1, seen: 1, processed: 0, unchanged: 0, failed: 0, missing: 0 }, sink)
    expect(calls).toEqual([])
  })
})
