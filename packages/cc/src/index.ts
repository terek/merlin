/**
 * @merlin/cc — Claude Code integration package.
 *
 * Discovers CC projects/sessions from disk, scans running processes,
 * reads session lockfiles, and manages CC subprocess sessions.
 */

// ---------------------------------------------------------------------------
// Types (CC events, JSONL entries, session state schemas)
// ---------------------------------------------------------------------------

export type {
  CCAssistantEvent,
  CCContentBlock,
  CCControlRequest,
  CCEvent,
  CCJSONLEntry,
  CCResultEvent,
  CCSystemEvent,
  CCThinkingEvent,
  CCUserEvent,
} from './types.ts'

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
} from './types.ts'

// ---------------------------------------------------------------------------
// Discovery (historical sessions from disk)
// ---------------------------------------------------------------------------

export type { DiscoveredFolder } from './discovery.ts'
export { ClaudeProjectDiscovery } from './discovery.ts'

// ---------------------------------------------------------------------------
// Process scanning (running CC processes)
// ---------------------------------------------------------------------------

export type { ProcessHit, ProcessScannerDeps } from './process-scanner.ts'
export {
  IS_LINUX,
  lsofCwd,
  ProcessScanner,
  parseResumeSessionId,
  procArgs,
  procCwd,
  psArgs,
} from './process-scanner.ts'

// ---------------------------------------------------------------------------
// Session lockfiles (hook-reported sessions)
// ---------------------------------------------------------------------------

export type { SessionLock } from './session-lockfiles.ts'
export { SessionLockfileReader } from './session-lockfiles.ts'

// ---------------------------------------------------------------------------
// Session management (CC subprocess control)
// ---------------------------------------------------------------------------

export type {
  CCSessionObserver,
  CCSessionOptions,
  SpecialKey,
  StateChangeEvent,
} from './session.ts'
export { CCSession } from './session.ts'
export type { SpawnOptions } from './spawn.ts'
export { spawnCCSession } from './spawn.ts'

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export { RollingBuffer } from './rolling-buffer.ts'
