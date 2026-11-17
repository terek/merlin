// The Limits section of the Cost page (docs/ui.md section 10): what a limit window is worth, from the windows the
// harnesses recorded. Pure; the windows themselves are chosen by `scopeWindows` (features/overview/windows.ts).

import type { LimitSession, LimitWindow } from '../../api/types'
import { formatMoney } from '../../lib/format'
import { shortId } from '../../lib/paths'
import { limitName } from '../overview/windows'

/** The median of a list (the mean of the middle two for an even count). NaN for none. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** A dollar figure in a sentence: whole dollars from $10, else as everywhere ($0.11). */
export const sentenceMoney = (usd: number): string =>
  usd >= 10 ? `$${Math.round(usd).toLocaleString('en-US')}` : formatMoney(usd)

const HARNESS_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }
const harnessName = (h: string): string => HARNESS_NAME[h] ?? h

/** How a top session is named: its own name, else its title, else the first 8 characters of its id. */
export const sessionLabel = (s: Pick<LimitSession, 'id' | 'name' | 'title'>): string =>
  s.name || s.title || shortId(s.id)

const count = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/**
 * What a window is worth, one sentence per harness and limit that has data. Codex (percentages recorded): "A Codex 5h
 * window is worth about $11 at API prices (1% ≈ $0.11, median of 6 windows)." from the windows that rose at least 10
 * points (`usdPerPercent`). Claude Code (no percentages): "Claude Code ran out after at least $47 (median of 4 hits;
 * spend this machine recorded)." from the hit windows' `seenUSD`. A group with no data has no sentence. The figures
 * are medians, never sums: windows can overlap and count the same message.
 */
export function worthSentences(windows: readonly LimitWindow[]): string[] {
  const groups = new Map<string, LimitWindow[]>()
  for (const w of windows) {
    if (!w.startsAt || !w.windowMinutes || w.kind === 'spend_cap' || w.limit === 'overage') continue
    const k = JSON.stringify([w.harness, w.account, w.limit, w.windowMinutes, w.plan, w.planPeriod])
    const g = groups.get(k)
    if (g) g.push(w)
    else groups.set(k, [w])
  }
  const out: { key: string; text: string }[] = []
  for (const [key, ws] of groups) {
    const first = ws[0]
    const name = `${harnessName(first.harness)}${first.accountLabel ? ` ${first.accountLabel}` : ''}${first.plan ? ` (${first.plan})` : ''}${first.planPeriod ? `, period from ${new Date(first.planPeriod).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}`
    const limit = limitName(first)
    const per = ws.flatMap((w) => (w.usdPerPercent && w.usdPerPercent > 0 ? [w.usdPerPercent] : []))
    if (first.harness === 'claude') {
      const seen = ws.flatMap((w) => (w.refusals > 0 && (w.seenUSD ?? 0) > 0 ? [w.seenUSD as number] : []))
      if (seen.length === 0) continue
      const of = first.windowMinutes === 300 ? '' : ` of its ${limit.toLowerCase()} limit`
      out.push({
        key,
        text: `${name} ran out${of} after at least ${sentenceMoney(median(seen))} (median of ${count(seen.length, 'hit', 'hits')}; spend this machine recorded).`,
      })
    } else if (per.length > 0) {
      const m = median(per)
      out.push({
        key,
        text: `A ${name} ${limit.toLowerCase()} window is worth about ${sentenceMoney(m * 100)} at API prices (1% ≈ ${formatMoney(m)}, ${per.length === 1 ? 'from the 1 window in this range' : `median of the ${per.length} windows in this range`}).`,
      })
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key)).map((s) => s.text)
}
