// What the Cost page adds to the scope it shares with the Overview: the migration of its old links, and the
// By place ranking, taken from the same lanes and the same tree as the Overview's sidebar.

import type { OverviewLane } from '../../api/types'
import { daysBefore, localDay } from '../../lib/time'
import {
  type Beads,
  type By,
  buildPlaceTree,
  NONE_SEL,
  nodeForPath,
  type PlaceNode,
  placeItems,
  searchLanes,
} from '../overview/model'

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

/** One line of the By place table. */
export interface PlaceRow {
  id: string
  /** What the line shows, and a bead's id apart. */
  text: string
  sub?: string
  closed: boolean
  title: string
  /** What a click selects (`in`). */
  path: string
  /** The sessions and spend at or under it. */
  count: number
  usd: number
  /** It has places under it: a click drills down. */
  drill: boolean
  node?: PlaceNode
  none?: boolean
}

export interface PlaceRows {
  rows: PlaceRow[]
  /** What the shares are of: the spend of the rows. */
  total: number
}

/**
 * The ranking the Overview's tree lacks: the children of the selection (the top-level places with nothing
 * selected), each rolled up over everything under it, by spend, the (none) place last. The tree is the
 * Overview's (the lanes the search leaves, `buildPlaceTree`), so the figures are its figures. A selected leaf is
 * shown as the one row it is; a selected folder that is itself a place also gets a row for the spend that sits
 * directly in it.
 */
export function placeRows(
  lanes: readonly OverviewLane[],
  opts: {
    by: By
    sel: string | null
    term: string
    hits?: ReadonlySet<string>
    home: string | undefined
    beads?: Beads
    label: (n: PlaceNode) => { text: string; id?: string; title?: string; closed: boolean }
  },
): PlaceRows {
  const { by, sel, home, beads } = opts
  const tree = buildPlaceTree(placeItems(searchLanes([...lanes], opts.term, opts.hits), by, beads), by, home)
  const row = (n: PlaceNode, over?: Partial<PlaceRow>): PlaceRow => {
    const l = opts.label(n)
    return {
      id: n.id,
      text: l.text,
      sub: l.id,
      closed: l.closed,
      title: l.title ? `${l.title}\n${n.label}` : n.id,
      path: n.path,
      count: n.count,
      usd: n.usd,
      drill: n.children.length > 0,
      node: n,
      ...over,
    }
  }
  const noneRow = (): PlaceRow[] =>
    tree.none
      ? [
          {
            id: NONE_SEL,
            text: '(none)',
            closed: true,
            title: '',
            path: NONE_SEL,
            count: tree.none.count,
            usd: tree.none.usd,
            drill: false,
            none: true,
          },
        ]
      : []
  let rows: PlaceRow[]
  if (sel === null) rows = [...tree.nodes.map((n) => row(n)), ...noneRow()]
  else if (sel === NONE_SEL) rows = noneRow()
  else {
    const n = nodeForPath(tree.nodes, sel)
    if (!n) rows = []
    else if (n.children.length === 0) rows = [row(n, { drill: false })]
    else {
      rows = n.children.map((c) => row(c))
      if (n.place)
        rows.push(
          row(n, {
            id: `${n.id}#here`,
            text: '(directly here)',
            sub: undefined,
            title: 'Spend in the place itself, not in a place under it',
            count: n.place.count,
            usd: n.place.usd,
            drill: false,
            node: undefined,
          }),
        )
    }
  }
  const ranked = rows.filter((r) => !r.none).sort((a, b) => b.usd - a.usd || (a.id < b.id ? -1 : 1))
  rows = [...ranked, ...rows.filter((r) => r.none)]
  return { rows, total: rows.reduce((n, r) => n + r.usd, 0) }
}
