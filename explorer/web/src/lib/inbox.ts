// A prompt a machine delivered (a teammate's message, a teammate going idle, a background task
// reporting) comes from the API already taken apart, as `inbox` messages. These helpers say how a
// message reads. Digests written before the API did that still carry the harness's markup in the
// text; `turnPrompt` falls back to the regular expressions of ./wrapper for those.

import type { InboxMessage, Turn } from '../api/types'
import { firstLine } from './paths'
import { type Unwrapped, unwrapMachineText } from './wrapper'

/** Short origin of a message: "from reviewer", "reviewer idle", "task completed". */
export function inboxLabel(m: InboxMessage): string {
  switch (m.kind) {
    case 'idle': {
      const who = m.from || 'teammate'
      return m.status && m.status !== 'available' ? `${who} idle (${m.status})` : `${who} idle`
    }
    case 'task':
      return `task ${m.status || 'event'}`
    case 'assignment':
      return m.from ? `task assigned by ${m.from}` : 'task assigned'
    default:
      return m.from ? `from ${m.from}` : 'message'
  }
}

/** What a compact line shows after the label: the summary, else the error, else the first line of the text. */
export function inboxSummary(m: InboxMessage): string {
  return m.summary || m.error || firstLine(m.text ?? '')
}

/** Everything a message says, for a reader: summary, error and text, without repeating itself. */
export function inboxBody(m: InboxMessage): string {
  const parts: string[] = []
  for (const s of [m.summary, m.error, m.text]) if (s?.trim() && !parts.includes(s)) parts.push(s)
  return parts.join('\n\n')
}

/**
 * A turn's prompt as a reader wants it: label, body and one-line summary. For a delivered prompt
 * the label is the first message's, with a count when there are more.
 */
export function turnPrompt(t: Pick<Turn, 'userText' | 'inbox'>): Unwrapped {
  const inbox = t.inbox ?? []
  if (inbox.length === 0) return unwrapMachineText(t.userText ?? '')
  const more = inbox.length > 1 ? ` +${inbox.length - 1}` : ''
  const bodies = inbox.map((m) => (inbox.length > 1 ? `${inboxLabel(m)}\n${inboxBody(m)}`.trim() : inboxBody(m)))
  if (t.userText?.trim()) bodies.push(t.userText)
  return {
    label: `${inboxLabel(inbox[0])}${more}`,
    body: bodies.filter(Boolean).join('\n\n'),
    summary: inboxSummary(inbox[0]),
  }
}
