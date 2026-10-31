// Highlighting of search terms in a snippet.

export interface Segment {
  text: string
  match: boolean
}

/** The distinct, non-empty terms of a query (whitespace separated), longest first. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const t of query.split(/\s+/)) {
    const k = t.toLowerCase()
    if (k && !seen.has(k)) {
      seen.add(k)
      terms.push(t)
    }
  }
  return terms.sort((a, b) => b.length - a.length)
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

/**
 * Splits `snippet` into segments, marking the parts that equal a term of `query`
 * (case-insensitive, literal: "a.b" matches "a.b" and not "axb"). The segments joined give back
 * the snippet exactly. Longer terms win where terms overlap.
 */
export function highlightSnippet(snippet: string, query: string): Segment[] {
  const terms = queryTerms(query)
  if (!snippet) return []
  if (terms.length === 0) return [{ text: snippet, match: false }]
  const re = new RegExp(terms.map(escapeRegExp).join('|'), 'gi')
  const out: Segment[] = []
  let last = 0
  for (const m of snippet.matchAll(re)) {
    const at = m.index ?? 0
    if (m[0] === '') continue
    if (at > last) out.push({ text: snippet.slice(last, at), match: false })
    out.push({ text: m[0], match: true })
    last = at + m[0].length
  }
  if (last < snippet.length) out.push({ text: snippet.slice(last), match: false })
  return out
}
