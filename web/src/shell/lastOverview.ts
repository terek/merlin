import { scopeSearch } from '../lib/scope'

// The last Overview address visited in this tab (path and query), for the Session page's back link.

const KEY = 'explorer-last-overview'

/** Whether a location is the Overview page: `/`. */
export const isOverviewPath = (pathname: string): boolean => pathname === '/'

/** Remembers `pathname + search` when it is the Overview's; anything else is left alone. */
export function rememberOverview(pathname: string, search: string, store: Pick<Storage, 'setItem'> = sessionStorage) {
  if (!isOverviewPath(pathname)) return
  try {
    store.setItem(KEY, pathname + search)
  } catch {
    // storage unavailable: the back link falls back to `/`
  }
}

/** The remembered Overview address, or `/`. */
export function lastOverview(store: Pick<Storage, 'getItem'> = sessionStorage): string {
  try {
    const v = store.getItem(KEY)
    return v?.startsWith('/') && isOverviewPath(v.split(/[?#]/)[0]) ? v : '/'
  } catch {
    return '/'
  }
}

const SCOPE_KEY = 'explorer-last-scope'
const Q_KEY = 'explorer-last-overview-q'

/** Whether a location reads the scope: the Overview or Cost. */
export const isScopePath = (pathname: string): boolean => pathname === '/' || pathname === '/cost'

/**
 * Remembers the scope (`?range=…&in=…`, without the search) of the Overview or Cost, and the Overview's search
 * apart: Cost has none, and the Overview gets its own back. Other pages are left alone.
 */
export function rememberScope(pathname: string, search: string, store: Pick<Storage, 'setItem'> = sessionStorage) {
  if (!isScopePath(pathname)) return
  try {
    store.setItem(SCOPE_KEY, scopeSearch(search, { q: false }))
    if (pathname === '/') store.setItem(Q_KEY, new URLSearchParams(search).get('q') ?? '')
  } catch {
    // storage unavailable: the tabs carry no scope from other pages
  }
}

/** The scope last seen, as a query string (empty for none), without the search. */
export function lastScope(store: Pick<Storage, 'getItem'> = sessionStorage): string {
  try {
    const v = store.getItem(SCOPE_KEY) ?? ''
    return v.startsWith('?') ? scopeSearch(v, { q: false }) : ''
  } catch {
    return ''
  }
}

/** The search last used on the Overview. */
export function lastQ(store: Pick<Storage, 'getItem'> = sessionStorage): string {
  try {
    return store.getItem(Q_KEY) ?? ''
  } catch {
    return ''
  }
}

const withQ = (scope: string, q: string): string => {
  if (!q) return scope
  const p = new URLSearchParams(scope)
  p.set('q', q)
  return `?${p.toString()}`
}

/**
 * The addresses of the two lenses. Cost gets the scope without a search; the Overview gets the scope of the page
 * being read (its own search too), else the last scope seen with the search last used on the Overview.
 */
export function lensLinks(
  pathname: string,
  search: string,
  store?: Pick<Storage, 'getItem'>,
): { overview: string; cost: string } {
  if (pathname === '/')
    return { overview: `/${scopeSearch(search)}`, cost: `/cost${scopeSearch(search, { q: false })}` }
  const scope = pathname === '/cost' ? scopeSearch(search, { q: false }) : lastScope(store)
  return { overview: `/${withQ(scope, lastQ(store))}`, cost: `/cost${scope}` }
}
