// What the box under the focus's graph says, as pure functions: who a prompt came from, what a turn or a piece
// of agent work did in a line, and the exchange (request, response) between the main agent and an agent.
// No dollars, no tokens: the graph and its hover carry those.

import type { Agent, InboxKind, InboxMessage, QueuedPrompt, Turn, TurnOrigin } from '../../api/types'
import { plural } from '../../lib/format'
import { inboxBody, inboxLabel } from '../../lib/inbox'
import { firstLine } from '../../lib/paths'
import { unwrapMachineText } from '../../lib/wrapper'

/** Where a prompt came from, in words. `typed` is the one a person wrote. */
export interface Source {
  typed: boolean
  label: string
}

/** What a delivered prompt is, from the messages it carries; absent when there are none. */
function inboxSource(inbox: readonly InboxMessage[]): string | undefined {
  const kinds = new Set<InboxKind>(inbox.map((m) => m.kind ?? 'message'))
  if (kinds.size !== 1) return undefined
  switch ([...kinds][0]) {
    case 'task':
      return 'A background task reported'
    case 'idle':
      return 'A teammate went idle'
    case 'assignment':
      return 'A task was assigned'
    default:
      return undefined
  }
}

/** Who started a turn: you, a teammate, a background task, a wake-up. */
export function promptSource(origin: TurnOrigin, inbox: readonly InboxMessage[] = []): Source {
  const delivered = inboxSource(inbox)
  switch (origin) {
    case 'human':
      return { typed: true, label: 'You typed' }
    case 'command':
      return { typed: true, label: 'You ran a command' }
    case 'task-notification':
      return { typed: false, label: delivered ?? 'A background task reported' }
    case 'peer':
      return { typed: false, label: delivered ?? 'A teammate wrote' }
    case 'scheduled':
      return { typed: false, label: 'A scheduled wake-up' }
    case 'sdk':
      return { typed: false, label: 'A program sent' }
    case 'continuation':
      return { typed: false, label: 'Continued from an earlier session' }
    default:
      return { typed: false, label: delivered ?? 'The task it was started with' }
  }
}

/** The kind of a delivered message, as a reader names it. */
export function inboxKindName(m: InboxMessage): string {
  switch (m.kind) {
    case 'task':
      return 'task result'
    case 'idle':
      return 'idle'
    case 'assignment':
      return 'assignment'
    default:
      return 'message'
  }
}

/** The tools of a turn or a piece of work in a line: "18 tool calls (Edit 6, Bash 5, Read 4, …)". Empty without calls. */
export function toolsLine(toolCalls: number, byName?: Record<string, number>, top = 3): string {
  if (toolCalls <= 0) return ''
  const names = Object.entries(byName ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const head = names
    .slice(0, top)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')
  const more = names.length > top ? ', …' : ''
  return `${plural(toolCalls, 'tool call')}${head ? ` (${head}${more})` : ''}`
}

/** "3 files" for the files a turn touched; empty for none. */
export function filesLine(files?: readonly string[]): string {
  return files && files.length > 0 ? plural(files.length, 'file') : ''
}

/** "reached the main agent in turn 15" / "in turns 15 and 18"; empty when no report is known. */
export function reachedLine(reports: readonly number[]): string {
  if (reports.length === 0) return ''
  const list =
    reports.length === 1
      ? `turn ${reports[0]}`
      : `turns ${reports.slice(0, -1).join(', ')} and ${reports[reports.length - 1]}`
  return `reached the main agent in ${list}`
}

/** One request or response of an exchange. */
export interface Exchange {
  /** The index of the agent's turn (`Agent.turns`). */
  index: number
  /** Who sent the request: "main agent", a teammate's name, "you". */
  from: string
  /** The request's time, and the response's. */
  requestAt?: string
  responseAt?: string
  /** The request, whole; empty when there is none to show. */
  request: string
  /** The harness keeps the request only encrypted (Codex). */
  encrypted: boolean
  /** The messages the request is made of, when a machine delivered them. */
  inbox: InboxMessage[]
  queued: QueuedPrompt[]
  response: string
  interrupted: boolean
  /** The main agent's turn it belongs to. */
  rootTurn?: number
  /** The one the pinned piece of work is. */
  open: boolean
}

/** Who sent the message that set an agent working again. */
function senderOf(origin: TurnOrigin, inbox: readonly InboxMessage[]): string {
  const named = inbox.find((m) => m.from)?.from
  if (named) return named
  switch (origin) {
    case 'human':
    case 'command':
      return 'you'
    case 'task-notification':
      return 'a background task'
    case 'scheduled':
      return 'a wake-up'
    default:
      return 'the main agent'
  }
}

/** The index of the agent turn the piece of work starting at `startMs` is: the one that starts then, else by ordinal. */
export function openTurn(agent: Agent, startMs: number, ordinal: number): number {
  const turns = agent.turns ?? []
  let best = -1
  let gap = Number.POSITIVE_INFINITY
  turns.forEach((t, i) => {
    const ms = t.startedAt ? Date.parse(t.startedAt) : Number.NaN
    const d = Math.abs(ms - startMs)
    if (d < gap) {
      gap = d
      best = i
    }
  })
  if (best >= 0 && gap < 2000) return best
  return Math.max(0, Math.min(turns.length - 1, ordinal - 1))
}

/**
 * The exchange between the main agent and an agent, oldest first: for each of the agent's turns the request
 * and the response. `open` marks the one pinned. An agent whose digest has no turns is one request and one
 * response, from its prompt and its final text.
 */
export function agentThread(agent: Agent, openIndex: number): Exchange[] {
  const turns = agent.turns ?? []
  if (turns.length === 0) {
    return [
      {
        index: 0,
        from: 'the main agent',
        requestAt: agent.startedAt,
        responseAt: agent.endedAt,
        request: agent.prompt ?? '',
        encrypted: !!agent.promptEncrypted,
        inbox: [],
        queued: [],
        response: agent.finalText ?? '',
        interrupted: false,
        open: true,
      },
    ]
  }
  return turns.map((t, i) => {
    const inbox = t.inbox ?? []
    const first = i === 0 && t.origin === 'spawn'
    const typed = t.prompt ? unwrapMachineText(t.prompt).body : ''
    return {
      index: i,
      from: first ? 'the main agent' : senderOf(t.origin, inbox),
      requestAt: t.startedAt,
      responseAt: t.endedAt,
      request: i === 0 ? (t.prompt ?? agent.prompt ?? '') : typed,
      encrypted: !!(t.promptEncrypted || (i === 0 && agent.promptEncrypted && !t.prompt)),
      inbox,
      queued: t.queued ?? [],
      response: t.finalText ?? '',
      interrupted: !!t.interrupted,
      rootTurn: t.rootTurn,
      open: i === openIndex,
    }
  })
}

/** What a folded exchange shows: its sender and the first line of its request. */
export function exchangeGist(x: Exchange): string {
  if (x.encrypted && !x.request) return 'encrypted'
  const first = x.request.trim() ? x.request : x.inbox.map(inboxBody).join('\n')
  return firstLine(unwrapMachineText(first).body)
}

/** The text of a request when the exchange's prompt is a machine's: the inbox messages (shown on their own). */
export function exchangeLabel(x: Exchange): string {
  return x.inbox.length > 0 ? inboxLabel(x.inbox[0]) : ''
}

/** A turn's marks: interrupted, abandoned, a slash command. */
export function turnMarks(t: Pick<Turn, 'interrupted' | 'abandoned' | 'command'>): string[] {
  const out: string[] = []
  if (t.interrupted) out.push('interrupted')
  if (t.abandoned) out.push('abandoned')
  if (t.command) out.push(t.command.startsWith('/') ? t.command : `/${t.command}`)
  return out
}

/** What stands where a turn's reply would be. */
export function noReply(t: Pick<Turn, 'interrupted' | 'abandoned'>): string {
  if (t.interrupted) return 'No reply (interrupted)'
  if (t.abandoned) return 'No reply (abandoned)'
  return 'No reply'
}
