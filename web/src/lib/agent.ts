// How an agent is shown: what started it, and for a sub-agent whether it is a fork or can be sent more work.

import type { Agent } from '../api/types'

/**
 * An agent's role: its kind, except that a sub-agent that started with its parent's conversation is a
 * `fork`, and one that could be (or was) sent more work is `addressable` (a Claude Code teammate, a Codex
 * agent). Digests of schema 1 said so in `kind` ('teammate', 'fork').
 */
export type AgentRole = 'subagent' | 'addressable' | 'fork' | 'compact' | 'workflow' | 'review' | 'approval-review'

export function agentRole(a: Pick<Agent, 'kind' | 'inheritsContext' | 'addressable'>): AgentRole {
  switch (a.kind) {
    case 'fork':
      return 'fork'
    case 'teammate':
      return 'addressable'
    case 'subagent':
      return a.inheritsContext ? 'fork' : a.addressable ? 'addressable' : 'subagent'
    default:
      return a.kind
  }
}

/** The words for a role, as a reader sees them. */
export const ROLE_LABEL: Record<AgentRole, string> = {
  subagent: 'sub-agent',
  addressable: 'addressable agent',
  fork: 'fork',
  compact: 'compaction',
  workflow: 'workflow',
  review: 'review',
  'approval-review': 'approval review',
}
