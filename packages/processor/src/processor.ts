/**
 * Processor: orchestrates lean session extraction and segmentation for a project.
 *
 * Pure transform + storage layer. Does NOT track runtime state (processing,
 * error, outdated) — that's the caller's responsibility. The on-disk index
 * is a manifest of successfully processed sessions with fingerprints for
 * staleness detection.
 *
 * Storage layout per session:
 *   ~/.merlin/projects/<dir>/<session-id>/
 *     lean.jsonl       — header + turns
 *     segments.json    — array of Segment objects
 */

import os from 'node:os'
import path from 'node:path'
import { isSessionIgnored } from '@merlin/ignore'
import type { EmbeddingProvider, LLMProvider } from '@merlin/llm'
import { llmStats, type ModelStats } from '@merlin/llm'
import { TaskConceptExtractor } from './concept-extractor.ts'
import { emptyEmbeddings, TaskEmbedder } from './embedder.ts'
import { parseSessionJsonl } from './jsonl-parser.ts'
import { buildLeanSessionWithSubagents, updateLeanSession } from './lean-session.ts'
import type { InnerProgressEvent, ProgressEvent } from './progress.ts'
import type { FolderIndex, FolderIndexEntry } from './schema.ts'
import { segmentByDay } from './segmenter.ts'
import { cwdToProjectDirName, discoverRawSessions, LeanSessionStore, listMatchingProjectDirs } from './store.ts'
import { createLimiter, TurnSummarizer } from './summarizer.ts'

export interface ProcessorOptions {
  /** Base directory for Merlin data. Default: ~/.merlin */
  merlinDir?: string
  /** Claude Code projects directory. Default: ~/.claude/projects */
  claudeProjectsDir?: string
  /** Minimum raw file size to process (skip tiny metadata-only files). Default: 500 */
  minSizeBytes?: number
  /** Override home directory for .merlinignore resolution (for testing). */
  homeDir?: string
  /** LLM provider for summarization. If provided, enables LLM summaries. */
  llmProvider?: LLMProvider
  /** Embedding provider for task vectors. If provided, enables task embeddings. */
  embeddingProvider?: EmbeddingProvider
  /** Max concurrent LLM calls across all sessions/turns. Default: 100 */
  llmConcurrency?: number
  /**
   * Turns per chunked context-aware LLM call for session summarization.
   * Default is defined by TurnSummarizer (DEFAULT_CHUNK_SIZE). Set to 1 to
   * disable chunking and fall back to per-turn calls.
   */
  summarizerChunkSize?: number
  /** Structured progress callback for processing visibility. */
  onEvent?: (e: ProgressEvent) => void
}

/** Aggregated LLM cost stats from a processing run. */
export interface LLMCostStats {
  calls: number
  inputTokens: number
  outputTokens: number
  totalMs: number
  perModel: Map<string, ModelStats>
  summary: string
}

export interface ProcessResult {
  /** Session IDs that were successfully processed. */
  processed: string[]
  /** Session IDs that were skipped (unchanged or too small). */
  skipped: string[]
  /** Sessions that failed with error details. */
  errors: { sessionId: string; error: string }[]
  /** LLM cost stats if summarization was enabled. */
  llmCosts?: LLMCostStats
}

/** Result of a re-embed operation across all stored sessions in a project. */
export interface ReembedResult {
  /** Sessions whose embeddings were rewritten. */
  sessions: number
  /** Total number of tasks re-embedded. */
  tasks: number
  /** Sessions that failed with error details. */
  errors: { sessionId: string; error: string }[]
  /** Reason embeddings were skipped, if any (e.g. provider not configured). */
  skipped?: string
  /** LLM cost stats for the embedding calls made. */
  llmCosts?: LLMCostStats
}

/**
 * Per-session comparison of raw file vs stored output.
 * The caller uses this to determine what's pending, outdated, or current.
 */
export interface SessionCheck {
  sessionId: string
  /** Encoded project dir name this session belongs to (may differ from the queried project for nested dirs). */
  projectDirName: string
  rawPath: string
  rawSizeBytes: number
  rawLastModified: string
  /** Stored fingerprint, or null if not yet processed. */
  stored: { sizeBytes: number; lastModified: string } | null
}

export class Processor {
  private merlinDir: string
  private claudeProjectsDir: string
  private minSizeBytes: number
  private homeDir: string
  private summarizer: TurnSummarizer | undefined
  private conceptExtractor: TaskConceptExtractor | undefined
  private embedder: TaskEmbedder | undefined
  private onEvent: ((e: ProgressEvent) => void) | undefined

  constructor(opts: ProcessorOptions = {}) {
    this.merlinDir = opts.merlinDir || path.join(process.env.HOME || '~', '.merlin')
    this.claudeProjectsDir = opts.claudeProjectsDir || path.join(process.env.HOME || '~', '.claude', 'projects')
    this.minSizeBytes = opts.minSizeBytes ?? 500
    this.homeDir = opts.homeDir || os.homedir()
    this.onEvent = opts.onEvent
    if (opts.llmProvider) {
      const limiter = createLimiter(opts.llmConcurrency ?? 100)
      this.summarizer = new TurnSummarizer(opts.llmProvider, { limiter, chunkSize: opts.summarizerChunkSize })
      this.conceptExtractor = new TaskConceptExtractor(opts.llmProvider, { limiter })
    }
    if (opts.embeddingProvider) {
      this.embedder = new TaskEmbedder(opts.embeddingProvider)
    }
  }

  /**
   * Check all sessions for a project: compare raw files against stored output.
   * Returns one entry per raw session (excluding tiny files).
   * The caller decides what's pending/outdated/current based on the fingerprints.
   */
  async checkProject(projectCwd: string): Promise<SessionCheck[]> {
    const projectDirName = cwdToProjectDirName(projectCwd)
    const rawSessions = await discoverRawSessions(this.claudeProjectsDir, projectDirName)
    const homeDir = this.homeDir
    const projectRelative = projectCwd.startsWith(`${homeDir}/`) ? projectCwd.slice(homeDir.length + 1) : projectCwd

    // Load indexes for each distinct project dir (parent + nested)
    const indexCache = new Map<string, Map<string, FolderIndexEntry>>()
    const getIndex = async (dirName: string) => {
      if (!indexCache.has(dirName)) {
        const store = new LeanSessionStore(this.merlinDir, dirName)
        const index = await store.readIndex()
        indexCache.set(dirName, new Map(index?.sessions.map((s) => [s.sessionId, s]) ?? []))
      }
      return indexCache.get(dirName)!
    }

    const checks: SessionCheck[] = []
    for (const raw of rawSessions) {
      if (raw.sizeBytes < this.minSizeBytes) continue
      if (await isSessionIgnored(homeDir, `${projectRelative}/${raw.sessionId}`)) continue
      const indexMap = await getIndex(raw.projectDirName)
      const entry = indexMap.get(raw.sessionId)
      checks.push({
        sessionId: raw.sessionId,
        projectDirName: raw.projectDirName,
        rawPath: raw.filePath,
        rawSizeBytes: raw.sizeBytes,
        rawLastModified: raw.lastModified,
        stored: entry ? { sizeBytes: entry.rawSizeBytes, lastModified: entry.rawLastModified } : null,
      })
    }
    return checks
  }

  /**
   * Process all sessions for a project.
   * Only processes sessions that are new or have changed since last processing.
   */
  async processProject(projectCwd: string, opts?: { force?: boolean }): Promise<ProcessResult> {
    const force = opts?.force ?? false
    const projectDirName = cwdToProjectDirName(projectCwd)

    const rawSessions = await discoverRawSessions(this.claudeProjectsDir, projectDirName)
    if (rawSessions.length === 0) {
      return { processed: [], skipped: [], errors: [] }
    }

    // Group sessions by their actual project dir (parent + nested)
    const byDir = new Map<string, typeof rawSessions>()
    for (const raw of rawSessions) {
      const list = byDir.get(raw.projectDirName) || []
      list.push(raw)
      byDir.set(raw.projectDirName, list)
    }

    // Load existing indexes per project dir
    const indexCache = new Map<
      string,
      {
        store: LeanSessionStore
        index: FolderIndex
        existingMap: Map<string, FolderIndexEntry>
      }
    >()
    for (const dirName of byDir.keys()) {
      const store = new LeanSessionStore(this.merlinDir, dirName)
      await store.init()
      const index = (await store.readIndex()) || {
        version: 1 as const,
        projectPath: projectCwd,
        projectDirName: dirName,
        sessions: [] as FolderIndexEntry[],
        lastProcessedAt: '',
      }
      indexCache.set(dirName, {
        store,
        index,
        existingMap: new Map(index.sessions.map((s) => [s.sessionId, s])),
      })
    }

    const result: ProcessResult = { processed: [], skipped: [], errors: [] }
    const homeDir = this.homeDir
    const projectRelative = projectCwd.startsWith(`${homeDir}/`) ? projectCwd.slice(homeDir.length + 1) : projectCwd

    // Reset LLM stats for this run
    llmStats.reset()

    // Collect sessions to process
    const toProcess: Array<{
      raw: (typeof rawSessions)[0]
      existing: FolderIndexEntry | undefined
    }> = []

    for (const raw of rawSessions) {
      if (raw.sizeBytes < this.minSizeBytes) {
        result.skipped.push(raw.sessionId)
        continue
      }

      if (await isSessionIgnored(homeDir, `${projectRelative}/${raw.sessionId}`)) {
        result.skipped.push(raw.sessionId)
        continue
      }

      const { existingMap } = indexCache.get(raw.projectDirName)!
      const existing = existingMap.get(raw.sessionId)
      if (
        !force &&
        existing &&
        existing.rawSizeBytes === raw.sizeBytes &&
        existing.rawLastModified === raw.lastModified
      ) {
        result.skipped.push(raw.sessionId)
        continue
      }

      toProcess.push({ raw, existing })
    }

    // Process sessions in parallel — LLM calls are throttled by the shared limiter
    const total = toProcess.length
    let completed = 0
    if (total > 0) this._log(`processing: 0/${total} sessions`)

    const outcomes = await Promise.allSettled(
      toProcess.map(async ({ raw, existing }) => {
        const { store } = indexCache.get(raw.projectDirName)!
        this.onEvent?.({ kind: 'session-start', cwd: projectCwd, sessionId: raw.sessionId })
        try {
          const entry = await this._processOne(raw, existing, store, raw.projectDirName, projectCwd)
          completed++
          this._log(`processing: ${completed}/${total} sessions (${raw.sessionId.slice(0, 8)} done)`)
          return { sessionId: raw.sessionId, dirName: raw.projectDirName, entry }
        } finally {
          this.onEvent?.({ kind: 'session-done', cwd: projectCwd, sessionId: raw.sessionId })
        }
      }),
    )

    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i]!
      const sessionId = toProcess[i]!.raw.sessionId
      if (outcome.status === 'fulfilled') {
        const { dirName, entry } = outcome.value
        indexCache.get(dirName)!.existingMap.set(sessionId, entry)
        result.processed.push(sessionId)
      } else {
        const errorMessage = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        console.error(`[processor] error processing ${sessionId}:`, errorMessage)
        result.errors.push({ sessionId, error: errorMessage })
      }
    }

    // Write indexes per project dir
    for (const { store, index, existingMap } of indexCache.values()) {
      index.sessions = Array.from(existingMap.values())
      index.lastProcessedAt = new Date().toISOString()
      await store.writeIndex(index)
    }

    // Attach LLM cost stats if summarization was used
    if (llmStats.callCount > 0) {
      result.llmCosts = snapshotLLMCosts()
    }

    return result
  }

  /**
   * Process a single session by ID.
   * Discovers the raw file path internally.
   */
  async processSession(
    projectCwd: string,
    sessionId: string,
    rawFilePath?: string,
  ): Promise<{ ok: boolean; error?: string; llmCosts?: LLMCostStats }> {
    const projectDirName = cwdToProjectDirName(projectCwd)
    llmStats.reset()
    let sessionStartEmitted = false

    try {
      // Discover raw file if path not provided
      let filePath = rawFilePath
      let actualDirName = projectDirName
      if (!filePath) {
        const rawSessions = await discoverRawSessions(this.claudeProjectsDir, projectDirName)
        const found = rawSessions.find((r) => r.sessionId === sessionId)
        if (!found) return { ok: false, error: `Raw session file not found: ${sessionId}` }
        filePath = found.filePath
        actualDirName = found.projectDirName
      }

      // Use the session's actual project dir for storage
      const store = new LeanSessionStore(this.merlinDir, actualDirName)
      await store.init()

      const { stat } = await import('node:fs/promises')
      const fileStat = await stat(filePath)

      // Skip if already processed and unchanged
      const index = await store.readIndex()
      const existing = index?.sessions.find((s) => s.sessionId === sessionId)
      if (
        existing &&
        existing.rawSizeBytes === fileStat.size &&
        existing.rawLastModified === fileStat.mtime.toISOString()
      ) {
        return { ok: true }
      }

      const content = await Bun.file(filePath).text()
      const parsed = parseSessionJsonl(content, sessionId)
      parsed.sessionId = sessionId

      // Read existing session for incremental summary carry-forward
      const existingSession = existing ? await store.readSession(sessionId) : null

      const sid = sessionId.slice(0, 8)
      this.onEvent?.({ kind: 'session-start', cwd: projectCwd, sessionId })
      sessionStartEmitted = true
      const onInner = this._makeInnerForwarder(projectCwd, sessionId, sid)
      const leanSession = await buildLeanSessionWithSubagents(parsed, {
        rawSizeBytes: fileStat.size,
        rawLastModified: fileStat.mtime.toISOString(),
        projectDirName: actualDirName,
        sessionDir: path.dirname(filePath),
        summarizer: this.summarizer,
        onEvent: onInner,
        existingTurns: existingSession?.turns,
        existingTasks: existingSession?.tasks,
        existingContext: existingSession?.summarizationContext as
          | import('./summarizer.ts').SummarizationContext
          | undefined,
      })

      // Extract concepts (only stale tasks)
      if (this.conceptExtractor && leanSession.tasks?.length) {
        await this.conceptExtractor.extractConcepts(leanSession.tasks, leanSession.turns, onInner)
      }

      // Embed tasks (only stale ones)
      if (this.embedder && leanSession.tasks?.length) {
        const existing = (await store.readEmbeddings(sessionId)) ?? emptyEmbeddings()
        const updated = await this.embedder.embedTasks(leanSession.tasks, leanSession.turns, existing, onInner)
        await store.writeEmbeddings(sessionId, updated)
      }

      await store.writeSession(leanSession)

      const segments = segmentByDay(leanSession.turns)
      await store.writeSegments(sessionId, segments)

      // Update index entry
      const updatedIndex = (await store.readIndex()) || {
        version: 1 as const,
        projectPath: projectCwd,
        projectDirName: actualDirName,
        sessions: [] as FolderIndexEntry[],
        lastProcessedAt: '',
      }

      const sessions = updatedIndex.sessions.filter((s) => s.sessionId !== sessionId)
      sessions.push({
        sessionId,
        title: leanSession.header.title,
        startedAt: leanSession.header.startedAt,
        endedAt: leanSession.header.endedAt,
        turnCount: leanSession.header.turnCount,
        userTurnCount: leanSession.header.userTurnCount,
        rawSizeBytes: fileStat.size,
        rawLastModified: fileStat.mtime.toISOString(),
      })
      updatedIndex.sessions = sessions
      updatedIndex.lastProcessedAt = new Date().toISOString()
      await store.writeIndex(updatedIndex)

      const llmCosts = llmStats.callCount > 0 ? snapshotLLMCosts() : undefined
      return { ok: true, llmCosts }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (sessionStartEmitted) {
        this.onEvent?.({ kind: 'session-done', cwd: projectCwd, sessionId })
      }
    }
  }

  /**
   * Re-embed every task in every stored session of a project, ignoring
   * existing embeddings. Intended for tuning the embedding source text or
   * switching models — does not touch summarization, labeling, or segments.
   */
  async reembedProject(projectCwd: string): Promise<ReembedResult> {
    const result: ReembedResult = { sessions: 0, tasks: 0, errors: [] }

    if (!this.embedder) {
      result.skipped = 'no embedding provider configured'
      return result
    }

    const projectDirName = cwdToProjectDirName(projectCwd)
    const dirs = await listMatchingProjectDirs(this.merlinDir, projectDirName)
    if (dirs.length === 0) return result

    llmStats.reset()

    for (const dirName of dirs) {
      const store = new LeanSessionStore(this.merlinDir, dirName)
      const ids = await store.listSessionIds()

      for (const sessionId of ids) {
        try {
          const session = await store.readSession(sessionId)
          if (!session?.tasks?.length) continue

          this.onEvent?.({ kind: 'session-start', cwd: projectCwd, sessionId })
          const sid = sessionId.slice(0, 8)
          const onInner = this._makeInnerForwarder(projectCwd, sessionId, sid)
          try {
            // Pass an empty container so every task counts as missing → re-embedded.
            const updated = await this.embedder.embedTasks(session.tasks, session.turns, emptyEmbeddings(), onInner)
            await store.writeEmbeddings(sessionId, updated)
            result.sessions++
            result.tasks += session.tasks.length
            this._log(`re-embedded ${sid}: ${session.tasks.length} tasks`)
          } finally {
            this.onEvent?.({ kind: 'session-done', cwd: projectCwd, sessionId })
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          result.errors.push({ sessionId, error: message })
          this._log(`re-embed failed ${sessionId.slice(0, 8)}: ${message}`)
        }
      }
    }

    if (llmStats.callCount > 0) result.llmCosts = snapshotLLMCosts()
    return result
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async _processOne(
    raw: { sessionId: string; filePath: string; sizeBytes: number; lastModified: string; projectDirName: string },
    existing: FolderIndexEntry | undefined,
    store: LeanSessionStore,
    _projectDirName: string,
    projectCwd: string,
  ): Promise<FolderIndexEntry> {
    const content = await Bun.file(raw.filePath).text()
    const parsed = parseSessionJsonl(content, raw.sessionId)
    parsed.sessionId = raw.sessionId

    const sid = raw.sessionId.slice(0, 8)
    const onInner = this._makeInnerForwarder(projectCwd, raw.sessionId, sid)
    const buildOpts = {
      rawSizeBytes: raw.sizeBytes,
      rawLastModified: raw.lastModified,
      projectDirName: raw.projectDirName,
      sessionDir: path.dirname(raw.filePath),
      summarizer: this.summarizer,
      onEvent: onInner,
    }

    // Try incremental update first
    let leanSession = null
    if (existing) {
      const existingSession = await store.readSession(raw.sessionId)
      if (existingSession) {
        leanSession = await updateLeanSession(existingSession, parsed, buildOpts)
      }
    }

    // Full build if incremental update didn't apply
    if (!leanSession) {
      leanSession = await buildLeanSessionWithSubagents(parsed, {
        ...buildOpts,
        existingTasks: undefined,
      })
    }

    // Extract concepts (only stale tasks)
    if (this.conceptExtractor && leanSession.tasks?.length) {
      await this.conceptExtractor.extractConcepts(leanSession.tasks, leanSession.turns, onInner)
    }

    // Embed tasks (only stale ones)
    if (this.embedder && leanSession.tasks?.length) {
      const existing = (await store.readEmbeddings(raw.sessionId)) ?? emptyEmbeddings()
      const updated = await this.embedder.embedTasks(leanSession.tasks, leanSession.turns, existing, onInner)
      await store.writeEmbeddings(raw.sessionId, updated)
    }

    await store.writeSession(leanSession)

    const segments = segmentByDay(leanSession.turns)
    await store.writeSegments(raw.sessionId, segments)

    return {
      sessionId: raw.sessionId,
      title: leanSession.header.title,
      startedAt: leanSession.header.startedAt,
      endedAt: leanSession.header.endedAt,
      turnCount: leanSession.header.turnCount,
      userTurnCount: leanSession.header.userTurnCount,
      rawSizeBytes: raw.sizeBytes,
      rawLastModified: raw.lastModified,
    }
  }

  // -------------------------------------------------------------------------
  // Event helpers
  // -------------------------------------------------------------------------

  private _log(msg: string): void {
    this.onEvent?.({ kind: 'log', msg })
  }

  /**
   * Build an InnerProgressEvent forwarder that enriches `turns`/`tasks` events
   * with cwd+sessionId and prefixes log lines with the short session id.
   */
  private _makeInnerForwarder(cwd: string, sessionId: string, sid: string): (e: InnerProgressEvent) => void {
    return (e) => {
      if (!this.onEvent) return
      if (e.kind === 'log') {
        this.onEvent({ kind: 'log', msg: `[${sid}] ${e.msg}` })
      } else if (e.kind === 'turns') {
        this.onEvent({ kind: 'turns', cwd, sessionId, done: e.done, discovered: e.discovered })
      } else if (e.kind === 'tasks') {
        this.onEvent({ kind: 'tasks', cwd, sessionId, done: e.done, discovered: e.discovered })
      } else if (e.kind === 'embeddings') {
        this.onEvent({ kind: 'embeddings', cwd, sessionId, done: e.done, discovered: e.discovered })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LLM cost helpers
// ---------------------------------------------------------------------------

function snapshotLLMCosts(): LLMCostStats {
  const perModel = llmStats.stats()
  let calls = 0,
    inputTokens = 0,
    outputTokens = 0,
    totalMs = 0
  for (const s of perModel.values()) {
    calls += s.calls
    inputTokens += s.inputTokens
    outputTokens += s.outputTokens
    totalMs += s.totalMs
  }
  return {
    calls,
    inputTokens,
    outputTokens,
    totalMs,
    perModel,
    summary: llmStats.summary(),
  }
}
