// Small helpers over session summaries.

import type { SessionKey, SessionSummary, State } from '../api/types'
import { firstLine, shortId } from './paths'

export const keyString = (k: SessionKey) => `${k.harness}/${k.id}`

export const sameKey = (a: SessionKey, b: SessionKey) => a.harness === b.harness && a.id === b.id

/** Title, else name, else the first line of the last prompt, else the short id. */
export function sessionTitle(s: Pick<SessionSummary, 'title' | 'name' | 'lastPrompt' | 'key'>): string {
  return s.title || s.name || (s.lastPrompt ? firstLine(s.lastPrompt.text) : '') || shortId(s.key.id)
}

/** Prompts a human typed. Falls back to `turns` for a daemon that does not send `humanTurns`. */
export function promptCount(s: Pick<SessionSummary, 'humanTurns' | 'turns'>): number {
  return s.humanTurns ?? s.turns
}

export const isRunning = (state: State) => state === 'busy' || state === 'idle'

/** A session another one continues from is dimmed in lists. */
export const isSuperseded = (s: Pick<SessionSummary, 'lineage'>) => !s.lineage.leaf
