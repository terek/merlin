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

/** Whether a location reads the scope: the Overview or Cost. */
export const isScopePath = (pathname: string): boolean => pathname === '/' || pathname === '/cost'

/** Remembers the scope (`?range=…&in=…`) of the Overview or Cost; other pages are left alone. */
export function rememberScope(pathname: string, search: string, store: Pick<Storage, 'setItem'> = sessionStorage) {
  if (!isScopePath(pathname)) return
  try {
    store.setItem(SCOPE_KEY, scopeSearch(search))
  } catch {
    // storage unavailable: the tabs carry no scope from other pages
  }
}

/** The scope last seen, as a query string (empty for none). */
export function lastScope(store: Pick<Storage, 'getItem'> = sessionStorage): string {
  try {
    const v = store.getItem(SCOPE_KEY) ?? ''
    return v.startsWith('?') ? scopeSearch(v) : ''
  } catch {
    return ''
  }
}

/** The addresses of the two lenses: with the scope of the page being read, else the last one seen. */
export function lensLinks(
  pathname: string,
  search: string,
  store?: Pick<Storage, 'getItem'>,
): { overview: string; cost: string } {
  const scope = isScopePath(pathname) ? scopeSearch(search) : lastScope(store)
  return { overview: `/${scope}`, cost: `/cost${scope}` }
}
