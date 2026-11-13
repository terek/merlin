// Mock of the Explorer API at realistic scale, for developing the views without a daemon:
//   MOCK_PORT=7451 bun run mock        (default port 7452)
// It serves every endpoint of docs/api.md (filters, paging, search, cost with split, the event
// stream), over the generated data set of gen.ts. All text in it is invented. The responses are
// typed by src/api/types.ts. Vite proxies /api to it with EXPLORER_API=http://127.0.0.1:<port>.

import type {
  Candidate,
  CompactionTally,
  CostBacking,
  CostBy,
  CostRow,
  CostSplitEntry,
  CostTable,
  Hit,
  MomentsReport,
  Money,
  Overview,
  OverviewGroup,
  OverviewLane,
  OverviewSlot,
  OverviewSpan,
  ProjectList,
  ProjectSummary,
  ScanProgress,
  SearchResult,
  SessionList,
  SessionSummary,
  State,
  TreeList,
  TreeSummary,
} from '../src/api/types'
import { heldContext } from '../src/features/overview/model'
import { buildDataset, type Dataset, makeRng, messagesOf, order, PRICE, type Sess } from './gen'
import {
  assignPlaces,
  costKey,
  costLabel,
  groups,
  type PlaceFilter,
  placeFilterOf,
  placeMatches,
  repos,
} from './places'

const port = Number(process.env.MOCK_PORT ?? 7452)
// Written by a throwaway program over synthetic digests (no real history); see docs/moments.md.
const mockMoments: MomentsReport = await Bun.file(new URL('./moments.json', import.meta.url)).json()
const MIN = 60_000

const ds: Dataset = buildDataset(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 30 * MIN)
assignPlaces(ds.sessions)

// ---- helpers --------------------------------------------------------------------------

class BadRequest extends Error {}

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function fail(status: number, code: string, message: string, candidates?: Candidate[]): Response {
  return json(status, { error: { code, message, candidates } })
}

function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A date ("2026-09-16", local midnight) or an RFC 3339 time, in ms. */
function parseTime(name: string, v: string | null, wholeDay = false): number | undefined {
  if (!v) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  const t = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (wholeDay ? 1 : 0)).getTime() : Date.parse(v)
  if (Number.isNaN(t))
    throw new BadRequest(`${name}=${JSON.stringify(v)}: use an RFC 3339 time or a date like 2026-09-16`)
  return t
}

function limitParam(u: URL, def: number): number {
  const v = u.searchParams.get('limit')
  if (v === null) return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 500)
    throw new BadRequest(`limit=${JSON.stringify(v)}: use a number from 1 to 500`)
  return n
}

function list(u: URL, name: string): string[] {
  return u.searchParams
    .getAll(name)
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean)
}

interface Filter {
  project?: string
  kinds: string[]
  states: State[]
  since?: number
  until?: number
  /** repo, checkout, remote and touched (dev/places.ts). */
  place: PlaceFilter
}

function filterOf(u: URL): Filter {
  const kinds = list(u, 'kind')
  for (const k of kinds) {
    if (k === 'sdk') throw new BadRequest('kind=sdk: scripted runs are never listed')
    if (k !== 'interactive' && k !== 'background')
      throw new BadRequest(`kind=${JSON.stringify(k)}: use interactive or background`)
  }
  const states: State[] = []
  for (const s of list(u, 'state')) {
    if (s === 'running') states.push('busy', 'idle')
    else if (s === 'busy' || s === 'idle' || s === 'recent' || s === 'ended') states.push(s)
    else throw new BadRequest(`state=${JSON.stringify(s)}: use running, recent or ended`)
  }
  return {
    project: u.searchParams.get('project') || undefined,
    kinds: kinds.length ? kinds : ['interactive', 'background'],
    states,
    since: parseTime('since', u.searchParams.get('since')),
    until: parseTime('until', u.searchParams.get('until'), true),
    place: placeFilterOf(u),
  }
}

function matches(f: Filter, s: SessionSummary): boolean {
  if (f.project && f.project !== s.project && f.project !== s.projectKey) return false
  if (!f.kinds.includes(s.kind)) return false
  if (f.states.length && !f.states.includes(s.state)) return false
  const at = Date.parse(s.lastActivityAt ?? '')
  if (f.since !== undefined && at < f.since) return false
  if (f.until !== undefined && at >= f.until) return false
  return placeMatches(f.place, s)
}

const visible = () => ds.sessions.filter((s) => s.summary.kind !== 'sdk')

// ---- /api/projects --------------------------------------------------------------------

function projects(): ProjectList {
  const by = new Map<string, ProjectSummary>()
  for (const s of visible()) {
    const p = s.summary
    const cur = by.get(p.project) ?? {
      harness: 'claude',
      projectKey: p.projectKey,
      project: p.project,
      sessions: 0,
      scriptedRuns: 0,
      lastActivityAt: undefined,
      cost: { totalUSD: 0, reportedUSD: 0, attributedUSD: 0 },
    }
    cur.sessions++
    if (p.cost.flag === 'unknown') cur.unknownSessions = (cur.unknownSessions ?? 0) + 1
    if (!cur.lastActivityAt || (p.lastActivityAt ?? '') > cur.lastActivityAt) cur.lastActivityAt = p.lastActivityAt
    for (const e of s.spend) addMoney(cur.cost, e.usd, e.reported)
    by.set(p.project, cur)
  }
  for (const l of ds.scripted) {
    const cur = by.get(l.project)
    if (!cur) continue
    cur.scriptedRuns += l.count
    cur.cost.totalUSD += l.totalUSD
    cur.cost.reportedUSD += l.reportedUSD
    cur.cost.attributedUSD += l.attributedUSD
  }
  return { projects: [...by.values()].sort((a, b) => ((a.lastActivityAt ?? '') < (b.lastActivityAt ?? '') ? 1 : -1)) }
}

function addTally(a: CompactionTally | undefined, b: CompactionTally): CompactionTally {
  if (!a) return { ...b }
  return {
    calls: a.calls + b.calls,
    cold: a.cold + b.cold,
    usd: a.usd + b.usd,
    warmUSD: a.warmUSD + b.warmUSD,
    uncoveredUSD: a.uncoveredUSD + b.uncoveredUSD,
  }
}

function addMoney(m: Money, usd: number, reported: boolean) {
  m.totalUSD += usd
  if (reported) m.reportedUSD += usd
  else m.attributedUSD += usd
}

// ---- /api/sessions --------------------------------------------------------------------

const enc = (s: SessionSummary) => btoa(`${s.lastActivityAt}|${s.key.id}`).replace(/=+$/, '')

function sessionsList(u: URL): SessionList | TreeList {
  const by = u.searchParams.get('by')
  if (by === 'tree') return treesList(u)
  if (by && by !== 'session') throw new BadRequest(`by=${JSON.stringify(by)}: use session or tree`)
  const f = filterOf(u)
  const limit = limitParam(u, 50)
  const cursor = u.searchParams.get('cursor')
  const all = visible()
    .filter((s) => matches(f, s.summary))
    .sort(order)
  let start = 0
  if (cursor) {
    let at: string
    let id: string
    try {
      ;[at, id] = atob(cursor).split('|')
    } catch {
      throw new BadRequest('cursor: not a cursor of this API')
    }
    start = all.findIndex(
      (s) =>
        (s.summary.lastActivityAt ?? '') < at || ((s.summary.lastActivityAt ?? '') === at && s.summary.key.id > id),
    )
    if (start < 0) start = all.length
  }
  const page = all.slice(start, start + limit).map((s) => s.summary)
  const more = start + limit < all.length
  let scripted = [] as SessionList['scripted']
  if (!cursor) {
    scripted = ds.scripted.filter((l) => dayInRange(l.day, f.since, f.until) && (!f.project || l.project === f.project))
  }
  return { sessions: page, total: all.length, nextCursor: more ? enc(page[page.length - 1]) : undefined, scripted }
}

/** Trees with a member matching the filters, each with every member, newest last activity first. */
function treesList(u: URL): TreeList {
  const f = filterOf(u)
  const limit = limitParam(u, 50)
  const cursor = u.searchParams.get('cursor')
  const byRoot = new Map<string, Sess[]>()
  for (const s of visible()) {
    const k = s.summary.lineage.root.id
    byRoot.set(k, [...(byRoot.get(k) ?? []), s])
  }
  const all: TreeSummary[] = []
  for (const members of byRoot.values()) {
    if (!members.some((m) => matches(f, m.summary))) continue
    const fam = members[0].detail.family
    const pos = (s: Sess) => fam.members.findIndex((m) => m.key.id === s.summary.key.id)
    const sessions = [...members].sort((a, b) => pos(a) - pos(b)).map((m) => m.summary)
    const newest = [...members].sort(order)[0].summary
    const open = fam.leaves.find((k) => members.some((m) => m.summary.key.id === k.id)) ?? newest.key
    all.push({
      root: members[0].summary.lineage.root,
      open,
      lastActivityAt: newest.lastActivityAt,
      bestUSD: sessions.reduce((n, m) => n + m.cost.bestUSD, 0),
      sessions,
    })
  }
  all.sort((a, b) => {
    const x = a.lastActivityAt ?? ''
    const y = b.lastActivityAt ?? ''
    return x < y ? 1 : x > y ? -1 : a.root.id < b.root.id ? -1 : 1
  })
  let start = 0
  if (cursor) {
    let at: string
    let id: string
    try {
      ;[at, id] = atob(cursor).split('|')
    } catch {
      throw new BadRequest('cursor: not a cursor of this API')
    }
    start = all.findIndex((t) => (t.lastActivityAt ?? '') < at || ((t.lastActivityAt ?? '') === at && t.root.id > id))
    if (start < 0) start = all.length
  }
  const page = all.slice(start, start + limit)
  const last = page[page.length - 1]
  const more = start + limit < all.length
  const scripted = cursor
    ? []
    : ds.scripted.filter((l) => dayInRange(l.day, f.since, f.until) && (!f.project || l.project === f.project))
  return {
    trees: page,
    total: all.length,
    sessions: all.reduce((n, t) => n + t.sessions.length, 0),
    nextCursor: more && last ? btoa(`${last.lastActivityAt}|${last.root.id}`).replace(/=+$/, '') : undefined,
    scripted,
  }
}

function dayInRange(day: string, since: number | undefined, until: number | undefined): boolean {
  const from = since === undefined ? '' : localDay(since)
  const to = until === undefined ? '9999-99-99' : localDay(until - 1)
  return day >= from && day <= to
}

function groupList(u: URL): unknown {
  const by = u.searchParams.get('by')
  if (by !== 'dir' && by !== 'checkout' && by !== 'repo' && by !== 'remote')
    throw new BadRequest(`by=${JSON.stringify(by)}: use dir, checkout, repo or remote`)
  const f = filterOf(u)
  return groups(
    by,
    visible()
      .map((s) => s.summary)
      .filter((s) => matches(f, s)),
  )
}

function sessionDetail(harness: string, id: string, u: URL): Response {
  if (harness !== 'claude') return fail(404, 'not_found', `no such harness: ${harness}`)
  let s = ds.byId.get(id)
  if (!s) {
    const hits = visible().filter((x) => x.summary.key.id.startsWith(id))
    if (hits.length > 1) {
      return fail(
        409,
        'ambiguous_id',
        'the id prefix matches several sessions; give more characters',
        hits.slice(0, 20).map((h) => ({
          key: h.summary.key,
          title: h.summary.title,
          project: h.summary.project,
          lastActivityAt: h.summary.lastActivityAt,
        })),
      )
    }
    s = hits[0]
  }
  if (!s || id.length === 0) return fail(404, 'not_found', `no session with id ${id}`)
  const d = s.detail
  if (u.searchParams.get('messages') === '1') {
    return json(200, { ...d, digest: { ...d.digest, messages: messagesOf(d.digest) } })
  }
  return json(200, d)
}

// ---- /api/search ----------------------------------------------------------------------

function snippetOf(text: string, terms: string[]): string {
  const low = text.toLowerCase()
  const at = Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0))
  const from = Math.max(0, at - 40)
  const out = text.slice(from, from + 160).replace(/\s+/g, ' ')
  return (from > 0 ? '…' : '') + out + (from + 160 < text.length ? '…' : '')
}

function search(u: URL): SearchResult {
  const q = (u.searchParams.get('q') ?? '').trim()
  if (!q) throw new BadRequest('q is required')
  const terms = q.toLowerCase().split(/\s+/)
  const f = filterOf(u)
  const limit = limitParam(u, 50)
  const hit = (text: string | undefined) => !!text && terms.every((t) => text.toLowerCase().includes(t))
  const ranked: { rank: number; hit: Hit }[] = []
  for (const s of visible()) {
    if (!matches(f, s.summary)) continue
    const p = s.summary
    const base = { session: p.key, root: p.lineage.root, title: p.title, project: p.project }
    if (hit(p.title))
      ranked.push({
        rank: 0,
        hit: { ...base, at: p.lastActivityAt, field: 'title', turn: -1, snippet: snippetOf(p.title ?? '', terms) },
      })
    const inherited = s.detail.lineage.inheritedTurns.length
    for (const t of s.detail.digest.turns ?? []) {
      if (t.index < inherited) continue
      const continuedIn = s.detail.lineage.children.filter((c) => c.atTurn >= t.index).map((c) => c.child)
      const extra = continuedIn.length ? { continuedIn } : {}
      if (hit(t.userText))
        ranked.push({
          rank: 0,
          hit: {
            ...base,
            at: t.startedAt,
            field: 'prompt',
            turn: t.index,
            abandoned: t.abandoned,
            snippet: snippetOf(t.userText, terms),
            ...extra,
          },
        })
      if (hit(t.finalText))
        ranked.push({
          rank: 1,
          hit: {
            ...base,
            at: t.endedAt,
            field: 'final',
            turn: t.index,
            abandoned: t.abandoned,
            snippet: snippetOf(t.finalText ?? '', terms),
            ...extra,
          },
        })
    }
    ;(s.detail.digest.compactions ?? []).forEach((c, i) => {
      if (hit(c.summary))
        ranked.push({
          rank: 2,
          hit: { ...base, at: c.at, field: 'compaction', turn: i, snippet: snippetOf(c.summary ?? '', terms) },
        })
    })
    for (const [field, v] of [
      ['project', p.project],
      ['cwd', p.cwd],
      ['branch', p.branch],
    ] as const) {
      if (hit(v)) ranked.push({ rank: 3, hit: { ...base, at: p.lastActivityAt, field, turn: -1, snippet: v ?? '' } })
    }
  }
  ranked.sort((a, b) => a.rank - b.rank || ((a.hit.at ?? '') < (b.hit.at ?? '') ? 1 : -1))
  return { query: q, hits: ranked.slice(0, limit).map((r) => r.hit), truncated: ranked.length > limit }
}

// ---- /api/cost ------------------------------------------------------------------------

interface Contribution {
  session: string
  label?: string
  flag?: Sess['summary']['cost']['flag']
  project: string
  /** Last activity of the session (not set for scripted lines). */
  at?: string
  day: string
  model: string
  kind: string
  usd: number
  reported: boolean
  /** Sessions this contribution stands for (a scripted line stands for `count`). */
  count: number
  scripted: boolean
  /** The session's summary (not set for scripted lines): the location keys read off it. */
  summary?: SessionSummary
  /** A compaction call: no spend of its own, an estimate on the side. */
  comp?: CompactionTally
}

function costTable(u: URL): CostTable {
  const by = (u.searchParams.get('by') ?? 'project') as CostBy
  if (!['project', 'day', 'model', 'kind', 'session', 'dir', 'checkout', 'repo', 'remote', 'branch'].includes(by))
    throw new BadRequest(
      `by=${JSON.stringify(by)}: use project, day, model, kind, session, dir, checkout, repo, remote or branch`,
    )
  const split = u.searchParams.get('split') as 'project' | 'model' | 'kind' | null
  if (split && !['project', 'model', 'kind'].includes(split))
    throw new BadRequest(`split=${JSON.stringify(split)}: use project, model or kind`)
  const project = u.searchParams.get('project') || undefined
  const place = placeFilterOf(u)
  const since = parseTime('since', u.searchParams.get('since'))
  const until = parseTime('until', u.searchParams.get('until'), true)
  const limit = u.searchParams.has('limit') ? limitParam(u, 0) : by === 'session' ? 100 : 0

  const fromDay = since === undefined ? '' : localDay(since)
  const toDay = until === undefined ? '9999-99-99' : localDay(until - 1)
  const inDays = (d: string) => d >= fromDay && d <= toDay
  const cs: Contribution[] = []
  for (const s of visible()) {
    const p = s.summary
    if (project && project !== p.project && project !== p.projectKey) continue
    if (!placeMatches(place, p)) continue
    if (by === 'session') {
      const at = Date.parse(p.lastActivityAt ?? '')
      if ((since !== undefined && at < since) || (until !== undefined && at >= until)) continue
    }
    for (const e of s.spend) {
      const day = localDay(e.at)
      if (by !== 'session' && !inDays(day)) continue
      cs.push({
        session: p.key.id,
        label: p.title,
        flag: p.cost.flag,
        project: p.project,
        at: p.lastActivityAt,
        day,
        model: e.model,
        kind: p.kind,
        usd: e.usd,
        reported: e.reported,
        count: 1,
        scripted: false,
        summary: p,
      })
    }
    for (const c of s.detail.digest.compactions ?? []) {
      if (!c.call) continue
      const day = localDay(Date.parse(c.at))
      if (by !== 'session' && !inDays(day)) continue
      const covered = p.cost.flag !== 'estimated'
      cs.push({
        session: p.key.id,
        label: p.title,
        flag: p.cost.flag,
        project: p.project,
        at: p.lastActivityAt,
        day,
        model: c.call.model,
        kind: p.kind,
        usd: 0,
        reported: covered,
        count: 0,
        scripted: false,
        summary: p,
        comp: {
          calls: 1,
          cold: c.call.cache === 'cold' ? 1 : 0,
          usd: c.call.usd,
          warmUSD: c.call.warmUSD,
          uncoveredUSD: covered ? 0 : c.call.usd,
        },
      })
    }
  }
  for (const l of ds.scripted) {
    if ((project && l.project !== project) || (by !== 'session' && !inDays(l.day))) continue
    if (by === 'session' && (since !== undefined || until !== undefined) && !dayInRange(l.day, since, until)) continue
    const model = 'claude-haiku-4-5-20251001'
    cs.push({
      session: `scripted:${l.project}`,
      label: `scripted runs · ${l.project}`,
      project: l.project,
      day: l.day,
      model,
      kind: 'sdk',
      usd: l.reportedUSD,
      reported: true,
      count: l.count,
      scripted: true,
    })
    cs.push({
      session: `scripted:${l.project}`,
      project: l.project,
      day: l.day,
      model,
      kind: 'sdk',
      usd: l.attributedUSD,
      reported: false,
      count: 0,
      scripted: true,
    })
  }

  const placeDims = ['dir', 'checkout', 'repo', 'remote', 'branch']
  const keyOf = (c: Contribution, dim: CostBy | 'project' | 'model' | 'kind'): string =>
    dim === 'session'
      ? c.session
      : placeDims.includes(dim) && c.summary
        ? costKey(dim as 'dir', c.summary)
        : placeDims.includes(dim)
          ? ''
          : (c[dim as 'project' | 'day' | 'model' | 'kind'] as string)
  const rows = new Map<string, CostRow & { ids: Set<string>; parts: Map<string, CostSplitEntry> }>()
  for (const c of cs) {
    const k = keyOf(c, by)
    let row = rows.get(k)
    if (!row) {
      row = {
        key: k,
        label: by === 'session' ? c.label : placeDims.includes(by) ? costLabel(by as 'dir', k) : undefined,
        flag: by === 'session' ? c.flag : undefined,
        harness: by === 'session' && !c.scripted ? 'claude' : undefined,
        project: by === 'session' ? c.project : undefined,
        lastActivityAt: by === 'session' ? c.at : undefined,
        sessions: 0,
        totalUSD: 0,
        reportedUSD: 0,
        attributedUSD: 0,
        ids: new Set(),
        parts: new Map(),
      }
      rows.set(k, row)
    }
    addMoney(row, c.usd, c.reported)
    if (c.comp) row.compactions = addTally(row.compactions, c.comp)
    row.sessions += c.count
    if (!c.scripted && c.model !== '(overhead)') row.ids.add(c.session)
    if (!c.scripted && c.model === '(overhead)') row.ids.add(c.session)
    if (split) {
      const sk = keyOf(c, split)
      const part = row.parts.get(sk) ?? { key: sk, totalUSD: 0, reportedUSD: 0, attributedUSD: 0 }
      addMoney(part, c.usd, c.reported)
      if (c.comp) part.compactions = addTally(part.compactions, c.comp)
      row.parts.set(sk, part)
    }
  }
  let out: CostRow[] = [...rows.values()].map(({ ids, parts, ...row }) => ({
    ...row,
    sessions: by === 'session' ? Math.max(1, row.sessions) : ids.size + row.sessions,
    split: split ? [...parts.values()].sort((a, b) => b.totalUSD - a.totalUSD) : undefined,
  }))
  out = by === 'day' ? out.sort((a, b) => (a.key < b.key ? -1 : 1)) : out.sort((a, b) => b.totalUSD - a.totalUSD)
  const total: Money = { totalUSD: 0, reportedUSD: 0, attributedUSD: 0 }
  for (const c of cs) {
    addMoney(total, c.usd, c.reported)
    if (c.comp) total.compactions = addTally(total.compactions, c.comp)
  }
  const backing: CostBacking = { exact: 0, partial: 0, estimated: 0, scriptedRuns: 0 }
  const seen = new Set<string>()
  for (const c of cs) {
    if (c.scripted) backing.scriptedRuns += c.count
    else if (!seen.has(c.session)) {
      seen.add(c.session)
      if (c.flag) backing[c.flag]++
    }
  }
  const truncated = limit > 0 && out.length > limit
  return {
    by,
    project,
    since: since === undefined ? undefined : new Date(since).toISOString(),
    until: until === undefined ? undefined : new Date(until).toISOString(),
    rows: truncated ? out.slice(0, limit) : out,
    total,
    sessions: seen.size + backing.scriptedRuns,
    backing,
    truncated: truncated || undefined,
  }
}

// ---- /api/overview (experimental) ------------------------------------------------------

/** The overview's lanes borrow other harnesses for some sessions, so that the page shows every mark. */
function overviewHarness(id: string, harness: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 7 === 0 ? 'codex' : h % 11 === 0 ? 'pi' : harness
}

const SLOT_MS: Record<OverviewSlot, number> = {
  '1m': MIN,
  '2m': 2 * MIN,
  '5m': 5 * MIN,
  '10m': 10 * MIN,
  '15m': 15 * MIN,
  '30m': 30 * MIN,
  '1h': 60 * MIN,
  '2h': 120 * MIN,
  '3h': 180 * MIN,
  '6h': 360 * MIN,
  '12h': 720 * MIN,
  '1d': 1440 * MIN,
}

/** The unix-ms parameter or an RFC 3339 time. */
function overviewTime(name: string, v: string | null): number | undefined {
  if (!v) return undefined
  const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v)
  if (Number.isNaN(t)) throw new BadRequest(`${name}=${JSON.stringify(v)}: use an RFC 3339 time or Unix milliseconds`)
  return t
}

/** A message the overview counts: its time, dollars and (main agent only) prompt tokens. */
interface OvMsg {
  at: number
  usd: number
  ctx: number
}

/** One generated agent of a session. */
interface OvAgent {
  kind: OverviewSpan['kind']
  start: number
  end: number
  title: string
}

/** A session as the overview sees it: calls (main agent has ctx > 0), turn starts and agents. */
interface OvSession {
  sess: Sess
  msgs: OvMsg[]
  turns: number[]
  agents: OvAgent[]
  /** A fork or continued session: its own life is a span. */
  branch?: OvAgent
}

const overviewCache = new Map<string, OvSession>()

const AGENT_TITLES = [
  'Explore the codebase',
  'Review the diff',
  'Run the test suite',
  'Find call sites',
  'Check the docs',
  'Summarise the logs',
  'Write the migration',
  'Audit dependencies',
]

const localHour = (t: number) => new Date(t).getHours()

/** The next 9 o'clock at or after t, plus a little. */
function nextMorning(t: number, r: ReturnType<typeof makeRng>): number {
  const d = new Date(t)
  d.setHours(9, r.int(0, 40), 0, 0)
  if (d.getTime() < t) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * The synthetic life of a session, from its id: turns of a few model calls a minute apart, then a pause (mostly
 * 6 to 40 minutes, now and then an hour or three), bursts of agents after some turns, a compaction when the
 * context is full. The merlin project does not run at night.
 */
function overviewSession(s: Sess): OvSession {
  const id = s.summary.key.id
  const hit = overviewCache.get(id)
  if (hit) return hit
  const r = makeRng([...id].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7))
  const noNights = /merlin/.test(`${s.summary.cwd ?? ''} ${s.summary.project}`)
  const out: OvSession = { sess: s, msgs: [], turns: [], agents: [] }
  let t = s.summary.startedAt ? Date.parse(s.summary.startedAt) : 0
  if (!t) {
    overviewCache.set(id, out)
    return out
  }
  if (noNights && localHour(t) < 9) t = nextMorning(t, r)
  const first = t
  const total = s.summary.cost.bestUSD
  const nTurns = Math.max(2, Math.min(45, Math.round(s.summary.turns / 3) + r.int(0, 4)))
  const weights: number[] = []
  let ctx = r.int(12_000, 40_000)
  for (let k = 0; k < nTurns; k++) {
    out.turns.push(t)
    const calls = r.int(2, 12)
    for (let c = 0; c < calls; c++) {
      t += r.int(12, 70) * 1000
      ctx += r.int(800, 7000)
      if (ctx > 190_000) ctx = r.int(30_000, 50_000)
      const w = 0.3 + r.next() * (ctx / 100_000)
      weights.push(w)
      out.msgs.push({ at: t, usd: w, ctx })
    }
    if (r.chance(0.3)) {
      const burst = r.chance(0.4)
      const n = burst ? r.int(5, 15) : r.int(1, 3)
      const kind: OverviewSpan['kind'] = r.pick(['subagent', 'subagent', 'subagent', 'teammate', 'fork', 'workflow'])
      for (let a = 0; a < n; a++) {
        const st = t + r.int(0, burst ? 100_000 : 40_000)
        const len = kind === 'workflow' ? r.int(5, 40) * MIN : r.int(1, 14) * MIN
        out.agents.push({ kind, start: st, end: st + len, title: `${r.pick(AGENT_TITLES)} ${a + 1}` })
        weights.push(0.5)
        out.msgs.push({ at: st + len, usd: 0.5, ctx: 0 })
      }
    }
    // the pause before the next turn
    const p = r.next()
    t += p < 0.2 ? r.int(1, 4) * MIN : p < 0.88 ? r.int(6, 40) * MIN : r.int(70, 240) * MIN
    if (noNights && (localHour(t) < 9 || localHour(t) >= 23)) t = nextMorning(t, r)
    if (t > ds.now) break
  }
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  out.msgs.forEach((m) => {
    m.usd = (m.usd / sum) * total
  })
  out.msgs.sort((a, b) => a.at - b.at)
  if (s.parent && out.msgs.length > 0) {
    out.branch = {
      kind: s.parent.kind === 'fork' ? 'session-fork' : 'continuation',
      start: first,
      end: out.msgs[out.msgs.length - 1].at,
      title: s.summary.title ?? '',
    }
  }
  overviewCache.set(id, out)
  return out
}

const OV_TOPICS = [
  'the retry logic in the sync client',
  'flaky tests in the billing module',
  'a migration for the new accounts table',
  'the slow dashboard query',
  'error handling around the upload path',
  'the release checklist',
  'a rename of the config loader',
  'pagination on the activity feed',
  'the cache invalidation bug',
  'dark mode contrast in the settings page',
]
const OV_NAMES = ['billing-fix', 'sync retries', 'migration', 'perf pass', 'release prep', 'feed paging']

/** Synthetic overview text from the id: most sessions a recap or a first prompt, some only a last prompt. */
function overviewText(id: string): Pick<OverviewLane, 'name' | 'recap' | 'firstPrompt' | 'lastPrompt'> {
  const h = [...id].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 11)
  const topic = OV_TOPICS[h % OV_TOPICS.length]
  const at = new Date(ds.now - (h % 5000) * MIN).toISOString()
  const prompt = (text: string, turn: number) => ({ turn, at, text, truncated: false })
  const out: ReturnType<typeof overviewText> = {}
  if (h % 7 === 0) out.name = OV_NAMES[h % OV_NAMES.length]
  const kind = h % 10
  if (kind < 4) {
    out.recap = {
      at,
      text: `Working on ${topic}. The failing case is reproduced and the fix is in place; what is left is a test for the edge case and a look at the callers.`,
      truncated: false,
    }
    out.firstPrompt = prompt(`Please look at ${topic}`, 0)
  } else if (kind < 8) {
    out.firstPrompt = prompt(
      `Can you help me with ${topic}? Start by reading the code around it and tell me what you find before changing anything.`,
      0,
    )
    out.lastPrompt = prompt('ok, go ahead', 5)
  } else {
    out.lastPrompt = prompt(`now also update the docs for ${topic}`, 3)
  }
  return out
}

function overview(u: URL): Overview {
  const q = u.searchParams
  const by = q.get('by') === 'project' ? 'dir' : (q.get('by') ?? 'dir')
  if (by !== 'dir' && by !== 'checkout' && by !== 'repo' && by !== 'remote')
    throw new BadRequest(`by=${JSON.stringify(by)}: use dir, checkout, repo or remote`)
  const to0 = overviewTime('to', q.get('to')) ?? Date.now()
  const from0 = overviewTime('from', q.get('from')) ?? to0 - 7 * 86_400_000
  if (from0 >= to0) throw new BadRequest('from must be before to')
  let slot = q.get('slot') as OverviewSlot | null
  if (!slot)
    slot = (Object.keys(SLOT_MS) as OverviewSlot[]).find((k) => Math.ceil((to0 - from0) / SLOT_MS[k]) <= 200) ?? '1d'
  const slotMs = SLOT_MS[slot]
  if (!slotMs)
    throw new BadRequest(`slot=${JSON.stringify(slot)}: use 1m, 2m, 5m, 10m, 15m, 30m, 1h, 2h, 3h, 6h, 12h or 1d`)
  // Slots start on local boundaries (a 1d slot at local midnight).
  const off = -new Date(from0).getTimezoneOffset() * MIN
  const from = Math.floor((from0 + off) / slotMs) * slotMs - off
  const to = Math.ceil((to0 + off) / slotMs) * slotMs - off
  const slots = Math.round((to - from) / slotMs)
  if (slots > 2000) throw new BadRequest(`${slots} slots: at most 2000`)
  const at = (t: number) => Math.floor((t - from) / slotMs)
  const zeros = () => new Array<number>(slots).fill(0)
  const r2 = (x: number) => Math.round(x * 1e6) / 1e6
  const wantGroup = q.has('group') ? q.get('group') : undefined
  const inRange = (t: number) => t >= from && t < to

  interface Acc {
    group: OverviewGroup
    ctxPeak: number[]
    ctxSum: number[]
    idlePeak: number[]
    idleSum: number[]
    priciest?: { s: Sess; usd: number }
  }
  const accs = new Map<string, Acc>()
  const lanes: OverviewLane[] = []
  const bySpan = (a: OverviewSpan, b: OverviewSpan) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0

  for (const s of visible()) {
    const os = overviewSession(s)
    const key = costKey(by, s.summary)
    if (wantGroup !== undefined && wantGroup !== key) continue
    const usd = zeros()
    const active = zeros()
    let total = 0
    let any = false
    for (const m of os.msgs) {
      const i = at(m.at)
      if (i < 0 || i >= slots) continue
      any = true
      usd[i] += m.usd
      total += m.usd
      active[i] = 1
    }
    if (!any) continue
    const { context, idle } = heldContext(
      os.msgs.filter((m) => m.ctx > 0).map((m) => ({ at: m.at, ctx: m.ctx })),
      from,
      slotMs,
      slots,
    )
    context.forEach((v, i) => {
      if (v > 0) active[i] = 1
    })
    const sid = { harness: overviewHarness(s.summary.key.id, s.summary.key.harness), id: s.summary.key.id }
    const agents = os.agents.filter((a) => a.end >= from && a.start < to)
    const spans: OverviewSpan[] = agents.map((a) => ({
      kind: a.kind,
      start: new Date(a.start).toISOString(),
      end: new Date(a.end).toISOString(),
      session: sid,
      title: a.title,
    }))
    const b = os.branch
    if (b && b.end >= from && b.start < to)
      spans.push({
        kind: b.kind,
        start: new Date(b.start).toISOString(),
        end: new Date(b.end).toISOString(),
        session: sid,
        title: b.title,
      })
    spans.sort(bySpan)
    const turns = os.turns.filter(inRange).length
    const nAgents = agents.filter((a) => inRange(a.start)).length
    const lastMsg = os.msgs[os.msgs.length - 1].at

    let a = accs.get(key)
    if (!a) {
      a = {
        group: {
          key,
          name: costLabel(by, key),
          sessions: 0,
          turns: 0,
          agents: 0,
          usd: 0,
          usdSlots: zeros(),
          contextPeak: [],
          contextSum: [],
          idlePeak: [],
          idleSum: [],
          active: zeros(),
          spans: [],
        },
        ctxPeak: zeros(),
        ctxSum: zeros(),
        idlePeak: zeros(),
        idleSum: zeros(),
      }
      accs.set(key, a)
    }
    const g = a.group
    g.sessions++
    g.turns += turns
    g.agents += nAgents
    g.usd += total
    if (!a.priciest || total > a.priciest.usd) a.priciest = { s, usd: total }
    const lastIso = new Date(lastMsg).toISOString()
    if (lastIso > (g.lastActivityAt ?? '')) g.lastActivityAt = lastIso
    for (let i = 0; i < slots; i++) {
      g.usdSlots[i] += usd[i]
      g.active[i] += active[i]
      a.ctxSum[i] += context[i]
      a.idleSum[i] += idle[i]
      if (context[i] > a.ctxPeak[i]) a.ctxPeak[i] = context[i]
      if (idle[i] > a.idlePeak[i]) a.idlePeak[i] = idle[i]
    }
    g.spans.push(...spans)

    // the lane's arrays from its first to its last non-empty slot
    let lo = slots
    let hi = -1
    for (let i = 0; i < slots; i++) {
      if (usd[i] > 0 || context[i] > 0 || idle[i] > 0 || active[i] > 0) {
        if (lo === slots) lo = i
        hi = i
      }
    }
    const cut = (x: number[]) => x.slice(lo, hi + 1)
    lanes.push({
      harness: sid.harness,
      id: sid.id,
      title: s.summary.title,
      ...overviewText(sid.id),
      group: key,
      dir: s.summary.project || undefined,
      startedAt: new Date(os.msgs[0].at).toISOString(),
      lastActivityAt: lastIso,
      usd: r2(total),
      turns,
      agents: nAgents,
      slot0: lo,
      usdSlots: cut(usd).map(r2),
      context: cut(context),
      idle: cut(idle),
      active: cut(active),
      spans,
    })
  }

  const groups: OverviewGroup[] = [...accs.values()]
    .map((a) => ({
      ...a.group,
      usd: r2(a.group.usd),
      priciest: a.priciest && {
        harness: a.priciest.s.summary.key.harness,
        id: a.priciest.s.summary.key.id,
        title: a.priciest.s.summary.title,
        usd: r2(a.priciest.usd),
      },
      usdSlots: a.group.usdSlots.map(r2),
      contextPeak: a.ctxPeak,
      contextSum: a.ctxSum,
      idlePeak: a.idlePeak,
      idleSum: a.idleSum,
      spans: a.group.spans.sort(bySpan),
    }))
    .sort((x, y) => y.usd - x.usd || (x.key < y.key ? -1 : 1))
  const order = new Map(groups.map((g, i) => [g.key, i]))
  lanes.sort(
    (x, y) =>
      (order.get(x.group) ?? 0) - (order.get(y.group) ?? 0) ||
      y.usd - x.usd ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  )

  // Scripted runs: each day's line spread over local working hours, the weights from a hash.
  const scripted = { sessions: 0, usd: 0, usdSlots: zeros() }
  for (const l of ds.scripted) {
    const [y, mo, d] = l.day.split('-').map(Number)
    const day0 = new Date(y, mo - 1, d).getTime()
    const hours = Array.from({ length: 10 }, (_, h) => day0 + (8 + h) * 60 * MIN)
    const w = hours.map((_, h) => 1 + ((d * 31 + h * 17 + l.count) % 5))
    const wsum = w.reduce((x, y2) => x + y2, 0)
    let counted = false
    hours.forEach((t, h) => {
      const i = at(t)
      if (i < 0 || i >= slots) return
      const part = (l.totalUSD * w[h]) / wsum
      scripted.usdSlots[i] += part
      scripted.usd += part
      if (!counted) {
        scripted.sessions += l.count
        counted = true
      }
    })
  }
  scripted.usd = r2(scripted.usd)
  scripted.usdSlots = scripted.usdSlots.map(r2)

  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    slot,
    slotMs,
    slots,
    by,
    groups,
    scripted,
    lanes,
  }
}

// ---- /api/events ----------------------------------------------------------------------

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const textEnc = new TextEncoder()

function emit(name: string, data: unknown) {
  const chunk = textEnc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  for (const c of clients) {
    try {
      c.enqueue(chunk)
    } catch {
      clients.delete(c)
    }
  }
}

const idleProgress: ScanProgress = {
  pending: 0,
  seen: ds.sessions.length,
  processed: 0,
  unchanged: ds.sessions.length,
  failed: 0,
  missing: 0,
}

function events(req: Request): Response {
  let ctl: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c
      clients.add(c)
      c.enqueue(
        textEnc.encode(`retry: 3000\n: connected\n\nevent: scan-progress\ndata: ${JSON.stringify(idleProgress)}\n\n`),
      )
    },
    cancel() {
      clients.delete(ctl)
    },
  })
  req.signal.addEventListener('abort', () => clients.delete(ctl))
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  })
}

setInterval(() => {
  for (const c of clients) {
    try {
      c.enqueue(textEnc.encode(': heartbeat\n\n'))
    } catch {
      clients.delete(c)
    }
  }
}, 15_000)

// Every few seconds one of the live sessions gets a new turn; now and then one changes state.
const rng = makeRng(7)
const liveSessions = ds.sessions.filter((s) => s.live)
setInterval(() => {
  if (clients.size === 0 || liveSessions.length === 0) return
  const s = rng.pick(liveSessions)
  const d = s.detail.digest
  const turns = d.turns ?? []
  const at = Date.now()
  const prev = turns[turns.length - 1]
  const usd = 0.02 + rng.next() * 0.08
  const model = 'claude-sonnet-5-5'
  turns.push({
    ...prev,
    index: prev.index + 1,
    uuid: rng.uuid(),
    startedAt: new Date(at - 4000).toISOString(),
    endedAt: new Date(at).toISOString(),
    durationMs: 4000,
    origin: 'human',
    userText: `live update ${prev.index + 1}: ${rng.pick(['check the build', 'run the tests again', 'show me the diff'])}`,
    finalText: 'Done.',
    spawned: undefined,
    cost: { usd, byModel: { [model]: { usd, input: 500, output: 800, cacheRead: 40000 } } },
    costWithAgents: usd,
  })
  d.stats.turns++
  d.stats.humanTurns++
  d.cost.usd += usd
  d.lastActivityAt = new Date(at).toISOString()
  const sum = s.summary
  sum.turns = turns.length
  sum.humanTurns = (sum.humanTurns ?? 0) + 1
  sum.lastActivityAt = d.lastActivityAt
  sum.cost = { ...sum.cost, bestUSD: sum.cost.bestUSD + usd, uncoveredUSD: sum.cost.uncoveredUSD + usd }
  sum.lastPrompt = {
    turn: prev.index + 1,
    at: d.lastActivityAt,
    text: turns[turns.length - 1].userText,
    truncated: false,
  }
  s.detail.cost.bestUSD += usd
  s.detail.cost.ownUSD += usd
  s.detail.cost.uncoveredUSD += usd
  s.spend.push({ at, model, usd, reported: false })
  s.detail.summary = sum
  emit('session-updated', { key: sum.key, session: sum })
  if (rng.chance(0.3)) {
    const previous = sum.state
    const state: State = previous === 'busy' ? 'idle' : 'busy'
    sum.state = state
    emit('session-state', { key: sum.key, state, previous })
  }
}, 4000)

// ---- server ---------------------------------------------------------------------------

function route(req: Request): Response {
  const u = new URL(req.url)
  const host = u.hostname
  if (host !== '127.0.0.1' && host !== 'localhost')
    return fail(403, 'forbidden_host', 'Host must be 127.0.0.1 or localhost')
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return new Response(
      JSON.stringify({ error: { code: 'method_not_allowed', message: 'the API is read-only: GET only' } }),
      { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } },
    )
  const p = u.pathname.replace(/\/+$/, '')
  try {
    if (p === '/api/harnesses')
      return json(200, {
        harnesses: [
          { name: 'claude', title: 'Claude Code', resume: 'claude --resume {id}' },
          { name: 'codex', title: 'Codex', resume: 'codex resume {id}', badge: 'codex' },
          { name: 'pi', title: 'Pi', resume: 'pi --session {id}', badge: 'pi' },
        ],
      })
    if (p === '/api/prices')
      return json(200, {
        unit: 'USD per million tokens',
        cacheWrite5mMultiplier: 1.25,
        cacheWrite1hMultiplier: 2,
        fastMultiplier: 2,
        models: Object.fromEntries(
          Object.entries(PRICE).map(([n, x]) => [
            n,
            { input: x.in, output: x.out, cacheRead: x.cr, status: 'verified' },
          ]),
        ),
      })
    if (p === '/api/projects') return json(200, projects())
    // The mock has repositories (dev/places.ts) but no bead databases: the rail shows their empty state.
    if (p === '/api/repos') return json(200, repos(visible().map((s) => s.summary)))
    if (p === '/api/groups') return json(200, groupList(u))
    if (p === '/api/beads') return json(200, { prefixes: [], families: [], databases: 0 })
    if (p === '/api/sessions') return json(200, sessionsList(u))
    const m = /^\/api\/sessions\/([^/]+)\/([^/]+)$/.exec(p)
    if (m) return sessionDetail(decodeURIComponent(m[1]), decodeURIComponent(m[2]), u)
    if (p === '/api/search') return json(200, search(u))
    if (p === '/api/cost') return json(200, costTable(u))
    // A report built by internal/moments from synthetic digests; regenerate it when the registry changes.
    if (p === '/api/overview') return json(200, overview(u))
    if (p === '/api/moments') return json(200, mockMoments)
    if (p === '/api/events') return events(req)
  } catch (e) {
    if (e instanceof BadRequest) return fail(400, 'invalid_parameter', e.message)
    console.error(e)
    return fail(500, 'internal', String(e))
  }
  return fail(404, 'not_found', `no such endpoint: ${u.pathname}`)
}

Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch: route })
console.log(
  `mock API on http://127.0.0.1:${port}: ${ds.sessions.length} sessions, ${ds.scripted.reduce((a, l) => a + l.count, 0)} scripted runs, big session ${ds.bigId}`,
)
