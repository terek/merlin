// A session open inside the Overview (docs/ui.md section 10b, "A session in place"): the address it has, the
// list it walks, and where the old session links go. Pure; the page that draws it is Focus.tsx.

import { withoutFocus } from '../../lib/scope'

export interface Key {
  harness: string
  id: string
}

/** `open=<harness>:<id>` (the id may hold colons: the harness ends at the first); null for anything else. */
export function parseOpen(v: string | null | undefined): Key | null {
  if (!v) return null
  const at = v.indexOf(':')
  if (at <= 0 || at === v.length - 1) return null
  return { harness: v.slice(0, at), id: v.slice(at + 1) }
}

export const openValue = (k: Key): string => `${k.harness}:${k.id}`

/**
 * The query of the Overview with `key` open: the scope and the rest as they are, the previous session's zoom and
 * development parameters gone, and the session's own zoom (`sfrom`, `sto`) when it opens on a stretch.
 */
export function focusSearch(
  search: string | URLSearchParams,
  key: Key,
  stretch?: { from: string; to: string },
): string {
  const out = withoutFocus(search)
  out.set('open', openValue(key))
  if (stretch) {
    out.set('sfrom', stretch.from)
    out.set('sto', stretch.to)
  }
  return `?${out.toString()}`
}

/** The query with the session closed: the scope as it was. */
export function closedSearch(search: string | URLSearchParams): string {
  const s = withoutFocus(search).toString()
  return s ? `?${s}` : ''
}

/**
 * Where an old session address (`/s/:harness/:id?from&to&pin&unit&cursor#…`) goes: the Overview as it was last
 * left (`last`, a path and query) with the session open. Its zoom (`from`, `to`) becomes `sfrom`, `sto`; the
 * development parameters and the hash are carried as they are.
 */
export function legacyTarget(last: string, key: Key, search: string, hash: string): string {
  const q = last.indexOf('?')
  const out = withoutFocus(q < 0 ? '' : last.slice(q + 1))
  out.set('open', openValue(key))
  const old = new URLSearchParams(search)
  const from = old.get('from')
  const to = old.get('to')
  if (from) out.set('sfrom', from)
  if (to) out.set('sto', to)
  for (const k of ['pin', 'unit', 'cursor'] as const) {
    const v = old.get(k)
    if (v) out.set(k, v)
  }
  const h = hash && hash !== '#' ? (hash.startsWith('#') ? hash : `#${hash}`) : ''
  return `/?${out.toString()}${h}`
}

export interface Position {
  /** 1-based. */
  n: number
  total: number
  prev: Key | null
  next: Key | null
}

/** Where `key` is in the ordered list, and its neighbours; null when it is not in the list. */
export function positionIn(rows: readonly Key[], key: Key): Position | null {
  const i = rows.findIndex((r) => r.harness === key.harness && r.id === key.id)
  if (i < 0) return null
  const at = (j: number): Key | null => (rows[j] ? { harness: rows[j].harness, id: rows[j].id } : null)
  return { n: i + 1, total: rows.length, prev: at(i - 1), next: at(i + 1) }
}
