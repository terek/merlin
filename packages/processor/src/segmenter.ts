/**
 * Segments lean sessions by calendar day boundaries.
 *
 * Each segment groups consecutive turns from the same date.
 * Topic and summary are generated via truncation for now.
 *
 * TODO: Semantic segmentation — detect topic shifts within a day
 *       and split accordingly (e.g. interleaved tasks A-B-A-B).
 * TODO: LLM-powered topic labels and summaries via @merlin/llm.
 */

import type { LeanTurn, TokenUsage } from './schema.ts'
import type { Segment } from './segment-schema.ts'

/** Maximum length for truncated topic. */
const TOPIC_MAX_LENGTH = 60

/** Maximum length for truncated summary. */
const SUMMARY_MAX_LENGTH = 300

/**
 * Segment lean turns by calendar day.
 * Returns one Segment per unique date, in chronological order.
 */
export function segmentByDay(turns: LeanTurn[]): Segment[] {
  if (turns.length === 0) return []

  const groups = new Map<string, { turns: LeanTurn[]; startIndex: number }>()
  const dateOrder: string[] = []

  for (const turn of turns) {
    const date = extractDate(turn.userTimestamp)
    if (!groups.has(date)) {
      groups.set(date, { turns: [], startIndex: turn.index })
      dateOrder.push(date)
    }
    groups.get(date)!.turns.push(turn)
  }

  const segments: Segment[] = []
  let segIndex = 0

  for (const date of dateOrder) {
    const { turns: dayTurns, startIndex } = groups.get(date)!

    const userPrompts = dayTurns.map((t) => t.userText)
    const topic = buildTopic(userPrompts)
    const summary = buildSummary(userPrompts)
    const usage = aggregateSegmentUsage(dayTurns)

    const firstTurn = dayTurns[0]!
    const lastTurn = dayTurns[dayTurns.length - 1]!

    segments.push({
      index: segIndex++,
      date,
      topic,
      summary,
      turnRange: [startIndex, startIndex + dayTurns.length],
      userPrompts,
      timeRange: [firstTurn.userTimestamp, lastTurn.agentTimestamp],
      usage,
    })
  }

  return segments
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract YYYY-MM-DD from an ISO timestamp. Falls back to 'unknown'. */
function extractDate(timestamp: string): string {
  if (!timestamp || timestamp.length < 10) return 'unknown'
  return timestamp.slice(0, 10)
}

/**
 * Build a topic label from user prompts.
 * Currently: truncated first user prompt.
 * TODO: LLM-generated topic (3-7 words).
 */
function buildTopic(userPrompts: string[]): string {
  const first = userPrompts[0] || ''
  // Take the first line, strip leading punctuation/whitespace
  const firstLine = first.split('\n')[0]!.trim()
  if (firstLine.length <= TOPIC_MAX_LENGTH) return firstLine
  return `${firstLine.slice(0, TOPIC_MAX_LENGTH - 3)}...`
}

/**
 * Build a summary from user prompts.
 * Currently: concatenation of prompts, truncated.
 * TODO: LLM-generated summary (2-5 sentences).
 */
function buildSummary(userPrompts: string[]): string {
  const joined = userPrompts.map((p, i) => `${i + 1}. ${p.split('\n')[0]!.trim()}`).join(' ')
  if (joined.length <= SUMMARY_MAX_LENGTH) return joined
  return `${joined.slice(0, SUMMARY_MAX_LENGTH - 3)}...`
}

/** Aggregate token usage across turns in a segment. */
function aggregateSegmentUsage(turns: LeanTurn[]): TokenUsage | null {
  let inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheWriteTokens = 0
  let count = 0
  for (const t of turns) {
    if (t.usage) {
      inputTokens += t.usage.inputTokens
      outputTokens += t.usage.outputTokens
      cacheReadTokens += t.usage.cacheReadTokens
      cacheWriteTokens += t.usage.cacheWriteTokens
      count++
    }
  }
  return count > 0 ? { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } : null
}
