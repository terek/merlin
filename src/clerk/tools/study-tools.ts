/**
 * Study tools — inspect processed project data (sessions, tasks, concepts,
 * lean turns, raw turns) stored under ~/.merlin/projects/<project-dir>/.
 *
 * Bound to a project cwd. Powers the Study mode agent: the user is reading
 * back through what was done in this project's coding sessions, not editing.
 */

import path from 'node:path'
import type { EmbeddingProvider } from '@merlin/llm'
import {
  cwdToProjectDirName,
  type LeanSessionHeader,
  LeanSessionStore,
  type LeanTurn,
  type ParsedTurn,
  parseSessionJsonl,
  type SessionTask,
} from '@merlin/processor'

export interface SessionSummary {
  sessionId: string
  title: string | null
  startedAt: string
  endedAt: string
  turnCount: number
  userTurnCount: number
  taskCount: number
}

export interface TaskSummary {
  sessionId: string
  taskId: string
  description: string
  concepts?: Array<{ concept: string; description: string }>
  turnIndices: number[]
  startedAt?: number
  endedAt?: number
}

export interface TaskSearchHit extends TaskSummary {
  score: number
}

export class StudyTools {
  private store: LeanSessionStore

  constructor(
    merlinDir: string,
    private claudeProjectsDir: string,
    private cwd: string,
    private embeddingProvider?: EmbeddingProvider,
  ) {
    this.store = new LeanSessionStore(merlinDir, cwdToProjectDirName(cwd))
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  async listSessions(): Promise<SessionSummary[]> {
    const index = await this.store.readIndex()
    if (!index) return []
    const out: SessionSummary[] = []
    for (const s of index.sessions) {
      const tasks = await this.store.readTasks(s.sessionId)
      out.push({
        sessionId: s.sessionId,
        title: s.title,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        turnCount: s.turnCount,
        userTurnCount: s.userTurnCount,
        taskCount: tasks?.length ?? 0,
      })
    }
    out.sort((a, b) => b.endedAt.localeCompare(a.endedAt))
    return out
  }

  async getSessionHeader(sessionId: string): Promise<LeanSessionHeader | { error: string }> {
    const header = await this.store.readHeader(sessionId)
    if (!header) return { error: `Session ${sessionId} not found in processed data for this project` }
    return header
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  async listTasks(): Promise<TaskSummary[]> {
    const sessionIds = await this.store.listSessionIds()
    const out: TaskSummary[] = []
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        const tasks = await this.store.readTasks(sessionId)
        if (!tasks) return
        for (const t of tasks) out.push(taskToSummary(sessionId, t))
      }),
    )
    out.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    return out
  }

  async getTask(sessionId: string, taskId: string): Promise<TaskSummary | { error: string }> {
    const tasks = await this.store.readTasks(sessionId)
    const task = tasks?.find((t) => t.id === taskId)
    if (!task) return { error: `Task ${taskId} not found in session ${sessionId}` }
    return taskToSummary(sessionId, task)
  }

  async searchTasks(query: string, limit: number = 10): Promise<TaskSearchHit[] | { error: string }> {
    const trimmed = query.trim()
    if (!trimmed) return []
    if (!this.embeddingProvider) {
      return { error: 'Semantic task search unavailable: no embedding provider configured.' }
    }

    const [queryEmbed, taskBundles] = await Promise.all([
      this.embeddingProvider.embed([trimmed], { taskType: 'RETRIEVAL_QUERY' }),
      this.loadAllTaskBundles(),
    ])
    const queryVec = queryEmbed.vectors[0]
    if (!queryVec) return { error: 'Embedding provider returned no vector' }
    const qNorm = norm(queryVec)
    if (qNorm === 0) return []

    const hits: TaskSearchHit[] = []
    for (const { sessionId, tasks, embeddings } of taskBundles) {
      if (!tasks || !embeddings) continue
      for (const task of tasks) {
        const e = embeddings.taskEmbeddings[task.id]
        if (!e || e.dim !== queryVec.length) continue
        const score = cosine(queryVec, e.vector, qNorm)
        hits.push({ ...taskToSummary(sessionId, task), score })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  private async loadAllTaskBundles() {
    const sessionIds = await this.store.listSessionIds()
    return Promise.all(
      sessionIds.map(async (sessionId) => {
        const [tasks, embeddings] = await Promise.all([
          this.store.readTasks(sessionId),
          this.store.readEmbeddings(sessionId),
        ])
        return { sessionId, tasks, embeddings }
      }),
    )
  }

  // ── Turns ───────────────────────────────────────────────────────────────

  /** Lean (summarised) turns by half-open index range [start, end). */
  async getLeanTurns(sessionId: string, start: number, end: number): Promise<LeanTurn[] | { error: string }> {
    const session = await this.store.readSession(sessionId)
    if (!session) return { error: `Session ${sessionId} not found in processed data for this project` }
    return session.turns.slice(start, end)
  }

  /** Raw (full) turns from the original Claude Code JSONL. Use sparingly. */
  async getRawTurns(sessionId: string, start: number, end: number): Promise<ParsedTurn[] | { error: string }> {
    const projectDirName = cwdToProjectDirName(this.cwd)
    const jsonlPath = path.join(this.claudeProjectsDir, projectDirName, `${sessionId}.jsonl`)
    try {
      const content = await Bun.file(jsonlPath).text()
      const parsed = parseSessionJsonl(content, sessionId)
      return parsed.turns.slice(start, end)
    } catch {
      return { error: `Raw session file not found at ${jsonlPath}` }
    }
  }
}

function taskToSummary(sessionId: string, t: SessionTask): TaskSummary {
  return {
    sessionId,
    taskId: t.id,
    description: t.description,
    concepts: t.concepts?.items,
    turnIndices: t.turns,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
  }
}

function norm(v: number[]): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!
  return Math.sqrt(s)
}

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
