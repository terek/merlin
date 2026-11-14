// The scope the Overview and Cost both read: the URL's `range`, `from`, `to`, `by`, `in` and `q`.

export const SCOPE_KEYS = ['range', 'from', 'to', 'by', 'in', 'q'] as const

/** The scope's parameters of a query string, as `?…` (empty for none). */
export function scopeSearch(search: string | URLSearchParams): string {
  const from = typeof search === 'string' ? new URLSearchParams(search) : search
  const out = new URLSearchParams()
  for (const k of SCOPE_KEYS) {
    const v = from.get(k)
    if (v) out.set(k, v)
  }
  const s = out.toString()
  return s ? `?${s}` : ''
}
