// How a compaction's cost reads. Claude Code does not record the call that writes the summary,
// so its cost is an estimate from the context size and the price table, never part of a
// recomputed total, and cold means the agent had been idle longer than the cache lifetime.
// Codex records the call (the compaction has a `messageId`): its cost is that message's, in the
// totals, and cold means most of the context was not read from the cache.

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

/** "~" before an estimate, nothing before a recorded figure. */
export const approx = (recorded: boolean) => (recorded ? '' : '~')

/**
 * One line for a compaction's call: its cost, and for a cold one why and what warm would have
 * cost. `recorded` when the harness recorded the call rather than it being estimated.
 */
export function callLine(call: CompactionCall, recorded = false): string {
  const a = approx(recorded)
  if (call.cache !== 'cold') return `call ${a}${formatMoney(call.usd)}, cache warm`
  const why = recorded ? `cold cache (${idleText(call.idleMs)} idle)` : `cold cache after ${idleText(call.idleMs)} idle`
  return `call ${a}${formatMoney(call.usd)}: ${why}, the context was read again at the ${billingText(call.billing)} price; warm it would have cost ${a}${formatMoney(call.warmUSD)}`
}

/** The extra a cold call cost over a warm one; 0 for a warm call. */
export const coldExtra = (call: CompactionCall) => (call.cache === 'cold' ? Math.max(0, call.usd - call.warmUSD) : 0)

/** A tally that may count recorded calls: then `recorded` of its `calls` are not estimates. */
type Tally = CompactionTally & { recorded?: number }

/** "~" unless every call of the tally was recorded. */
const tallyApprox = (t: Tally) => approx(t.calls > 0 && t.recorded === t.calls)

/** The headline of a tally: "~$126 for 81 compactions, 34 cold". */
export function tallyLine(t: Tally): string {
  const n = `${t.calls} ${t.calls === 1 ? 'compaction' : 'compactions'}`
  const usd = `${tallyApprox(t)}${formatMoney(t.usd)}`
  return t.cold > 0 ? `${usd} for ${n}, ${t.cold} cold` : `${usd} for ${n}`
}

/** What the tally would have been with a warm cache every time, when that differs. */
export function warmLine(t: Tally): string {
  if (t.cold === 0) return ''
  return `with a warm cache every time: ${tallyApprox(t)}${formatMoney(t.warmUSD)}`
}
