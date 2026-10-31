// Cost logic behind <Money> and the cost panels.

import type { CostBacking, CostFlag, SessionCost, SessionDigest } from '../api/types'
import { formatCount, formatMoney, plural } from './format'

/** The marker written with a figure: prefix "~" (estimated), suffix "+est" (partial), none (exact). */
export function flagMarkers(flag: CostFlag | undefined): { prefix: string; suffix: string } {
  if (flag === 'estimated') return { prefix: '~', suffix: '' }
  if (flag === 'partial') return { prefix: '', suffix: '+est' }
  return { prefix: '', suffix: '' }
}

/** The sentence that explains a flag (the tooltip of <Money>). */
export function flagExplanation(flag: CostFlag | undefined): string {
  switch (flag) {
    case 'exact':
      return 'Reported by Claude Code for the whole session.'
    case 'partial':
      return 'Partly reported; the rest recomputed from token counts.'
    case 'estimated':
      return 'Recomputed from token counts; no figure was reported for this session.'
    default:
      return ''
  }
}

/**
 * Why a figure is only a lower bound (the `lowerBound` of <Money>): messages written down before
 * they finished (partial output tokens; mostly sub-agent messages) and messages on a model without
 * a price (counted as $0). '' when there are none.
 */
export function lowerBoundNote(truncated = 0, unpriced = 0): string {
  const parts: string[] = []
  if (truncated > 0) parts.push(`${plural(truncated, 'message')} cut short in the transcript (partial output tokens)`)
  if (unpriced > 0) parts.push(`${plural(unpriced, 'message')} on a model without a price (counted as $0)`)
  return parts.length ? `A lower bound: ${parts.join(', ')}.` : ''
}

/**
 * lowerBoundNote for the best cost of one or several sessions: only those flagged `lowerBound` count,
 * and only for their unpriced messages (a truncated message's missing output is estimated in it).
 */
export function sessionsLowerBound(costs: readonly Pick<SessionCost, 'lowerBound' | 'unpricedMessages'>[]): string {
  let unpriced = 0
  for (const c of costs) if (c.lowerBound) unpriced += c.unpricedMessages ?? 0
  return lowerBoundNote(0, unpriced)
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
 * together are what Claude Code reported), and spend recomputed from token counts outside the
 * reported windows. They add up to `bestUSD`.
 */
export function sessionCostSegments(cost: SessionCost): CostSegment[] {
  // the estimates and Claude Code's other rates explain part of the overhead
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
export function agentCostSplit(digest: Pick<SessionDigest, 'cost' | 'agents'>): { main: number; agents: number } {
  let agents = 0
  for (const a of digest.agents ?? []) agents += a.cost.usd
  return { main: Math.max(0, digest.cost.usd - agents), agents }
}

/** "69 sessions exact, 5 partial, 149 estimated, 3,132 scripted runs"; zero parts are left out. */
export function backingSentence(b: CostBacking): string {
  const parts: string[] = []
  const lead = (n: number, word: string) =>
    parts.length === 0 ? `${formatCount(n)} session${n === 1 ? '' : 's'} ${word}` : `${formatCount(n)} ${word}`
  if (b.exact) parts.push(lead(b.exact, 'exact'))
  if (b.partial) parts.push(lead(b.partial, 'partial'))
  if (b.estimated) parts.push(lead(b.estimated, 'estimated'))
  if (b.scriptedRuns) parts.push(`${formatCount(b.scriptedRuns)} scripted run${b.scriptedRuns === 1 ? '' : 's'}`)
  if (!parts.length) return 'no sessions'
  const out = parts.join(', ')
  return b.lowerBound ? `${out}; ${formatCount(b.lowerBound)} only a lower bound` : out
}

/** The `lowerBound` of a total over a cost table's sessions; '' when none of them is a lower bound. */
export function backingLowerBound(b: CostBacking): string {
  if (!b.lowerBound) return ''
  return `A lower bound: ${plural(b.lowerBound, 'session')} include messages on a model without a price (counted as $0).`
}

/** The weakest flag of several (estimated < partial < exact); undefined for none. */
export function weakestFlag(flags: (CostFlag | undefined)[]): CostFlag | undefined {
  const rank: Record<CostFlag, number> = { estimated: 0, partial: 1, exact: 2 }
  let best: CostFlag | undefined
  for (const f of flags) if (f && (!best || rank[f] < rank[best])) best = f
  return best
}
