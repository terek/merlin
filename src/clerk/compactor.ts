/**
 * Compaction: turn a closed study session into a MemoryEntry.
 *
 * Short conversations (< VERBATIM_THRESHOLD substantive chars) are kept
 * verbatim. Longer ones are summarised by the processor LLM into 2–5
 * sentences plus topic tags. Only user+assistant text counts toward the
 * threshold; tool calls and tool results don't.
 */

import type { LLMProvider } from '@merlin/llm'
import { z } from 'zod'
import {
  type ActiveSession,
  type MemoryEntry,
  renderTranscript,
  substantiveChars,
  VERBATIM_THRESHOLD,
} from './memory-store.ts'

const SummarySchema = z.object({
  summary: z.string(),
  topics: z.array(z.string()),
})

const SUMMARIZER_SYSTEM = `You compress a finished Clerk study conversation into a tight memory entry that future sessions will recall.

Output:
- "summary": 2–5 sentences. What did the user explore, what did they learn, what was concluded? Use past tense. Concrete: name files, sessions, tasks, concepts that came up. No filler.
- "topics": 3–6 short kebab-case tags pinpointing what the chat was about (e.g. "segmenter-design", "embedding-store").

Do NOT advise. Do NOT speculate. Just record what happened.`

export async function compact(
  session: ActiveSession,
  /** Cheap, high-volume model — typically the processor LLM. May be undefined; we then fall back to verbatim. */
  summarizer: LLMProvider | undefined,
): Promise<MemoryEntry | null> {
  const turnCount = countTurns(session)
  if (turnCount === 0) return null

  const chars = substantiveChars(session.messages)
  if (chars === 0) return null

  if (chars < VERBATIM_THRESHOLD || !summarizer) {
    return {
      kind: 'verbatim',
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.updatedAt,
      turnCount,
      text: renderTranscript(session.messages),
    }
  }

  try {
    const transcript = renderTranscript(session.messages)
    const result = await summarizer.parse({
      system: SUMMARIZER_SYSTEM,
      messages: [{ role: 'user', text: transcript }],
      schema: SummarySchema,
      schemaName: 'study_memory',
    })
    return {
      kind: 'summary',
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.updatedAt,
      turnCount,
      summary: result.summary,
      topics: result.topics,
    }
  } catch {
    // Summary failed — fall back to verbatim transcript so we never lose memory entirely.
    return {
      kind: 'verbatim',
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.updatedAt,
      turnCount,
      text: renderTranscript(session.messages),
    }
  }
}

/** Render past memory entries into the system-prompt preamble. Newest first. */
export function renderMemoryPreamble(entries: MemoryEntry[]): string {
  if (entries.length === 0) return ''
  const blocks: string[] = []
  blocks.push(`Recent prior conversations (newest first; faded recall — no transcripts):`)
  for (const e of entries) {
    const when = humanRange(e.startedAt, e.endedAt)
    if (e.kind === 'summary') {
      blocks.push(`• [${when}] ${e.summary}\n  topics: ${e.topics.join(', ')}`)
    } else {
      blocks.push(`• [${when}] short chat:\n${indent(e.text)}`)
    }
  }
  return blocks.join('\n\n')
}

function indent(s: string, by = '  '): string {
  return s
    .split('\n')
    .map((l) => `${by}${l}`)
    .join('\n')
}

function humanRange(startIso: string, endIso: string): string {
  const date = startIso.slice(0, 10)
  const start = startIso.slice(11, 16)
  const end = endIso.slice(11, 16)
  return `${date} ${start}→${end}`
}

function countTurns(session: ActiveSession): number {
  let n = 0
  for (const m of session.messages) if (m.role === 'user') n++
  return n
}
