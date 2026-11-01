// Pure helpers of the Moments page (docs/moments.md): ordering, the card's content and the data a
// shared card would carry.

import type { MomentPersona, MomentStatus, MomentsReport, MomentView, PersonaView } from '../../api/types'

export const PERSONAS: MomentPersona[] = ['karpathy', 'boris', 'yegge']

export const PERSONA_NAMES: Record<MomentPersona, string> = {
  karpathy: 'Andrej Karpathy',
  boris: 'Boris Cherny',
  yegge: 'Steve Yegge',
}

/** Strongest first: habits before explored, then more weeks, more hits, then title. */
export function compareMoments(a: MomentView, b: MomentView): number {
  const rank = (m: MomentView) => (m.status === 'habit' ? 0 : m.status === 'explored' ? 1 : 2)
  return rank(a) - rank(b) || b.weeks - a.weeks || b.hits - a.hits || a.title.localeCompare(b.title)
}

export interface Grouped {
  habits: MomentView[]
  explored: MomentView[]
  unseen: MomentView[]
}

/** The moments by status, each group strongest first (unseen in registry order). */
export function groupByStatus(moments: MomentView[]): Grouped {
  const of = (s: MomentStatus) => moments.filter((m) => m.status === s)
  return {
    habits: of('habit').sort(compareMoments),
    explored: of('explored').sort(compareMoments),
    unseen: of('unseen'),
  }
}

export interface CardItem {
  id: string
  title: string
  status: MomentStatus
  isNew: boolean
}

export interface CardColumn {
  persona: PersonaView
  items: CardItem[]
  /** Moments of this persona seen but not shown on the card. */
  more: number
}

/**
 * One column per persona with up to `per` of their moments: the strongest habits, but room for
 * the best new moment so that a fresh step shows even next to many habits.
 */
export function cardColumns(report: MomentsReport, per = 3): CardColumn[] {
  return PERSONAS.flatMap((id) => {
    const persona = report.personas.find((p) => p.id === id)
    if (!persona) return []
    const seen = report.moments.filter((m) => m.persona === id && m.status !== 'unseen').sort(compareMoments)
    const picked = seen.slice(0, per)
    const fresh = seen.find((m) => m.new)
    if (fresh && !picked.includes(fresh) && picked.length === per) picked[per - 1] = fresh
    const items = picked.map((m) => ({ id: m.id, title: m.title, status: m.status, isNew: !!m.new }))
    return [{ persona, items, more: seen.length - items.length }]
  })
}

/** A number on the card with what it counts, e.g. 14 · months. */
export interface CardStat {
  value: string
  label: string
}

const DAY_MS = 86_400_000

/**
 * How long the history behind the report runs, in the largest unit that keeps the number
 * readable: days under two weeks, weeks under two months, months under two years, then years.
 */
export function historyLength(since: string | undefined, now: string): CardStat | null {
  if (!since) return null
  const days = Math.max(1, Math.round((Date.parse(now) - Date.parse(since)) / DAY_MS))
  const unit = (n: number, one: string, many: string) => ({ value: String(n), label: n === 1 ? one : many })
  if (days < 14) return unit(days, 'day', 'days')
  if (days < 61) return unit(Math.round(days / 7), 'week', 'weeks')
  const months = Math.round(days / 30.44)
  if (months < 24) return unit(months, 'month', 'months')
  const years = Math.round((days / 365.25) * 2) / 2
  return { value: String(years), label: 'years' }
}

/** The card's headline numbers: sessions (scripted runs left out), projects, history length. */
export function cardStats(report: MomentsReport): CardStat[] {
  const sessions = report.sessions - report.scripted
  const stats = [
    { value: sessions.toLocaleString('en-US'), label: sessions === 1 ? 'session' : 'sessions' },
    { value: report.projects.toLocaleString('en-US'), label: report.projects === 1 ? 'project' : 'projects' },
  ]
  const h = historyLength(report.since, report.now)
  return h ? [...stats, h] : stats
}

export interface CardSummary {
  seen: number
  total: number
  habits: number
  fresh: number
}

export function cardSummary(report: MomentsReport): CardSummary {
  const seen = report.moments.filter((m) => m.status !== 'unseen')
  return {
    seen: seen.length,
    total: report.moments.length,
    habits: seen.filter((m) => m.status === 'habit').length,
    fresh: seen.filter((m) => m.new).length,
  }
}

/**
 * What a shared card would carry, and nothing more: the handle the person typed, the three
 * reactions, and the ids of the moments seen with their status. No session text, path or project.
 */
export interface SharePayload {
  /** handle, optional */
  h?: string
  /** reactions, Karpathy, Boris, Yegge */
  r: string[]
  /** moment id → 'h' (habit) or 'e' (explored) */
  m: Record<string, 'h' | 'e'>
  /** ids of moments first seen in the recent window */
  n: string[]
}

export function sharePayload(report: MomentsReport, handle: string): SharePayload {
  const m: Record<string, 'h' | 'e'> = {}
  for (const v of report.moments) if (v.status !== 'unseen') m[v.id] = v.status === 'habit' ? 'h' : 'e'
  const p: SharePayload = {
    r: PERSONAS.map((id) => report.personas.find((x) => x.id === id)?.reaction ?? ''),
    m,
    n: report.moments.filter((v) => v.new).map((v) => v.id),
  }
  const h = handle.trim()
  if (h) p.h = h
  return p
}

/** base64url of the payload's UTF-8 JSON. */
export function encodePayload(p: SharePayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(p))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Reads a payload back. Moment ids not in `known` are dropped: a card made before a moment was
 * removed still opens. Returns undefined for anything that is not a payload.
 */
export function decodePayload(s: string, known: ReadonlySet<string>): SharePayload | undefined {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    const raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.r) || typeof raw.m !== 'object') return undefined
    const m: Record<string, 'h' | 'e'> = {}
    for (const [id, st] of Object.entries(raw.m)) if (known.has(id) && (st === 'h' || st === 'e')) m[id] = st
    const n = Array.isArray(raw.n) ? raw.n.filter((id: unknown) => typeof id === 'string' && known.has(id)) : []
    const p: SharePayload = { r: raw.r.map(String).slice(0, 3), m, n }
    if (typeof raw.h === 'string' && raw.h) p.h = raw.h
    return p
  } catch {
    return undefined
  }
}

/** A handle as it appears on the card: "@name", at most 24 characters. */
export function cardHandle(handle: string): string {
  const h = handle.trim().replace(/^@+/, '').slice(0, 24)
  return h ? `@${h}` : ''
}
