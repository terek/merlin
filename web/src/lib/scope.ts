// The scope the Overview and Cost both read: the URL's `range`, `from`, `to`, `by`, `in`, `q` and, for a limit window, `harness`.

export const SCOPE_KEYS = ['range', 'from', 'to', 'by', 'in', 'q', 'harness', 'account'] as const

/**
 * The scope's parameters of a query string, as `?…` (empty for none). `q: false` leaves the search out: Cost has none.
 */
export function scopeSearch(search: string | URLSearchParams, opts: { q?: boolean } = {}): string {
  const from = typeof search === 'string' ? new URLSearchParams(search) : search
  const out = new URLSearchParams()
  for (const k of SCOPE_KEYS) {
    if (k === 'q' && opts.q === false) continue
    const v = from.get(k)
    if (v) out.set(k, v)
  }
  const s = out.toString()
  return s ? `?${s}` : ''
}

/**
 * The parameters of a session opened in the Overview: `open=<harness>:<id>` and the session's own zoom
 * (`sfrom`, `sto`), and the development ones (`pin`, `unit`, `cursor`) a session link may carry. None of them is
 * part of the scope: any change of scope drops them.
 */
export const FOCUS_KEYS = ['open', 'sfrom', 'sto', 'pin', 'unit', 'cursor'] as const

/** A copy of the query with the session focus's parameters removed. */
export function withoutFocus(search: string | URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(search)
  for (const k of FOCUS_KEYS) out.delete(k)
  return out
}
