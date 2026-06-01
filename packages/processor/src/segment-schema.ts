/**
 * Segment data model.
 *
 * Segments group consecutive lean turns into semantically coherent chunks.
 * Currently segmented by calendar day boundaries.
 * TODO: Semantic segmentation using LLM topic detection.
 */

import { z } from 'zod'
import { TokenUsageSchema } from './schema.ts'

export const SegmentSchema = z.object({
  /** Sequential index within the session (0-based). */
  index: z.number().int().nonnegative(),

  /** Calendar date (YYYY-MM-DD) of the turns in this segment. */
  date: z.string(),

  /**
   * Short topic label (3-7 words).
   * Currently: truncated first user prompt.
   * TODO: LLM-generated topic label.
   */
  topic: z.string(),

  /**
   * Concise summary of the segment.
   * Currently: truncated concatenation of user prompts.
   * TODO: LLM-generated summary (2-5 sentences).
   */
  summary: z.string(),

  /** Lean turn index range [start, end) within the session. */
  turnRange: z.tuple([z.number(), z.number()]),

  /** User prompt texts from the turns in this segment. */
  userPrompts: z.array(z.string()),

  /** ISO 8601 time range [first turn start, last turn end]. */
  timeRange: z.tuple([z.string(), z.string()]),

  /** Aggregated token usage for this segment. Null if no usage data. */
  usage: TokenUsageSchema.nullable().optional(),
})

export type Segment = z.infer<typeof SegmentSchema>
