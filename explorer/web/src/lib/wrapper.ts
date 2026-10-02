// Claude Code wraps some machine-authored prompts in markup: a background task's notification,
// a message from another session or teammate. This turns such a text into what a reader wants.
// Regular expressions over the known shapes only, never an HTML parser; anything else comes back
// unchanged.

import { firstLine } from './paths'

export interface Unwrapped {
  /** Short origin of the text: "completed", "from reviewer"; empty when the shape is not recognised. */
  label: string
  /** The text without the wrapper. For an unrecognised text, the text itself. */
  body: string
  /** What a compact line shows after the label: the summary, else the first line of the body. */
  summary: string
}

const entities: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' }
const decode = (s: string) => s.replace(/&(?:quot|apos|lt|gt|amp);/g, (m) => entities[m])

/** The value of attribute `name` in the text of a tag's attributes; either quote style. */
function attr(attrs: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  return m ? decode(m[1] ?? m[2] ?? '').trim() : ''
}

/** The trimmed text of `<tag>…</tag>` inside `s`; empty when absent. */
function child(s: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(s)
  return m ? decode(m[1]).trim() : ''
}

/** A body that is a JSON object with a "result" or "message" string shows that string. */
function jsonText(body: string): string {
  const t = body.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return body
  try {
    const v: unknown = JSON.parse(t)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      for (const k of ['result', 'message']) if (typeof o[k] === 'string' && o[k]) return o[k] as string
    }
  } catch {
    // not JSON after all
  }
  return body
}

const TASK = /^\s*<task-notification(?:\s[^>]*)?>([\s\S]*?)<\/task-notification>\s*$/
const TEAMMATE = /<teammate-message((?:\s[^>]*?)?)>([\s\S]*?)<\/teammate-message>/g
const CROSS = /<cross-session-message((?:\s[^>]*?)?)>([\s\S]*?)<\/cross-session-message>/g
const PEER_PREFIX = /^\s*Another Claude session sent a message:\s*/
// the paragraph Claude Code closes a peer prompt with: instructions for the model, not content
const PEER_TRAILER = /^This came from another Claude session\b[^\n]*(?:\n(?!\n)[^\n]*)*/

export function unwrapMachineText(text: string): Unwrapped {
  const same: Unwrapped = { label: '', body: text, summary: firstLine(text) }

  const task = TASK.exec(text)
  if (task) {
    const status = child(task[1], 'status')
    const summary = child(task[1], 'summary')
    const result = child(task[1], 'result')
    if (!status && !summary) return same
    const body = [summary, result].filter(Boolean).join('\n\n')
    return { label: status || 'task notification', body, summary: summary || firstLine(body) }
  }

  // Peer messages: the optional prefix line, one or more wrapped messages, the optional closing
  // paragraph, and nothing else.
  const rest = text.replace(PEER_PREFIX, '')
  for (const [re, fromAttr] of [
    [TEAMMATE, 'teammate_id'],
    [CROSS, 'from'],
  ] as const) {
    re.lastIndex = 0
    const found = [...rest.matchAll(re)]
    if (found.length === 0) continue
    if (rest.replace(re, '').trim().replace(PEER_TRAILER, '').trim() !== '') return same
    const bodies = found.map((m) => jsonText(decode(m[2]).trim()))
    const from = attr(found[0][1], fromAttr)
    const summary = attr(found[0][1], 'summary') || firstLine(bodies[0])
    return { label: from ? `from ${from}` : 'peer message', body: bodies.join('\n\n'), summary }
  }
  return same
}
