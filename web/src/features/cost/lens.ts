// What the Cost page adds to the scope it shares with the Overview: the migration of its old links.

import { daysBefore, localDay } from '../../lib/time'

const OLD_KEYS = ['project', 'repocut', 'beadcut']

/**
 * An old Cost address in the Overview's terms: `project=X` is `by=dir&in=X`; `range=90d` is `from` and `to` for
 * the 90 days up to today; `range=all` is `from` the first day with spend (`firstDay`, null while not known:
 * the result is then 'wait') to today; `repocut` and `beadcut` go. A lone `from` is one day. null when the
 * address is already in the new terms.
 */
export function migrateCostSearch(
  search: URLSearchParams,
  today: Date,
  firstDay: string | null,
): URLSearchParams | 'wait' | null {
  const range = search.get('range')
  const old = OLD_KEYS.some((k) => search.has(k)) || range === '90d' || range === 'all'
  const lone = search.has('from') !== search.has('to')
  if (!old && !lone) return null
  const next = new URLSearchParams(search)
  const project = next.get('project')
  if (project && !next.has('in')) {
    next.set('by', 'dir')
    next.set('in', project)
  }
  for (const k of OLD_KEYS) next.delete(k)
  if (lone) {
    const day = next.get('from') ?? next.get('to') ?? ''
    next.set('from', day)
    next.set('to', day)
  }
  if (range === '90d' || range === 'all') {
    if (range === 'all' && !firstDay) return 'wait'
    next.delete('range')
    next.set('from', range === '90d' ? localDay(daysBefore(today, 89)) : (firstDay ?? ''))
    next.set('to', localDay(today))
  }
  return next
}
