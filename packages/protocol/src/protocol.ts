import { z } from 'zod'
import { ActiveSessionSchema, MerlinModelSchema } from './model.ts'

// JSON Patch operation (RFC 6902) — lightweight schema, not full spec validation
const JsonPatchOpSchema = z.object({
  op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
  path: z.string(),
  value: z.unknown().optional(),
  from: z.string().optional(),
})

// ── Client → Daemon messages ─────────────────────────────────────────────────

const SubscribeMetadata = z.object({ type: z.literal('subscribe'), scope: z.literal('metadata') })
const SubscribeSession = z.object({ type: z.literal('subscribe'), scope: z.literal('session'), sessionId: z.string() })
const UnsubscribeMetadata = z.object({ type: z.literal('unsubscribe'), scope: z.literal('metadata') })
const UnsubscribeSession = z.object({
  type: z.literal('unsubscribe'),
  scope: z.literal('session'),
  sessionId: z.string(),
})
const SendMessage = z.object({ type: z.literal('send_message'), sessionId: z.string(), text: z.string() })
const OpenProject = z.object({ type: z.literal('open_project'), cwd: z.string(), ccSessionId: z.string().optional() })
const KillSession = z.object({ type: z.literal('kill_session'), sessionId: z.string() })
const RefreshProjects = z.object({ type: z.literal('refresh_projects'), force: z.boolean().optional() })
const Approve = z.object({ type: z.literal('approve'), sessionId: z.string(), optionKey: z.string() })
const Deny = z.object({ type: z.literal('deny'), sessionId: z.string() })
const Archive = z.object({ type: z.literal('archive'), scope: z.enum(['project', 'session']), id: z.string() })
const Unarchive = z.object({ type: z.literal('unarchive'), scope: z.enum(['project', 'session']), id: z.string() })
const CollapseProject = z.object({ type: z.literal('collapse_project'), cwd: z.string() })
const UncollapseProject = z.object({ type: z.literal('uncollapse_project'), cwd: z.string() })
// ── Clerk (Study mode) ───────────────────────────────────────────────────────
// One active study session per project. Idle/shutdown closes & compacts;
// the last 3 compacted summaries are recalled into the next session's
// system prompt as ambient memory.

const ClerkMessage = z.object({
  type: z.literal('clerk_message'),
  cwd: z.string(),
  text: z.string(),
})
const ClerkInterrupt = z.object({ type: z.literal('clerk_interrupt'), cwd: z.string() })
/** Pull the active study session's message history when the chat panel opens. */
const ClerkLoad = z.object({ type: z.literal('clerk_load'), cwd: z.string() })
const GetSegments = z.object({ type: z.literal('get_segments'), cwd: z.string() })
const GetRawTurns = z.object({
  type: z.literal('get_raw_turns'),
  cwd: z.string(),
  sessionId: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
})
const GetLeanTurns = z.object({
  type: z.literal('get_lean_turns'),
  cwd: z.string(),
  sessionId: z.string(),
})
const GetSessionSegments = z.object({
  type: z.literal('get_session_segments'),
  cwd: z.string(),
  sessionId: z.string(),
})
const GetProjectTasks = z.object({ type: z.literal('get_project_tasks'), cwd: z.string() })
const SearchTasks = z.object({
  type: z.literal('search_tasks'),
  cwd: z.string(),
  query: z.string(),
  /** Echoed back so the client can drop stale responses. */
  requestId: z.string(),
  /** Max number of task results to return. Default 50. */
  limit: z.number().int().positive().optional(),
})
const ProcessProject = z.object({ type: z.literal('process_project'), cwd: z.string() })
const ProcessSession = z.object({ type: z.literal('process_session'), cwd: z.string(), sessionId: z.string() })
const ProcessAll = z.object({ type: z.literal('process_all') })
const DeleteProcessing = z.object({
  type: z.literal('delete_processing'),
  cwd: z.string(),
  sessionId: z.string().optional(),
})
const ReembedProject = z.object({ type: z.literal('reembed_project'), cwd: z.string() })
const GetOrganizer = z.object({
  type: z.literal('get_organizer'),
  cwd: z.string(),
  /** If true, bypass the cached result and regenerate. */
  refresh: z.boolean().optional(),
})

export const ClientMessageSchema = z.union([
  SubscribeMetadata,
  SubscribeSession,
  UnsubscribeMetadata,
  UnsubscribeSession,
  SendMessage,
  OpenProject,
  KillSession,
  RefreshProjects,
  Approve,
  Deny,
  Archive,
  Unarchive,
  CollapseProject,
  UncollapseProject,
  ClerkMessage,
  ClerkInterrupt,
  ClerkLoad,
  GetSegments,
  GetRawTurns,
  GetLeanTurns,
  GetSessionSegments,
  GetProjectTasks,
  SearchTasks,
  ProcessProject,
  ProcessSession,
  ProcessAll,
  DeleteProcessing,
  ReembedProject,
  GetOrganizer,
])

// ── Daemon → Client messages ─────────────────────────────────────────────────

const SnapshotMetadata = z.object({
  type: z.literal('snapshot'),
  scope: z.literal('metadata'),
  data: MerlinModelSchema,
})
const SnapshotSession = z.object({
  type: z.literal('snapshot'),
  scope: z.literal('session'),
  sessionId: z.string(),
  data: ActiveSessionSchema,
})
const PatchMetadata = z.object({
  type: z.literal('patch'),
  scope: z.literal('metadata'),
  ops: z.array(JsonPatchOpSchema),
})
const PatchSession = z.object({
  type: z.literal('patch'),
  scope: z.literal('session'),
  sessionId: z.string(),
  ops: z.array(JsonPatchOpSchema),
})
const ErrorMessage = z.object({ type: z.literal('error'), message: z.string() })
// Clerk stream — carries cwd so clients can route to the right chat panel.
const ClerkChunk = z.object({ type: z.literal('clerk_chunk'), cwd: z.string(), text: z.string() })
const ClerkToolActivity = z.object({
  type: z.literal('clerk_tool_activity'),
  cwd: z.string(),
  tool: z.string(),
  description: z.string(),
})
/**
 * Result of a tool invocation, streamed live so the debug view can render it
 * inline. `content` is exactly the text that gets fed back into the LLM as the
 * tool result on the next agent turn — usually JSON-stringified.
 */
const ClerkToolResult = z.object({
  type: z.literal('clerk_tool_result'),
  cwd: z.string(),
  tool: z.string(),
  content: z.string(),
})
const ClerkDone = z.object({ type: z.literal('clerk_done'), cwd: z.string() })
const ClerkError = z.object({ type: z.literal('clerk_error'), cwd: z.string(), error: z.string() })
/**
 * Snapshot of the active study session for `cwd`. Empty messages = no active session.
 * `systemPrompt` and `tools` describe exactly what the LLM would see on the next
 * turn — used by the chat panel's debug view.
 */
const ClerkActive = z.object({
  type: z.literal('clerk_active'),
  cwd: z.string(),
  messages: z.array(z.unknown()),
  systemPrompt: z.string(),
  tools: z.array(z.unknown()),
})
const SegmentsResponse = z.object({ type: z.literal('segments'), cwd: z.string(), sessions: z.array(z.unknown()) })
const LeanTurnsResponse = z.object({
  type: z.literal('lean_turns'),
  cwd: z.string(),
  sessionId: z.string(),
  title: z.string().nullable(),
  turns: z.array(z.unknown()),
  tasks: z.array(z.unknown()).optional(),
})
const SessionSegmentsResponse = z.object({
  type: z.literal('session_segments'),
  cwd: z.string(),
  sessionId: z.string(),
  segments: z.array(z.unknown()),
})
const ProjectTasksResponse = z.object({
  type: z.literal('project_tasks'),
  cwd: z.string(),
  tasksBySession: z.record(z.string(), z.array(z.unknown())),
})
const SearchTasksResultsResponse = z.object({
  type: z.literal('search_tasks_results'),
  cwd: z.string(),
  query: z.string(),
  requestId: z.string(),
  /** May be present when the daemon couldn't run the search (e.g. no embedding provider). */
  error: z.string().optional(),
  results: z.array(
    z.object({
      sessionId: z.string(),
      taskId: z.string(),
      score: z.number(),
      task: z.unknown(),
    }),
  ),
})
const OrganizerResponse = z.object({
  type: z.literal('organizer'),
  cwd: z.string(),
  /** True while the daemon is generating. Allows optimistic UI. */
  pending: z.boolean(),
  /** Present when generation failed. */
  error: z.string().optional(),
  /** Per-task rename. `taskId` is composite: "${sessionId}/${taskId}". */
  tasks: z.array(
    z.object({
      taskId: z.string(),
      name: z.string(),
      /** Optional group label for visual clustering. */
      group: z.string().optional(),
      /** Optional LLM reasoning / note. */
      note: z.string().optional(),
    }),
  ),
  /** ISO timestamp when this result was produced. */
  generatedAt: z.string().optional(),
})
const RawTurnsResponse = z.object({
  type: z.literal('raw_turns'),
  cwd: z.string(),
  sessionId: z.string(),
  turns: z.array(
    z.object({
      index: z.number(),
      role: z.enum(['user', 'assistant']),
      text: z.string(),
      timestamp: z.string(),
      usage: z
        .object({
          inputTokens: z.number(),
          outputTokens: z.number(),
          cacheReadTokens: z.number(),
          cacheWriteTokens: z.number(),
        })
        .optional(),
    }),
  ),
  total: z.number(),
  title: z.string().nullable(),
})

export const DaemonMessageSchema = z.union([
  SnapshotMetadata,
  SnapshotSession,
  PatchMetadata,
  PatchSession,
  ErrorMessage,
  ClerkChunk,
  ClerkToolActivity,
  ClerkToolResult,
  ClerkDone,
  ClerkError,
  ClerkActive,
  SegmentsResponse,
  RawTurnsResponse,
  LeanTurnsResponse,
  SessionSegmentsResponse,
  ProjectTasksResponse,
  SearchTasksResultsResponse,
  OrganizerResponse,
])

// ── Inferred types ──────────────────────────────────────────────────────────

import type { LeanTurn, ParsedTurn, Segment, SessionTask } from '@merlin/processor'

/** A single message in a Clerk study session. Mirrors @merlin/llm's ConversationMessage. */
export interface ClerkMessageEntry {
  role: 'user' | 'assistant' | 'tool_results'
  text?: string
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>
  toolResults?: Array<{ callId: string; content: string }>
}

/** Tool definition the agent advertises to the LLM. Mirrors @merlin/llm's ToolDefinition. */
export interface ClerkToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description?: string }>
    required: string[]
  }
}

export type ClientMessage = z.infer<typeof ClientMessageSchema>
export type DaemonMessage =
  | Exclude<
      z.infer<typeof DaemonMessageSchema>,
      | { type: 'segments' }
      | { type: 'raw_turns' }
      | { type: 'lean_turns' }
      | { type: 'session_segments' }
      | { type: 'project_tasks' }
      | { type: 'search_tasks_results' }
      | { type: 'clerk_active' }
    >
  | { type: 'segments'; cwd: string; sessions: unknown[] }
  | { type: 'raw_turns'; cwd: string; sessionId: string; turns: ParsedTurn[]; total: number; title: string | null }
  | {
      type: 'lean_turns'
      cwd: string
      sessionId: string
      title: string | null
      turns: LeanTurn[]
      tasks?: SessionTask[]
    }
  | { type: 'session_segments'; cwd: string; sessionId: string; segments: Segment[] }
  | { type: 'project_tasks'; cwd: string; tasksBySession: Record<string, SessionTask[]> }
  | {
      type: 'search_tasks_results'
      cwd: string
      query: string
      requestId: string
      error?: string
      results: Array<{ sessionId: string; taskId: string; score: number; task: SessionTask }>
    }
  | {
      type: 'clerk_active'
      cwd: string
      messages: ClerkMessageEntry[]
      systemPrompt: string
      tools: ClerkToolDef[]
    }
