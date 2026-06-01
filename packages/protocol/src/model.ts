import { z } from 'zod'

// ── Re-exports from @merlin/cc (types that originate from CC interaction) ────

export {
  type PendingApproval,
  PendingApprovalSchema,
  type PendingQuestion,
  PendingQuestionSchema,
  type PreprocessingStatus,
  PreprocessingStatusSchema,
  type SessionState,
  SessionStateSchema,
  type SessionSummary,
  SessionSummarySchema,
} from '@merlin/cc'

import { PendingApprovalSchema, PendingQuestionSchema, SessionStateSchema, SessionSummarySchema } from '@merlin/cc'

// ── Metadata scope (synced to ALL clients) ──────────────────────────────────

export const HostInfoSchema = z.object({
  name: z.string(),
  instanceName: z.string(),
  version: z.string(),
  connectedClients: z.number(),
})

export const ProjectOwnerSchema = z.union([
  z.literal('available'),
  z.object({ type: z.literal('external'), pids: z.array(z.number()) }),
  z.object({ type: z.literal('daemon'), instanceName: z.string() }),
])

export const PreprocessingStatsSchema = z.object({
  total: z.number(),
  processed: z.number(),
  running: z.number(),
  error: z.number(),
  outdated: z.number(),
  missing: z.number(),
})

export const ProjectSchema = z.object({
  cwd: z.string(),
  displayName: z.string(),
  lastTimestamp: z.number(),
  sessions: z.array(SessionSummarySchema),
  owner: ProjectOwnerSchema,
  activeSessionId: z.string().optional(),
  /** True if this project has been archived by the user. */
  archived: z.boolean().optional(),
  /** True if this project has nested projects collapsed into it. */
  collapsed: z.boolean().optional(),
  /** Aggregate preprocessing stats. */
  preprocessing: PreprocessingStatsSchema.optional(),
})

// ── Processing runtime (live counters while the queue is non-idle) ──────────

export const RuntimeSessionSchema = z.object({
  cwd: z.string(),
  sessionId: z.string(),
  startedAt: z.number(),
  turnsDone: z.number(),
  turnsDiscovered: z.number(),
  tasksDone: z.number(),
  tasksDiscovered: z.number(),
})

export const LLMCostSchema = z.object({
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
})

export const ProcessingRuntimeSchema = z.object({
  /** Per-session live counters. Empty when no sessions are actively processing. */
  activeSessions: z.array(RuntimeSessionSchema),
  /** Cumulative LLM costs since daemon start, keyed by model name. */
  llmTotals: z.record(z.string(), LLMCostSchema),
})

export const MerlinModelSchema = z.object({
  host: HostInfoSchema,
  projects: z.record(z.string(), ProjectSchema),
  /** Number of projects fully hidden by .merlinignore at the last discovery pass. */
  ignoredProjectCount: z.number(),
  /** Live processing counters. */
  processingRuntime: ProcessingRuntimeSchema,
})

// ── Session scope (synced only to subscribed clients) ────────────────────────

export const ActiveSessionSchema = z.object({
  id: z.string(),
  ccSessionId: z.string().optional(),
  projectCwd: z.string(),
  state: SessionStateSchema,
  contextLines: z.array(z.string()),
  pendingApproval: PendingApprovalSchema.nullable(),
  pendingQuestion: PendingQuestionSchema.nullable(),
  connectedAt: z.number(),
})

// ── Inferred types ──────────────────────────────────────────────────────────

export type HostInfo = z.infer<typeof HostInfoSchema>
export type ProjectOwner = z.infer<typeof ProjectOwnerSchema>
export type PreprocessingStats = z.infer<typeof PreprocessingStatsSchema>
export type Project = z.infer<typeof ProjectSchema>
export type RuntimeSession = z.infer<typeof RuntimeSessionSchema>
export type LLMCost = z.infer<typeof LLMCostSchema>
export type ProcessingRuntime = z.infer<typeof ProcessingRuntimeSchema>
export type MerlinModel = z.infer<typeof MerlinModelSchema>
export type ActiveSession = z.infer<typeof ActiveSessionSchema>
