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

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * What the head says in place of the row's graph when the session lies outside the list's range: "Outside this
 * range: Sep 7–9" (one day: "Sep 7"; across months: "Sep 30 – Oct 2"). Local days, like the list's axis.
 */
export function outsideNote(startMs: number, endMs: number): string {
  if (!Number.isFinite(startMs)) return 'Outside this range'
  const a = new Date(startMs)
  const b = new Date(Number.isFinite(endMs) ? Math.max(endMs, startMs) : startMs)
  const day = (d: Date) => `${MONTH[d.getMonth()]} ${d.getDate()}`
  const same = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
  const text =
    same && a.getDate() === b.getDate()
      ? day(a)
      : same
        ? `${day(a)}–${b.getDate()}`
        : `${day(a)} – ${day(b)}${a.getFullYear() === b.getFullYear() ? '' : ` ${b.getFullYear()}`}`
  return `Outside this range: ${text}`
}

/** The first and last activity (ms) over every time given: the session's own and its family's; NaN when none parses. */
export function lifeRange(
  starts: readonly (string | undefined)[],
  ends: readonly (string | undefined)[],
): [number, number] {
  const ms = (l: readonly (string | undefined)[]) =>
    l.map((s) => (s ? Date.parse(s) : Number.NaN)).filter(Number.isFinite)
  const a = ms(starts)
  const b = ms([...ends, ...starts])
  return a.length ? [Math.min(...a), Math.max(...b)] : [Number.NaN, Number.NaN]
}

/**
 * What the head draws under its text line: the row graph for a session that has a lane in this scope (as the list
 * does, whatever its life says: a lane is in the range because something of it is), the "outside this range" note
 * for a session without one whose life misses the axis, and nothing for one without a lane whose life overlaps it.
 */
export function headRow(hasLane: boolean, life: readonly [number, number], axis: { fromMs: number; toMs: number }) {
  if (hasLane) return 'graph' as const
  const [a, b] = life
  return Number.isFinite(a) && (b < axis.fromMs || a > axis.toMs) ? ('note' as const) : ('none' as const)
}
