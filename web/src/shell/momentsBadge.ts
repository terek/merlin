// The count on the Moments tab: what is new since the Moments page was last opened (docs/ui.md, "Moments"). The last
// visit is kept in `localStorage` under `merlin.moments.seen` as { at, suggestions }; without storage the count only
// clears for as long as the page stays loaded.

import { useEffect, useState } from 'react'
import { useMoments } from '../api/queries'
import type { MomentsReport } from '../api/types'

export const SEEN_KEY = 'merlin.moments.seen'
const CHANGED = 'merlin:moments-seen'

export interface Seen {
  /** The report time of the last visit. */
  at: string
  /** The suggestions shown then. */
  suggestions: string[]
}

/** Reads what a stored value says; undefined for anything that is not a Seen. */
export function parseSeen(raw: string | null): Seen | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object' || typeof v.at !== 'string' || !Array.isArray(v.suggestions)) return undefined
    if (Number.isNaN(Date.parse(v.at))) return undefined
    return { at: v.at, suggestions: v.suggestions.filter((s: unknown): s is string => typeof s === 'string') }
  } catch {
    return undefined
  }
}

/**
 * What is new in a report since the last visit: moments whose first hit is later than the visit, and suggestions not
 * shown then. The first visit (nothing stored) counts the suggestions.
 */
export function badgeCount(report: MomentsReport, seen: Seen | undefined): number {
  if (!seen) return report.suggestions.length
  const at = Date.parse(seen.at)
  const known = new Set(seen.suggestions)
  const moments = report.moments.filter((m) => m.status !== 'unseen' && m.first && Date.parse(m.first) > at).length
  return moments + report.suggestions.filter((s) => !known.has(s.moment)).length
}

let memory: Seen | undefined

function readSeen(): Seen | undefined {
  try {
    const stored = parseSeen(localStorage.getItem(SEEN_KEY))
    if (stored) return stored
  } catch {
    // no storage: the last visit of this page load is all there is
  }
  return memory
}

/** Records that the page showed this report. */
export function markSeen(report: MomentsReport) {
  const seen: Seen = { at: report.now, suggestions: report.suggestions.map((s) => s.moment) }
  memory = seen
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    // private window or storage blocked: kept in memory only
  }
  window.dispatchEvent(new Event(CHANGED))
}

/** The number to show on the Moments tab; 0 (hidden) until the report is there. */
export function useMomentsBadge(): number {
  const q = useMoments({ passive: true })
  const [seen, setSeen] = useState(readSeen)
  useEffect(() => {
    const update = () => setSeen(readSeen())
    window.addEventListener(CHANGED, update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener(CHANGED, update)
      window.removeEventListener('storage', update)
    }
  }, [])
  return q.data ? badgeCount(q.data, seen) : 0
}
