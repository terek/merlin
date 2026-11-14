// The cuts of the Cost page's "By repository" table and where a row leads.

import { placeLink } from '../../lib/places'

export type RepoCut = 'repo' | 'checkout' | 'remote' | 'branch'

/** `repocut=` from the URL; anything unknown is the repository cut. */
export function parseRepoCut(v: string | null): RepoCut {
  return v === 'branch' || v === 'checkout' || v === 'remote' ? v : 'repo'
}

/**
 * The Sessions page narrowed to a row of the repository table, grouped by it: a repository,
 * checkout or remote (the primary value the row counts, so no `touched`), a branch (key
 * "repository#branch") or a bead.
 */
export function placePath(cut: RepoCut | 'bead', key: string): string {
  if (cut === 'repo' || cut === 'checkout' || cut === 'remote') return placeLink(cut, key)
  const p = new URLSearchParams()
  if (cut === 'bead') {
    p.set('group', 'bead')
    p.set('bead', key)
  } else {
    p.set('group', 'repo')
    const hash = key.indexOf('#')
    const repo = hash >= 0 ? key.slice(0, hash) : key
    p.set('repo', repo || '-')
    if (hash >= 0 && key.slice(hash + 1)) p.set('branch', key.slice(hash + 1))
  }
  return `/sessions?${p.toString()}`
}
