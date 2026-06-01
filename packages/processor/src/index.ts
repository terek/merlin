/**
 * @merlin/processor -- public API
 *
 * Parses raw Claude Code session JSONL files into lightweight LeanSession
 * representations, segments them by day, and stores results.
 */

// ---------------------------------------------------------------------------
// Data models (Zod schemas + inferred types)
// ---------------------------------------------------------------------------

export {
  type AggregateUsage,
  AggregateUsageSchema,
  type FolderIndex,
  type FolderIndexEntry,
  FolderIndexEntrySchema,
  FolderIndexSchema,
  type LeanSession,
  type LeanSessionHeader,
  LeanSessionHeaderSchema,
  LeanSessionSchema,
  type LeanTurn,
  LeanTurnSchema,
  type SessionEmbeddings,
  SessionEmbeddingsSchema,
  type SessionTask,
  SessionTaskSchema,
  type SubagentTurn,
  SubagentTurnSchema,
  type TaskConcept,
  TaskConceptSchema,
  type TaskConcepts,
  TaskConceptsSchema,
  type TaskEmbedding,
  TaskEmbeddingSchema,
  type TokenUsage,
  TokenUsageSchema,
  type TurnTags,
  TurnTagsSchema,
} from './schema.ts'

export {
  type Segment,
  SegmentSchema,
} from './segment-schema.ts'

// ---------------------------------------------------------------------------
// Processor (main orchestrator)
// ---------------------------------------------------------------------------

export type { LLMCostStats, ProcessorOptions, ProcessResult, ReembedResult, SessionCheck } from './processor.ts'
export { Processor } from './processor.ts'
export type { InnerProgressEvent, ProgressEvent } from './progress.ts'

// ---------------------------------------------------------------------------
// Processing queue
// ---------------------------------------------------------------------------

export type {
  AllJob,
  EnqueueRequest,
  ProcessingJob,
  ProcessingQueueOptions,
  ProjectJob,
  SessionJob,
  SessionResult,
} from './queue.ts'
export { ProcessingQueue } from './queue.ts'

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

export type { SessionSummarizationResult, SummarizationContext, SummarizeOptions, TurnSummaries } from './summarizer.ts'
export { createLimiter, reconstructContext, SUMMARIZE_MIN_LENGTH, TurnSummarizer } from './summarizer.ts'

// ---------------------------------------------------------------------------
// Concept extraction
// ---------------------------------------------------------------------------

export type { ConceptExtractorOptions } from './concept-extractor.ts'
export { TaskConceptExtractor } from './concept-extractor.ts'

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export type { EmbedderOptions } from './embedder.ts'
export { emptyEmbeddings, TaskEmbedder } from './embedder.ts'

// ---------------------------------------------------------------------------
// Lean session building
// ---------------------------------------------------------------------------

export type { BuildOptions } from './lean-session.ts'
export {
  buildLeanSession,
  buildLeanSessionWithSubagents,
  updateLeanSession,
} from './lean-session.ts'

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

export { segmentByDay } from './segmenter.ts'

// ---------------------------------------------------------------------------
// Storage & discovery
// ---------------------------------------------------------------------------

export type { RawSessionInfo } from './store.ts'
export {
  cwdToProjectDirName,
  discoverRawSessions,
  LeanSessionStore,
  listMatchingProjectDirs,
} from './store.ts'

// ---------------------------------------------------------------------------
// Raw JSONL parsing
// ---------------------------------------------------------------------------

export type { ParsedSession, ParsedTurn } from './jsonl-parser.ts'
export { parseSessionJsonl } from './jsonl-parser.ts'

// ---------------------------------------------------------------------------
// Processing state (in-memory tracking)
// ---------------------------------------------------------------------------

export type { PreprocessingStats, SessionProcessingState } from './processing-state.ts'
export { ProcessingState } from './processing-state.ts'
