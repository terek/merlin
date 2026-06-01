/**
 * Builds lean sessions from parsed raw session data.
 *
 * A lean session collapses multi-message assistant sequences into single turns,
 * filters interruption noise, and computes aggregate metadata. Subagent
 * executions are nested inside the parent turn that launched them.
 *
 * Key design decisions:
 * - Each user prompt + agent response becomes one lean turn.
 * - Subagents are nested in the parent turn's `subagents` array, since they
 *   execute between the user prompt and agent response.
 * - Summaries are currently simple truncation.
 *   TODO: LLM-powered summarization for long messages.
 * - Supports incremental updates.
 */

import type { ParsedSession, ParsedTurn } from './jsonl-parser.ts'
import { parseSessionJsonl } from './jsonl-parser.ts'
import type { InnerProgressEvent } from './progress.ts'
import type {
  AggregateUsage,
  LeanSession,
  LeanSessionHeader,
  LeanTurn,
  SessionTask,
  SubagentTurn,
  TokenUsage,
} from './schema.ts'
import type { SummarizationContext, TurnSummarizer } from './summarizer.ts'
import { reconstructContext } from './summarizer.ts'

/** Minimum response length to be considered "substantial". */
const SUBSTANTIAL_RESPONSE_LENGTH = 80

// ---------------------------------------------------------------------------
// Build lean session from parsed data
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** Raw file size in bytes (for change detection). */
  rawSizeBytes: number
  /** Raw file mtime as ISO string (for change detection). */
  rawLastModified: string
  /** Project directory name in Claude Code encoding. */
  projectDirName: string
  /**
   * Directory containing the session folder (which contains subagents/).
   * e.g. ~/.claude/projects/-Users-alice-work-myapp/
   * If provided, subagent JSONL files will be parsed and nested into turns.
   */
  sessionDir?: string
  /** Optional LLM summarizer for generating summaries instead of truncation. */
  summarizer?: TurnSummarizer
  /** Structured progress callback for turn-level visibility. */
  onEvent?: (e: InnerProgressEvent) => void
  /** Existing turns to carry forward summaries from (incremental updates). */
  existingTurns?: LeanTurn[]
  /** Existing tasks from prior processing (for incremental context reconstruction). */
  existingTasks?: SessionTask[]
  /** Existing summarization context from prior processing (exact resume). */
  existingContext?: SummarizationContext
}

/**
 * Build a complete lean session from a parsed raw session (sync, no subagents).
 */
export function buildLeanSession(parsed: ParsedSession, opts: BuildOptions): LeanSession {
  const sessionPrefix = parsed.sessionId.slice(0, 8)
  const cleaned = filterInterruptions(parsed.turns)
  const turns = collapseToLeanTurns(cleaned, sessionPrefix)
  const header = buildHeader(parsed, turns, sessionPrefix, opts)
  return { header, turns, tasks: undefined }
}

/**
 * Build a lean session with subagent files parsed from disk.
 * If a summarizer is provided, runs LLM summarization in parallel for all turns.
 */
export async function buildLeanSessionWithSubagents(parsed: ParsedSession, opts: BuildOptions): Promise<LeanSession> {
  const sessionPrefix = parsed.sessionId.slice(0, 8)
  const cleaned = filterInterruptions(parsed.turns)
  const turns = collapseToLeanTurns(cleaned, sessionPrefix)

  if (opts.sessionDir) {
    const subagentTurns = await parseSubagents(opts.sessionDir, parsed.sessionId)
    nestSubagents(turns, subagentTurns)
  }

  // Carry forward existing summaries before summarizing (incremental updates)
  if (opts.existingTurns) {
    carryForwardSummaries(turns, opts.existingTurns)
  }

  // Summarize: context-aware for main turns, context-blind for subagents
  let tasks: SessionTask[] | undefined
  let summarizationContext: SummarizationContext | undefined
  if (opts.summarizer) {
    const result = await summarizeAllTurns(
      turns,
      opts.summarizer,
      opts.onEvent,
      opts.existingTurns,
      opts.existingTasks,
      opts.existingContext,
    )
    tasks = result.tasks
    summarizationContext = result.context
  }

  if (tasks) computeTaskTimeRanges(tasks, turns)

  const header = buildHeader(parsed, turns, sessionPrefix, opts)
  return { header, turns, tasks, summarizationContext }
}

/**
 * Incrementally update a lean session with new turns from the raw session.
 * Carries forward existing summaries/tags so only new turns need LLM calls.
 * Returns null if no changes.
 */
export async function updateLeanSession(
  existing: LeanSession,
  parsed: ParsedSession,
  opts: BuildOptions,
): Promise<LeanSession | null> {
  if (existing.header.rawSizeBytes === opts.rawSizeBytes && existing.header.rawLastModified === opts.rawLastModified) {
    return null
  }

  // Rebuild with existing turns + tasks passed through — summaries are carried forward
  // before the summarizer runs, so only new turns get LLM calls.
  return buildLeanSessionWithSubagents(parsed, {
    ...opts,
    existingTurns: existing.turns,
    existingTasks: existing.tasks,
    existingContext: existing.summarizationContext as SummarizationContext | undefined,
  })
}

/**
 * Copy summaries/tags from old turns to matching new turns.
 *
 * Matching strategy: by index for all turns except the last old turn.
 * The last old turn may have changed (active session appending content),
 * so we match it by userText prefix to detect genuine content changes.
 *
 * New turns (index >= oldTurns.length) are left unsummarized.
 */
function carryForwardSummaries(newTurns: LeanTurn[], oldTurns: LeanTurn[]): void {
  for (let i = 0; i < newTurns.length && i < oldTurns.length; i++) {
    const newT = newTurns[i]!
    const oldT = oldTurns[i]!
    const oldHas = !!(oldT.userSummary || oldT.agentSummary || oldT.taskId)

    // For the last old turn, verify the user prompt matches
    // (agentText may differ due to response still streaming when last processed)
    if (i === oldTurns.length - 1) {
      if (newT.userText.slice(0, 200) !== oldT.userText.slice(0, 200)) continue
    }

    if (oldHas) copyAnnotations(newT, oldT)

    // Carry forward subagent summaries by agentId
    if (oldT.subagents.length > 0 && newT.subagents.length > 0) {
      const oldSubMap = new Map<string, SubagentTurn>()
      for (const s of oldT.subagents) oldSubMap.set(s.agentId, s)
      for (const s of newT.subagents) {
        const oldSub = oldSubMap.get(s.agentId)
        if (oldSub) copyAnnotations(s, oldSub)
      }
    }
  }
}

function copyAnnotations(
  target: { userSummary?: string; agentSummary?: string; taskId?: string },
  source: { userSummary?: string; agentSummary?: string; taskId?: string },
): void {
  if (source.userSummary) target.userSummary = source.userSummary
  if (source.agentSummary) target.agentSummary = source.agentSummary
  if (source.taskId) target.taskId = source.taskId
}

// ---------------------------------------------------------------------------
// Shared helpers (used by both main turns and subagent turns)
// ---------------------------------------------------------------------------

/**
 * Pick the best response text from an assistant turn sequence.
 * TODO: Better algorithm that considers content quality, not just length.
 */
export function pickResponse(turns: ParsedTurn[]): string {
  if (turns.length === 1) return turns[0]!.text
  const last = turns[turns.length - 1]!
  if (last.text.length >= SUBSTANTIAL_RESPONSE_LENGTH) return last.text
  if (turns.length >= 2) {
    return `${turns[turns.length - 2]!.text}\n\n${last.text}`
  }
  return last.text
}

/** Aggregate token usage across parsed turns. Returns null if none. */
export function aggregateUsage(turns: ParsedTurn[]): TokenUsage | null {
  let inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheWriteTokens = 0
  let count = 0
  for (const t of turns) {
    if (t.usage) {
      inputTokens += t.usage.inputTokens
      outputTokens += t.usage.outputTokens
      cacheReadTokens += t.usage.cacheReadTokens
      cacheWriteTokens += t.usage.cacheWriteTokens
      count++
    }
  }
  return count > 0 ? { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } : null
}

/** Compute duration between two ISO timestamps. Null if missing or >24h. */
export function computeDuration(startTs: string, endTs: string): number | null {
  if (!startTs || !endTs) return null
  const diff = new Date(endTs).getTime() - new Date(startTs).getTime()
  if (diff >= 0 && diff < 24 * 60 * 60 * 1000) return diff
  return null
}

export function formatTurnId(sessionPrefix: string, index: number): string {
  return `${sessionPrefix}-${String(index).padStart(4, '0')}`
}

// ---------------------------------------------------------------------------
// Phase 1: Filter interruption noise
// ---------------------------------------------------------------------------

const INTERRUPTED_FOR_TOOL = '[Request interrupted by user for tool use]'
const INTERRUPTED_BY_USER = '[Request interrupted by user]'

function filterInterruptions(turns: ParsedTurn[]): ParsedTurn[] {
  return turns
    .filter((t) => {
      if (t.role !== 'user') return true
      if (t.text.includes(INTERRUPTED_FOR_TOOL)) return false
      if (t.text.trim() === INTERRUPTED_BY_USER) return false
      return true
    })
    .map((t) => {
      if (t.role === 'user' && t.text.startsWith(INTERRUPTED_BY_USER)) {
        const rest = t.text.slice(INTERRUPTED_BY_USER.length).trim()
        if (rest) return { ...t, text: rest }
      }
      return t
    })
}

// ---------------------------------------------------------------------------
// Phase 2: Collapse into lean turns
// ---------------------------------------------------------------------------

function collapseToLeanTurns(turns: ParsedTurn[], sessionPrefix: string): LeanTurn[] {
  const result: LeanTurn[] = []
  let currentUser: ParsedTurn | null = null
  let assistantSeq: ParsedTurn[] = []

  for (const t of turns) {
    if (t.role === 'user') {
      if (currentUser) {
        if (assistantSeq.length > 0) {
          emitPair(result, currentUser, assistantSeq, sessionPrefix)
          currentUser = t
          assistantSeq = []
        } else {
          currentUser = {
            ...t,
            text: `${currentUser.text}\n\n${t.text}`,
            timestamp: currentUser.timestamp,
          }
        }
      } else {
        currentUser = t
      }
    } else if (t.role === 'assistant' && currentUser) {
      assistantSeq.push(t)
    }
  }

  if (currentUser && assistantSeq.length > 0) {
    emitPair(result, currentUser, assistantSeq, sessionPrefix)
  }

  return result
}

function emitPair(result: LeanTurn[], user: ParsedTurn, assistants: ParsedTurn[], sessionPrefix: string): void {
  const index = result.length
  const responseText = pickResponse(assistants)
  const usage = aggregateUsage(assistants)
  const rawMessageCount = assistants.reduce((sum, a) => sum + a.rawMessageCount, 0)
  const agentTimestamp = assistants[assistants.length - 1]!.timestamp
  const durationMs = computeDuration(user.timestamp, agentTimestamp)

  const turn: LeanTurn = {
    id: formatTurnId(sessionPrefix, index),
    index,
    userText: user.text,
    userTimestamp: user.timestamp,
    agentText: responseText,
    agentTimestamp,
    durationMs,
    usage,
    rawMessageCount,
    subagents: [],
  }

  result.push(turn)
}

// ---------------------------------------------------------------------------
// Phase 3: Parse subagent files and nest inside parent turns
// ---------------------------------------------------------------------------

interface ParsedSubagent {
  sub: SubagentTurn
  /** Timestamp of kickoff — used to find the parent turn. */
  launchTimestamp: string
}

async function parseSubagents(sessionDir: string, sessionId: string): Promise<ParsedSubagent[]> {
  const { readdir } = await import('node:fs/promises')
  const path = await import('node:path')

  const subagentsDir = path.join(sessionDir, sessionId, 'subagents')
  let files: string[]
  try {
    files = await readdir(subagentsDir)
  } catch {
    return []
  }

  const jsonlFiles = files.filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
  if (jsonlFiles.length === 0) return []

  const results: ParsedSubagent[] = []

  for (const file of jsonlFiles) {
    const agentId = file.slice('agent-'.length, -'.jsonl'.length)

    // Read optional meta file for agentType
    let agentType: string | undefined
    try {
      const metaPath = path.join(subagentsDir, `agent-${agentId}.meta.json`)
      const metaContent = await Bun.file(metaPath).text()
      const meta = JSON.parse(metaContent) as { agentType?: string }
      if (meta.agentType) agentType = meta.agentType
    } catch {
      /* no meta file */
    }

    try {
      const content = await Bun.file(path.join(subagentsDir, file)).text()
      const parsed = parseSessionJsonl(content, agentId)
      if (parsed.turns.length === 0) continue

      const firstUser = parsed.turns.find((t) => t.role === 'user')
      if (!firstUser) continue

      const assistantTurns = parsed.turns.filter((t) => t.role === 'assistant')
      if (assistantTurns.length === 0) continue

      const agentText = pickResponse(assistantTurns)
      const usage = aggregateUsage(assistantTurns)
      const rawMessageCount = assistantTurns.reduce((sum, a) => sum + a.rawMessageCount, 0)
      const agentTimestamp = assistantTurns[assistantTurns.length - 1]!.timestamp
      const durationMs = computeDuration(firstUser.timestamp, agentTimestamp)

      const sub: SubagentTurn = {
        agentId,
        userText: firstUser.text,
        userTimestamp: firstUser.timestamp,
        agentText,
        agentTimestamp,
        durationMs,
        usage,
        rawMessageCount,
      }

      if (agentType) sub.agentType = agentType

      results.push({ sub, launchTimestamp: firstUser.timestamp })
    } catch (err) {
      console.error(`[processor] error parsing subagent ${agentId}:`, err)
    }
  }

  results.sort((a, b) => a.launchTimestamp.localeCompare(b.launchTimestamp))
  return results
}

/**
 * Compute startedAt / endedAt on each task from its turns' timestamps.
 * Task.turns are 1-based indices; LeanTurn.index is 0-based.
 */
function computeTaskTimeRanges(tasks: SessionTask[], turns: LeanTurn[]): void {
  const byIndex = new Map<number, LeanTurn>()
  for (const t of turns) byIndex.set(t.index, t)

  for (const task of tasks) {
    let minTs = Infinity
    let maxTs = -Infinity
    for (const turnIdx of task.turns) {
      const turn = byIndex.get(turnIdx - 1) // 1-based → 0-based
      if (!turn) continue
      const userMs = new Date(turn.userTimestamp).getTime()
      const agentMs = new Date(turn.agentTimestamp).getTime()
      if (userMs < minTs) minTs = userMs
      if (agentMs > maxTs) maxTs = agentMs
    }
    if (minTs < Infinity) task.startedAt = minTs
    if (maxTs > -Infinity) task.endedAt = maxTs
  }
}

/**
 * Nest subagent turns inside the parent main turn whose time window contains
 * the subagent's launch timestamp.
 */
function nestSubagents(turns: LeanTurn[], subagents: ParsedSubagent[]): void {
  for (const { sub, launchTimestamp } of subagents) {
    // Find the last main turn whose userTimestamp <= launch timestamp
    let parent: LeanTurn | null = null
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]!.userTimestamp <= launchTimestamp) {
        parent = turns[i]!
        break
      }
    }
    // Fall back to last turn if none found
    if (!parent && turns.length > 0) {
      parent = turns[turns.length - 1]!
    }
    if (parent) {
      parent.subagents.push(sub)
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 4: LLM summarization
//   Main turns:    sequential, context-aware (rolling context tracks tasks)
//   Subagent turns: parallel, context-blind
// ---------------------------------------------------------------------------

async function summarizeAllTurns(
  turns: LeanTurn[],
  summarizer: TurnSummarizer,
  onEvent?: (e: InnerProgressEvent) => void,
  existingTurns?: LeanTurn[],
  existingTasks?: SessionTask[],
  existingContext?: SummarizationContext,
): Promise<{ tasks: SessionTask[]; context?: SummarizationContext }> {
  // Separate main turns that need summarization from those already done
  const firstNewIndex = turns.findIndex((t) => needsSummarization(t))
  const hasNewMainTurns = firstNewIndex >= 0

  // Count total work items for progress reporting
  let total = 0
  if (hasNewMainTurns) total += turns.length - firstNewIndex
  for (const turn of turns) {
    for (const sub of turn.subagents) {
      if (needsSummarization(sub)) total++
    }
  }

  if (total === 0) return { tasks: existingTasks ?? [], context: existingContext }

  let completed = 0
  onEvent?.({ kind: 'log', msg: `summarizing: 0/${total} turns` })
  onEvent?.({ kind: 'turns', done: 0, discovered: total })

  // --- Context-aware summarization for main turns ---
  let tasks: SessionTask[] = existingTasks ?? []
  let finalContext: SummarizationContext | undefined = existingContext

  if (hasNewMainTurns) {
    // Use stored context if available, otherwise reconstruct from existing data
    let initialContext: SummarizationContext | undefined = existingContext
    if (!initialContext && firstNewIndex > 0 && existingTurns) {
      initialContext = reconstructContext(tasks, existingTurns.slice(0, firstNewIndex))
    }

    const newTurns = turns.slice(firstNewIndex)
    const result = await summarizer.summarizeSession(
      newTurns.map((t) => ({ userText: t.userText, agentText: t.agentText })),
      initialContext,
    )

    // Apply results to turns
    for (let i = 0; i < newTurns.length; i++) {
      const turn = newTurns[i]!
      const r = result.turnResults[i]!
      if (r.userSummary) turn.userSummary = r.userSummary
      if (r.agentSummary) turn.agentSummary = r.agentSummary
      if (r.taskId) turn.taskId = r.taskId
      if (r._contextSnapshot) (turn as { _context?: unknown })._context = r._contextSnapshot

      completed++
      onEvent?.({ kind: 'log', msg: `summarizing: ${completed}/${total} turns` })
      onEvent?.({ kind: 'turns', done: completed, discovered: total })
    }

    tasks = result.tasks
    finalContext = result.context
  }

  // --- Context-blind summarization for subagents (parallel) ---
  const subagentJobs: Promise<void>[] = []
  for (const turn of turns) {
    for (const sub of turn.subagents) {
      if (!needsSummarization(sub)) continue
      subagentJobs.push(
        summarizeSingle(sub, summarizer).then(() => {
          completed++
          onEvent?.({ kind: 'log', msg: `summarizing: ${completed}/${total} turns` })
          onEvent?.({ kind: 'turns', done: completed, discovered: total })
        }),
      )
    }
  }
  if (subagentJobs.length > 0) await Promise.all(subagentJobs)

  return { tasks, context: finalContext }
}

/** Returns true if this item needs summarization (no existing summary or task assignment). */
function needsSummarization(obj: { userSummary?: string; agentSummary?: string; taskId?: string }): boolean {
  return !obj.userSummary && !obj.agentSummary && !obj.taskId
}

async function summarizeSingle(
  obj: {
    userText: string
    agentText: string
    userSummary?: string
    agentSummary?: string
    tags?: import('./schema.ts').TurnTags
  },
  summarizer: TurnSummarizer,
): Promise<void> {
  if (!needsSummarization(obj)) return

  const result = await summarizer.summarizeTurn(obj.userText, obj.agentText)
  if (result.userSummary) obj.userSummary = result.userSummary
  if (result.agentSummary) obj.agentSummary = result.agentSummary
}

// ---------------------------------------------------------------------------
// Header builder
// ---------------------------------------------------------------------------

function buildHeader(
  parsed: ParsedSession,
  turns: LeanTurn[],
  sessionPrefix: string,
  opts: BuildOptions,
): LeanSessionHeader {
  const turnCount = turns.length

  const startedAt = turns.length > 0 ? turns[0]!.userTimestamp : ''
  const lastTurn = turns.length > 0 ? turns[turns.length - 1]! : null
  const endedAt = lastTurn?.agentTimestamp || lastTurn?.userTimestamp || ''

  let totalDurationMs: number | null = null
  if (startedAt && endedAt) {
    const diff = new Date(endedAt).getTime() - new Date(startedAt).getTime()
    if (diff >= 0) totalDurationMs = diff
  }

  // Aggregate usage across main turns + their subagents
  let inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    apiCalls = 0
  for (const t of turns) {
    if (t.usage) {
      inputTokens += t.usage.inputTokens
      outputTokens += t.usage.outputTokens
      cacheReadTokens += t.usage.cacheReadTokens
      cacheWriteTokens += t.usage.cacheWriteTokens
      apiCalls++
    }
    for (const s of t.subagents) {
      if (s.usage) {
        inputTokens += s.usage.inputTokens
        outputTokens += s.usage.outputTokens
        cacheReadTokens += s.usage.cacheReadTokens
        cacheWriteTokens += s.usage.cacheWriteTokens
        apiCalls++
      }
    }
  }
  const usage: AggregateUsage | null =
    apiCalls > 0 ? { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, apiCalls } : null

  return {
    version: 1,
    sessionId: parsed.sessionId,
    sessionPrefix,
    projectPath: parsed.cwd,
    projectDirName: opts.projectDirName,
    title: parsed.title,
    slug: parsed.slug,
    ccVersion: parsed.ccVersion,
    startedAt,
    endedAt,
    turnCount,
    userTurnCount: turnCount,
    agentTurnCount: turnCount,
    usage,
    totalDurationMs,
    rawSizeBytes: opts.rawSizeBytes,
    rawLastModified: opts.rawLastModified,
    rawLineCount: parsed.rawLineCount,
  }
}
