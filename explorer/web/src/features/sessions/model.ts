// The logic of the Sessions page as pure functions: filters in the URL, day groups with their
// sums, families within a day, keyboard selection and the grouping of search hits.

import type { Hit, ScriptedLine, SessionFilters, SessionKey, SessionSummary } from '../../api/types'
import { keyString, sessionTitle } from '../../lib/session'
import { daysBefore, localDay, localDayOf } from '../../lib/time'

// ---- filters in the URL ------------------------------------------------------------------

export type StateFilter = '' | 'running' | 'recent'
export type KindFilter = '' | 'interactive' | 'background'
export type SinceFilter = '' | '7d' | '30d'

/** What the URL holds: `project`, `state`, `kind`, `since` and `q`. Empty string = not set. */
export interface PageFilters {
  project: string
  state: StateFilter
  kind: KindFilter
  since: SinceFilter
  q: string
}

export const NO_FILTERS: PageFilters = { project: '', state: '', kind: '', since: '', q: '' }

const pick = <T extends string>(v: string | null, allowed: readonly T[], none: T): T =>
  allowed.includes(v as T) ? (v as T) : none

/** Reads the filters; a value the page does not know counts as not set. */
export function readFilters(p: URLSearchParams): PageFilters {
  return {
    project: p.get('project') ?? '',
    state: pick(p.get('state'), ['running', 'recent'], ''),
    kind: pick(p.get('kind'), ['interactive', 'background'], ''),
    since: pick(p.get('since'), ['7d', '30d'], ''),
    q: p.get('q') ?? '',
  }
}

/** A copy of `p` with `patch` applied; empty values are removed so the URL stays short. */
export function writeFilters(p: URLSearchParams, patch: Partial<PageFilters>): URLSearchParams {
  const next = new URLSearchParams(p)
  for (const [k, v] of Object.entries(patch)) {
    if (v) next.set(k, v)
    else next.delete(k)
  }
  return next
}

/** True when anything but the search is set (the "clear filters" button). */
export const hasFilters = (f: PageFilters) => Boolean(f.project || f.state || f.kind || f.since)

/** The `since` preset as the local date the API takes. */
export function sinceDate(since: SinceFilter, now: Date = new Date()): string | undefined {
  if (!since) return undefined
  return localDay(daysBefore(now, since === '7d' ? 6 : 29))
}

/** The parameters of /api/sessions (and /api/search, which ignores `state`). */
export function apiFilters(f: PageFilters, now: Date = new Date()): SessionFilters {
  const out: SessionFilters = {}
  if (f.project) out.project = f.project
  if (f.state) out.state = f.state
  if (f.kind) out.kind = f.kind
  const since = sinceDate(f.since, now)
  if (since) out.since = since
  return out
}

// ---- day groups --------------------------------------------------------------------------

export interface Row {
  session: SessionSummary
  /** 1 for an ancestor drawn under the leaf of its family in the same day. */
  level: 0 | 1
}

export interface DayGroup {
  /** Local day "2026-09-16"; "" for sessions that have no activity time. */
  day: string
  rows: Row[]
  scripted: ScriptedLine[]
  /** Visible rows' best cost plus the day's scripted lines. */
  totalUSD: number
  /** More sessions of this day may follow in a page that is not loaded yet. */
  incomplete: boolean
}

const activity = (s: SessionSummary) => (s.lastActivityAt ? Date.parse(s.lastActivityAt) : 0)

/**
 * Puts the members of one family that share a day together: the leaves first, then the
 * ancestors indented below, newest first within each. A session alone keeps level 0. The family
 * stands where its newest member stood.
 */
export function arrangeFamilies(sessions: SessionSummary[]): Row[] {
  const byRoot = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    const k = `${s.lineage.root.harness}/${s.lineage.root.id}`
    const list = byRoot.get(k)
    if (list) list.push(s)
    else byRoot.set(k, [s])
  }
  const rows: Row[] = []
  const done = new Set<string>()
  for (const s of sessions) {
    const k = `${s.lineage.root.harness}/${s.lineage.root.id}`
    if (done.has(k)) continue
    done.add(k)
    const members = byRoot.get(k) ?? [s]
    if (members.length === 1) {
      rows.push({ session: s, level: 0 })
      continue
    }
    const ordered = [...members].sort(
      (a, b) => Number(b.lineage.leaf) - Number(a.lineage.leaf) || activity(b) - activity(a),
    )
    ordered.forEach((m, i) => {
      rows.push({ session: m, level: i === 0 || m.lineage.leaf ? 0 : 1 })
    })
  }
  return rows
}

/**
 * Groups a list (newest last activity first) by the local day of its last activity. `scripted`
 * are the aggregate lines of scripted runs; `more` says that pages follow, in which case the
 * oldest day is `incomplete` and scripted lines of days older than the loaded rows are held back.
 */
export function buildDayGroups(sessions: SessionSummary[], scripted: ScriptedLine[], more: boolean): DayGroup[] {
  const byDay = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    const d = localDayOf(s.lastActivityAt)
    const list = byDay.get(d)
    if (list) list.push(s)
    else byDay.set(d, [s])
  }
  const oldest = sessions.length ? localDayOf(sessions[sessions.length - 1].lastActivityAt) : ''
  const scriptedByDay = new Map<string, ScriptedLine[]>()
  for (const l of scripted) {
    if (more && oldest && l.day < oldest) continue
    const list = scriptedByDay.get(l.day)
    if (list) list.push(l)
    else scriptedByDay.set(l.day, [l])
  }
  const days = [...new Set([...byDay.keys(), ...scriptedByDay.keys()])].sort((a, b) => {
    if (a === b) return 0
    if (a === '') return 1
    if (b === '') return -1
    return a < b ? 1 : -1
  })
  return days.map((day) => {
    const rows = arrangeFamilies(byDay.get(day) ?? [])
    const lines = (scriptedByDay.get(day) ?? []).sort(
      (a, b) => b.totalUSD - a.totalUSD || (a.project < b.project ? -1 : 1),
    )
    const totalUSD = rows.reduce((n, r) => n + r.session.cost.bestUSD, 0) + lines.reduce((n, l) => n + l.totalUSD, 0)
    return { day, rows, scripted: lines, totalUSD, incomplete: more && day === oldest }
  })
}

/** Scripted runs are neither interactive nor background nor in a liveness state: a filter hides them. */
export const showsScripted = (f: PageFilters) => !f.state && !f.kind

// ---- keyboard selection ------------------------------------------------------------------

/**
 * The id selected after a `j` (delta 1) or `k` (delta -1). The selection is an id, not an index,
 * so rows that move (a session became active) do not carry it away; when the selected id is gone
 * the first item is chosen by `j` and the last by `k`. Does not wrap.
 */
export function moveSelection(ids: string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null
  const at = current === null ? -1 : ids.indexOf(current)
  if (at < 0) return delta === 1 ? ids[0] : ids[ids.length - 1]
  return ids[Math.min(ids.length - 1, Math.max(0, at + delta))]
}

// ---- search ------------------------------------------------------------------------------

export interface HitGroup {
  session: SessionKey
  title?: string
  project: string
  at?: string
  hits: { hit: Hit; index: number }[]
}

/** Groups hits by session in the order the API returned them (a group stands where its first hit stood). */
export function groupHits(hits: Hit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>()
  hits.forEach((hit, index) => {
    const k = `${hit.session.harness}/${hit.session.id}`
    let g = groups.get(k)
    if (!g) {
      g = { session: hit.session, title: hit.title, project: hit.project, at: hit.at, hits: [] }
      groups.set(k, g)
    }
    g.hits.push({ hit, index })
  })
  return [...groups.values()]
}

/** Label of a hit's field, in the words a person uses. */
export function fieldLabel(field: Hit['field']): string {
  switch (field) {
    case 'final':
      return 'answer'
    case 'compaction':
      return 'summary'
    default:
      return field
  }
}

/** Where a hit leads: the turn, the compaction, or the session itself. */
export function hitHash(hit: Pick<Hit, 'field' | 'turn'>): string | undefined {
  if (hit.turn < 0) return undefined
  if (hit.field === 'prompt' || hit.field === 'final') return `t${hit.turn}`
  if (hit.field === 'compaction') return `c${hit.turn}`
  return undefined
}

/** What a hit's place is called: "turn 4", or "compaction 1" for a compaction summary (its `turn` is the compaction index). */
export function hitPlace(hit: Pick<Hit, 'field' | 'turn'>): string {
  return `${hit.field === 'compaction' ? 'compaction' : 'turn'} ${hit.turn}`
}

/** Titles of the sessions in cached list pages, by "harness/id". */
export function cachedTitles(pages: readonly { sessions: readonly SessionSummary[] }[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of pages)
    for (const s of p.sessions) {
      const t = sessionTitle(s)
      if (t) out.set(keyString(s.key), t)
    }
  return out
}
