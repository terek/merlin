/**
 * @merlin/protocol -- shared data model and wire protocol
 *
 * Zod schemas + inferred TypeScript types for the Merlin world model
 * (projects, sessions, host info) and the client↔daemon message protocol.
 */

// ── Model (world state) ─────────────────────────────────────────────────────

export {
  type ActiveSession,
  ActiveSessionSchema,
  // Inferred types
  type HostInfo,
  // Zod schemas
  HostInfoSchema,
  type MerlinModel,
  MerlinModelSchema,
  type PendingApproval,
  PendingApprovalSchema,
  type PendingQuestion,
  PendingQuestionSchema,
  type PreprocessingStats,
  PreprocessingStatsSchema,
  type PreprocessingStatus,
  PreprocessingStatusSchema,
  type Project,
  type ProjectOwner,
  ProjectOwnerSchema,
  ProjectSchema,
  type SessionState,
  SessionStateSchema,
  type SessionSummary,
  // Re-exports from @merlin/cc
  SessionSummarySchema,
} from './model.ts'

// ── Protocol (wire messages) ─────────────────────────────────────────────────

export {
  type ClerkMessageEntry,
  type ClerkToolDef,
  type ClientMessage,
  ClientMessageSchema,
  type DaemonMessage,
  DaemonMessageSchema,
} from './protocol.ts'
