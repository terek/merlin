/**
 * Organizer: experimental LLM-driven renaming/regrouping for project tasks.
 *
 * Feeds the project's tasks (flat, chronological) into an LLM and asks it
 * to produce tighter task names and optional group labels. Caches results
 * in memory per-cwd. No persistence — cache lives only for the lifetime
 * of the daemon process.
 *
 * Sessions are intentionally absent from both input and output: they're
 * artificial chat-window boundaries that don't align with the evolution
 * of concepts. The task id is a composite "${sessionId}/${taskId}" so
 * clients can trace a renamed task back to its origin session.
 */

import { type LLMProvider, llmStats, type ModelStats } from '@merlin/llm'
import { cwdToProjectDirName, LeanSessionStore, type SessionTask } from '@merlin/processor'
import type { MerlinModel, SessionSummary } from '@merlin/protocol'
import type { SyncEngine } from '@merlin/sync'
import { z } from 'zod'
import type { LogFn } from '../daemon.ts'

const ResponseSchema = z.object({
  tasks: z.array(
    z.object({
      taskId: z.string(),
      name: z.string(),
      group: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
})

export interface OrganizerTaskRename {
  /** Composite id: "${sessionId}/${taskId}" */
  taskId: string
  name: string
  /** Optional group label for clustering related tasks across the project. */
  group?: string
  note?: string
}

export interface OrganizerResult {
  tasks: OrganizerTaskRename[]
  generatedAt: string
}

const SYSTEM_PROMPT = `You help an engineer organize their Claude Code task history for a project.

Input: a JSON object with a single 'tasks' array — a chronological flat list (earliest first) of every task across the project.
Each task has:
- 'taskId': composite id of the form "<sessionId>/<localTaskId>" (e.g. "411c11fc-.../t1"). Keep it EXACTLY as given; it is only there so the UI can trace a task back to its originating session.
- 'description': the current, often-generic description.
- 'turnCount', 'startedAt', 'endedAt', 'durationMs': metadata.
- 'concepts' (usually present): the things the task was actively building or refining, each with its own short description. Concepts are the strongest signal of what the task is really about.

Sessions are intentionally omitted. They are arbitrary chat-window boundaries, not units of meaning — ignore any implied session grouping from the id prefix.

Your job:
1. Give each task a tighter, more specific name than its current description. Technical and concrete — prefer concept names over generic verbs. 3-8 words.
2. Optionally assign each task a 'group' label (2-4 words) — a product/feature/subsystem concept shared across related tasks. Use the SAME group string for related tasks (case-sensitive match) so the UI can cluster them. Concepts that recur across neighbouring tasks in time are the strongest grouping signals.

Rules:
- Reuse known proper nouns (subsystems, files, APIs, concept names) verbatim.
- Avoid generic words: "work", "changes", "updates", "improvements".
- Task names must be distinct — no two identical.
- Keep the composite 'taskId' exactly as given.`

interface InFlight {
  promise: Promise<void>
}

export class OrganizerHandler {
  private cache = new Map<string, OrganizerResult>()
  private inFlight = new Map<string, InFlight>()

  constructor(
    private syncEngine: SyncEngine,
    private merlinDir: string,
    private log: LogFn,
    private llmProvider: LLMProvider | undefined,
    private getModel: () => MerlinModel,
  ) {}

  /** Handle a client request. Sends the cached result (if any) immediately,
   * then kicks off generation if forced or missing. */
  async handle(clientId: string, cwd: string, refresh: boolean): Promise<void> {
    const cached = this.cache.get(cwd)
    if (cached && !refresh) {
      this.sendResult(clientId, cwd, cached, false)
      return
    }

    // Send optimistic "pending" while we generate.
    this.sendPending(clientId, cwd, cached)

    // Dedup in-flight requests per cwd.
    let existing = this.inFlight.get(cwd)
    if (!existing) {
      const promise = this.generate(cwd).finally(() => {
        this.inFlight.delete(cwd)
      })
      existing = { promise }
      this.inFlight.set(cwd, existing)
    }

    try {
      await existing.promise
      const result = this.cache.get(cwd)
      if (result) {
        this.sendResult(clientId, cwd, result, false)
      }
    } catch (err) {
      this.log(`organizer: ${err instanceof Error ? err.message : err}`)
      this.sendError(clientId, cwd, err instanceof Error ? err.message : String(err))
    }
  }

  private async generate(cwd: string): Promise<void> {
    if (!this.llmProvider) {
      throw new Error('Organizer disabled: no LLM provider configured (set PROCESSOR_MODEL).')
    }

    const model = this.getModel()
    const project = model.projects[cwd]
    if (!project) throw new Error(`Project not found: ${cwd}`)

    const store = new LeanSessionStore(this.merlinDir, cwdToProjectDirName(cwd))
    const tasksBySession = new Map<string, SessionTask[]>()
    await Promise.all(
      project.sessions.map(async (s) => {
        const tasks = await store.readTasks(s.sessionId)
        if (tasks && tasks.length > 0) tasksBySession.set(s.sessionId, tasks)
      }),
    )

    const input = buildInput(project.sessions, tasksBySession)
    const inputJson = JSON.stringify(input)

    // Dump the exact LLM input (system prompt + user payload) for inspection.
    const dumpPath = '/tmp/session_organizer_input.json'
    try {
      await Bun.write(
        dumpPath,
        JSON.stringify({ cwd, generatedAt: new Date().toISOString(), system: SYSTEM_PROMPT, user: input }, null, 2),
      )
      this.log(`organizer: wrote input dump → ${dumpPath}`)
    } catch (err) {
      this.log(`organizer: failed to write dump: ${err instanceof Error ? err.message : err}`)
    }

    // Snapshot stats before so we can attribute tokens/cost to just this call.
    // Not perfectly robust under concurrent LLM traffic, but good enough for
    // experimenting (processing queue runs on its own path).
    const before = snapshotStats()
    const startedAt = Date.now()
    const parsed = await this.llmProvider.parse({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', text: inputJson }],
      schema: ResponseSchema,
      schemaName: 'organizer_result',
    })
    const durationMs = Date.now() - startedAt
    const delta = diffStats(before, snapshotStats())
    this.log(
      `organizer: ${cwd} LLM call ${(durationMs / 1000).toFixed(1)}s, ` +
        `prompt ${inputJson.length} chars, tasks=${parsed.tasks.length}${formatDelta(delta)}`,
    )

    const result: OrganizerResult = {
      tasks: parsed.tasks,
      generatedAt: new Date().toISOString(),
    }
    this.cache.set(cwd, result)
    this.log(`organizer: ${cwd} → ${result.tasks.length} task(s) renamed`)
  }

  private sendResult(clientId: string, cwd: string, r: OrganizerResult, pending: boolean): void {
    this.syncEngine.sendToClient(clientId, {
      type: 'organizer',
      cwd,
      pending,
      tasks: r.tasks,
      generatedAt: r.generatedAt,
    })
  }

  private sendPending(clientId: string, cwd: string, prev: OrganizerResult | undefined): void {
    this.syncEngine.sendToClient(clientId, {
      type: 'organizer',
      cwd,
      pending: true,
      tasks: prev?.tasks ?? [],
      generatedAt: prev?.generatedAt,
    })
  }

  private sendError(clientId: string, cwd: string, error: string): void {
    const prev = this.cache.get(cwd)
    this.syncEngine.sendToClient(clientId, {
      type: 'organizer',
      cwd,
      pending: false,
      error,
      tasks: prev?.tasks ?? [],
      generatedAt: prev?.generatedAt,
    })
  }
}

function buildInput(sessions: SessionSummary[], tasksBySession: Map<string, SessionTask[]>): { tasks: unknown[] } {
  // Flat chronological task list. Each taskId is composite so the client can
  // trace back to its session without needing a separate sessions array.
  type FlatTask = {
    taskId: string
    description: string
    turnCount: number
    startedAt: string | null
    endedAt: string | null
    durationMs: number | null
    concepts?: Array<{ concept: string; description: string }>
    /** Unix ms — used only for sorting, stripped before serialization. */
    _sortKey: number
  }

  const flat: FlatTask[] = []
  for (const s of sessions) {
    const tasks = tasksBySession.get(s.sessionId) ?? []
    for (const t of tasks) {
      flat.push({
        taskId: `${s.sessionId}/${t.id}`,
        description: t.description,
        turnCount: t.turns.length,
        startedAt: t.startedAt ? new Date(t.startedAt).toISOString() : null,
        endedAt: t.endedAt ? new Date(t.endedAt).toISOString() : null,
        durationMs: t.startedAt && t.endedAt ? t.endedAt - t.startedAt : null,
        concepts: t.concepts?.items.map((c) => ({ concept: c.concept, description: c.description })),
        _sortKey: t.startedAt ?? Number.MAX_SAFE_INTEGER,
      })
    }
  }
  flat.sort((a, b) => a._sortKey - b._sortKey)

  return { tasks: flat.map(({ _sortKey: _, ...rest }) => rest) }
}

// ── Usage attribution ──────────────────────────────────────────────────────

function snapshotStats(): Map<string, ModelStats> {
  // Deep-ish copy so later mutations inside llmStats don't leak into the snapshot.
  const out = new Map<string, ModelStats>()
  for (const [k, v] of llmStats.stats()) {
    out.set(k, { ...v })
  }
  return out
}

function diffStats(before: Map<string, ModelStats>, after: Map<string, ModelStats>): Map<string, ModelStats> {
  const out = new Map<string, ModelStats>()
  for (const [k, a] of after) {
    const b = before.get(k)
    const calls = a.calls - (b?.calls ?? 0)
    if (calls <= 0) continue
    const beforeCost = b?.costUsd ?? 0
    const afterCost = a.costUsd ?? 0
    const costUsd = a.costUsd == null ? null : afterCost - beforeCost
    out.set(k, {
      calls,
      inputTokens: a.inputTokens - (b?.inputTokens ?? 0),
      outputTokens: a.outputTokens - (b?.outputTokens ?? 0),
      totalMs: a.totalMs - (b?.totalMs ?? 0),
      costUsd,
    })
  }
  return out
}

function formatDelta(delta: Map<string, ModelStats>): string {
  if (delta.size === 0) return ''
  const parts: string[] = []
  for (const [key, s] of delta) {
    let part = `${key}: ~${s.inputTokens} in / ~${s.outputTokens} out`
    if (s.costUsd !== null) {
      const cost = s.costUsd < 0.01 ? s.costUsd.toFixed(4) : s.costUsd.toFixed(3)
      part += `, $${cost}`
    }
    parts.push(part)
  }
  return ` — ${parts.join(' | ')}`
}
