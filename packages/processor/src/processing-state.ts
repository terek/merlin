/**
 * In-memory processing state tracker.
 *
 * Tracks per-session processing status (missing, running, processed,
 * outdated, error). Initialized from Processor.checkProject() and updated
 * as processing runs.
 */

import type { PreprocessingStatus } from '@merlin/cc'
import type { ProcessResult, SessionCheck } from './processor.ts'

/** Aggregate stats across sessions in a project. */
export interface PreprocessingStats {
  total: number
  processed: number
  running: number
  error: number
  outdated: number
  missing: number
}

export interface SessionProcessingState {
  status: PreprocessingStatus
  errorMessage?: string
  userTurnCount?: number
}

export class ProcessingState {
  /** project cwd -> sessionId -> state */
  private state = new Map<string, Map<string, SessionProcessingState>>()

  /** Initialize/refresh state for a project from checkProject results. */
  applyChecks(cwd: string, checks: SessionCheck[]): void {
    const map = this.state.get(cwd) || new Map()

    // Preserve in-flight "running" state -- don't overwrite with check results
    const preserved = new Map<string, SessionProcessingState>()
    for (const [id, s] of map) {
      if (s.status === 'running') preserved.set(id, s)
    }

    // Build fresh state from checks
    const fresh = new Map<string, SessionProcessingState>()
    for (const check of checks) {
      if (preserved.has(check.sessionId)) {
        fresh.set(check.sessionId, preserved.get(check.sessionId)!)
        continue
      }

      if (!check.stored) {
        fresh.set(check.sessionId, { status: 'missing' })
      } else if (check.stored.sizeBytes === check.rawSizeBytes && check.stored.lastModified === check.rawLastModified) {
        const existing = map.get(check.sessionId)
        fresh.set(check.sessionId, {
          status: 'processed',
          userTurnCount: existing?.userTurnCount,
        })
      } else {
        fresh.set(check.sessionId, { status: 'outdated' })
      }
    }

    this.state.set(cwd, fresh)
  }

  /** Mark a session as running (for immediate UI feedback). */
  markRunning(cwd: string, sessionId: string): void {
    const map = this._getOrCreate(cwd)
    const existing = map.get(sessionId)
    map.set(sessionId, { ...existing, status: 'running', errorMessage: undefined })
  }

  /** Apply results from processProject or processSession. */
  applyResult(cwd: string, result: ProcessResult): void {
    const map = this._getOrCreate(cwd)
    for (const id of result.processed) {
      map.set(id, { status: 'processed' })
    }
    for (const { sessionId, error } of result.errors) {
      map.set(sessionId, { status: 'error', errorMessage: error })
    }
  }

  /** Apply result from a single processSession call. */
  applySessionResult(cwd: string, sessionId: string, result: { ok: boolean; error?: string }): void {
    const map = this._getOrCreate(cwd)
    if (result.ok) {
      map.set(sessionId, { status: 'processed' })
    } else {
      map.set(sessionId, { status: 'error', errorMessage: result.error })
    }
  }

  /** Mark a session as deleted (remove from state). */
  deleteSession(cwd: string, sessionId: string): void {
    const map = this.state.get(cwd)
    if (map) map.delete(sessionId)
  }

  /** Clear all state for a project. */
  deleteProject(cwd: string): void {
    this.state.delete(cwd)
  }

  /** Get status for a single session. */
  getStatus(cwd: string, sessionId: string): SessionProcessingState | undefined {
    return this.state.get(cwd)?.get(sessionId)
  }

  /** Get all session statuses for a project. */
  getProjectState(cwd: string): Map<string, SessionProcessingState> {
    return this.state.get(cwd) || new Map()
  }

  /** Compute aggregate stats for a project. */
  getStats(cwd: string): PreprocessingStats | undefined {
    const map = this.state.get(cwd)
    if (!map || map.size === 0) return undefined

    let total = 0,
      processed = 0,
      running = 0,
      error = 0,
      outdated = 0,
      missing = 0
    for (const s of map.values()) {
      total++
      switch (s.status) {
        case 'processed':
          processed++
          break
        case 'running':
          running++
          break
        case 'error':
          error++
          break
        case 'outdated':
          outdated++
          break
        case 'missing':
          missing++
          break
      }
    }
    return { total, processed, running, error, outdated, missing }
  }

  private _getOrCreate(cwd: string): Map<string, SessionProcessingState> {
    let map = this.state.get(cwd)
    if (!map) {
      map = new Map()
      this.state.set(cwd, map)
    }
    return map
  }
}
