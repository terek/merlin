// The logic of the Sessions page as pure functions: filters in the URL, trees of linked sessions
// grouped by day, keyboard selection and the grouping of search hits by tree.

import type {
  CostFlag,
  Hit,
  ScriptedLine,
  SessionFilters,
  SessionKey,
  SessionSummary,
  State,
  TreeSummary,
} from '../../api/types'
import { plural } from '../../lib/format'
import { keyString, sameKey, sessionTitle } from '../../lib/session'
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

// ---- trees and day groups ----------------------------------------------------------------

/** The member a tree's row shows and opens: its `open` session (the newest leaf). */
export function openMember(t: TreeSummary): SessionSummary {
  return t.sessions.find((s) => sameKey(s.key, t.open)) ?? t.sessions[t.sessions.length - 1]
}

const BUSY: Record<State, number> = { busy: 3, idle: 2, recent: 1, ended: 0 }

/** The liveness a tree's row shows: that of its busiest member. */
export function treeState(t: TreeSummary): State {
  return t.sessions.reduce<State>((st, s) => (BUSY[s.state] > BUSY[st] ? s.state : st), 'ended')
}

const FLAG_RANK: Record<CostFlag, number> = { exact: 0, partial: 1, estimated: 2 }

/** How well a tree's cost is backed: the weakest of its members. */
export function treeFlag(t: TreeSummary): CostFlag {
  return t.sessions.reduce<CostFlag>((f, s) => (FLAG_RANK[s.cost.flag] > FLAG_RANK[f] ? s.cost.flag : f), 'exact')
}

/** "12 sessions", or "14 sessions in 12 trees" when some trees hold several. */
export function countLabel(sessions: number, trees: number): string {
  return sessions === trees ? plural(sessions, 'session') : `${plural(sessions, 'session')} in ${plural(trees, 'tree')}`
}

/** One session line: a tree's own row (level 0) or a member listed under it (level 1). */
export interface Row {
  session: SessionSummary
  level: 0 | 1
}

export interface DayGroup {
  /** Local day "2026-09-16" of the trees' last activity; "" for trees that have no activity time. */
  day: string
  trees: TreeSummary[]
  scripted: ScriptedLine[]
  /** More trees of this day may follow in a page that is not loaded yet. */
  incomplete: boolean
}

/**
 * Groups trees (newest last activity first) by the local day of their last activity. A tree's
 * spend runs over many days, so a group has no money total; only its scripted lines carry their
 * own. `more` says that pages follow, in which case the oldest day is `incomplete` and scripted
 * lines of days older than the loaded trees are held back.
 */
export function buildDayGroups(trees: TreeSummary[], scripted: ScriptedLine[], more: boolean): DayGroup[] {
  const byDay = new Map<string, TreeSummary[]>()
  for (const t of trees) {
    const d = localDayOf(t.lastActivityAt)
    const list = byDay.get(d)
    if (list) list.push(t)
    else byDay.set(d, [t])
  }
  const oldest = trees.length ? localDayOf(trees[trees.length - 1].lastActivityAt) : ''
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
    const lines = (scriptedByDay.get(day) ?? []).sort(
      (a, b) => b.totalUSD - a.totalUSD || (a.project < b.project ? -1 : 1),
    )
    return { day, trees: byDay.get(day) ?? [], scripted: lines, incomplete: more && day === oldest }
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
  root: SessionKey
  /** The session of the group's first (best ranked) hit: the group's title and link. */
  session: SessionKey
  title?: string
  project: string
  at?: string
  hits: { hit: Hit; index: number }[]
  /** How many sessions of the tree have hits here. */
  sessions: number
}

/** Groups hits by tree in the order the API returned them (a group stands where its first hit stood). */
export function groupHits(hits: Hit[]): HitGroup[] {
  const groups = new Map<string, HitGroup & { seen: Set<string> }>()
  hits.forEach((hit, index) => {
    const root = hit.root ?? hit.session
    const k = keyString(root)
    let g = groups.get(k)
    if (!g) {
      g = {
        root,
        session: hit.session,
        title: hit.title,
        project: hit.project,
        at: hit.at,
        hits: [],
        sessions: 0,
        seen: new Set(),
      }
      groups.set(k, g)
    }
    g.hits.push({ hit, index })
    g.seen.add(keyString(hit.session))
    g.sessions = g.seen.size
  })
  return [...groups.values()].map(({ seen: _, ...g }) => g)
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

/** Titles of the sessions in cached tree pages, by "harness/id". */
export function cachedTitles(pages: readonly { trees: readonly TreeSummary[] }[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of pages)
    for (const t of p.trees)
      for (const s of t.sessions) {
        const title = sessionTitle(s)
        if (title) out.set(keyString(s.key), title)
      }
  return out
}
