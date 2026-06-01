/**
 * ProcessingQueue -- controlled async queue for session/project processing.
 *
 * Accepts enqueue requests from callers (daemon), deduplicates across job
 * types, processes up to maxConcurrent jobs in parallel, and persists state
 * to disk so interrupted jobs are resumed after a daemon restart.
 */

import os from 'node:os'
import type { LLMCostStats, Processor, ProcessResult } from './processor.ts'

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

export interface ProjectJob {
  type: 'project'
  /** Dedup key: the cwd itself. */
  id: string
  cwd: string
  enqueuedAt: string
}

export interface SessionJob {
  type: 'session'
  /** Dedup key: `${cwd}::${sessionId}`. */
  id: string
  cwd: string
  sessionId: string
  enqueuedAt: string
}

export interface AllJob {
  type: 'all'
  /** Dedup key: always 'all'. */
  id: 'all'
  enqueuedAt: string
}

export type ProcessingJob = ProjectJob | SessionJob | AllJob

/** Return type of a single-session processSession call. */
export type SessionResult = { ok: boolean; error?: string; llmCosts?: LLMCostStats }

/**
 * What callers pass to enqueue() — no id or timestamp needed from the caller.
 */
export type EnqueueRequest =
  | { type: 'project'; cwd: string }
  | { type: 'session'; cwd: string; sessionId: string }
  | { type: 'all' }

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ProcessingQueueOptions {
  /** Max jobs executing concurrently. Default: 2. */
  maxConcurrent?: number
  /** Path to the JSON persistence file. Default: ~/.merlin/processing-queue.json */
  persistPath?: string
  /**
   * Called when an 'all' job executes to get the current list of project cwds.
   * Invoked at execution time (not enqueue time) so it reflects current state.
   */
  resolveAllProjects?: () => string[]
  /** Called when a job begins executing. May be async. */
  onJobStart?: (job: ProcessingJob) => void | Promise<void>
  /** Called when a job completes successfully. May be async. */
  onJobComplete?: (job: ProcessingJob, result: ProcessResult | SessionResult) => void | Promise<void>
  /** Called when a job throws an unhandled error. May be async. */
  onJobError?: (job: ProcessingJob, error: Error) => void | Promise<void>
  /**
   * Called when the last active job for a cwd finishes (project + session jobs
   * for that cwd all drained). Use this as the single broadcast point for UI
   * updates rather than refreshing after every individual job.
   */
  onProjectDrained?: (cwd: string) => void | Promise<void>
}

// ---------------------------------------------------------------------------
// Persistence schema
// ---------------------------------------------------------------------------

interface PersistedState {
  version: 1
  pending: ProcessingJob[]
  running: ProcessingJob[]
}

// ---------------------------------------------------------------------------
// Queue implementation
// ---------------------------------------------------------------------------

function deriveId(req: EnqueueRequest): string {
  if (req.type === 'project') return req.cwd
  if (req.type === 'session') return `${req.cwd}::${req.sessionId}`
  return 'all'
}

export class ProcessingQueue {
  private _pending: ProcessingJob[] = []
  private _pendingIds = new Set<string>()
  /** id → job for currently executing jobs. */
  private _running = new Map<string, ProcessingJob>()
  /** cwd → Set of jobIds actively processing for that project. */
  private _activeByProject = new Map<string, Set<string>>()

  private readonly maxConcurrent: number
  private readonly persistPath: string

  constructor(
    private readonly processor: Processor,
    private readonly opts: ProcessingQueueOptions = {},
  ) {
    this.maxConcurrent = opts.maxConcurrent ?? 2
    const defaultMerlinDir = `${os.homedir()}/.merlin`
    this.persistPath = opts.persistPath ?? `${defaultMerlinDir}/processing-queue.json`
  }

  /**
   * Load persisted queue state and begin draining.
   * Must be called once before enqueuing (typically in daemon start()).
   */
  async init(): Promise<void> {
    try {
      const file = Bun.file(this.persistPath)
      if (await file.exists()) {
        const state = (await file.json()) as PersistedState
        if (state?.version === 1) {
          // Jobs in 'running' state were interrupted mid-execution — restore as pending.
          const toRestore = [...(state.running ?? []), ...(state.pending ?? [])]
          for (const job of toRestore) {
            if (!this._pendingIds.has(job.id)) {
              this._pending.push(job)
              this._pendingIds.add(job.id)
            }
          }
        }
      }
    } catch {
      // Corrupted or missing — start with empty queue.
    }
    this._drain()
  }

  /**
   * Add a job to the queue. Silently deduplicates:
   * - session(cwd) dropped if project(cwd) is pending/running
   * - project(cwd) cancels pending session(cwd,*) jobs (subsumed)
   * - duplicate jobs (same id) dropped
   * - 'all' dropped if another 'all' is pending; when expanding, skips
   *   cwds that are already pending/running
   */
  enqueue(req: EnqueueRequest): void {
    const id = deriveId(req)

    // Cross-type dedup: session subsumed by a pending/running project job.
    if (req.type === 'session' && (this._pendingIds.has(req.cwd) || this._running.has(req.cwd))) {
      return
    }

    // New project supersedes pending (not running) session jobs for same cwd.
    if (req.type === 'project') {
      const before = this._pending.length
      this._pending = this._pending.filter((j) => {
        if (j.type === 'session' && j.cwd === req.cwd) {
          this._pendingIds.delete(j.id)
          return false
        }
        return true
      })
      void before // suppress unused-var warning
    }

    // Standard dedup: same job already queued or running.
    if (this._pendingIds.has(id) || this._running.has(id)) {
      return
    }

    const job = {
      ...req,
      id,
      enqueuedAt: new Date().toISOString(),
    } as ProcessingJob

    this._pending.push(job)
    this._pendingIds.add(id)
    void this._persist()
    this._drain()
  }

  get pendingCount(): number {
    return this._pending.length
  }

  get runningCount(): number {
    return this._running.size
  }

  /** Snapshot of queue state (for diagnostics / tests). */
  getState(): { pending: ProcessingJob[]; running: ProcessingJob[] } {
    return {
      pending: [...this._pending],
      running: [...this._running.values()],
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _drain(): void {
    while (this._running.size < this.maxConcurrent && this._pending.length > 0) {
      const job = this._pending.shift()!
      this._pendingIds.delete(job.id)
      this._running.set(job.id, job)

      // Track per-project active job count (only for jobs with a cwd).
      if (job.type !== 'all') {
        let set = this._activeByProject.get(job.cwd)
        if (!set) {
          set = new Set()
          this._activeByProject.set(job.cwd, set)
        }
        set.add(job.id)
      }

      void this._executeJob(job)
    }
    void this._persist()
  }

  private async _executeJob(job: ProcessingJob): Promise<void> {
    try {
      await (this.opts.onJobStart?.(job) ?? Promise.resolve())

      let result: ProcessResult | SessionResult
      try {
        result = await this._run(job)
        await (this.opts.onJobComplete?.(job, result) ?? Promise.resolve())
      } catch (err) {
        await (this.opts.onJobError?.(job, err instanceof Error ? err : new Error(String(err))) ?? Promise.resolve())
      } finally {
        this._running.delete(job.id)

        if (job.type !== 'all') {
          const set = this._activeByProject.get(job.cwd)
          if (set) {
            set.delete(job.id)
            if (set.size === 0) {
              this._activeByProject.delete(job.cwd)
              await (this.opts.onProjectDrained?.(job.cwd) ?? Promise.resolve())
            }
          }
        }

        void this._persist()
        this._drain()
      }
    } catch (err) {
      // A callback threw — shouldn't happen, but don't crash the queue.
      console.error('[ProcessingQueue] unexpected callback error:', err)
      // Ensure the job is removed from running and the queue continues.
      if (this._running.has(job.id)) {
        this._running.delete(job.id)
        if (job.type !== 'all') {
          const set = this._activeByProject.get(job.cwd)
          if (set) {
            set.delete(job.id)
            if (set.size === 0) this._activeByProject.delete(job.cwd)
          }
        }
        void this._persist()
        this._drain()
      }
    }
  }

  private async _run(job: ProcessingJob): Promise<ProcessResult | SessionResult> {
    if (job.type === 'project') {
      return this.processor.processProject(job.cwd)
    }
    if (job.type === 'session') {
      return this.processor.processSession(job.cwd, job.sessionId)
    }
    // 'all' job: expand into individual project jobs at execution time so the
    // project list reflects current state (not the state when enqueued).
    const cwds = this.opts.resolveAllProjects?.() ?? []
    for (const cwd of cwds) {
      this.enqueue({ type: 'project', cwd })
    }
    // The 'all' job itself is just a dispatcher; return an empty result.
    return { processed: [], skipped: [], errors: [] }
  }

  private async _persist(): Promise<void> {
    const state: PersistedState = {
      version: 1,
      pending: [...this._pending],
      running: [...this._running.values()],
    }
    try {
      await Bun.write(this.persistPath, JSON.stringify(state, null, 2))
    } catch {
      // Non-critical — queue continues operating without persistence.
    }
  }
}
