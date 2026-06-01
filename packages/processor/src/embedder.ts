/**
 * Task-level embeddings.
 *
 * Computes dense vector embeddings for each task using the task description
 * plus the summaries of all turns assigned to it. Stored separately from
 * tasks.json so vectors don't bloat the file we read on every render.
 *
 * Staleness detection mirrors TaskConceptExtractor: each embedding records
 * the task.contentHash it was derived from. When contentHash changes, the
 * embedding is recomputed.
 */

import type { EmbeddingProvider } from '@merlin/llm'
import type { InnerProgressEvent } from './progress.ts'
import type { LeanTurn, SessionEmbeddings, SessionTask, TaskEmbedding } from './schema.ts'

export interface EmbedderOptions {
  /** Maximum chars of source text per task (truncate if longer). */
  maxChars?: number
}

const DEFAULT_MAX_CHARS = 8000

export class TaskEmbedder {
  private provider: EmbeddingProvider
  private maxChars: number

  constructor(provider: EmbeddingProvider, opts: EmbedderOptions = {}) {
    this.provider = provider
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  }

  /**
   * Compute embeddings for any tasks whose contentHash differs from the
   * stored embedding's sourceHash. Removes embeddings for tasks that no
   * longer exist. Returns the updated embedding map (mutates `existing`).
   */
  async embedTasks(
    tasks: SessionTask[],
    turns: LeanTurn[],
    existing: SessionEmbeddings,
    onEvent?: (e: InnerProgressEvent) => void,
  ): Promise<SessionEmbeddings> {
    // Drop entries for tasks that no longer exist
    const liveIds = new Set(tasks.map((t) => t.id))
    for (const id of Object.keys(existing.taskEmbeddings)) {
      if (!liveIds.has(id)) delete existing.taskEmbeddings[id]
    }

    const stale = tasks.filter((t) => {
      const e = existing.taskEmbeddings[t.id]
      // Untyped (legacy) or wrong-typed vectors are also stale — they were
      // produced symmetrically and should be regenerated as RETRIEVAL_DOCUMENT.
      return !e || e.sourceHash !== t.contentHash || e.taskType !== 'RETRIEVAL_DOCUMENT'
    })

    if (stale.length === 0) return existing

    const turnByIndex = new Map<number, LeanTurn>()
    for (const turn of turns) turnByIndex.set(turn.index + 1, turn)

    const sources = stale.map((t) => this._buildSource(t, turnByIndex))

    onEvent?.({ kind: 'log', msg: `embedding: 0/${stale.length} tasks` })
    onEvent?.({ kind: 'embeddings', done: 0, discovered: stale.length })

    const result = await this.provider.embed(sources, { taskType: 'RETRIEVAL_DOCUMENT' })

    for (let i = 0; i < stale.length; i++) {
      const task = stale[i]!
      const vector = result.vectors[i]
      if (!vector) continue
      const embedding: TaskEmbedding = {
        vector,
        model: result.model,
        dim: vector.length,
        sourceHash: task.contentHash,
        taskType: 'RETRIEVAL_DOCUMENT',
      }
      existing.taskEmbeddings[task.id] = embedding
    }

    onEvent?.({ kind: 'log', msg: `embedding: ${stale.length}/${stale.length} tasks` })
    onEvent?.({ kind: 'embeddings', done: stale.length, discovered: stale.length })

    return existing
  }

  private _buildSource(task: SessionTask, turnByIndex: Map<number, LeanTurn>): string {
    const turnLines: string[] = []
    for (const idx of task.turns) {
      const turn = turnByIndex.get(idx)
      if (!turn) continue
      const u = turn.userSummary ?? truncate(turn.userText)
      const a = turn.agentSummary ?? truncate(turn.agentText)
      turnLines.push(`[Turn ${idx}] User: ${u}\nAgent: ${a}`)
    }

    const text = `Task: ${task.description}\n\n${turnLines.join('\n\n')}`
    return text.length > this.maxChars ? text.slice(0, this.maxChars) : text
  }
}

function truncate(text: string, maxLength = 200): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3)}...`
}

/** Build an empty SessionEmbeddings container. */
export function emptyEmbeddings(): SessionEmbeddings {
  return { version: 1, taskEmbeddings: {} }
}
