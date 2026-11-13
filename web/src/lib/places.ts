// Names of the places a session worked: repositories, checkouts and remotes (docs/location.md §3).
// A repository's key is its git common dir (`/home/dev/acme/.git`), whose base name is `.git`
// or `.bare`: a name is never read off the key when the API gives one.

import type { SessionPlaces } from '../api/types'
import { baseName } from './paths'

const segments = (path: string) => path.split(/[\\/]+/).filter(Boolean)

/**
 * The display name of a repository from its key, the rule of `repos.Name` in Go: the base name;
 * when that is `.git` or `.bare`, its parent's; a `.git` suffix stripped. Only a fallback for a
 * key whose name is not known yet (a filter chip while the repositories load): use the API's
 * `name` wherever it is at hand.
 */
export function repoName(key: string): string {
  const parts = segments(key)
  let base = parts[parts.length - 1] ?? ''
  if (base === '.git' || base === '.bare') base = parts[parts.length - 2] ?? ''
  const trimmed = base.endsWith('.git') ? base.slice(0, -4) : base
  return trimmed || base
}

/** The key's directories with a trailing `.git` / `.bare` left out: where the named thing lives. */
export function homeOf(key: string): string[] {
  const parts = segments(key)
  const last = parts[parts.length - 1]
  return last === '.git' || last === '.bare' ? parts.slice(0, -1) : parts
}

/**
 * The labels to show for a list of places, in the order given. A name that occurs once is shown
 * as it is; places that share a name show the fewest trailing directories of their paths that
 * tell them apart ("acme/main", "ops/main"). Entries with an empty key (the group of none) and
 * values that are not paths keep their name.
 */
export function placeLabels(items: readonly { key: string; name: string }[]): string[] {
  const homes = items.map((i) => homeOf(i.key))
  const sharing = new Map<string, number[]>()
  items.forEach((it, i) => {
    if (!it.key) return
    const list = sharing.get(it.name)
    if (list) list.push(i)
    else sharing.set(it.name, [i])
  })
  const out = items.map((i) => i.name)
  for (const idx of sharing.values()) {
    if (idx.length < 2) continue
    for (const i of idx) {
      const mine = homes[i]
      const tail = (k: number) => mine.slice(-k).join('/')
      let k = 2
      // the fewest trailing segments no other place of this name ends with
      while (k < mine.length && idx.some((j) => j !== i && homes[j].slice(-k).join('/') === tail(k))) k++
      out[i] = mine.length >= 2 ? tail(k) : out[i]
    }
  }
  return out
}

export type PlaceKind = 'checkout' | 'repo' | 'remote'

/**
 * The Sessions page narrowed to one value of a location key, grouped by that key. An empty key
 * (the sessions with none) is `-`. `touched` adds the sessions that only touched the value: the
 * Session page uses it so the session you came from is in the list; a table row that counts the
 * primary value does not.
 */
export function placeLink(kind: PlaceKind, key: string, touched = false): string {
  const p = new URLSearchParams({ group: kind, [kind]: key || '-' })
  if (touched && key) p.set('touched', '1')
  return `/?${p.toString()}`
}

/** One place of a session, as the Session page's header lists it. */
export interface PlaceEntry {
  kind: PlaceKind
  key: string
  /** The name shown: with enough of the path when two of the session's places share one. */
  label: string
  /** Where the session counts (its primary value) rather than only touched it. */
  primary: boolean
  /** The directory is no longer on disk (known for repositories only). */
  gone?: boolean
}

const unique = <T>(xs: T[], key: (x: T) => string): T[] => {
  const seen = new Set<string>()
  return xs.filter((x) => !seen.has(key(x)) && !!seen.add(key(x)))
}

/**
 * The places of a session split into the ones it counts under (checkout, repository, remote, in
 * that order) and the others it touched, each kind in the order the API lists it.
 */
export function sessionPlaces(p: SessionPlaces): { primary: PlaceEntry[]; others: PlaceEntry[] } {
  const checkouts = unique([...(p.checkout ? [p.checkout] : []), ...(p.checkouts ?? [])], (k) => k)
  const repos = unique([...(p.repo ? [p.repo] : []), ...(p.repos ?? [])], (r) => r.repo)
  const remotes = unique([...(p.remote ? [p.remote] : []), ...(p.remotes ?? [])], (k) => k)
  const labelled = (kind: PlaceKind, keys: string[], names: string[], primary: string | undefined): PlaceEntry[] => {
    const labels = placeLabels(keys.map((key, i) => ({ key, name: names[i] })))
    return keys.map((key, i) => ({ kind, key, label: labels[i], primary: key === primary }))
  }
  const all = [
    ...labelled('checkout', checkouts, checkouts.map(baseName), p.checkout),
    ...labelled(
      'repo',
      repos.map((r) => r.repo),
      repos.map((r) => r.name),
      p.repo?.repo,
    ).map((e, i) => (repos[i].gone ? { ...e, gone: true } : e)),
    ...labelled('remote', remotes, remotes, p.remote),
  ]
  const order = { checkout: 0, repo: 1, remote: 2 }
  return {
    primary: all.filter((e) => e.primary).sort((a, b) => order[a.kind] - order[b.kind]),
    others: all.filter((e) => !e.primary),
  }
}

/** What tells a remote apart without its host: `github.com/acme/app` -> `acme/app`; a local path keeps its last two directories. */
function remoteTail(remote: string): string {
  const parts = remote.split('/').filter(Boolean)
  if (remote.startsWith('/')) return parts.slice(-2).join('/')
  return parts.length > 1 ? parts.slice(1).join('/') : remote
}

/**
 * Short labels for a list of remotes, in the order given: the host is dropped, since it is the
 * same on most rows and a truncated row would read only that. Remotes that would get one label
 * (one path on two hosts, two local paths ending alike) keep their whole string. An empty
 * remote (the none row) gets ''. Links and filters use the whole remote, never the label.
 */
export function remoteLabels(remotes: readonly string[]): string[] {
  const tails = remotes.map((r) => (r ? remoteTail(r) : ''))
  const count = new Map<string, number>()
  for (const t of tails) count.set(t, (count.get(t) ?? 0) + 1)
  return remotes.map((r, i) => (!r ? '' : (count.get(tails[i]) ?? 0) > 1 ? r : tails[i]))
}
