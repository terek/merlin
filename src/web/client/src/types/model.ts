/**
 * Re-exports from @merlin/protocol and @merlin/processor.
 * Web client components import from here via the @/ alias.
 */

// ── Model types (from @merlin/protocol) ─────────────────────────────────────

export type {
  ActiveSession,
  HostInfo,
  MerlinModel,
  PendingApproval,
  PendingQuestion,
  PreprocessingStats,
  PreprocessingStatus,
  Project,
  ProjectOwner,
  SessionState,
  SessionSummary,
} from '@merlin/protocol'

// ── Processor types (from @merlin/processor) ────────────────────────────────

export type {
  LeanTurn,
  ParsedTurn as RawTurn,
  Segment,
  SessionTask,
  SubagentTurn,
  TaskConcept,
  TaskConcepts,
  TokenUsage as TurnUsage,
} from '@merlin/processor'

// ── Legacy / client-only types ──────────────────────────────────────────────

export interface SubagentSummary {
  agentId: string
  launchPrompt: string
  summary: string
}

export interface ClerkSegment {
  index: number
  date: string
  topic: string
  summary: string
  turnRange: [number, number]
  userPrompts: string[]
  subagentLaunches: SubagentSummary[]
  timeRange: [string, string]
  usage?: UsageStats
}

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turns: number
}

export interface CompactedTurn {
  index: number
  userPrompt: string
  response: string
  userTimestamp: string
  responseTimestamp: string
  usage?: UsageStats
}

export interface ProcessedSession {
  sessionId: string
  projectPath: string
  title: string | null
  startedAt: string
  endedAt: string
  turnCount: number
  segments: ClerkSegment[]
  compacted?: CompactedTurn[]
  usage?: UsageStats
}
