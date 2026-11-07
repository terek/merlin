// Pure helpers of the bead page: the timeline grouped by session, and how a step is worded.

import type { BeadDetail, BeadSession, BeadStep } from '../../api/types'

/** The past tense of a bd operation, as the timeline words it. */
const VERB: Record<string, string> = {
  create: 'created',
  claim: 'claimed',
  update: 'updated',
  close: 'closed',
  reopen: 'reopened',
  comment: 'commented',
  dep: 'dependency',
  show: 'viewed',
}

export function opVerb(op: string): string {
  return VERB[op] ?? op
}

export interface StepGroup {
  harness: string
  sessionId: string
  /** The session's row in `sessions`, when the API lists it (viewing a bead alone does not). */
  session?: BeadSession
  steps: BeadStep[]
}

/** Steps grouped by session; groups in the time order of their first step, steps in time order. */
export function groupSteps(timeline: readonly BeadStep[] = [], sessions: readonly BeadSession[] = []): StepGroup[] {
  const byKey = new Map<string, StepGroup>()
  const sorted = [...timeline].sort((a, b) => a.at.localeCompare(b.at))
  for (const step of sorted) {
    const key = `${step.harness}/${step.sessionId}`
    let g = byKey.get(key)
    if (!g) {
      const session = sessions.find((s) => s.harness === step.harness && s.id === step.sessionId)
      g = { harness: step.harness, sessionId: step.sessionId, session, steps: [] }
      byKey.set(key, g)
    }
    g.steps.push(step)
  }
  return [...byKey.values()]
}

/** The family root first, the parent last (the API gives the parent first). */
export function chain(d: Pick<BeadDetail, 'ancestors'>): NonNullable<BeadDetail['ancestors']> {
  return [...(d.ancestors ?? [])].reverse()
}

/** "worker" for an agent's step, "main" for the main agent's. */
export function actor(step: Pick<BeadStep, 'agentId'>): string {
  return step.agentId ? 'worker' : 'main'
}
