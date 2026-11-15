// Limit windows as a scope (docs/ui.md sections 10 and 10b): which windows matter, the range one stands for, how a
// window and its lockout are written, and the marks the Overview draws (refusal ticks, locked-out bands). Pure.

import type { LimitRefusal, LimitWindow } from '../../api/types'
import { type Axis, type CustomRange, instantRange, sessionKey, stampText, windowLength, xOf } from './model'

const MIN = 60_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A Codex window that reached this many percent counts as a limit hit even if no call was refused. */
export const NEAR_FULL = 90

/** A window worth showing: calls were refused in it, or it came close to full. */
export const qualifies = (w: LimitWindow): boolean => w.refusals > 0 || (w.maxPercent ?? 0) >= NEAR_FULL

/** The window's span: `startsAt` to `resetsAt`; without a start, the readings' first to the reset. */
export function windowSpan(w: LimitWindow): { fromMs: number; toMs: number } {
  const toMs = Date.parse(w.resetsAt)
  const start = Date.parse(w.startsAt ?? w.firstSeenAt)
  return { fromMs: Number.isNaN(start) ? toMs : start, toMs }
}

/** The windows that qualify, overlap [fromMs, toMs) and belong to `harness` (all when none), newest first. */
export function scopeWindows(
  windows: readonly LimitWindow[],
  fromMs: number,
  toMs: number,
  harness?: string,
): LimitWindow[] {
  return windows
    .filter((w) => {
      if (!qualifies(w) || (harness && w.harness !== harness)) return false
      const s = windowSpan(w)
      return s.fromMs < toMs && s.toMs > fromMs
    })
    .sort((a, b) => windowSpan(b).toMs - windowSpan(a).toMs || (a.harness < b.harness ? -1 : 1))
}

/** The scope a window stands for: its instants and its harness. */
export function windowRange(w: LimitWindow): CustomRange {
  const s = windowSpan(w)
  return instantRange(s.fromMs, s.toMs, w.harness)
}

/** How long the window locked the user out: its reset minus the first refused call. undefined when none. */
export function lockoutMs(w: LimitWindow): number | undefined {
  if (!w.firstRefusalAt) return undefined
  const d = Date.parse(w.resetsAt) - Date.parse(w.firstRefusalAt)
  return Number.isNaN(d) || d <= 0 ? undefined : d
}

/** A lockout's length, rounded as the session graph writes its breaks: `40m`, `2h`, `3d`. */
export function lockoutText(ms: number): string {
  const m = ms / MIN
  if (m < 57.5) return `${Math.max(5, Math.round(m / 5) * 5)}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

/** The stretch of the window with no calls allowed, clipped to [fromMs, toMs). null when it has none or is outside. */
export function lockoutBand(w: LimitWindow, fromMs: number, toMs: number): { fromMs: number; toMs: number } | null {
  if (lockoutMs(w) === undefined) return null
  const a = Math.max(Date.parse(w.firstRefusalAt as string), fromMs)
  const b = Math.min(Date.parse(w.resetsAt), toMs)
  return b > a ? { fromMs: a, toMs: b } : null
}

/** The limit in words: `5h`, `Weekly`; any other length as it is. */
export function limitName(w: Pick<LimitWindow, 'windowMinutes'>): string {
  if (w.windowMinutes === 300) return '5h'
  if (w.windowMinutes === 10080) return 'Weekly'
  return windowLength(w.windowMinutes * MIN)
}

const monthDay = (ms: number): string => {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** When the window ran: `Fri 14, 10:00–15:00`; across midnight both days; a week `Nov 7 → Nov 14`. */
export function windowTimes(w: LimitWindow): string {
  const { fromMs, toMs } = windowSpan(w)
  if (w.windowMinutes >= 1440) return `${monthDay(fromMs)} → ${monthDay(toMs)}`
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
