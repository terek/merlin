// Limit windows as a scope (docs/ui.md sections 10 and 10b): which windows matter, the range one stands for, how a
// window and its lockout are written, and the marks the Overview draws (refusal ticks, locked-out bands). Pure.

import type { LimitLockout, LimitRefusal, Limits, LimitWindow } from '../../api/types'
import { type Axis, type CustomRange, instantRange, sessionKey, stampText, windowLength, xOf } from './model'

const MIN = 60_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A Codex window that reached this many percent counts as a limit hit even if no call was refused. */
export const NEAR_FULL = 90

/** A window worth showing: calls were refused in it, or it came close to full. */
export const qualifies = (w: LimitWindow): boolean => w.refusals > 0 || (w.maxPercent ?? 0) >= NEAR_FULL

/** Known window bounds, or the observed readings only when the provider gave no start. */
export function windowSpan(w: LimitWindow): { fromMs: number; toMs: number } {
  const toMs = Date.parse(w.startsAt ? w.resetsAt : w.lastSeenAt)
  const start = Date.parse(w.startsAt ?? w.firstSeenAt)
  return { fromMs: Number.isNaN(start) ? toMs : start, toMs }
}

/** The windows that qualify, overlap [fromMs, toMs) and belong to `harness` (all when none), newest first. */
export function scopeWindows(
  windows: readonly LimitWindow[],
  fromMs: number,
  toMs: number,
  harness?: string,
  account?: string,
  lockouts: readonly LimitLockout[] = [],
  nowMs = Date.now(),
): LimitWindow[] {
  return windows
    .filter((w) => {
      if (!qualifies(w) || (harness && w.harness !== harness) || (account && (w.account ?? 'unknown') !== account))
        return false
      const s = windowSpan(w)
      return (
        (s.fromMs < toMs && (w.startsAt ? s.toMs > fromMs : s.toMs >= fromMs)) ||
        windowLockouts(w, lockouts).some((l) => lockoutBand(l, fromMs, toMs, nowMs) !== null)
      )
    })
    .sort((a, b) => windowSpan(b).toMs - windowSpan(a).toMs || (a.harness < b.harness ? -1 : 1))
}

/** The scope a window stands for: its instants and its harness. */
export function windowRange(w: LimitWindow): CustomRange {
  const s = windowSpan(w)
  return instantRange(s.fromMs, s.toMs, w.harness, w.account ?? 'unknown')
}

/** Account lockout duration observed so far; open episodes stop at now, never at a future reset. */
export function lockoutMs(l: LimitLockout, nowMs = Date.now()): number | undefined {
  const d = Math.min(nowMs, Date.parse(l.endedAt ?? '') || nowMs) - Date.parse(l.startedAt)
  return Number.isFinite(d) && d > 0 ? d : undefined
}

/** Episodes belonging to this window, including multiple refusals separated by a recovery. */
export function windowLockouts(w: LimitWindow, lockouts: readonly LimitLockout[]): LimitLockout[] {
  return lockouts.filter(
    (l) =>
      l.harness === w.harness &&
      l.account === w.account &&
      l.limit === w.limit &&
      l.kind === w.kind &&
      l.windowMinutes === w.windowMinutes &&
      !!l.resetsAt &&
      Math.abs(Date.parse(l.resetsAt) - Date.parse(w.resetsAt)) <= 10 * MIN,
  )
}

/** Neutral account-level wording; observed blocked work is clipped separately. */
export function episodeText(l: LimitLockout, nowMs = Date.now()): string {
  const prefix = l.accountLabel ? `${l.accountLabel}: ` : ''
  if (l.end === 'open')
    return `${prefix}locked out since ${stampText(Date.parse(l.startedAt))}, ${l.resetsAt ? `until ${stampText(Date.parse(l.resetsAt))} or sooner` : 'end unknown'} (open)`
  const ms = lockoutMs(l, nowMs)
  return `${prefix}${l.end === 'resumed' ? `calls resumed after ${lockoutText(ms ?? 0)}` : `until reset${ms ? ` (${lockoutText(ms)})` : ''}`}`
}

/** A lockout's length, rounded as the session graph writes its breaks: `40m`, `2h`, `3d`. */
export function lockoutText(ms: number): string {
  const m = ms / MIN
  if (m < 57.5) return `${Math.max(5, Math.round(m / 5) * 5)}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

/** Observed blocked work: to the episode end or first successful call anywhere, capped at now. */
export function lockoutBand(
  l: LimitLockout,
  fromMs: number,
  toMs: number,
  nowMs = Date.now(),
): { fromMs: number; toMs: number } | null {
  const a = Math.max(Date.parse(l.startedAt), fromMs)
  const b = Math.min(Date.parse(l.endedAt ?? '') || nowMs, Date.parse(l.workResumedAt ?? '') || nowMs, nowMs, toMs)
  return b > a ? { fromMs: a, toMs: b } : null
}

/** Names remain useful even when the provider never recorded window bounds. */
export function limitName(w: { windowMinutes?: number; limit?: string; kind?: string }): string {
  if (w.kind === 'spend_cap') return 'Spend cap'
  if (w.limit === 'overage') return 'Overage limit'
  const model = w.limit === 'seven_day_opus' ? ' (Opus)' : w.limit === 'seven_day_sonnet' ? ' (Sonnet)' : ''
  if (w.windowMinutes === 300) return `5h${model}`
  if (w.windowMinutes === 10080) return `Weekly${model}`
  return w.windowMinutes && Number.isFinite(w.windowMinutes) && w.windowMinutes > 0
    ? `${windowLength(w.windowMinutes * MIN)}${model}`
    : 'Unnamed limit'
}

const monthDay = (ms: number): string => {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** When the window ran: `Fri 14, 10:00–15:00`; across midnight both days; a week `Nov 7 → Nov 14`. */
export function windowTimes(w: LimitWindow): string {
  if (!w.startsAt)
    return `refused ${stampText(Date.parse(w.firstRefusalAt ?? w.firstSeenAt))}; reset ${monthDay(Date.parse(w.resetsAt))}, ${stampText(Date.parse(w.resetsAt)).split(', ')[1]}`
  const { fromMs, toMs } = windowSpan(w)
  if ((w.windowMinutes ?? 0) >= 1440) return `${monthDay(fromMs)} → ${monthDay(toMs)}`
  const a = stampText(fromMs)
  const b = stampText(toMs)
  return a.slice(0, a.indexOf(',')) === b.slice(0, b.indexOf(','))
    ? `${a}–${b.slice(b.indexOf(',') + 2)}`
    : `${a} – ${b}`
}

/** The ticks of refusals on an axis (px): those inside it, sorted, a tick closer than `minGap` px to the last kept dropped. */
export function refusalTicks(times: readonly number[], axis: Axis, minGap = 3): number[] {
  const xs = times
    .filter((t) => t >= axis.fromMs && t < axis.toMs)
    .map((t) => xOf(axis, t))
    .sort((a, b) => a - b)
  const out: number[] = []
  for (const x of xs) if (out.length === 0 || x - out[out.length - 1] >= minGap) out.push(x)
  return out
}

/** The times (ms) of every refused call, by session (`harness/id`); scripted runs' refusals are in none. */
export function refusalsBySession(refusals: readonly LimitRefusal[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const r of refusals) {
    const t = Date.parse(r.at)
    if (!r.session || Number.isNaN(t)) continue
    const k = sessionKey(r.session.harness, r.session.id)
    const list = out.get(k)
    if (list) list.push(t)
    else out.set(k, [t])
  }
  return out
}

/** One observed blocked stretch for an account; open episodes end at now. */
export interface LockoutSpan {
  fromMs: number
  toMs: number
  untilMs: number
  open: boolean
  episodes: LimitLockout[]
}

export function lockoutSpans(
  episodes: readonly LimitLockout[],
  harness: string,
  fromMs: number,
  toMs: number,
  account?: string,
  nowMs = Date.now(),
): LockoutSpan[] {
  const bands = episodes
    .filter((l) => l.harness === harness && l.account === account)
    .flatMap((l) => {
      const b = lockoutBand(l, fromMs, toMs, nowMs)
      const whole = lockoutBand(l, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, nowMs)
      return b && whole ? [{ ...b, untilMs: whole.toMs, l }] : []
    })
    .sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs)
  const out: LockoutSpan[] = []
  for (const b of bands) {
    const open = b.l.end === 'open' && !b.l.workResumedAt
    const last = out[out.length - 1]
    if (last && b.fromMs <= last.toMs) {
      last.toMs = Math.max(last.toMs, b.toMs)
      last.untilMs = Math.max(last.untilMs, b.untilMs)
      last.open ||= open
      last.episodes.push(b.l)
    } else out.push({ fromMs: b.fromMs, toMs: b.toMs, untilMs: b.untilMs, open, episodes: [b.l] })
  }
  return out
}

/** Match by the session's recorded account; unknown and known accounts stay separate. */
export function sessionLockouts(
  limits: Limits | undefined,
  key: { harness: string; id: string },
  nowMs = Date.now(),
): LockoutSpan[] {
  const account = limits?.sessionAccounts?.find(
    (x) => x.session.harness === key.harness && x.session.id === key.id,
  )?.account
  return lockoutSpans(
    limits?.lockouts ?? [],
    key.harness,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    account,
    nowMs,
  )
}

/** Cache one calculation per harness/account while assigning the right spans to each session row. */
export function lockoutsBySession(
  limits: Limits | undefined,
  keys: readonly { harness: string; id: string }[],
  nowMs = Date.now(),
): Map<string, LockoutSpan[]> {
  const accounts = new Map(
    (limits?.sessionAccounts ?? []).map((x) => [sessionKey(x.session.harness, x.session.id), x.account]),
  )
  const scopes = new Map<string, LockoutSpan[]>()
  const out = new Map<string, LockoutSpan[]>()
  for (const key of keys) {
    const id = sessionKey(key.harness, key.id)
    const account = accounts.get(id)
    const scope = JSON.stringify([key.harness, account])
    let spans = scopes.get(scope)
    if (!spans) {
      spans = lockoutSpans(
        limits?.lockouts ?? [],
        key.harness,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        account,
        nowMs,
      )
      scopes.set(scope, spans)
    }
    if (spans.length > 0) out.set(id, spans)
  }
  return out
}

/** Graphs describe observed interruption, independently of the account's continuing lockout. */
export function lockoutTitle(s: Pick<LockoutSpan, 'untilMs' | 'episodes' | 'open'>): string {
  const names = [...new Set(s.episodes.map(limitName))].join(' and ')
  return `No successful calls observed after ${names} refusal${s.open ? ' (open, through now)' : ` until ${stampText(s.untilMs)}`}`
}

/** How far a session's last activity may lie before a lockout's first refused call and still be its end (a refused call writes no activity). */
export const LOCK_TOLERANCE_MS = 5 * MIN

/** A session's life, in ms. */
export interface Life {
  fromMs: number
  toMs: number
}

const inSpan = (s: Pick<LockoutSpan, 'fromMs' | 'toMs'>, refusals: readonly number[]) =>
  refusals.some((t) => t >= s.fromMs && t < s.toMs)

/**
 * Whether a lockout touched a session: its life overlaps the lockout (a last activity just before the first
 * refused call counts, since the call that was refused is not activity), or one of its calls was refused in it.
 */
export function lockoutAffects(
  s: Pick<LockoutSpan, 'fromMs' | 'toMs'>,
  life: Life | null,
  refusals: readonly number[] = [],
): boolean {
  if (inSpan(s, refusals)) return true
  return !!life && life.fromMs < s.toMs && life.toMs + LOCK_TOLERANCE_MS >= s.fromMs
}

/** The lockouts that touched the session, whole (the caller clips them to its axis). */
export function affectedLockouts<T extends Pick<LockoutSpan, 'fromMs' | 'toMs'>>(
  spans: readonly T[] | undefined,
  life: Life | null,
  refusals: readonly number[] = [],
): T[] {
  return (spans ?? []).filter((s) => lockoutAffects(s, life, refusals))
}

/**
 * When the wait for a limit's reset ends, for a session that was stopped by it: the latest end among the lockouts
 * that began within the session (first refusal no later than its last activity plus a little, or one of its calls
 * refused in it) and run past its last activity. undefined when none.
 */
export function waitUntil(
  spans: readonly Pick<LockoutSpan, 'fromMs' | 'toMs'>[] | undefined,
  life: Life,
  refusals: readonly number[] = [],
): number | undefined {
  let end: number | undefined
  for (const s of spans ?? []) {
    if (s.toMs <= life.toMs) continue
    const began = s.fromMs >= life.fromMs - LOCK_TOLERANCE_MS && s.fromMs <= life.toMs + LOCK_TOLERANCE_MS
    if (!began && !inSpan(s, refusals)) continue
    end = Math.max(end ?? s.toMs, s.toMs)
  }
  return end
}
