// Pure functions that patch cached query data from events, plus the event handler that applies
// them to a QueryClient. No React and no browser: unit-tested in cache.test.ts.

import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { sameKey } from '../lib/session'
import type { EventMap, SessionDetail, SessionFilters, SessionKey, SessionList, SessionSummary, State } from './types'

export type SessionPages = InfiniteData<SessionList, string | undefined>

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
      qc.setQueryData<SessionDetail>(['session', key.harness, key.id], (d) => patchDetailState(d, state))
      sink.changed?.(key)
      break
    }
    case 'session-missing': {
      const { key } = data as EventMap['session-missing']
      invalidate(SESSIONS)
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
