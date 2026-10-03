// How a compaction's cost reads. The call that writes the summary is not in the transcript, so
// its cost is an estimate from the context size and the price table; it is never part of a
// recomputed total. A cold call read its whole context again at full price because the main
// agent had been idle longer than the cache lifetime.

import type { CompactionCall, CompactionTally } from '../api/types'
import { formatDuration, formatMoney } from './format'

/** The time a compaction waited, in the coarse form of an idle gap: "8h 43m", "6 min". */
export function idleText(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`
  return formatDuration(ms)
}

function billingText(billing: string): string {
  switch (billing) {
    case 'cache-write-1h':
      return 'one-hour cache-write'
    case 'cache-write-5m':
      return 'cache-write'
    case 'input':
      return 'plain input'
    default:
      return billing
  }
}

/** One line for a compaction's call: the estimate, and for a cold one why and what warm would have cost. */
export function callLine(call: CompactionCall): string {
  if (call.cache !== 'cold') return `call ~${formatMoney(call.usd)}, cache warm`
  return `call ~${formatMoney(call.usd)}: cold cache after ${idleText(call.idleMs)} idle, the context was read again at the ${billingText(call.billing)} price; warm it would have cost ~${formatMoney(call.warmUSD)}`
}

/** The extra a cold call cost over a warm one; 0 for a warm call. */
export const coldExtra = (call: CompactionCall) => (call.cache === 'cold' ? Math.max(0, call.usd - call.warmUSD) : 0)

/** The headline of a tally: "~$126 for 81 compactions, 34 cold". */
export function tallyLine(t: CompactionTally): string {
  const n = `${t.calls} ${t.calls === 1 ? 'compaction' : 'compactions'}`
  return t.cold > 0 ? `~${formatMoney(t.usd)} for ${n}, ${t.cold} cold` : `~${formatMoney(t.usd)} for ${n}`
}

/** What the tally would have been with a warm cache every time, when that differs. */
export function warmLine(t: CompactionTally): string {
  if (t.cold === 0) return ''
  return `with a warm cache every time: ~${formatMoney(t.warmUSD)}`
}
