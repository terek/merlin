// Cost logic behind <Money> and the cost panels.

import type { CostBacking, CostFlag, SessionCost, SessionDigest } from '../api/types'
import { formatCount } from './format'

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
      return 'Recomputed from token counts; Claude Code reported nothing for this session.'
    default:
      return ''
  }
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
  return [
    { key: 'reported', label: 'Reported, matched to messages', usd: cost.coveredUSD },
    { key: 'overhead', label: 'Reported, not explained by messages (overhead)', usd: cost.overheadUSD },
    { key: 'attributed', label: 'Recomputed from tokens, outside reported windows', usd: cost.uncoveredUSD },
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
  return parts.length ? parts.join(', ') : 'no sessions'
}

/** The weakest flag of several (estimated < partial < exact); undefined for none. */
export function weakestFlag(flags: (CostFlag | undefined)[]): CostFlag | undefined {
  const rank: Record<CostFlag, number> = { estimated: 0, partial: 1, exact: 2 }
  let best: CostFlag | undefined
  for (const f of flags) if (f && (!best || rank[f] < rank[best])) best = f
  return best
}
