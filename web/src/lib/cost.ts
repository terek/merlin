// Cost logic behind <Money> and the cost panels.

import type { CostBacking, CostFlag, SessionCost, SessionDigest } from '../api/types'
import { formatCount, formatMoney, plural } from './format'

/** The marker written with a figure: prefix "~" (estimated), suffix "+est" (partial), none (exact). */
export function flagMarkers(flag: CostFlag | undefined): { prefix: string; suffix: string } {
  if (flag === 'estimated' || flag === 'recorded') return { prefix: '~', suffix: '' }
  if (flag === 'partial') return { prefix: '', suffix: '+est' }
  return { prefix: '', suffix: '' }
}

/** The sentence that explains a flag (the tooltip of <Money>). */
export function flagExplanation(flag: CostFlag | undefined): string {
  switch (flag) {
    case 'exact':
      return 'Reported by the harness for the whole session.'
    case 'partial':
      return 'Partly reported; the rest recomputed from token counts.'
    case 'recorded':
      return 'Recorded per call by the harness (its own catalog estimate, not an invoice); no total was reported for the session.'
    case 'estimated':
      return 'Recomputed from token counts; no figure was reported for this session.'
    case 'unknown':
      return 'Unknown: the session did the work, but the harness recorded no billed message and no cost figure. Not counted in any total.'
    default:
      return ''
  }
}

/**
 * Why a figure is only a lower bound (the `lowerBound` of <Money>): messages written down before
 * they finished (partial output tokens; mostly sub-agent messages) and messages on a model without
 * a price (counted as $0), and agent runs whose harness kept no record of their spend (unknown, not
 * $0). '' when there are none.
 */
export function lowerBoundNote(truncated = 0, unpriced = 0, unrecorded = 0): string {
  const parts: string[] = []
  if (truncated > 0) parts.push(`${plural(truncated, 'message')} cut short in the transcript (partial output tokens)`)
  if (unpriced > 0) parts.push(`${plural(unpriced, 'message')} on a model without a price (counted as $0)`)
  if (unrecorded > 0)
    parts.push(`${plural(unrecorded, 'agent run')} left no record of ${unrecorded === 1 ? 'its' : 'their'} spend`)
  return parts.length ? `A lower bound: ${parts.join(', ')}.` : ''
}

/**
 * lowerBoundNote for the best cost of one or several sessions: only those flagged `lowerBound` count,
 * and only for their unpriced messages (a truncated message's missing output is estimated in it).
 */
export function sessionsLowerBound(
  costs: readonly Pick<SessionCost, 'lowerBound' | 'unpricedMessages' | 'unrecordedAgents'>[],
): string {
  let unpriced = 0
  let unrecorded = 0
  for (const c of costs) {
    if (c.lowerBound) unpriced += c.unpricedMessages ?? 0
    unrecorded += c.unrecordedAgents ?? 0
  }
  return lowerBoundNote(0, unpriced, unrecorded)
}

/** An estimated amount: `~$1.20`, but `<$0.01` alone (the `<` says enough). */
export function approxMoney(usd: number): string {
  const s = formatMoney(usd)
  return s.startsWith('<') ? s : `~${s}`
}

/** The `estimate` of <Money> for a figure that includes the estimated output of truncated messages; '' for none. */
export function estimateNote(estimatedUSD: number, truncated: number): string {
  if (estimatedUSD < 0.00005) return ''
  return `Includes ${approxMoney(estimatedUSD)} estimated for the output of ${plural(truncated, 'message')} cut short in the transcript.`
}

export interface CostSegment {
  key: 'reported' | 'attributed' | 'overhead'
  label: string
  usd: number
}

/**
 * The three parts of a session's best cost for a stacked bar, in order: reported spend that a
 * transcript message explains (covered), overhead (reported, but no message explains it; the two
 * together are what the harness reported), and spend recomputed from token counts outside the
 * reported windows. They add up to `bestUSD`.
 */
export function sessionCostSegments(cost: SessionCost): CostSegment[] {
  // the estimates and the harness's other rates explain part of the overhead
  const explained = (cost.estimatedCoveredUSD ?? 0) + (cost.rateDiffUSD ?? 0)
  return [
    { key: 'reported', label: 'Reported, matched to messages', usd: cost.coveredUSD + explained },
    { key: 'overhead', label: 'Reported, not explained by messages (overhead)', usd: cost.overheadUSD - explained },
    {
      key: 'attributed',
      label: 'Recomputed from tokens, outside reported windows',
      usd: cost.uncoveredUSD + (cost.estimatedUncoveredUSD ?? 0),
    },
  ]
}

/**
 * Main agent versus sub-agents. Sub-agent spend is the sum of the agents' own attributed cost
 * (`digest.agents[].cost.usd`, compaction calls included); the main agent is the rest of
 * `digest.cost.usd`. Both are attributed figures, from token counts.
 */
export function agentCostSplit(digest: Pick<SessionDigest, 'cost' | 'agents'>): {
  main: number
  agents: number
  /** Agent runs with no record of their spend: counted as $0 in `agents`, which is then "at least". */
  unrecorded: number
} {
  let agents = 0
  let unrecorded = 0
  for (const a of digest.agents ?? []) {
    agents += a.cost.usd
    unrecorded += a.cost.unrecordedAgents ?? 0
  }
  return { main: Math.max(0, digest.cost.usd - agents), agents, unrecorded }
}

/** "69 sessions exact, 5 partial, 149 estimated, 3,132 scripted runs"; zero parts are left out. */
export function backingSentence(b: CostBacking): string {
  const parts: string[] = []
  const lead = (n: number, word: string) =>
    parts.length === 0 ? `${formatCount(n)} session${n === 1 ? '' : 's'} ${word}` : `${formatCount(n)} ${word}`
  if (b.exact) parts.push(lead(b.exact, 'exact'))
  if (b.partial) parts.push(lead(b.partial, 'partial'))
  if (b.estimated) parts.push(lead(b.estimated, 'estimated'))
  if (b.recorded) parts.push(lead(b.recorded, 'recorded'))
  if (b.unknown) parts.push(lead(b.unknown, 'unknown'))
  if (b.scriptedRuns) parts.push(`${formatCount(b.scriptedRuns)} scripted run${b.scriptedRuns === 1 ? '' : 's'}`)
  if (!parts.length) return 'no sessions'
  const out = parts.join(', ')
  return b.lowerBound ? `${out}; ${formatCount(b.lowerBound)} only a lower bound` : out
}

/** The `lowerBound` of a total over a cost table's sessions; '' when none of them is a lower bound. */
export function backingLowerBound(b: CostBacking): string {
  const unrecorded = b.unrecordedAgents ?? 0
  if (!b.lowerBound) return lowerBoundNote(0, 0, unrecorded)
  const priced = `${plural(b.lowerBound, 'session')} include messages on a model without a price (counted as $0)`
  if (!unrecorded) return `A lower bound: ${priced}.`
  return `A lower bound: ${priced}; ${plural(unrecorded, 'agent run')} left no record of ${unrecorded === 1 ? 'its' : 'their'} spend.`
}

/** The flag a rail row's <Money> takes: `unknown` only when every session counted is unknown and nothing else is billed. */
export function groupFlag(sessions: number, unknownSessions = 0, usd = 0): CostFlag | undefined {
  return sessions > 0 && unknownSessions >= sessions && usd === 0 ? 'unknown' : undefined
}

/** Appended to the cost sentences when sessions of the period have an unknown cost; '' for none. */
export function unknownNote(n: number): string {
  if (n <= 0) return ''
  return `${plural(n, 'session')} did work but recorded no cost: ${n === 1 ? 'it is' : 'they are'} in no total, so the real figure may be higher.`
}

/**
 * Why a spend graph's dollars are what they are: recomputed from tokens, recorded per call by the
 * harness, or not known at all. `recorded` counts the sessions whose figures the harness recorded.
 */
export function spendBasis(sessions: number, unknown: number, recorded = 0): string {
  if (sessions > 0 && unknown >= sessions) {
    return sessions === 1
      ? 'This session recorded work but no billed message and no cost figure, so its dollars are not known'
      : 'These sessions recorded work but no billed message and no cost figure, so their dollars are not known'
  }
  const base =
    recorded > 0 && recorded + unknown >= sessions
      ? 'Dollars are the per-call figures the harness recorded (its own estimate)'
      : recorded > 0
        ? `Dollars are recomputed from token counts, except ${plural(recorded, 'session')} whose per-call figures the harness recorded`
        : 'Dollars are recomputed from token counts'
  if (unknown > 0) {
    return `${base} (${plural(unknown, 'session')} of the tree recorded no cost and counts as unknown, not $0)`
  }
  return base
}

/** The weakest flag of several (unknown < estimated < partial < exact); undefined for none. */
export function weakestFlag(flags: (CostFlag | undefined)[]): CostFlag | undefined {
  const rank: Record<CostFlag, number> = { unknown: -1, estimated: 0, recorded: 1, partial: 2, exact: 3 }
  let best: CostFlag | undefined
  for (const f of flags) if (f && (!best || rank[f] < rank[best])) best = f
  return best
}
