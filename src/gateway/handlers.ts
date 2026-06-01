/**
 * Gateway data handlers: serve session data to clients on request.
 */

import type { EmbeddingProvider } from '@merlin/llm'
import { cwdToProjectDirName, LeanSessionStore, parseSessionJsonl, type SessionTask } from '@merlin/processor'
import type { MerlinModel } from '@merlin/protocol'
import type { SyncEngine } from '@merlin/sync'
import type { LogFn } from '../daemon.ts'

export class DataHandlers {
  constructor(
    private syncEngine: SyncEngine,
    private merlinDir: string,
    private claudeProjectsDir: string,
    private log: LogFn,
    private embeddingProvider: EmbeddingProvider | undefined = undefined,
    /** Getter for current model. Used to filter on-disk session ids by .merlinignore. */
    private getModel: (() => MerlinModel) | undefined = undefined,
  ) {}

  /** SessionIds the current model knows about for this cwd (post-merlinignore). */
  private allowedSessionIds(cwd: string): Set<string> | null {
    if (!this.getModel) return null
    const project = this.getModel().projects[cwd]
    if (!project) return new Set()
    return new Set(project.sessions.map((s) => s.sessionId))
  }

  async handleGetSegments(clientId: string, cwd: string): Promise<void> {
    // Legacy endpoint — returns empty. Use get_session_segments instead.
    this.syncEngine.sendToClient(clientId, { type: 'segments', cwd, sessions: [] })
  }

  async handleGetRawTurns(
    clientId: string,
    cwd: string,
    sessionId: string,
    offset?: number,
    limit?: number,
  ): Promise<void> {
    const projectDirName = cwdToProjectDirName(cwd)
    const jsonlPath = `${this.claudeProjectsDir}/${projectDirName}/${sessionId}.jsonl`

    try {
      const content = await Bun.file(jsonlPath).text()
      const parsed = parseSessionJsonl(content, sessionId)
      const total = parsed.turns.length
      const start = offset ?? 0
      const end = limit ? start + limit : total
      const turns = parsed.turns.slice(start, end)

      this.syncEngine.sendToClient(clientId, {
        type: 'raw_turns',
        cwd,
        sessionId,
        turns,
        total,
        title: parsed.title,
      })
    } catch (err) {
      this.log(`get_raw_turns failed for ${sessionId}: ${err instanceof Error ? err.message : err}`)
      this.syncEngine.sendToClient(clientId, {
        type: 'raw_turns',
        cwd,
        sessionId,
        turns: [],
        total: 0,
        title: null,
      })
    }
  }

  async handleGetLeanTurns(clientId: string, cwd: string, sessionId: string): Promise<void> {
    try {
      const store = new LeanSessionStore(this.merlinDir, cwdToProjectDirName(cwd))
      const session = await store.readSession(sessionId)

      this.syncEngine.sendToClient(clientId, {
        type: 'lean_turns',
        cwd,
        sessionId,
        title: session?.header.title ?? null,
        turns: session?.turns ?? [],
        tasks: session?.tasks ?? [],
      })
    } catch (err) {
      this.log(`get_lean_turns failed for ${sessionId}: ${err instanceof Error ? err.message : err}`)
      this.syncEngine.sendToClient(clientId, {
        type: 'lean_turns',
        cwd,
        sessionId,
        title: null,
        turns: [],
      })
    }
  }

  async handleGetProjectTasks(clientId: string, cwd: string): Promise<void> {
    const tasksBySession: Record<string, SessionTask[]> = {}
    try {
      const store = new LeanSessionStore(this.merlinDir, cwdToProjectDirName(cwd))
      // Filter by the current model's filtered session list so ignored/archived
      // sessions (per .merlinignore) never leak to clients, even if old
      // processed data still sits on disk. Fall back to the raw disk listing
      // only if no model getter was provided (backwards-compat for tests).
      const allowed = this.allowedSessionIds(cwd)
      const sessionIds = allowed ? Array.from(allowed) : await store.listSessionIds()
      await Promise.all(
        sessionIds.map(async (sessionId) => {
          const tasks = await store.readTasks(sessionId)
          if (tasks && tasks.length > 0) tasksBySession[sessionId] = tasks
        }),
      )
    } catch (err) {
      this.log(`get_project_tasks failed for ${cwd}: ${err instanceof Error ? err.message : err}`)
    }
    this.syncEngine.sendToClient(clientId, { type: 'project_tasks', cwd, tasksBySession })
  }

  async handleSearchTasks(
    clientId: string,
    cwd: string,
    query: string,
    requestId: string,
    limit?: number,
  ): Promise<void> {
    const send = (
      results: Array<{ sessionId: string; taskId: string; score: number; task: SessionTask }>,
      error?: string,
    ): void => {
      this.syncEngine.sendToClient(clientId, {
        type: 'search_tasks_results',
        cwd,
        query,
        requestId,
        results,
        error,
      })
    }

    if (!this.embeddingProvider) {
      send([], 'Semantic search disabled: no embedding provider configured (set PROCESSOR_EMBEDDING_MODEL).')
      return
    }
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      send([])
      return
    }

    try {
      const store = new LeanSessionStore(this.merlinDir, cwdToProjectDirName(cwd))
      const sessionIds = await store.listSessionIds()

      // Embed the query alongside loading task data, in parallel.
      // Use RETRIEVAL_QUERY so the vector lands in the same retrieval-tuned
      // space as the stored RETRIEVAL_DOCUMENT task vectors (Gemini only;
      // OpenAI ignores).
      const [queryEmbed, taskBundles] = await Promise.all([
        this.embeddingProvider.embed([trimmed], { taskType: 'RETRIEVAL_QUERY' }),
        Promise.all(
          sessionIds.map(async (sessionId) => {
            const [tasks, embeddings] = await Promise.all([store.readTasks(sessionId), store.readEmbeddings(sessionId)])
            return { sessionId, tasks, embeddings }
          }),
        ),
      ])

      const queryVec = queryEmbed.vectors[0]
      if (!queryVec) {
        send([], 'Embedding provider returned no vector')
        return
      }
      const qNorm = norm(queryVec)
      if (qNorm === 0) {
        send([])
        return
      }

      type Hit = { sessionId: string; taskId: string; score: number; task: SessionTask }
      const hits: Hit[] = []

      for (const { sessionId, tasks, embeddings } of taskBundles) {
        if (!tasks || !embeddings) continue
        for (const task of tasks) {
          const e = embeddings.taskEmbeddings[task.id]
          if (!e) continue
          if (e.dim !== queryVec.length) continue // model mismatch — skip
          const score = cosine(queryVec, e.vector, qNorm)
          hits.push({ sessionId, taskId: task.id, score, task })
        }
      }

      hits.sort((a, b) => b.score - a.score)
      const cap = limit ?? 50
      send(hits.slice(0, cap))
    } catch (err) {
      this.log(`search_tasks failed for ${cwd}: ${err instanceof Error ? err.message : err}`)
      send([], err instanceof Error ? err.message : String(err))
    }
  }

  async handleGetSessionSegments(clientId: string, cwd: string, sessionId: string): Promise<void> {
    try {
      const store = new LeanSessionStore(this.merlinDir, cwdToProjectDirName(cwd))
      const segments = await store.readSegments(sessionId)

      this.syncEngine.sendToClient(clientId, {
        type: 'session_segments',
        cwd,
        sessionId,
        segments: segments ?? [],
      })
    } catch (err) {
      this.log(`get_session_segments failed for ${sessionId}: ${err instanceof Error ? err.message : err}`)
      this.syncEngine.sendToClient(clientId, {
        type: 'session_segments',
        cwd,
        sessionId,
        segments: [],
      })
    }
  }
}

function norm(v: number[]): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!
  return Math.sqrt(s)
}

/** Cosine similarity, with the query's norm precomputed. */
function cosine(q: number[], v: number[], qNorm: number): number {
  let dot = 0
  let vNorm = 0
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!
    const b = v[i]!
    dot += a * b
    vNorm += b * b
  }
  const denom = qNorm * Math.sqrt(vNorm)
  return denom === 0 ? 0 : dot / denom
}
