// Pure functions that patch cached query data from events, plus the event handler that applies
// them to a QueryClient. No React and no browser: unit-tested in cache.test.ts.

import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { sameKey } from '../lib/session'
import type {
  EventMap,
  SessionDetail,
  SessionFilters,
  SessionKey,
  SessionList,
  SessionSummary,
  State,
  TreeList,
  TreeSummary,
} from './types'

export type SessionPages = InfiniteData<SessionList, string | undefined>
export type TreePages = InfiniteData<TreeList, string | undefined>

// ---- does a summary belong to a filtered list? ----------------------------------------

function parseBound(s: string | undefined): number | undefined {
  if (!s) return undefined
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  const t = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime()
    : Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}

const csv = (s: string | undefined) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

function stateMatches(want: string[], state: State): boolean {
  if (want.length === 0) return true
  return want.some((w) => (w === 'running' ? state === 'busy' || state === 'idle' : w === state))
}

/** Whether `s` would be listed under `f` (project, kind, state and since / until). */
export function matchesFilters(f: SessionFilters, s: SessionSummary): boolean {
  if (f.project && f.project !== s.project && f.project !== s.projectKey) return false
  const kinds = csv(f.kind)
  if (kinds.length === 0 ? s.kind === 'sdk' : !kinds.includes(s.kind)) return false
  if (!stateMatches(csv(f.state), s.state)) return false
  const at = s.lastActivityAt ? Date.parse(s.lastActivityAt) : 0
  const since = parseBound(f.since)
  if (since !== undefined && at < since) return false
  const until = parseBound(f.until)
  if (until !== undefined && at >= until) return false
  return true
}

/** No filter at all: the list every session of the default kinds is in. */
export const isUnfiltered = (f: SessionFilters) => !f.project && !f.state && !f.kind && !f.since && !f.until

const activity = (s: SessionSummary) => (s.lastActivityAt ? Date.parse(s.lastActivityAt) : 0)

// ---- patches --------------------------------------------------------------------------

function withTotal(pages: SessionList[], delta: number): SessionList[] {
  return delta === 0 ? pages : pages.map((p) => ({ ...p, total: Math.max(0, p.total + delta) }))
}

/**
 * Applies a `session-updated` summary to the cached pages of one list:
 * - a session that is in a page is replaced there (and removed when it no longer matches the
 *   list's filters); if it is on the first page, that page is re-sorted by last activity;
 * - a new session that matches the filters is inserted into the first page where its last
 *   activity puts it, when the first page covers that time (it is the only page, or the session
 *   is newer than the page's last row); otherwise it belongs to a page not loaded yet.
 * `total` follows. Returns `data` itself when nothing changes.
 */
export function patchSessionPages(
  data: SessionPages | undefined,
  filters: SessionFilters,
  session: SessionSummary,
): SessionPages | undefined {
  if (!data || data.pages.length === 0) return data
  const fits = matchesFilters(filters, session)
  let found = -1
  let at = -1
  data.pages.forEach((p, pi) => {
    const i = p.sessions.findIndex((s) => sameKey(s.key, session.key))
    if (i >= 0) {
      found = pi
      at = i
    }
  })

  let pages = data.pages
  if (found >= 0) {
    if (!fits) {
      pages = withTotal(
        pages.map((p, pi) => (pi === found ? { ...p, sessions: p.sessions.filter((_, i) => i !== at) } : p)),
        -1,
      )
    } else {
      pages = pages.map((p, pi) => {
        if (pi !== found) return p
        const sessions = p.sessions.map((s, i) => (i === at ? session : s))
        if (pi === 0) sessions.sort((a, b) => activity(b) - activity(a))
        return { ...p, sessions }
      })
    }
  } else if (fits) {
    const first = data.pages[0]
    const last = first.sessions[first.sessions.length - 1]
    const covered = !first.nextCursor || !last || activity(session) >= activity(last)
    const sessions = [...first.sessions]
    if (covered) {
      const i = sessions.findIndex((s) => activity(s) < activity(session))
      sessions.splice(i < 0 ? sessions.length : i, 0, session)
    }
    pages = withTotal([covered ? { ...first, sessions } : first, ...data.pages.slice(1)], 1)
  } else {
    return data
  }
  return { ...data, pages }
}

/** Sets the `state` of a session's row in the cached pages of one list. */
export function patchSessionStateInPages(
  data: SessionPages | undefined,
  filters: SessionFilters,
  key: SessionKey,
  state: State,
): SessionPages | undefined {
  if (!data) return data
  let hit: SessionSummary | undefined
  for (const p of data.pages) hit ??= p.sessions.find((s) => sameKey(s.key, key))
  if (!hit || hit.state === state) return data
  // A state filter may now include or exclude the row: go through the general path.
  return patchSessionPages(data, filters, { ...hit, state })
}

// ---- tree pages -------------------------------------------------------------------------

const treeActivity = (t: TreeSummary) => (t.lastActivityAt ? Date.parse(t.lastActivityAt) : 0)

/** `t` with its last activity, cost and member to open worked out again from its members. */
export function retally(t: TreeSummary): TreeSummary {
  let last = t.sessions[0]
  let open: SessionSummary | undefined
  for (const s of t.sessions) {
    if (activity(s) > activity(last)) last = s
    if (s.lineage.leaf && (!open || activity(s) > activity(open))) open = s
  }
  return {
    ...t,
    open: (open ?? last).key,
    lastActivityAt: last.lastActivityAt,
    bestUSD: t.sessions.reduce((n, s) => n + s.cost.bestUSD, 0),
  }
}

/**
 * Applies a `session-updated` summary to the cached pages of one tree list. A member of a cached
 * tree is replaced in place (the tree is re-tallied, the first page re-sorted, and the tree dropped
 * when no member matches the filters any more). A new session with no parent that matches is a
 * new tree, inserted into the first page when that page covers its time. A new member of a cached
 * tree, or a matching session whose tree is not cached, changes which sessions a tree holds, which
 * only the daemon knows: `refetch` is then true and `data` is returned unchanged.
 */
export function patchTreePages(
  data: TreePages | undefined,
  filters: SessionFilters,
  session: SessionSummary,
): { data: TreePages | undefined; refetch: boolean } {
  if (!data || data.pages.length === 0) return { data, refetch: false }
  let pi = -1
  let ti = -1
  data.pages.forEach((p, i) => {
    const j = p.trees.findIndex((t) => t.sessions.some((s) => sameKey(s.key, session.key)))
    if (j >= 0) {
      pi = i
      ti = j
    }
  })
  const withCounts = (pages: TreeList[], trees: number, sessions: number) =>
    trees === 0 && sessions === 0
      ? pages
      : pages.map((p) => ({ ...p, total: Math.max(0, p.total + trees), sessions: Math.max(0, p.sessions + sessions) }))

  if (pi >= 0) {
    const old = data.pages[pi].trees[ti]
    const tree = retally({
      ...old,
      sessions: old.sessions.map((s) => (sameKey(s.key, session.key) ? session : s)),
    })
    if (!tree.sessions.some((s) => matchesFilters(filters, s))) {
      const pages = data.pages.map((p, i) => (i === pi ? { ...p, trees: p.trees.filter((_, j) => j !== ti) } : p))
      return { data: { ...data, pages: withCounts(pages, -1, -tree.sessions.length) }, refetch: false }
    }
    const pages = data.pages.map((p, i) => {
      if (i !== pi) return p
      const trees = p.trees.map((t, j) => (j === ti ? tree : t))
      if (i === 0) trees.sort((a, b) => treeActivity(b) - treeActivity(a))
      return { ...p, trees }
    })
    return { data: { ...data, pages }, refetch: false }
  }
  // a new member of a cached tree, or a matching session of a tree not loaded or not listed yet
  const cachedRoot = data.pages.some((p) => p.trees.some((t) => sameKey(t.root, session.lineage.root)))
  if (cachedRoot) return { data, refetch: true }
  if (!matchesFilters(filters, session)) return { data, refetch: false }
  if (session.lineage.parent || !sameKey(session.lineage.root, session.key)) return { data, refetch: true }
  const tree = retally({ root: session.key, open: session.key, bestUSD: 0, sessions: [session] })
  const first = data.pages[0]
  const last = first.trees[first.trees.length - 1]
  const covered = !first.nextCursor || !last || treeActivity(tree) >= treeActivity(last)
  if (!covered) return { data: { ...data, pages: withCounts(data.pages, 1, 1) }, refetch: false }
  const trees = [...first.trees]
  const i = trees.findIndex((t) => treeActivity(t) < treeActivity(tree))
  trees.splice(i < 0 ? trees.length : i, 0, tree)
  return { data: { ...data, pages: withCounts([{ ...first, trees }, ...data.pages.slice(1)], 1, 1) }, refetch: false }
}

/** Sets the `state` of a member in the cached pages of one tree list. */
export function patchTreeStateInPages(
  data: TreePages | undefined,
  filters: SessionFilters,
  key: SessionKey,
  state: State,
): { data: TreePages | undefined; refetch: boolean } {
  let hit: SessionSummary | undefined
  for (const p of data?.pages ?? []) for (const t of p.trees) hit ??= t.sessions.find((s) => sameKey(s.key, key))
  if (!hit || hit.state === state) return { data, refetch: false }
  return patchTreePages(data, filters, { ...hit, state })
}

/** Sets `summary.state` of a cached session detail. */
export function patchDetailState(detail: SessionDetail | undefined, state: State): SessionDetail | undefined {
  if (!detail || detail.summary.state === state) return detail
  return { ...detail, summary: { ...detail.summary, state } }
}

/** Replaces `summary` of a cached session detail with a newer one. */
export function patchDetailSummary(
  detail: SessionDetail | undefined,
  summary: SessionSummary,
): SessionDetail | undefined {
  if (!detail) return detail
  return { ...detail, summary }
}

// ---- applying events to a QueryClient -------------------------------------------------

/** Cached lists: the query key is ['sessions', filters]. */
const SESSIONS = ['sessions'] as const
/** Cached tree lists: ['trees', filters]. */
const TREES = ['trees'] as const

export interface EventSink {
  /** Called with each session an event changed, to flash its row. */
  changed?: (key: SessionKey) => void
  /** Invalidate a query key later (throttled); defaults to invalidating at once. */
  invalidate?: (queryKey: readonly unknown[]) => void
}

/**
 * Applies one SSE event to the cache, as docs/ui.md section 6 describes:
 * session-updated patches the rows and the detail's summary and invalidates the detail, projects
 * and cost; session-state patches the `state`; session-missing invalidates lists and the detail.
 * `scan-progress` is not a cache matter.
 */
export function applyEvent<K extends keyof EventMap>(
  qc: QueryClient,
  name: K,
  data: EventMap[K],
  sink: EventSink = {},
) {
  const invalidate = sink.invalidate ?? ((queryKey) => void qc.invalidateQueries({ queryKey }))
  switch (name) {
    case 'session-updated': {
      const { key, session } = data as EventMap['session-updated']
      patchLists(qc, (pages, filters) => patchSessionPages(pages, filters, session))
      if (patchTrees(qc, (pages, filters) => patchTreePages(pages, filters, session))) invalidate(TREES)
      qc.setQueryData<SessionDetail>(['session', key.harness, key.id], (d) => patchDetailSummary(d, session))
      invalidate(['session', key.harness, key.id])
      invalidate(['projects'])
      invalidate(['cost'])
      sink.changed?.(key)
      break
    }
    case 'session-state': {
      const { key, state } = data as EventMap['session-state']
      patchLists(qc, (pages, filters) => patchSessionStateInPages(pages, filters, key, state))
      if (patchTrees(qc, (pages, filters) => patchTreeStateInPages(pages, filters, key, state))) invalidate(TREES)
      qc.setQueryData<SessionDetail>(['session', key.harness, key.id], (d) => patchDetailState(d, state))
      sink.changed?.(key)
      break
    }
    case 'session-missing': {
      const { key } = data as EventMap['session-missing']
      invalidate(SESSIONS)
      invalidate(TREES)
      invalidate(['session', key.harness, key.id])
      break
    }
    default:
      break
  }
}

function patchLists(
  qc: QueryClient,
  fn: (pages: SessionPages | undefined, filters: SessionFilters) => SessionPages | undefined,
) {
  for (const q of qc.getQueryCache().findAll({ queryKey: SESSIONS })) {
    const filters = (q.queryKey[1] ?? {}) as SessionFilters
    qc.setQueryData<SessionPages>(q.queryKey, (old) => fn(old, filters))
  }
}

/** Patches every cached tree list; true when one of them needs the daemon to be asked again. */
function patchTrees(
  qc: QueryClient,
  fn: (pages: TreePages | undefined, filters: SessionFilters) => { data: TreePages | undefined; refetch: boolean },
): boolean {
  let refetch = false
  for (const q of qc.getQueryCache().findAll({ queryKey: TREES })) {
    const filters = (q.queryKey[1] ?? {}) as SessionFilters
    qc.setQueryData<TreePages>(q.queryKey, (old) => {
      const r = fn(old, filters)
      refetch ||= r.refetch
      return r.data
    })
  }
  return refetch
}
