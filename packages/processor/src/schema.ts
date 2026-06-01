/**
 * Central data model for the Processor, defined as Zod schemas.
 *
 * Lean sessions are the first preprocessed layer: raw session JSONL files
 * stripped down to essential turns with computed metadata. They are the
 * foundation for all downstream processing (segmentation, labeling, clustering).
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
})
export type TokenUsage = z.infer<typeof TokenUsageSchema>

// ---------------------------------------------------------------------------
// Aggregate usage (across multiple turns)
// ---------------------------------------------------------------------------

export const AggregateUsageSchema = TokenUsageSchema.extend({
  /** Number of assistant API calls contributing to this aggregate. */
  apiCalls: z.number(),
})
export type AggregateUsage = z.infer<typeof AggregateUsageSchema>

// ---------------------------------------------------------------------------
// Turn Tags — free-vocabulary categorization extracted during summarization
// ---------------------------------------------------------------------------

export const TurnTagsSchema = z.object({
  /** Role of the user in this turn (e.g. "frontend", "backend", "tester"). */
  role: z.array(z.string()).nullable().optional(),
  /** Type of work (e.g. "bugfix", "feature", "refactor"). */
  type: z.array(z.string()).nullable().optional(),
  /** Subsystem touched (e.g. "auth", "api", "database"). */
  subsystem: z.array(z.string()).nullable().optional(),
  /** Project-specific tags (e.g. "session-store", "chat-ui"). */
  specific: z.array(z.string()).nullable().optional(),
})
export type TurnTags = z.infer<typeof TurnTagsSchema>

// ---------------------------------------------------------------------------
// Subagent Turn — a subagent execution nested inside a parent turn
// ---------------------------------------------------------------------------

export const SubagentTurnSchema = z.object({
  /** Agent ID from the subagent file (e.g. "a58e29f4d79ee80ad"). */
  agentId: z.string(),

  /** Agent type from .meta.json (e.g. "Explore", "general-purpose"). */
  agentType: z.string().optional(),

  /** Kickoff prompt sent to the subagent. */
  userText: z.string(),

  /** Summary of the kickoff prompt. Omitted when short enough. */
  userSummary: z.string().optional(),

  /** ISO 8601 timestamp of the kickoff. */
  userTimestamp: z.string(),

  /** Last substantial response from the subagent. */
  agentText: z.string(),

  /** Summary of the response. Omitted when short enough. */
  agentSummary: z.string().optional(),

  /** ISO 8601 timestamp of the final response. */
  agentTimestamp: z.string(),

  /** Duration in milliseconds from kickoff to final response. */
  durationMs: z.number().nullable(),

  /** Aggregated token usage across all assistant turns in the subagent. */
  usage: TokenUsageSchema.nullable(),

  /** Number of raw assistant messages collapsed. */
  rawMessageCount: z.number().int().positive(),

  /** Free-vocabulary tags extracted during summarization. */
  tags: TurnTagsSchema.optional(),
})
export type SubagentTurn = z.infer<typeof SubagentTurnSchema>

// ---------------------------------------------------------------------------
// Lean Turn — the core unit
// ---------------------------------------------------------------------------

export const LeanTurnSchema = z.object({
  /**
   * Stable turn identifier: first 8 chars of session hash + 4-digit index.
   * Example: "0c052bba-0001"
   */
  id: z.string(),

  /** Sequential index within the lean session (0-based). */
  index: z.number().int().nonnegative(),

  // -- User request --

  /** Verbatim user prompt. */
  userText: z.string(),

  /**
   * Summary of the user prompt for efficient downstream processing.
   * Omitted when identical to userText (short messages).
   * TODO: Use LLM summarization for long messages. Currently truncated.
   */
  userSummary: z.string().optional(),

  /** ISO 8601 timestamp of the user prompt. */
  userTimestamp: z.string(),

  // -- Agent response --

  /** Selected agent response text (last substantial message from the sequence). */
  agentText: z.string(),

  /**
   * Summary of the agent response for efficient downstream processing.
   * Omitted when identical to agentText (short messages).
   * TODO: Use LLM summarization for long messages. Currently truncated.
   */
  agentSummary: z.string().optional(),

  /** ISO 8601 timestamp of the (final) agent response. */
  agentTimestamp: z.string(),

  // -- Timing --

  /**
   * Duration in milliseconds from userTimestamp to agentTimestamp.
   * Null when timestamps are unavailable.
   */
  durationMs: z.number().nullable(),

  // -- Cost (from agent response) --

  /** Token usage across the agent response sequence (excludes subagent usage). */
  usage: TokenUsageSchema.nullable(),

  /**
   * Number of raw assistant messages that were collapsed into this single turn.
   * 1 means no collapsing occurred. >1 means multiple assistant responses were
   * merged (we picked the last substantial one).
   * TODO: Better algorithm for picking the ideal response from a long sequence.
   */
  rawMessageCount: z.number().int().positive(),

  // -- Subagents launched during this turn --

  /**
   * Subagent executions that occurred between userText and agentText.
   * Empty array when no subagents were launched.
   */
  subagents: z.array(SubagentTurnSchema),

  /** Free-vocabulary tags extracted during summarization. */
  tags: TurnTagsSchema.optional(),

  /** Task/workstream this turn was assigned to during context-aware summarization. */
  taskId: z.string().optional(),
})
export type LeanTurn = z.infer<typeof LeanTurnSchema>

// ---------------------------------------------------------------------------
// Lean Session Header — metadata at the top of the stored file
// ---------------------------------------------------------------------------

export const LeanSessionHeaderSchema = z.object({
  /** Format version for forward compatibility. */
  version: z.literal(1),

  sessionId: z.string(),

  /** First 8 chars of sessionId, used as turn ID prefix. */
  sessionPrefix: z.string(),

  /** Original project working directory. */
  projectPath: z.string().nullable(),

  /** Encoded project directory name (Claude Code format). */
  projectDirName: z.string(),

  /** Human-readable session title (from custom-title or slug). */
  title: z.string().nullable(),

  /** Session slug (e.g. "splendid-marinating-iverson"). */
  slug: z.string().nullable(),

  /** Claude Code version used in this session. */
  ccVersion: z.string().nullable(),

  /** ISO 8601 timestamp of the first turn. */
  startedAt: z.string(),

  /** ISO 8601 timestamp of the last turn. */
  endedAt: z.string(),

  /** Total number of lean turns. */
  turnCount: z.number().int().nonnegative(),

  /** Number of user turns. */
  userTurnCount: z.number().int().nonnegative(),

  /** Number of agent turns. */
  agentTurnCount: z.number().int().nonnegative(),

  /** Aggregate token usage across all turns. */
  usage: AggregateUsageSchema.nullable(),

  /** Total wall-clock duration in milliseconds (endedAt - startedAt). */
  totalDurationMs: z.number().nullable(),

  /** Size of the raw JSONL file in bytes (for change detection). */
  rawSizeBytes: z.number(),

  /** ISO 8601 mtime of the raw JSONL file (for change detection). */
  rawLastModified: z.string(),

  /** Number of raw JSONL lines that were parsed. */
  rawLineCount: z.number().int().nonnegative(),
})
export type LeanSessionHeader = z.infer<typeof LeanSessionHeaderSchema>

// ---------------------------------------------------------------------------
// Session Task — a discovered workstream/task from context-aware summarization
// ---------------------------------------------------------------------------

/** A single concept the task is actively forming, refining, or extending. */
export const TaskConceptSchema = z.object({
  /** kebab-case name, typically 1-3 words (e.g. "web-client", "merlinignore-file-syntax"). */
  concept: z.string(),
  /** One short sentence explaining the concept in local context. */
  description: z.string(),
})
export type TaskConcept = z.infer<typeof TaskConceptSchema>

export const TaskConceptsSchema = z.object({
  /** 1-5 concepts the task is actively focused on. */
  items: z.array(TaskConceptSchema),
  /** Content hash of the task when concepts were extracted (for staleness detection). */
  sourceHash: z.string().optional(),
})
export type TaskConcepts = z.infer<typeof TaskConceptsSchema>

export const SessionTaskSchema = z.object({
  /** Task identifier (e.g. "t1", "t2"). */
  id: z.string(),
  /** One-sentence technical description of the task (refined over time by LLM). */
  description: z.string(),
  /** Turn indices that belong to this task (1-based, matches context.turn_index). */
  turns: z.array(z.number().int().nonnegative()),
  /**
   * Content hash of (description + turns). Changes when the task is extended or refined.
   * Downstream processors compare their `sourceHash` against this to detect staleness.
   */
  contentHash: z.string(),
  /** Concepts the task is actively forming. Recomputed when contentHash changes. */
  concepts: TaskConceptsSchema.optional(),
  /** Unix ms timestamp of the earliest turn's user prompt. */
  startedAt: z.number().optional(),
  /** Unix ms timestamp of the latest turn's agent response. */
  endedAt: z.number().optional(),
})
export type SessionTask = z.infer<typeof SessionTaskSchema>

// ---------------------------------------------------------------------------
// Lean Session — full in-memory representation
// ---------------------------------------------------------------------------

export const LeanSessionSchema = z.object({
  header: LeanSessionHeaderSchema,
  turns: z.array(LeanTurnSchema),
  /** Tasks/workstreams discovered during context-aware summarization. */
  tasks: z.array(SessionTaskSchema).optional(),
})
/** In-memory lean session — may carry transient summarization context (not persisted in JSONL). */
export type LeanSession = z.infer<typeof LeanSessionSchema> & {
  /** Final summarization context after processing. Transient — persisted separately as context.json. */
  summarizationContext?: unknown
}

// ---------------------------------------------------------------------------
// Task Embeddings — vector representation of a task for semantic search
// ---------------------------------------------------------------------------

export const TaskEmbeddingSchema = z.object({
  /** Dense float vector. Length matches `dim`. */
  vector: z.array(z.number()),
  /** Embedding model identifier (e.g. "gemini-embedding-2-preview"). */
  model: z.string(),
  /** Vector dimensionality. */
  dim: z.number().int().positive(),
  /** Hash of the source content this embedding was computed from (matches SessionTask.contentHash when fresh). */
  sourceHash: z.string(),
  /**
   * Asymmetric task type used when the vector was produced. Stored task vectors
   * should be `RETRIEVAL_DOCUMENT`; queries are embedded with `RETRIEVAL_QUERY`
   * at search time and not persisted. Older vectors lack this field — they are
   * treated as stale and re-embedded on the next pass.
   */
  taskType: z.enum(['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY', 'SEMANTIC_SIMILARITY']).optional(),
})
export type TaskEmbedding = z.infer<typeof TaskEmbeddingSchema>

export const SessionEmbeddingsSchema = z.object({
  version: z.literal(1),
  /** taskId -> embedding. */
  taskEmbeddings: z.record(z.string(), TaskEmbeddingSchema),
})
export type SessionEmbeddings = z.infer<typeof SessionEmbeddingsSchema>

// ---------------------------------------------------------------------------
// Project Index Entry — manifest of successfully processed sessions
// ---------------------------------------------------------------------------

export const FolderIndexEntrySchema = z.object({
  sessionId: z.string(),
  title: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  turnCount: z.number().int().nonnegative(),
  userTurnCount: z.number().int().nonnegative(),
  /** Raw file size at time of processing (fingerprint for staleness detection). */
  rawSizeBytes: z.number(),
  /** Raw file mtime at time of processing (fingerprint for staleness detection). */
  rawLastModified: z.string(),
})
export type FolderIndexEntry = z.infer<typeof FolderIndexEntrySchema>

// ---------------------------------------------------------------------------
// Project Index — top-level index for a project
// ---------------------------------------------------------------------------

export const FolderIndexSchema = z.object({
  version: z.literal(1),
  projectPath: z.string(),
  projectDirName: z.string(),
  sessions: z.array(FolderIndexEntrySchema),
  lastProcessedAt: z.string(),
})
export type FolderIndex = z.infer<typeof FolderIndexSchema>
