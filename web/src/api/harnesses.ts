// What differs per harness (Claude Code, Codex, ...): the daemon's one list, GET /api/harnesses.
// Everything the UI says about a harness (its product name, the badge beside a session, the
// command that resumes one) comes from here, never from a literal in a component.

import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { get } from './client'

export interface HarnessInfo {
  /** As in session keys. */
  name: string
  /** Product name: "Claude Code". */
  title: string
  /** The resume command with "{id}" for the session id; absent: the harness has none. */
  resume?: string
  /** Short tag shown beside a session; absent for the main harness. */
  badge?: string
}

export interface HarnessList {
  harnesses: HarnessInfo[]
}

export const harnessesKey = () => ['harnesses'] as const

/** The harnesses never change while the daemon runs. */
export function useHarnesses(): UseQueryResult<HarnessList> {
  return useQuery({
    queryKey: harnessesKey(),
    queryFn: ({ signal }) => get<HarnessList>('/api/harnesses', undefined, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/**
 * The entry for `name`. A harness that is not listed is named by its name, tagged with it and has no
 * resume command; nothing is borrowed from another harness. While the list is loading there is no badge
 * and no resume command, so that nothing flashes in and out.
 */
export function describeHarness(list: readonly HarnessInfo[] | undefined, name: string): HarnessInfo {
  if (!list) return { name, title: name }
  return list.find((h) => h.name === name) ?? { name, title: name, badge: name }
}

/** The title, badge and resume template of one harness. */
export function useHarness(name: string): HarnessInfo {
  return describeHarness(useHarnesses().data?.harnesses, name)
}

/** The product names of some harnesses, "Claude Code and Codex" (names that are not listed stand as they are). */
export function harnessTitles(list: readonly HarnessInfo[] | undefined, names: readonly string[]): string {
  const titles = names.map((n) => describeHarness(list, n).title)
  if (titles.length < 2) return titles.join('')
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`
}
