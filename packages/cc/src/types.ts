import { z } from 'zod'

// ---------------------------------------------------------------------------
// CC NDJSON event types (stdout from `claude --output-format stream-json`)
// ---------------------------------------------------------------------------

export interface CCEvent {
  type: string
  [key: string]: unknown
}

export interface CCSystemEvent extends CCEvent {
  type: 'system'
  subtype?: string
  session_id?: string
  model?: string
  cwd?: string
  tools?: unknown[]
  mcp_servers?: unknown[]
  content?: unknown
}

export interface CCAssistantEvent extends CCEvent {
  type: 'assistant'
  message?: {
    role: 'assistant'
    content: CCContentBlock[]
  }
  content?: CCContentBlock[] | string
}

export interface CCUserEvent extends CCEvent {
  type: 'user'
  message?: {
    role: 'user'
    content: CCContentBlock[] | string
  }
  toolUseResult?: Record<string, unknown>
  tool_use_result?: Record<string, unknown>
}

export interface CCResultEvent extends CCEvent {
  type: 'result'
  subtype?: string
  session_id?: string
  sessionId?: string
}

export interface CCControlRequest extends CCEvent {
  type: 'control_request'
  request_id: string
  request: {
    subtype: string
    tool_name?: string
    input?: Record<string, unknown>
    permission_suggestions?: string[]
    tool_use_id?: string
  }
}

export interface CCThinkingEvent extends CCEvent {
  type: 'thinking'
  thinking?: string
}

// Content blocks within messages
export type CCContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }

// JSONL entry shape (stored in ~/.claude/projects/...)
export interface CCJSONLEntry {
  type?: string
  cwd?: string
  sessionId?: string
  slug?: string
  customTitle?: string
  timestamp?: number | string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Session state & interaction schemas (produced by CCSession)
// ---------------------------------------------------------------------------

export const SessionStateSchema = z.enum(['starting', 'idle', 'busy', 'waitingForInput', 'offeringChoices', 'exited'])
export type SessionState = z.infer<typeof SessionStateSchema>

export const PendingApprovalSchema = z.object({
  toolName: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  options: z.array(z.object({ key: z.string(), label: z.string() })),
})
export type PendingApproval = z.infer<typeof PendingApprovalSchema>

export const PendingQuestionSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string(),
      multiSelect: z.boolean(),
      options: z.array(z.object({ label: z.string(), description: z.string() })),
    }),
  ),
})
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>

// ---------------------------------------------------------------------------
// Session summary & preprocessing status (produced by discovery, enriched by daemon)
// ---------------------------------------------------------------------------

export const PreprocessingStatusSchema = z.enum(['missing', 'running', 'processed', 'outdated', 'error'])
export type PreprocessingStatus = z.infer<typeof PreprocessingStatusSchema>

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  slug: z.string().optional(),
  customTitle: z.string().optional(),
  lastTimestamp: z.number(),
  sizeBytes: z.number(),
  userTurnCount: z.number(),
  subagentCount: z.number(),
  /** PID of the CC process actively running this session, if any. */
  activePid: z.number().optional(),
  /** True if this session has been archived by the user. */
  archived: z.boolean().optional(),
  /** Preprocessing status for this session. */
  ppStatus: PreprocessingStatusSchema.optional(),
  /** Error message if preprocessing failed. */
  ppError: z.string().optional(),
  /** Turns covered by preprocessing (from stored segments). */
  ppTurnsCovered: z.number().optional(),
  /** If this session was spawned by an Agent tool in another session. */
  parentSessionId: z.string().optional(),
  /** Relative path prefix for sessions merged from a collapsed parent project (e.g. "daemon"). */
  nestedPath: z.string().optional(),
})
export type SessionSummary = z.infer<typeof SessionSummarySchema>
