// Names of the places a session worked: repositories, checkouts and remotes (docs/location.md §3).
// A repository's key is its git common dir (`/home/dev/acme/.git`), whose base name is `.git`
// or `.bare`: a name is never read off the key when the API gives one.

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
