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
