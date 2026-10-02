// One hook per endpoint, and the query keys (docs/ui.md section 6).
//
//   ['projects']                          useProjects
//   ['sessions', filters]                 useSessions       (infinite, pages of SessionList)
//   ['session', harness, id]              useSession        (['session', harness, id, 'messages'] with messages)
//   ['search', q, filters]                useSearch
//   ['cost', params]                      useCost

import {
  keepPreviousData,
  QueryClient,
  type UseInfiniteQueryResult,
  type UseQueryResult,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query'
import { daysBefore, localDay } from '../lib/time'
import { ApiError, get } from './client'
import type {
  CostParams,
  CostTable,
  ProjectList,
  SearchResult,
  SessionDetail,
  SessionFilters,
  SessionList,
} from './types'

export const STALE_MS = 30_000

export const queryKeys = {
  projects: () => ['projects'] as const,
  sessions: (filters: SessionFilters) => ['sessions', filters] as const,
  session: (harness: string, id: string, messages = false) =>
    messages ? (['session', harness, id, 'messages'] as const) : (['session', harness, id] as const),
  search: (q: string, filters: SessionFilters) => ['search', q, filters] as const,
  cost: (params: CostParams) => ['cost', params] as const,
}

/** Drops undefined and empty values, so that equal filters give equal keys. */
export function clean<T extends object>(o: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') out[k] = v
  return out as T
}

/** Do not retry what a retry cannot fix (4xx); retry a lost connection twice. */
export function retryPolicy(count: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false
  return count < 2
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: STALE_MS, refetchOnWindowFocus: true, retry: retryPolicy },
    },
  })
}

export function useProjects(): UseQueryResult<ProjectList> {
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: ({ signal }) => get<ProjectList>('/api/projects', undefined, signal),
  })
}

export const SESSIONS_PAGE = 50

/**
 * The session list, paged by `nextCursor`. `data.pages[i].sessions` are the rows, `pages[0].total`
 * the count over all pages, `pages[0].scripted` the aggregate lines of scripted runs. The previous
 * list stays on screen while a changed filter loads (`isPlaceholderData`). Call `fetchNextPage()`
 * when the end of the list scrolls into view while `hasNextPage`.
 */
export function useSessions(filters: SessionFilters): UseInfiniteQueryResult<{ pages: SessionList[] }> {
  const f = clean({ limit: SESSIONS_PAGE, ...filters })
  return useInfiniteQuery({
    queryKey: queryKeys.sessions(f),
    queryFn: ({ pageParam, signal }) => get<SessionList>('/api/sessions', { ...f, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  })
}

/** One session; `id` may be a unique prefix. A 409 ambiguous_id error carries `candidates`. */
export function useSession(
  harness: string,
  id: string,
  opts: { messages?: boolean } = {},
): UseQueryResult<SessionDetail> {
  return useQuery({
    queryKey: queryKeys.session(harness, id, opts.messages),
    queryFn: ({ signal }) =>
      get<SessionDetail>(
        `/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}`,
        opts.messages ? { messages: 1 } : undefined,
        signal,
      ),
  })
}

/** Full-text search. Disabled (and `data` undefined) while `q` is shorter than 2 characters. */
export function useSearch(q: string, filters: SessionFilters = {}): UseQueryResult<SearchResult> {
  const f = clean(filters)
  const term = q.trim()
  return useQuery({
    queryKey: queryKeys.search(term, f),
    queryFn: ({ signal }) => get<SearchResult>('/api/search', { ...f, q: term }, signal),
    enabled: term.length >= 2,
    placeholderData: keepPreviousData,
  })
}

export function useCost(params: CostParams = {}, opts: { enabled?: boolean } = {}): UseQueryResult<CostTable> {
  const p = clean(params)
  return useQuery({
    queryKey: queryKeys.cost(p),
    queryFn: ({ signal }) => get<CostTable>('/api/cost', { ...p }, signal),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  })
}

/** The cost range a `range` URL value stands for: `since` as a local date, none for "all". */
export function rangeSince(range: string, now: Date = new Date()): string | undefined {
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range]
  return days ? localDay(daysBefore(now, days - 1)) : undefined
}

/** The total spend of the last 7 days (today and the six days before), for the top bar. */
export function useSpend7d(): UseQueryResult<CostTable> {
  return useCost({ by: 'kind', since: rangeSince('7d'), limit: 1 })
}
