/**
 * Parses raw Claude Code session JSONL files into an intermediate representation.
 *
 * Ported from clerk/jsonl-parser.ts with the same edge-case handling:
 * - Merges assistant content blocks split across multiple JSONL lines (same message ID)
 * - Filters system-injected XML tags (task-notification, teammate-message, etc.)
 * - Detects subagent launches via Agent tool_use blocks
 * - Extracts token usage (keeps highest output_tokens per message)
 * - Skips malformed JSON lines gracefully
 */

import type { TokenUsage } from './schema.ts'

// ---------------------------------------------------------------------------
// Parsed types (intermediate, not stored)
// ---------------------------------------------------------------------------

export interface ParsedTurn {
  index: number
  role: 'user' | 'assistant'
  text: string
  timestamp: string
  messageId?: string
  usage: TokenUsage | null
  /** How many raw assistant JSONL entries were merged into this turn. */
  rawMessageCount: number
}

export interface ParsedSession {
  sessionId: string
  title: string | null
  slug: string | null
  cwd: string | null
  ccVersion: string | null
  turns: ParsedTurn[]
  rawLineCount: number
}

// ---------------------------------------------------------------------------
// Internal accumulator for merging assistant content blocks
// ---------------------------------------------------------------------------

interface AssistantAccum {
  messageId: string
  textParts: string[]
  timestamp: string
  usage: TokenUsage | null
  /** Number of raw JSONL entries contributing to this message. */
  entryCount: number
}

// ---------------------------------------------------------------------------
// System-injected XML tags to filter from user messages
// ---------------------------------------------------------------------------

const SYSTEM_XML_TAGS = [
  'task-notification',
  'teammate-message',
  'local-command-caveat',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'system-reminder',
]
const SYSTEM_XML_RE = new RegExp(`^\\s*<(${SYSTEM_XML_TAGS.join('|')})[\\s>]`)

/** Patterns for system-generated interruption messages (not real user input). */
const INTERRUPTED_FOR_TOOL = '[Request interrupted by user for tool use]'
const INTERRUPTED_BY_USER = '[Request interrupted by user]'

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseSessionJsonl(content: string, fallbackSessionId: string): ParsedSession {
  const lines = content.split('\n').filter((l) => l.trim())
  const rawLineCount = lines.length

  let sessionId = fallbackSessionId
  let title: string | null = null
  let slug: string | null = null
  let cwd: string | null = null
  let ccVersion: string | null = null

  const turns: ParsedTurn[] = []
  const assistantAccum = new Map<string, AssistantAccum>()
  const assistantOrder: string[] = []

  for (const line of lines) {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    const type = entry.type as string | undefined
    if (!type) continue

    // Extract metadata from any entry
    if (entry.sessionId && typeof entry.sessionId === 'string') sessionId = entry.sessionId
    if (entry.cwd && typeof entry.cwd === 'string' && !cwd) cwd = entry.cwd
    if (entry.slug && typeof entry.slug === 'string' && !slug) slug = entry.slug
    if (entry.version && typeof entry.version === 'string' && !ccVersion) ccVersion = entry.version
    if (type === 'custom-title' && typeof entry.customTitle === 'string') title = entry.customTitle

    if (type === 'user') {
      // Flush pending assistant messages before each user turn
      flushAssistants(assistantAccum, assistantOrder, turns)

      const message = entry.message as { content?: unknown } | undefined
      if (!message?.content) continue

      const text = extractUserText(message.content)
      if (!text) continue

      // Filter out pure interruption noise
      if (text === INTERRUPTED_BY_USER) continue
      if (text === INTERRUPTED_FOR_TOOL) continue

      const timestamp = extractTimestamp(entry)
      turns.push({
        index: turns.length,
        role: 'user',
        text,
        timestamp,
        usage: null,
        rawMessageCount: 1,
      })
    } else if (type === 'assistant') {
      const message = entry.message as { id?: string; content?: unknown[] } | undefined
      if (!message?.id || !message?.content) continue

      const msgId = message.id
      const timestamp = extractTimestamp(entry)

      if (!assistantAccum.has(msgId)) {
        assistantAccum.set(msgId, {
          messageId: msgId,
          textParts: [],
          timestamp,
          usage: null,
          entryCount: 0,
        })
        assistantOrder.push(msgId)
      }

      const accum = assistantAccum.get(msgId)!
      accum.entryCount++
      if (timestamp > accum.timestamp) accum.timestamp = timestamp

      // Extract usage — keep the one with highest output_tokens (final response)
      const rawUsage = (message as Record<string, unknown>).usage as Record<string, unknown> | undefined
      if (rawUsage) {
        const inputTokens = (rawUsage.input_tokens as number) || 0
        const outputTokens = (rawUsage.output_tokens as number) || 0
        const cacheReadTokens = (rawUsage.cache_read_input_tokens as number) || 0
        const cacheWriteTokens = (rawUsage.cache_creation_input_tokens as number) || 0
        // Only record usage if there are actual token counts
        if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheWriteTokens > 0) {
          if (!accum.usage || outputTokens > accum.usage.outputTokens) {
            accum.usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
          }
        }
      }

      for (const block of message.content) {
        if (typeof block !== 'object' || block === null) continue
        const b = block as Record<string, unknown>

        // Text blocks
        if (b.type === 'text' && typeof b.text === 'string' && (b.text as string).trim()) {
          accum.textParts.push(b.text as string)
        }
      }
    }
  }

  // Flush remaining assistant turns
  flushAssistants(assistantAccum, assistantOrder, turns)

  return { sessionId, title, slug, cwd, ccVersion, turns, rawLineCount }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flushAssistants(accum: Map<string, AssistantAccum>, order: string[], turns: ParsedTurn[]) {
  for (const msgId of order) {
    const a = accum.get(msgId)!
    // Only create a turn if there's text content
    if (a.textParts.length > 0) {
      turns.push({
        index: turns.length,
        role: 'assistant',
        text: a.textParts.join('\n\n'),
        timestamp: a.timestamp,
        messageId: a.messageId,
        usage: a.usage,
        rawMessageCount: a.entryCount,
      })
    }
  }
  accum.clear()
  order.length = 0
}

function isSystemXml(text: string): boolean {
  return SYSTEM_XML_RE.test(text)
}

function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') {
    return isSystemXml(content) ? null : content
  }
  if (!Array.isArray(content)) return null

  const texts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string' && !isSystemXml(b.text)) {
        texts.push(b.text)
      }
    }
  }
  return texts.length > 0 ? texts.join('\n') : null
}

function extractTimestamp(entry: Record<string, unknown>): string {
  const ts = entry.timestamp
  if (typeof ts === 'string') return ts
  if (typeof ts === 'number') return new Date(ts).toISOString()
  return ''
}
