/**
 * Context-aware turn summarizer.
 *
 * Processes turns with a rolling context that tracks discovered tasks and
 * recent activity. Two call modes:
 *
 *  - Chunk (default): one LLM call per chunk of up to `chunkSize` turns,
 *    returning an array of per-turn deltas in input order. The LLM treats
 *    the chunk as a sequence, allowed to reference task ids it creates
 *    earlier in the same chunk.
 *
 *  - Single-turn (chunkSize=1 or per-turn fallback): one LLM call per turn,
 *    returning one delta. Used as the fallback path when a chunk call fails
 *    after retry.
 *
 * Each delta — single or chunked item — has the same schema and is applied
 * mechanically via applyDelta. Subagent turns use context-blind summarization.
 */

import type { LLMProvider } from '@merlin/llm'
import { z } from 'zod'
import type { SessionTask } from './schema.ts'

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Minimum text length (chars) to trigger LLM summarization. */
export const SUMMARIZE_MIN_LENGTH = 0

/** Default number of turns per chunked LLM call. */
export const DEFAULT_CHUNK_SIZE = 15

// ---------------------------------------------------------------------------
// Delta schema shared by single-turn and chunked protocols
// ---------------------------------------------------------------------------

const DELTA_SCHEMA_DOC = `Delta (per turn) schema:
{
  "task_id": "t3" | null,
  "action": "extend" | "new" | "refine",
  "new_task": { "id": "t4", "description": "..." },
  "refined_description": "...",
  "gist": "one-liner" | null,
  "summary": { "user": "..." | null, "agent": "..." | null }
}

Actions:
- "new": a new task/workstream identified. Provide new_task with next available id.
- "extend": turn belongs to existing task. Provide task_id.
- "refine": turn updates understanding of existing task. Provide task_id + refined_description.

Summary rules:
- Terse bullet points (- prefix) or single statement. No narrative framing.
- Lead with the concrete thing: requirement, decision, file, API, bug, config.
- Preserve ALL technical specifics: paths, function names, flags, error messages.
- Omit filler and process narration.
- Don't repeat in agent summary what's already in user summary.
- 1-5 bullets. Return null if message is trivially short.`

// ---------------------------------------------------------------------------
// Context-aware system prompts (cacheable — identical across all calls)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You process coding session turns with project context. Produce a delta to update the context, plus a turn summary.

Input (in user message): { context, user_message, agent_message }

Context schema:
{
  "tasks": [{ "id": "t1", "description": "one sentence, technical", "turns": [1,2,5] }],
  "recent": [{ "turn": 14, "gist": "one-liner" }, ...],
  "turn_index": 15
}

${DELTA_SCHEMA_DOC}`

const SYSTEM_PROMPT_CHUNK = `You process a chunk of consecutive coding session turns with project context. Produce one delta per input turn, in the same order.

Input (in user message): { context, turns: [ { turn_index, user_message, agent_message }, ... ] }

Context schema:
{
  "tasks": [{ "id": "t1", "description": "one sentence, technical", "turns": [1,2,5] }],
  "recent": [{ "turn": 14, "gist": "one-liner" }, ...],
  "turn_index": 15
}

The context describes state BEFORE the first turn of the chunk. Process the turns sequentially. A task you create in turn K may be extended/refined by later turns in the same chunk — use the id you assigned. Task ids must be unique across both the input context tasks and any new_task entries you emit.

${DELTA_SCHEMA_DOC}

items.length MUST equal turns.length and must appear in the same order. Each item's turn_index must echo the input turn_index for that position.`

// ---------------------------------------------------------------------------
// Context-blind fallback (for subagents and error recovery)
// ---------------------------------------------------------------------------

const FALLBACK_SYSTEM_PROMPT = `You summarize coding session turns into scannable bullet points. Each turn has a user prompt and an agent response.

Rules:
- Use terse bullet points (- prefix) or a single statement (without prefix), not narrative sentences.
- Lead each bullet with the concrete thing: a requirement, constraint, decision, file, API, config change, bug, etc.
- Preserve ALL technical details: file paths, function names, flags, config keys, error messages, version numbers, specific constraints.
- Omit filler, pleasantries, and process narration.
- For user prompts: extract requirements, constraints, and acceptance criteria.
- For agent responses: extract outcomes, decisions, key artifacts, and any trade-offs or caveats mentioned.
- Do not repeat info stated in the user summary again in the agent summary.
- Typical summary is 1-5 bullets. Use fewer for simple turns, more for complex ones.
- If a message is short enough that a summary would be as long as the original, return null for that field.`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TurnSummaries {
  userSummary?: string
  agentSummary?: string
  taskId?: string
  /** Debug: snapshot of the rolling context after this turn was processed. */
  _contextSnapshot?: SummarizationContext
}

/** Rolling context maintained across turns within a session. */
export interface SummarizationContext {
  tasks: SessionTask[]
  recent: Array<{ turn: number; gist: string }>
  turn_index: number
}

/** Result of context-aware summarization of an entire session. */
export interface SessionSummarizationResult {
  /** Per-turn summaries, indexed by turn index. */
  turnResults: TurnSummaries[]
  /** Discovered tasks/workstreams. */
  tasks: SessionTask[]
  /** Final rolling context (for persistence — enables exact incremental resume). */
  context: SummarizationContext
}

// Zod-enforced schemas for the three structured-output call paths.

const LLMDeltaSchema = z.object({
  task_id: z.string().nullable(),
  action: z.enum(['extend', 'new', 'refine']),
  new_task: z.object({ id: z.string(), description: z.string() }).optional(),
  refined_description: z.string().optional(),
  gist: z.string().nullable(),
  summary: z.object({ user: z.string().nullable(), agent: z.string().nullable() }),
})
type LLMDelta = z.infer<typeof LLMDeltaSchema>

const ChunkResponseSchema = z.object({
  items: z.array(LLMDeltaSchema),
})

const FallbackSummarySchema = z.object({
  userSummary: z.string().nullable(),
  agentSummary: z.string().nullable(),
})

export interface SummarizeOptions {
  /** Shared concurrency limiter. All LLM calls go through this. */
  limiter: <T>(fn: () => Promise<T>) => Promise<T>
  /**
   * Turns per chunked context-aware LLM call. Default DEFAULT_CHUNK_SIZE.
   * Set to 1 to disable chunking (one call per turn).
   */
  chunkSize?: number
}

// ---------------------------------------------------------------------------
// TurnSummarizer
// ---------------------------------------------------------------------------

export class TurnSummarizer {
  private provider: LLMProvider
  private limiter: <T>(fn: () => Promise<T>) => Promise<T>
  private chunkSize: number

  constructor(provider: LLMProvider, opts: SummarizeOptions) {
    this.provider = provider
    this.limiter = opts.limiter
    this.chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK_SIZE)
  }

  /**
   * Context-aware summarization of a full session's turns.
   *
   * Turns are processed in chunks of up to `chunkSize`. Each chunk issues one
   * LLM call that returns a per-turn delta array; deltas are applied in order
   * to the rolling context, so chunk N+1 sees the state chunk N produced.
   *
   * When a chunk has only 1 turn (chunkSize=1 or trailing remainder), the
   * single-turn path is used — same delta schema, simpler prompt.
   *
   * On parse failure after retry, the chunk falls back to per-turn sequential
   * processing (each turn using the single-turn path with its own fallback).
   *
   * @param initialContext — starting context (empty for new sessions, reconstructed for incremental)
   */
  async summarizeSession(
    turns: Array<{ userText: string; agentText: string }>,
    initialContext?: SummarizationContext,
  ): Promise<SessionSummarizationResult> {
    const ctx: SummarizationContext = initialContext ?? { tasks: [], recent: [], turn_index: 1 }
    const turnResults: TurnSummaries[] = []

    for (let offset = 0; offset < turns.length; offset += this.chunkSize) {
      const chunk = turns.slice(offset, offset + this.chunkSize)

      if (chunk.length === 1) {
        const t = chunk[0]!
        const result = await this.limiter(() => this._contextAwareCall(ctx, t.userText, t.agentText))
        result._contextSnapshot = JSON.parse(JSON.stringify(ctx))
        turnResults.push(result)
        continue
      }

      const deltas = await this.limiter(() => this._contextAwareChunkCall(ctx, chunk))
      if (deltas) {
        for (const delta of deltas) {
          const result = applyDelta(ctx, delta)
          result._contextSnapshot = JSON.parse(JSON.stringify(ctx))
          turnResults.push(result)
        }
      } else {
        // Chunk call failed after retry — fall back to per-turn sequential processing
        console.warn(`[processor] chunk call failed; falling back to per-turn for ${chunk.length} turns`)
        for (const t of chunk) {
          const result = await this.limiter(() => this._contextAwareCall(ctx, t.userText, t.agentText))
          result._contextSnapshot = JSON.parse(JSON.stringify(ctx))
          turnResults.push(result)
        }
      }
    }

    return { turnResults, tasks: ctx.tasks, context: ctx }
  }

  /**
   * Context-blind summarization for a single turn (subagents, fallback).
   */
  async summarizeTurn(userText: string, agentText: string): Promise<TurnSummaries> {
    const userNeedsSummary = userText.length > SUMMARIZE_MIN_LENGTH
    const agentNeedsSummary = agentText.length > SUMMARIZE_MIN_LENGTH

    if (!userNeedsSummary && !agentNeedsSummary) return {}

    return this.limiter(async () => {
      const content = buildFallbackContent(userText, agentText, userNeedsSummary, agentNeedsSummary)
      try {
        const result = await this.provider.parse({
          system: FALLBACK_SYSTEM_PROMPT,
          messages: [{ role: 'user', text: content }],
          schema: FallbackSummarySchema,
          schemaName: 'turn_summary',
        })
        return projectFallback(result, userNeedsSummary, agentNeedsSummary)
      } catch (err) {
        console.error('[processor] summarization failed:', err instanceof Error ? err.message : err)
        return {
          userSummary: userNeedsSummary ? truncate(userText) : undefined,
          agentSummary: agentNeedsSummary ? truncate(agentText) : undefined,
        }
      }
    })
  }

  // -------------------------------------------------------------------------
  // Context-aware LLM call + context update
  // -------------------------------------------------------------------------

  private async _contextAwareCall(
    ctx: SummarizationContext,
    userText: string,
    agentText: string,
  ): Promise<TurnSummaries> {
    const input = JSON.stringify({
      context: ctx,
      user_message: userText,
      agent_message: agentText,
    })

    const delta = await retryParse(
      () =>
        this.provider.parse({
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', text: input }],
          schema: LLMDeltaSchema,
          schemaName: 'turn_delta',
        }),
      'context-aware call',
    )

    if (!delta) {
      console.warn(`[processor] falling back to context-blind for turn ${ctx.turn_index}`)
      const fallback = await this._fallbackCall(userText, agentText)
      ctx.turn_index++
      return fallback
    }

    return applyDelta(ctx, delta)
  }

  // -------------------------------------------------------------------------
  // Chunked context-aware LLM call
  // -------------------------------------------------------------------------

  /**
   * Send a chunk of turns in one LLM call. Returns parsed deltas in input
   * order, or null if the call failed after retry or the LLM returned a
   * mismatched item count.
   *
   * Does NOT apply deltas to ctx — the caller does so sequentially, keeping
   * applyDelta as the single source of truth for context mutation.
   */
  private async _contextAwareChunkCall(
    ctx: SummarizationContext,
    chunk: Array<{ userText: string; agentText: string }>,
  ): Promise<LLMDelta[] | null> {
    const firstTurnIndex = ctx.turn_index
    const input = JSON.stringify({
      context: ctx,
      turns: chunk.map((t, i) => ({
        turn_index: firstTurnIndex + i,
        user_message: t.userText,
        agent_message: t.agentText,
      })),
    })

    const result = await retryParse(
      () =>
        this.provider.parse({
          system: SYSTEM_PROMPT_CHUNK,
          messages: [{ role: 'user', text: input }],
          schema: ChunkResponseSchema,
          schemaName: 'chunk_deltas',
        }),
      'chunk call',
    )

    if (!result) return null
    if (result.items.length !== chunk.length) {
      console.warn(`[processor] chunk returned ${result.items.length} items, expected ${chunk.length}`)
      return null
    }
    return result.items
  }

  private async _fallbackCall(userText: string, agentText: string): Promise<TurnSummaries> {
    const userNeedsSummary = userText.length > SUMMARIZE_MIN_LENGTH
    const agentNeedsSummary = agentText.length > SUMMARIZE_MIN_LENGTH
    const content = buildFallbackContent(userText, agentText, userNeedsSummary, agentNeedsSummary)

    try {
      const result = await this.provider.parse({
        system: FALLBACK_SYSTEM_PROMPT,
        messages: [{ role: 'user', text: content }],
        schema: FallbackSummarySchema,
        schemaName: 'turn_summary',
      })
      return projectFallback(result, userNeedsSummary, agentNeedsSummary)
    } catch {
      return {
        userSummary: truncate(userText),
        agentSummary: truncate(agentText),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Run an async parse() once, retry once on failure, return null if both throw. */
async function retryParse<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt === 0) {
        console.warn(`[processor] ${label} failed, retrying:`, err instanceof Error ? err.message : err)
      } else {
        console.warn(`[processor] ${label} failed after retry:`, err instanceof Error ? err.message : err)
      }
    }
  }
  return null
}

function buildFallbackContent(
  userText: string,
  agentText: string,
  userNeedsSummary: boolean,
  agentNeedsSummary: boolean,
): string {
  const userInput = userNeedsSummary
    ? `USER PROMPT (${userText.length} chars):\n${userText}`
    : `USER PROMPT (short, no summary needed):\n${userText}`
  const agentInput = agentNeedsSummary
    ? `AGENT RESPONSE (${agentText.length} chars):\n${agentText}`
    : `AGENT RESPONSE (short, no summary needed):\n${agentText}`
  return `${userInput}\n\n---\n\n${agentInput}`
}

/** Convert validated FallbackSummary → TurnSummaries, honoring the per-side need flags. */
function projectFallback(
  result: { userSummary: string | null; agentSummary: string | null },
  userNeedsSummary: boolean,
  agentNeedsSummary: boolean,
): TurnSummaries {
  const out: TurnSummaries = {}
  if (userNeedsSummary && result.userSummary) out.userSummary = result.userSummary
  if (agentNeedsSummary && result.agentSummary) out.agentSummary = result.agentSummary
  return out
}

// ---------------------------------------------------------------------------
// Delta application
// ---------------------------------------------------------------------------

/** Compute content hash for a task. Deterministic from description + turns. */
function computeTaskHash(description: string, turns: number[]): string {
  const content = `${description}\0${turns.join(',')}`
  return Bun.hash(content).toString(36)
}

/**
 * Apply an LLM delta to the rolling context. Mutates ctx in place.
 * Returns the TurnSummaries for this turn.
 */
function applyDelta(ctx: SummarizationContext, delta: LLMDelta): TurnSummaries {
  const turnIndex = ctx.turn_index

  // Apply task action
  let taskId: string | undefined
  switch (delta.action) {
    case 'new':
      if (delta.new_task) {
        const turns = [turnIndex]
        const task: SessionTask = {
          id: delta.new_task.id,
          description: delta.new_task.description,
          turns,
          contentHash: computeTaskHash(delta.new_task.description, turns),
        }
        ctx.tasks.push(task)
        taskId = task.id
      }
      break

    case 'extend':
      if (delta.task_id) {
        const task = ctx.tasks.find((t) => t.id === delta.task_id)
        if (task) {
          task.turns.push(turnIndex)
          task.contentHash = computeTaskHash(task.description, task.turns)
          taskId = task.id
        }
      }
      break

    case 'refine':
      if (delta.task_id) {
        const task = ctx.tasks.find((t) => t.id === delta.task_id)
        if (task) {
          if (delta.refined_description) task.description = delta.refined_description
          task.turns.push(turnIndex)
          task.contentHash = computeTaskHash(task.description, task.turns)
          taskId = task.id
        }
      }
      break
  }

  // Update recent window (max 5)
  if (delta.gist) {
    ctx.recent.push({ turn: turnIndex, gist: delta.gist })
    if (ctx.recent.length > 5) ctx.recent.shift()
  }

  // Advance turn index
  ctx.turn_index++

  // Build result
  const result: TurnSummaries = {}
  if (delta.summary.user) result.userSummary = delta.summary.user
  if (delta.summary.agent) result.agentSummary = delta.summary.agent
  if (taskId) result.taskId = taskId

  // Extract tags
  return result
}

// ---------------------------------------------------------------------------
// Context reconstruction (for incremental updates)
// ---------------------------------------------------------------------------

/**
 * Reconstruct a SummarizationContext from existing session data.
 * Used when incrementally updating a session — we rebuild context from
 * stored tasks and recent turn summaries so new turns get proper context.
 */
export function reconstructContext(
  existingTasks: SessionTask[],
  existingTurns: Array<{ userSummary?: string; agentSummary?: string }>,
): SummarizationContext {
  const tasks = existingTasks.map((t) => ({ ...t, turns: [...t.turns] }))

  // Build recent from last 5 turns that have summaries
  const recent: Array<{ turn: number; gist: string }> = []
  for (let i = Math.max(0, existingTurns.length - 5); i < existingTurns.length; i++) {
    const t = existingTurns[i]!
    const gist = t.userSummary || t.agentSummary
    if (gist) {
      // Use first line as gist, truncated
      const firstLine = gist.split('\n')[0]!.replace(/^- /, '')
      recent.push({ turn: i + 1, gist: truncate(firstLine, 80) })
    }
  }

  return {
    tasks,
    recent,
    turn_index: existingTurns.length + 1,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxLength = 200): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3)}...`
}

// ---------------------------------------------------------------------------
// Simple concurrency limiter (avoids external dependency)
// ---------------------------------------------------------------------------

/**
 * Create a concurrency limiter.
 * All calls to the returned function run at most `concurrency` tasks at once.
 */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0
  const queue: Array<() => void> = []

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (running >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve))
    }
    running++
    try {
      return await fn()
    } finally {
      running--
      if (queue.length > 0) queue.shift()!()
    }
  }
}
