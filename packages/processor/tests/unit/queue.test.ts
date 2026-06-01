import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Processor } from '../../src/processor.ts'
import type { ProcessingJob, ProcessResult, SessionResult } from '../../src/queue.ts'
import { ProcessingQueue } from '../../src/queue.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deferred promise for controlling when mocked processing resolves. */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Yield to microtask queue so fire-and-forget async calls settle. */
const tick = () => Bun.sleep(1)

/** Create a mock Processor with controllable promises per cwd/sessionId. */
function mockProcessor() {
  const projectCalls: Array<{ cwd: string; resolve: (r: ProcessResult) => void; reject: (e: Error) => void }> = []
  const sessionCalls: Array<{
    cwd: string
    sessionId: string
    resolve: (r: SessionResult) => void
    reject: (e: Error) => void
  }> = []

  const processor = {
    processProject(cwd: string): Promise<ProcessResult> {
      const d = deferred<ProcessResult>()
      projectCalls.push({ cwd, resolve: d.resolve, reject: d.reject })
      return d.promise
    },
    processSession(cwd: string, sessionId: string): Promise<SessionResult> {
      const d = deferred<SessionResult>()
      sessionCalls.push({ cwd, sessionId, resolve: d.resolve, reject: d.reject })
      return d.promise
    },
  } as unknown as Processor

  return { processor, projectCalls, sessionCalls }
}

const okResult: ProcessResult = { processed: ['s1'], skipped: [], errors: [] }
const okSession: SessionResult = { ok: true }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProcessingQueue', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'queue-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  function persistPath() {
    return path.join(tmpDir, 'queue.json')
  }

  // ── Basic enqueue + execution ──────────────────────────────────────────

  test('processes a project job', async () => {
    const { processor, projectCalls } = mockProcessor()
    const started: ProcessingJob[] = []
    const completed: ProcessingJob[] = []

    const q = new ProcessingQueue(processor, {
      persistPath: persistPath(),
      onJobStart: (j) => {
        started.push(j)
      },
      onJobComplete: (j) => {
        completed.push(j)
      },
    })
    await q.init()

    q.enqueue({ type: 'project', cwd: '/a' })
    await tick()

    expect(q.runningCount).toBe(1)
    expect(q.pendingCount).toBe(0)
    expect(projectCalls.length).toBe(1)

    projectCalls[0].resolve(okResult)
    await tick()

    expect(started.length).toBe(1)
    expect(started[0].type).toBe('project')
    expect(completed.length).toBe(1)
    expect(q.runningCount).toBe(0)
  })

  test('processes a session job', async () => {
    const { processor, sessionCalls } = mockProcessor()
    const completed: Array<{ job: ProcessingJob; result: any }> = []

    const q = new ProcessingQueue(processor, {
      persistPath: persistPath(),
      onJobComplete: (j, r) => {
        completed.push({ job: j, result: r })
      },
    })
    await q.init()

    q.enqueue({ type: 'session', cwd: '/a', sessionId: 'abc' })
    await tick()

    sessionCalls[0].resolve(okSession)
    await tick()

    expect(completed.length).toBe(1)
    expect(completed[0].job.type).toBe('session')
    expect((completed[0].result as SessionResult).ok).toBe(true)
  })

  // ── maxConcurrent ─────────────────────────────────────────────────────

  test('respects maxConcurrent', async () => {
    const { processor, projectCalls } = mockProcessor()

    const q = new ProcessingQueue(processor, {
      maxConcurrent: 2,
      persistPath: persistPath(),
    })
    await q.init()

    q.enqueue({ type: 'project', cwd: '/a' })
    q.enqueue({ type: 'project', cwd: '/b' })
    q.enqueue({ type: 'project', cwd: '/c' })
    await tick()

    expect(q.runningCount).toBe(2)
    expect(q.pendingCount).toBe(1)
    expect(projectCalls.length).toBe(2)

    // Complete first job → third should start
    projectCalls[0].resolve(okResult)
    await tick()

    expect(q.runningCount).toBe(2)
    expect(q.pendingCount).toBe(0)
    expect(projectCalls.length).toBe(3)
  })

  // ── Deduplication ─────────────────────────────────────────────────────

  test('deduplicates same project job', async () => {
    const { processor, projectCalls } = mockProcessor()

    const q = new ProcessingQueue(processor, {
      maxConcurrent: 1,
      persistPath: persistPath(),
    })
    await q.init()

    q.enqueue({ type: 'project', cwd: '/a' })
    q.enqueue({ type: 'project', cwd: '/a' }) // duplicate
    await tick()

    expect(q.runningCount).toBe(1)
    expect(q.pendingCount).toBe(0)

    projectCalls[0].resolve(okResult)
    await tick()

    expect(projectCalls.length).toBe(1) // only ran once
  })

  test('deduplicates same session job', async () => {
    const { processor } = mockProcessor()

    const q = new ProcessingQueue(processor, {
      maxConcurrent: 1,
      persistPath: persistPath(),
    })
    await q.init()

    q.enqueue({ type: 'session', cwd: '/a', sessionId: 's1' })
    q.enqueue({ type: 'session', cwd: '/a', sessionId: 's1' }) // dup

    expect(q.runningCount).toBe(1)
    expect(q.pendingCount).toBe(0)
  })

  test('session dropped when project for same cwd is running', async () => {
    const { processor } = mockProcessor()

    const q = new ProcessingQueue(processor, {
      maxConcurrent: 1,
      persistPath: persistPath(),
    })
    await q.init()

    q.enqueue({ type: 'project', cwd: '/a' })
    q.enqueue({ type: 'session', cwd: '/a', sessionId: 's1' }) // subsumed

    expect(q.pendingCount).toBe(0)
    expect(q.runningCount).toBe(1)
  })

  test('session dropped when project for same cwd is pending', async () => {
    const { processor } = mockProcessor()

    const q = new ProcessingQueue(processor, {
      maxConcurrent: 1,
      persistPath: persistPath(),
    })
    await q.init()

    q.enqueue({ type: 'project', cwd: '/x' }) // runs immediately (fills slot)
    q.enqueue({ type: 'project', cwd: '/a' }) // pending
    q.enqueue({ type: 'session', cwd: '/a', sessionId: 's1' }) // subsumed by pending project

    expect(q.pendingCount).toBe(1) // only /a project
  })

  test('project cancels pending sessions for same cwd', async () => {
    const { processor } = mockProcessor()

    const q = new ProcessingQueue(processor, {
      maxConcurrent: 1,
      persistPath: persistPath(),
    })
    await q.init()

    // Fill the slot so sessions go to pending
    q.enqueue({ type: 'session', cwd: '/x', sessionId: 'fill' })
    q.enqueue({ type: 'session', cwd: '/a', sessionId: 's1' })
    q.enqueue({ type: 'session', cwd: '/a', sessionId: 's2' })
    expect(q.pendingCount).toBe(2)

    // Enqueue project for /a → should cancel pending sessions for /a
    q.enqueue({ type: 'project', cwd: '/a' })
    expect(q.pendingCount).toBe(1) // only the project job for /a remains
    const state = q.getState()
    expect(state.pending[0].type).toBe('project')
  })

  // ── 'all' job expansion ───────────────────────────────────────────────

  test('all job expands into project jobs', async () => {
    const { processor, projectCalls } = mockProcessor()

    const q = new ProcessingQueue(processor, {
      maxConcurrent: 5,
      persistPath: persistPath(),
      resolveAllProjects: () => ['/a', '/b', '/c'],
    })
    await q.init()

    q.enqueue({ type: 'all' })
    await tick()
    await tick() // extra tick for the expanded project jobs to start

    expect(projectCalls.length).toBe(3)
  })

  test('all job deduplicates already-running projects', async () => {
    const { processor, projectCalls } = mockProcessor()

    const q = new ProcessingQueue(processor, {
      maxConcurrent: 5,
      persistPath: persistPath(),
      resolveAllProjects: () => ['/a', '/b'],
    })
    await q.init()

    q.enqueue({ type: 'project', cwd: '/a' }) // runs immediately
    await tick()
    expect(projectCalls.length).toBe(1)

    q.enqueue({ type: 'all' })
    await tick()
    await tick()

    // /a already running → deduped; only /b should be new
    expect(projectCalls.length).toBe(2)
    expect(projectCalls[1].cwd).toBe('/b')
  })

  // ── onProjectDrained ──────────────────────────────────────────────────

  test('onProjectDrained fires after last job for a cwd completes', async () => {
    const { processor, sessionCalls } = mockProcessor()
    const drained: string[] = []

    const q = new ProcessingQueue(processor, {
      maxConcurrent: 5,
      persistPath: persistPath(),
      onProjectDrained: (cwd) => {
        drained.push(cwd)
      },
    })
    await q.init()

    q.enqueue({ type: 'session', cwd: '/a', sessionId: 's1' })
    q.enqueue({ type: 'session', cwd: '/a', sessionId: 's2' })
    q.enqueue({ type: 'session', cwd: '/b', sessionId: 's3' })
    await tick()

    // Complete s3 (only job for /b)
    sessionCalls[2].resolve(okSession)
    await tick()
    expect(drained).toEqual(['/b'])

    // Complete s1 (first of two for /a)
    sessionCalls[0].resolve(okSession)
    await tick()
    expect(drained).toEqual(['/b']) // /a not drained yet

    // Complete s2 (last for /a)
    sessionCalls[1].resolve(okSession)
    await tick()
    expect(drained).toEqual(['/b', '/a'])
  })

  // ── Error handling ────────────────────────────────────────────────────

  test('onJobError fires and queue continues', async () => {
    const { processor, projectCalls } = mockProcessor()
    const errors: Array<{ job: ProcessingJob; error: Error }> = []

    const q = new ProcessingQueue(processor, {
      maxConcurrent: 1,
      persistPath: persistPath(),
      onJobError: (j, e) => {
        errors.push({ job: j, error: e })
      },
    })
    await q.init()

    q.enqueue({ type: 'project', cwd: '/a' })
    q.enqueue({ type: 'project', cwd: '/b' })
    await tick()

    // Fail first job
    projectCalls[0].reject(new Error('boom'))
    await tick()

    expect(errors.length).toBe(1)
    expect(errors[0].error.message).toBe('boom')
    // Second job should have started
    expect(projectCalls.length).toBe(2)
  })

  // ── Persistence & restore ─────────────────────────────────────────────

  test('persists state and restores on init', async () => {
    const { processor } = mockProcessor()
    const pp = persistPath()

    const q1 = new ProcessingQueue(processor, {
      maxConcurrent: 1,
      persistPath: pp,
    })
    await q1.init()

    q1.enqueue({ type: 'project', cwd: '/a' }) // runs
    q1.enqueue({ type: 'project', cwd: '/b' }) // pending
    await tick()

    // Simulate daemon crash — create a new queue from persisted state
    const { processor: p2, projectCalls: pc2 } = mockProcessor()
    const q2 = new ProcessingQueue(p2, {
      maxConcurrent: 2,
      persistPath: pp,
    })
    await q2.init()
    await tick()

    // Both /a (was running, restored as pending) and /b should now be running
    expect(q2.runningCount).toBe(2)
    expect(pc2.length).toBe(2)
    const cwds = pc2.map((c) => c.cwd).sort()
    expect(cwds).toEqual(['/a', '/b'])
  })

  test('handles missing persist file gracefully', async () => {
    const { processor } = mockProcessor()

    const q = new ProcessingQueue(processor, {
      persistPath: path.join(tmpDir, 'nonexistent', 'queue.json'),
    })
    // Should not throw
    await q.init()
    expect(q.pendingCount).toBe(0)
    expect(q.runningCount).toBe(0)
  })
})
