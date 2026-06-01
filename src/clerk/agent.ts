/**
 * Clerk Study agent — provider-agnostic LLM conversation with read-only tools.
 * Handles the agentic loop: receives user text, calls study tools, returns
 * responses. The user is exploring what was done in this project; the agent
 * never edits files.
 */

import type { LLMProvider, ToolCall, ToolDefinition } from '@merlin/llm'
import type { ActiveSession } from './memory-store.ts'
import type { CodebaseTools } from './tools/codebase.ts'
import type { StudyTools } from './tools/study-tools.ts'

const STUDY_SYSTEM_PROMPT = `You are the Clerk in Study mode. The user is reading back through what was done in this project — sessions, tasks, decisions, concepts — and wants concise, accurate answers grounded in the recorded history.

Behaviour:
- Be fast and concise. The user may be on a phone, walking; one short paragraph is usually enough.
- Show user prompts verbatim — they are the source of truth.
- Compress everything else; never paraphrase decisions you don't have evidence for.
- Don't speculate. If the recorded history doesn't say, say so.
- Expect interruptions. Each answer should land on a natural stopping point so the user can redirect.
- No advice or opinions unless explicitly asked.

Tools:
- Prefer search_tasks and list_tasks to find what's relevant before reading turns.
- Prefer get_lean_turns over get_raw_turns; only escalate to raw if a summary clearly omits the detail.
- read_file / search_code / list_files inspect the current state of the codebase, not history. Use them sparingly.`

/** Build the exact system prompt the agent will send. Useful for debug views. */
export function buildStudySystemPrompt(cwd: string, memoryPreamble: string): string {
  const view = `Current view: project ${cwd}.`
  return [memoryPreamble, view, STUDY_SYSTEM_PROMPT].filter(Boolean).join('\n\n')
}

export const STUDY_TOOLS: ToolDefinition[] = [
  {
    name: 'list_sessions',
    description:
      'List all processed sessions in the current project with titles, time range, turn counts, and task counts. Sorted most recent first.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_session_header',
    description: 'Get metadata (title, slug, duration, usage) for a specific session.',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'list_tasks',
    description:
      'List all tasks (discovered workstreams) across the project with their descriptions, concepts, and turn indices.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_tasks',
    description:
      'Semantic search over project tasks by topic or keyword. Returns matching tasks sorted by relevance. Usually the right first move.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic, feature, or concept to search for' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_task',
    description: 'Get the full details of a single task, including concepts and the turn indices it covers.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        taskId: { type: 'string' },
      },
      required: ['sessionId', 'taskId'],
    },
  },
  {
    name: 'get_lean_turns',
    description:
      'Get lean (summarised) turns from a session by half-open index range [start, end). Prefer this over get_raw_turns unless the summaries omit needed detail.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        start: { type: 'number', description: 'Start turn index (0-based, inclusive)' },
        end: { type: 'number', description: 'End turn index (exclusive)' },
      },
      required: ['sessionId', 'start', 'end'],
    },
  },
  {
    name: 'get_raw_turns',
    description:
      'Get raw conversation turns from the original Claude Code JSONL. Use sparingly — only when the lean summaries are insufficient.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        start: { type: 'number', description: 'Start turn index (0-based, inclusive)' },
        end: { type: 'number', description: 'End turn index (exclusive)' },
      },
      required: ['sessionId', 'start', 'end'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the project (current state on disk, not history).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to project root or absolute)' },
        startLine: { type: 'number', description: 'Start line (1-based, optional)' },
        endLine: { type: 'number', description: 'End line (optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description: 'Search the current codebase for a pattern (regex via ripgrep).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (ripgrep syntax)' },
        glob: { type: 'string', description: 'File glob filter, e.g. "*.ts"' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_files',
    description: 'Find files matching a glob pattern within the project.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' } },
      required: ['pattern'],
    },
  },
]

export interface AgentCallbacks {
  onTextChunk?: (text: string) => void
  onToolActivity?: (tool: string, description: string) => void
  /** Fired right after a tool returns; `content` is what the LLM will see on the next turn. */
  onToolResult?: (tool: string, content: string) => void
  onDone?: () => void
  onError?: (error: string) => void
}

export class ClerkAgent {
  private provider: LLMProvider
  private studyTools: StudyTools
  private codebaseTools: CodebaseTools
  /** Built once per active session. Concatenated with the base prompt on each turn. */
  private systemPrompt: string
  private abortController: AbortController | null = null

  constructor(opts: {
    provider: LLMProvider
    cwd: string
    studyTools: StudyTools
    codebaseTools: CodebaseTools
    /** Already-rendered ambient memory preamble (may be empty). */
    memoryPreamble: string
  }) {
    this.provider = opts.provider
    this.studyTools = opts.studyTools
    this.codebaseTools = opts.codebaseTools
    this.systemPrompt = buildStudySystemPrompt(opts.cwd, opts.memoryPreamble)
  }

  /** Run one user turn through the tool-use loop. Persistence is the caller's job. */
  async chat(session: ActiveSession, userMessage: string, callbacks?: AgentCallbacks): Promise<string> {
    session.messages.push({ role: 'user', text: userMessage })
    let fullResponse = ''

    while (true) {
      this.abortController = new AbortController()

      let turnText = ''
      const turnToolCalls: ToolCall[] = []
      let wantsToolResults = false

      try {
        for await (const ev of this.provider.chatStream({
          system: this.systemPrompt,
          tools: STUDY_TOOLS,
          messages: session.messages,
          signal: this.abortController.signal,
        })) {
          if (ev.type === 'text-delta') {
            turnText += ev.text
            fullResponse += ev.text
            callbacks?.onTextChunk?.(ev.text)
          } else if (ev.type === 'tool-call') {
            turnToolCalls.push(ev.call)
          } else if (ev.type === 'done') {
            wantsToolResults = ev.wantsToolResults
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          if (fullResponse) session.messages.push({ role: 'assistant', text: fullResponse })
          callbacks?.onDone?.()
          return fullResponse
        }
        throw err
      }

      if (!wantsToolResults || turnToolCalls.length === 0) {
        session.messages.push({
          role: 'assistant',
          text: turnText || undefined,
          toolCalls: turnToolCalls.length > 0 ? turnToolCalls : undefined,
        })
        break
      }

      session.messages.push({
        role: 'assistant',
        text: turnText || undefined,
        toolCalls: turnToolCalls,
      })

      const toolResults = []
      for (const tc of turnToolCalls) {
        callbacks?.onToolActivity?.(tc.name, describeToolUse(tc))
        const result = await this.executeTool(tc.name, tc.input)
        const content = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        callbacks?.onToolResult?.(tc.name, content)
        toolResults.push({ callId: tc.id, content })
      }
      session.messages.push({ role: 'tool_results', toolResults })
    }

    callbacks?.onDone?.()
    return fullResponse
  }

  /** Interrupt the current response. */
  interrupt() {
    this.abortController?.abort()
    this.abortController = null
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const r = this.studyTools
    const c = this.codebaseTools
    switch (name) {
      case 'list_sessions':
        return r.listSessions()
      case 'get_session_header':
        return r.getSessionHeader(input.sessionId as string)
      case 'list_tasks':
        return r.listTasks()
      case 'search_tasks':
        return r.searchTasks(input.query as string, input.limit as number | undefined)
      case 'get_task':
        return r.getTask(input.sessionId as string, input.taskId as string)
      case 'get_lean_turns':
        return r.getLeanTurns(input.sessionId as string, input.start as number, input.end as number)
      case 'get_raw_turns':
        return r.getRawTurns(input.sessionId as string, input.start as number, input.end as number)
      case 'read_file':
        return c.readFile(
          input.path as string,
          input.startLine as number | undefined,
          input.endLine as number | undefined,
        )
      case 'search_code':
        return c.searchCode(
          input.pattern as string,
          input.glob as string | undefined,
          input.limit as number | undefined,
        )
      case 'list_files':
        return c.listFiles(input.pattern as string)
      default:
        return { error: `Unknown tool: ${name}` }
    }
  }
}

function describeToolUse(tc: ToolCall): string {
  switch (tc.name) {
    case 'list_sessions':
      return 'Listing project sessions'
    case 'get_session_header':
      return `Reading session ${(tc.input.sessionId as string)?.slice(0, 8)} header`
    case 'list_tasks':
      return 'Listing project tasks'
    case 'search_tasks':
      return `Searching tasks for "${tc.input.query}"`
    case 'get_task':
      return `Reading task ${tc.input.taskId} in session ${(tc.input.sessionId as string)?.slice(0, 8)}`
    case 'get_lean_turns':
      return `Reading turns ${tc.input.start}-${tc.input.end} of ${(tc.input.sessionId as string)?.slice(0, 8)}`
    case 'get_raw_turns':
      return `Reading raw turns ${tc.input.start}-${tc.input.end} of ${(tc.input.sessionId as string)?.slice(0, 8)}`
    case 'read_file':
      return `Reading ${tc.input.path}`
    case 'search_code':
      return `Searching code for "${tc.input.pattern}"`
    case 'list_files':
      return `Finding files matching "${tc.input.pattern}"`
    default:
      return tc.name
  }
}
