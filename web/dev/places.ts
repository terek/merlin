// The mock's repositories, checkouts and remotes (docs/location.md), over the generated sessions.
// Everything is invented: a bare layout, a plain clone with linked worktrees (one gone), two clones
// of one remote, two repositories that share a display name, sessions in no repository and
// sessions that touched several checkouts. The key rules are the API's: a repository is a git
// common dir whose base name is `.git` or `.bare`; every session counts under one value of each
// key (its primary one) and lists the others it touched.

import type {
  CheckoutGroup,
  Group,
  GroupDim,
  GroupList,
  Money,
  RepoGroup,
  RepoList,
  RepoRef,
  SessionPlaces,
  SessionSummary,
} from '../src/api/types'
import type { Sess } from './gen'

/** `repos.Name` of the Go side. */
export function repoNameOf(key: string): string {
  const parts = key.split('/').filter(Boolean)
  let b = parts[parts.length - 1] ?? ''
  if (b === '.git' || b === '.bare') b = parts[parts.length - 2] ?? ''
  return b.endsWith('.git') && b.length > 4 ? b.slice(0, -4) : b
}

interface Repo {
  key: string
  remote?: string
  gone?: boolean
}
interface Checkout {
  path: string
  worktree?: boolean
  gone?: boolean
}

const R = {
  web: { key: '/Users/dev/acme/web/.git', remote: 'git.example.test/acme/web' },
  api: { key: '/Users/dev/acme/api/.bare', remote: 'git.example.test/acme/api' },
  infra: { key: '/Users/dev/ops/infra/.bare', remote: 'git.example.test/acme/infra' },
  // the same path on another host: its remote label keeps the host
  merlin: { key: '/Users/dev/merlin/.git', remote: 'mirror.example.test/acme/merlin' },
  // three repositories named merlin: a bare container, a clone of the same remote, a mirror at home
  merlinWork: { key: '/Users/dev/work/merlin/.bare', remote: 'git.example.test/acme/merlin' },
  merlinOld: { key: '/Users/dev/old/merlin/.git', remote: 'git.example.test/acme/merlin' },
  apiSrc: { key: '/Users/dev/src/github.com/acme/api/.git', remote: 'github.com/acme/api' },
  ray: { key: '/Users/dev/labs/ray-tracer/.git', remote: 'git.example.test/labs/ray-tracer' },
  compiler: { key: '/Users/dev/labs/compiler/.git', remote: '/srv/git/compiler', gone: true },
  parser: { key: '/Users/dev/oss/parser/.git', remote: 'git.example.test/oss/parser' },
  kitA: { key: '/Users/dev/oss/cli-kit/.git', remote: 'git.example.test/oss/cli-kit' },
  kitB: { key: '/Users/dev/work/cli-kit/.git', remote: 'git.example.test/oss/cli-kit' },
  portal: { key: '/Users/dev/client/portal/.git', remote: 'git.example.test/client/portal' },
  clientWeb: { key: '/Users/dev/client/web/.git', remote: 'git.example.test/client/web' },
} satisfies Record<string, Repo>

const C = {
  web: { path: '/Users/dev/acme/web' },
  webFeature: { path: '/Users/dev/acme/web-feature', worktree: true },
  webOld: { path: '/Users/dev/acme/web-old', worktree: true, gone: true },
  apiMain: { path: '/Users/dev/acme/api/main' },
  apiFeature: { path: '/Users/dev/acme/api/feature' },
  infraMain: { path: '/Users/dev/ops/infra/main' },
  infraFeature: { path: '/Users/dev/ops/infra/feature' },
  merlin: { path: '/Users/dev/merlin' },
  merlinMain: { path: '/Users/dev/work/merlin/main' },
  merlinTree: { path: '/Users/dev/work/merlin/prosper', worktree: true },
  merlinOld: { path: '/Users/dev/old/merlin' },
  apiSrc: { path: '/Users/dev/src/github.com/acme/api' },
  ray: { path: '/Users/dev/labs/ray-tracer' },
  compiler: { path: '/Users/dev/labs/compiler' },
  parser: { path: '/Users/dev/oss/parser' },
  kitA: { path: '/Users/dev/oss/cli-kit' },
  kitB: { path: '/Users/dev/work/cli-kit' },
  portal: { path: '/Users/dev/client/portal' },
  clientWeb: { path: '/Users/dev/client/web' },
} satisfies Record<string, Checkout>

/** Where the sessions of a start directory worked, in turn (null: no checkout, as at a bare root). */
const LAYOUT: Record<string, { repo: Repo; checkouts: (Checkout | null)[] }> = {
  '/Users/dev/acme/web': { repo: R.web, checkouts: [C.web, C.web, C.web, C.webFeature, C.webOld] },
  '/Users/dev/acme/api': { repo: R.api, checkouts: [C.apiMain, C.apiMain, C.apiFeature, null] },
  '/Users/dev/acme/infra': { repo: R.infra, checkouts: [C.infraMain, C.infraFeature, C.infraMain] },
  '/Users/dev/merlin': { repo: R.merlin, checkouts: [C.merlin] },
  '/Users/dev/work/merlin': { repo: R.merlinWork, checkouts: [C.merlinMain, C.merlinTree, null] },
  '/Users/dev/work/merlin/web': { repo: R.merlinWork, checkouts: [C.merlinMain, C.merlinTree] },
  '/Users/dev/old/merlin': { repo: R.merlinOld, checkouts: [C.merlinOld] },
  '/Users/dev/src/github.com/acme/api': { repo: R.apiSrc, checkouts: [C.apiSrc] },
  '/Users/dev/labs/ray-tracer': { repo: R.ray, checkouts: [C.ray] },
  '/Users/dev/labs/compiler': { repo: R.compiler, checkouts: [C.compiler] },
  '/Users/dev/oss/parser': { repo: R.parser, checkouts: [C.parser] },
  '/Users/dev/client/portal': { repo: R.portal, checkouts: [C.portal] },
  '/Users/dev/client/billing': { repo: R.clientWeb, checkouts: [C.clientWeb] },
}
/** Two clones of one remote: sessions alternate between them. */
const CLONES = [
  { repo: R.kitA, checkout: C.kitA },
  { repo: R.kitB, checkout: C.kitB },
]

const repoRef = (r: Repo): RepoRef => ({
  repo: r.key,
  name: repoNameOf(r.key),
  remote: r.remote,
  gone: r.gone || undefined,
})

interface Loc {
  repo?: Repo
  checkout?: Checkout
  /** Everything it touched, the primary values included. */
  checkouts: Checkout[]
  repos: Repo[]
  remotes: string[]
}

const locs = new Map<string, Loc>()
const checkoutInfo = new Map<string, Checkout>()
/** The repository each checkout belongs to. */
const ownerOf = new Map<string, string>()
const repoInfo = new Map<string, Repo>()

/** Gives every session a location and fills in `repo`, `checkout`, `remote` and `places`. */
export function assignPlaces(sessions: Sess[]): void {
  for (const c of Object.values(C)) checkoutInfo.set(c.path, c)
  for (const r of Object.values(R)) repoInfo.set(r.key, r)
  for (const lay of Object.values(LAYOUT)) for (const c of lay.checkouts) if (c) ownerOf.set(c.path, lay.repo.key)
  for (const c of CLONES) ownerOf.set(c.checkout.path, c.repo.key)
  const seen = new Map<string, number>()
  let several = 0
  for (const s of sessions) {
    const sum = s.summary
    const i = seen.get(sum.project) ?? 0
    seen.set(sum.project, i + 1)
    let repo: Repo | undefined
    let checkout: Checkout | undefined
    if (sum.project === '/Users/dev/oss/cli-kit') {
      const clone = CLONES[i % CLONES.length]
      repo = clone.repo
      checkout = clone.checkout
    } else {
      const lay = LAYOUT[sum.project]
      repo = lay?.repo
      checkout = lay ? (lay.checkouts[i % lay.checkouts.length] ?? undefined) : undefined
    }
    const loc: Loc = { repo, checkout, checkouts: checkout ? [checkout] : [], repos: repo ? [repo] : [], remotes: [] }
    // a few sessions of the bare layout worked in several checkouts, and one went on into another repository
    if (repo === R.api && sum.kind !== 'sdk' && several < 4) {
      several++
      loc.checkouts = [C.apiMain, C.apiFeature]
      if (several === 2) {
        loc.checkouts = [C.apiMain, C.apiFeature, C.webFeature, C.web]
        loc.repos = [R.api, R.web]
      }
      if (several === 3) loc.checkouts = [C.apiFeature, C.apiMain, C.infraMain]
      if (several === 3) loc.repos = [R.api, R.infra]
      loc.checkout = loc.checkouts[0]
    }
    loc.remotes = [...new Set(loc.repos.map((r) => r.remote).filter((x): x is string => !!x))].sort()
    locs.set(sum.key.id, loc)
    sum.repo = repo ? repoRef(repo) : undefined
    sum.checkout = loc.checkout?.path
    sum.remote = repo?.remote
    s.detail.places = placesOf(loc, sum)
  }
}

function placesOf(loc: Loc, sum: SessionSummary): SessionPlaces {
  return {
    repo: sum.repo,
    checkout: sum.checkout,
    remote: sum.remote,
    checkouts: loc.checkouts.length ? loc.checkouts.map((c) => c.path).sort() : undefined,
    repos: loc.repos.length ? loc.repos.map(repoRef) : undefined,
    remotes: loc.remotes.length ? loc.remotes : undefined,
    branches: sum.branch ? [{ name: sum.branch, usd: sum.cost.bestUSD }] : undefined,
    noBeadUSD: sum.cost.bestUSD,
  }
}

// ---- filters ---------------------------------------------------------------------------

export interface PlaceFilter {
  repo?: string
  checkout?: string
  remote?: string
  touched: boolean
}

export function placeFilterOf(u: URL): PlaceFilter {
  const g = (k: string) => u.searchParams.get(k) || undefined
  const t = u.searchParams.get('touched')
  return {
    repo: g('repo'),
    checkout: g('checkout'),
    remote: g('remote'),
    touched: t === '1' || t === 'true',
  }
}

/** The API's rule: the most specific of checkout, repo and remote is widened by `touched`; `-` is primary. */
export function placeMatches(f: PlaceFilter, s: SessionSummary): boolean {
  const loc = locs.get(s.key.id)
  const wide = f.touched ? [f.checkout, f.repo, f.remote].find((v) => v && v !== '-') : undefined
  const test = (want: string | undefined, primary: string | undefined, touched: string[]) => {
    if (!want) return true
    if (want === '-') return !primary
    if (want === wide) return touched.includes(want)
    return primary === want
  }
  return (
    test(f.repo, s.repo?.repo, loc?.repos.map((r) => r.key) ?? []) &&
    test(f.checkout, s.checkout, loc?.checkouts.map((c) => c.path) ?? []) &&
    test(f.remote, s.remote, loc?.remotes ?? [])
  )
}

// ---- /api/groups, /api/repos ---------------------------------------------------------------

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

function keyOf(by: GroupDim, s: SessionSummary): string {
  return by === 'dir'
    ? s.project
    : by === 'checkout'
      ? (s.checkout ?? '')
      : by === 'repo'
        ? (s.repo?.repo ?? '')
        : (s.remote ?? '')
}

function nameOf(by: GroupDim, key: string): string {
  if (!key) return { dir: 'no directory', checkout: 'no checkout', repo: 'no repository', remote: 'no remote' }[by]
  return by === 'repo' ? repoNameOf(key) : by === 'remote' ? key : base(key)
}

const addMoney = (m: Money, s: SessionSummary) => {
  m.totalUSD += s.cost.bestUSD
  m.reportedUSD += s.cost.reportedUSD
  m.attributedUSD += Math.max(0, s.cost.bestUSD - s.cost.reportedUSD)
}

function order<T extends { key: string; lastActivityAt?: string }>(xs: T[]): T[] {
  return xs.sort((a, b) =>
    !a.key !== !b.key
      ? a.key
        ? -1
        : 1
      : (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || (a.key < b.key ? -1 : 1),
  )
}

export function groups(by: GroupDim, sessions: SessionSummary[]): GroupList {
  const out = new Map<string, Group>()
  for (const s of sessions) {
    const key = keyOf(by, s)
    let g = out.get(key)
    if (!g) {
      const gone = by === 'repo' ? repoInfo.get(key)?.gone : by === 'checkout' ? checkoutInfo.get(key)?.gone : undefined
      g = {
        key,
        name: nameOf(by, key),
        remote: by === 'repo' ? repoInfo.get(key)?.remote : undefined,
        gone: gone || undefined,
        sessions: 0,
        cost: { totalUSD: 0, reportedUSD: 0, attributedUSD: 0 },
      }
      out.set(key, g)
    }
    g.sessions++
    addMoney(g.cost, s)
    if ((s.lastActivityAt ?? '') > (g.lastActivityAt ?? '')) g.lastActivityAt = s.lastActivityAt
  }
  return { groups: order([...out.values()]) }
}

export function repos(sessions: SessionSummary[]): RepoList {
  const out = new Map<string, RepoGroup>()
  const touchedCo = new Map<string, Map<string, CheckoutGroup>>()
  const branches = new Map<
    string,
    Map<string, { name: string; sessions: number; usd: number; lastActivityAt?: string }>
  >()
  for (const s of sessions) {
    const key = s.repo?.repo ?? ''
    let g = out.get(key)
    if (!g) {
      g = {
        repo: key,
        name: key ? repoNameOf(key) : 'no repository',
        remote: repoInfo.get(key)?.remote,
        gone: repoInfo.get(key)?.gone || undefined,
        sessions: 0,
        cost: { totalUSD: 0, reportedUSD: 0, attributedUSD: 0 },
      }
      out.set(key, g)
      touchedCo.set(key, new Map())
      branches.set(key, new Map())
    }
    g.sessions++
    addMoney(g.cost, s)
    if ((s.lastActivityAt ?? '') > (g.lastActivityAt ?? '')) g.lastActivityAt = s.lastActivityAt
    if (!key) continue
    // a checkout counts the sessions of this repository that touched it, and their whole cost
    for (const c of locs.get(s.key.id)?.checkouts ?? []) {
      if (ownerOf.get(c.path) !== key) continue
      const m = touchedCo.get(key) as Map<string, CheckoutGroup>
      const cg = m.get(c.path) ?? {
        checkout: c.path,
        name: base(c.path),
        worktree: c.worktree || undefined,
        gone: c.gone || undefined,
        sessions: 0,
        bestUSD: 0,
      }
      cg.sessions++
      cg.bestUSD += s.cost.bestUSD
      if ((s.lastActivityAt ?? '') > (cg.lastActivityAt ?? '')) cg.lastActivityAt = s.lastActivityAt
      m.set(c.path, cg)
    }
    if (s.branch) {
      const m = branches.get(key) as Map<
        string,
        { name: string; sessions: number; usd: number; lastActivityAt?: string }
      >
      const b = m.get(s.branch) ?? { name: s.branch, sessions: 0, usd: 0 }
      b.sessions++
      b.usd += s.cost.bestUSD
      if ((s.lastActivityAt ?? '') > (b.lastActivityAt ?? '')) b.lastActivityAt = s.lastActivityAt
      m.set(s.branch, b)
    }
  }
  for (const [key, g] of out) {
    g.checkouts = [...(touchedCo.get(key)?.values() ?? [])].sort(
      (a, b) => b.sessions - a.sessions || (a.checkout < b.checkout ? -1 : 1),
    )
    g.branches = [...(branches.get(key)?.values() ?? [])].sort(
      (a, b) => b.sessions - a.sessions || (a.name < b.name ? -1 : 1),
    )
    if (g.checkouts.length === 0) g.checkouts = undefined
    if (g.branches.length === 0) g.branches = undefined
  }
  const list = [...out.values()].sort((a, b) =>
    !a.repo !== !b.repo
      ? a.repo
        ? -1
        : 1
      : (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || (a.repo < b.repo ? -1 : 1),
  )
  return { repos: list }
}

/** The cost row key of a session under a cost dimension of the location keys. */
export function costKey(by: 'dir' | 'checkout' | 'repo' | 'remote' | 'branch', s: SessionSummary): string {
  return by === 'branch' ? `${s.repo?.repo ?? ''}#${s.branch ?? ''}` : keyOf(by, s)
}

/** The label of a cost row of those keys, the API's (a repository by its name, never its key's base). */
export function costLabel(by: 'dir' | 'checkout' | 'repo' | 'remote' | 'branch', key: string): string {
  if (by !== 'branch') return nameOf(by, key)
  const hash = key.indexOf('#')
  const repo = key.slice(0, hash)
  const branch = key.slice(hash + 1)
  if (!repo) return branch || 'no repository or branch'
  return `${repoNameOf(repo)} · ${branch || 'no branch'}`
}
