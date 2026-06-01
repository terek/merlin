/**
 * Processing bridge: wires @merlin/processor into the daemon.
 * Handles queue callbacks, LLM provider init, processing state management.
 */

import type { EmbeddingProvider, LLMProvider } from '@merlin/llm'
import type { LLMCostStats, ProcessingJob, ProcessResult, ProgressEvent, SessionResult } from '@merlin/processor'
import { cwdToProjectDirName, LeanSessionStore, ProcessingState, Processor } from '@merlin/processor'
import type { RuntimeSession } from '@merlin/protocol'
import type { LogFn } from '../daemon.ts'
import type { ModelBuilder } from '../discovery/builder.ts'
import type { ModelStore } from '../discovery/store.ts'

export interface ProcessingBridgeOptions {
  merlinDir: string
  claudeProjectsDir: string
  log: LogFn
  /** Model store for publishing runtime progress. */
  store: ModelStore
}

export class ProcessingBridge {
  readonly processor: Processor
  readonly state: ProcessingState
  readonly embeddingProvider: EmbeddingProvider | undefined
  readonly llmProvider: LLMProvider | undefined
  private log: LogFn
  private merlinDir: string
  private store: ModelStore
  private _llmTotals = new Map<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>()
  /** Per-session live counters, keyed by sessionId. Mirrors model.processingRuntime.activeSessions. */
  private _runtime = new Map<string, RuntimeSession>()

  constructor(opts: ProcessingBridgeOptions) {
    this.log = opts.log
    this.merlinDir = opts.merlinDir
    this.store = opts.store

    this.embeddingProvider = this._initEmbeddingProvider()
    this.llmProvider = this._initLLMProvider()
    this.processor = new Processor({
      merlinDir: opts.merlinDir,
      claudeProjectsDir: opts.claudeProjectsDir,
      llmProvider: this.llmProvider,
      embeddingProvider: this.embeddingProvider,
      onEvent: (e) => this._handleEvent(e),
    })
    this.state = new ProcessingState()
  }

  /** Route processor events into log + runtime store. */
  private _handleEvent(e: ProgressEvent): void {
    if (e.kind === 'log') {
      this.log(e.msg)
      return
    }
    if (e.kind === 'session-start') {
      const rs: RuntimeSession = {
        cwd: e.cwd,
        sessionId: e.sessionId,
        startedAt: Date.now(),
        turnsDone: 0,
        turnsDiscovered: 0,
        tasksDone: 0,
        tasksDiscovered: 0,
      }
      this._runtime.set(e.sessionId, rs)
      this.store.upsertRuntimeSession(rs)
      return
    }
    if (e.kind === 'session-done') {
      this._runtime.delete(e.sessionId)
      this.store.removeRuntimeSession(e.sessionId)
      return
    }
    // embeddings: not surfaced to UI yet — log only.
    if (e.kind === 'embeddings') return

    // turns / tasks counter update
    const rs = this._runtime.get(e.sessionId)
    if (!rs) return
    if (e.kind === 'turns') {
      rs.turnsDone = e.done
      rs.turnsDiscovered = e.discovered
    } else {
      rs.tasksDone = e.done
      rs.tasksDiscovered = e.discovered
    }
    this.store.upsertRuntimeSession({ ...rs })
  }

  get llmTotals(): ReadonlyMap<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> {
    return this._llmTotals
  }

  /** Refresh processing state for a project from disk. */
  async refreshState(cwd: string): Promise<void> {
    const checks = await this.processor.checkProject(cwd)
    this.state.applyChecks(cwd, checks)
  }

  /** Queue callback: job starting. */
  async onJobStart(job: ProcessingJob, builder: ModelBuilder): Promise<void> {
    if (job.type === 'all') return

    try {
      await this.refreshState(job.cwd)
    } catch {
      /* non-critical */
    }

    if (job.type === 'project') {
      const stateMap = this.state.getProjectState(job.cwd)
      for (const [id, s] of stateMap) {
        if (s.status === 'missing' || s.status === 'outdated' || s.status === 'error') {
          this.state.markRunning(job.cwd, id)
        }
      }
    } else {
      this.state.markRunning(job.cwd, job.sessionId)
    }

    await builder.refresh()
  }

  /** Queue callback: job completed. */
  async onJobComplete(job: ProcessingJob, result: ProcessResult | SessionResult): Promise<void> {
    if (job.type === 'project') {
      const r = result as ProcessResult
      this.state.applyResult(job.cwd, r)
      if (r.processed.length > 0 || r.errors.length > 0) {
        this.log(`processed ${job.cwd}: ${r.processed.length} ok, ${r.errors.length} error(s)`)
      }
      this._logLLMCosts(r.llmCosts)
    } else if (job.type === 'session') {
      const r = result as SessionResult
      this.state.applySessionResult(job.cwd, job.sessionId, r)
      if (r.ok) {
        this.log(`processed session ${job.sessionId.slice(0, 8)} in ${job.cwd}`)
      } else {
        this.log(`process failed ${job.sessionId.slice(0, 8)} in ${job.cwd}: ${r.error}`)
      }
      this._logLLMCosts(r.llmCosts)
    }
  }

  /** Queue callback: job errored. */
  async onJobError(job: ProcessingJob, error: Error): Promise<void> {
    if (job.type === 'project') {
      this.log(`process failed for ${job.cwd}: ${error.message}`)
      this.state.deleteProject(job.cwd)
      try {
        await this.refreshState(job.cwd)
      } catch {
        /* non-critical */
      }
    } else if (job.type === 'session') {
      this.log(`process failed ${job.sessionId.slice(0, 8)} in ${job.cwd}: ${error.message}`)
      this.state.applySessionResult(job.cwd, job.sessionId, { ok: false, error: error.message })
    } else {
      this.log(`process_all failed: ${error.message}`)
    }
  }

  /** Delete processing data and refresh model. */
  async deleteProcessing(cwd: string, sessionId?: string, builder?: ModelBuilder): Promise<void> {
    const dirName = cwdToProjectDirName(cwd)
    const store = new LeanSessionStore(this.merlinDir, dirName)
    if (sessionId) {
      await store.deleteSession(sessionId)
      this.state.deleteSession(cwd, sessionId)
    } else {
      await store.deleteAllSessions()
      this.state.deleteProject(cwd)
    }
    this.log(`deleted processing for ${cwd}${sessionId ? ` session ${sessionId.slice(0, 8)}` : ' (all)'}`)
    if (builder) await builder.refresh()
  }

  /** Recompute task embeddings for every stored session in a project. */
  async reembedProject(cwd: string): Promise<void> {
    const r = await this.processor.reembedProject(cwd)
    if (r.skipped) {
      this.log(`re-embed ${cwd}: ${r.skipped}`)
      return
    }
    this.log(
      `re-embedded ${cwd}: ${r.tasks} task(s) across ${r.sessions} session(s)` +
        (r.errors.length ? `, ${r.errors.length} error(s)` : ''),
    )
    this._logLLMCosts(r.llmCosts)
  }

  private _logLLMCosts(llmCosts: LLMCostStats | undefined): void {
    if (!llmCosts) return
    for (const [model, s] of llmCosts.perModel) {
      // Legacy map (independent measurement, kept for cross-check).
      const existing = this._llmTotals.get(model) ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
      this._llmTotals.set(model, {
        calls: existing.calls + s.calls,
        inputTokens: existing.inputTokens + s.inputTokens,
        outputTokens: existing.outputTokens + s.outputTokens,
        costUsd: existing.costUsd + (s.costUsd ?? 0),
      })
      // New path: publish into the model for clients.
      this.store.bumpLLMTotals(model, {
        calls: s.calls,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        costUsd: s.costUsd ?? 0,
      })
      const cost = s.costUsd !== null ? `, $${s.costUsd < 0.01 ? s.costUsd.toFixed(4) : s.costUsd.toFixed(3)}` : ''
      this.log(`summarization: ${model}: ${s.calls} calls, ~${s.inputTokens} in / ~${s.outputTokens} out${cost}`)
    }
  }

  private _initEmbeddingProvider(): EmbeddingProvider | undefined {
    const model = process.env.PROCESSOR_EMBEDDING_MODEL
    if (!model) return undefined

    try {
      if (model.startsWith('text-embedding-')) {
        const apiKey = process.env.OPENAI_PROCESSOR_API_KEY || process.env.OPENAI_API_KEY
        if (!apiKey) {
          this.log('PROCESSOR_EMBEDDING_MODEL set to OpenAI but OPENAI_PROCESSOR_API_KEY/OPENAI_API_KEY missing')
          return undefined
        }
        const { OpenAIEmbeddingProvider } = require('@merlin/llm')
        this.log(`embeddings enabled: ${model}`)
        return new OpenAIEmbeddingProvider(apiKey, model)
      } else {
        // Default: Gemini (covers gemini-embedding-*, text-embedding-004, etc.)
        const apiKey = process.env.GEMINI_PROCESSOR_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
        if (!apiKey) {
          this.log('PROCESSOR_EMBEDDING_MODEL set but GEMINI_PROCESSOR_API_KEY/GEMINI_API_KEY missing')
          return undefined
        }
        const { GeminiEmbeddingProvider } = require('@merlin/llm')
        this.log(`embeddings enabled: ${model}`)
        return new GeminiEmbeddingProvider(apiKey, model)
      }
    } catch (err) {
      this.log(`embeddings disabled: ${err instanceof Error ? err.message : err}`)
      return undefined
    }
  }

  private _initLLMProvider(): LLMProvider | undefined {
    const model = process.env.PROCESSOR_MODEL
    if (!model) return undefined

    try {
      if (model.startsWith('claude')) {
        const apiKey = process.env.ANTHROPIC_PROCESSOR_API_KEY || process.env.ANTHROPIC_API_KEY
        if (!apiKey) {
          this.log('PROCESSOR_MODEL set to Claude but ANTHROPIC_PROCESSOR_API_KEY/ANTHROPIC_API_KEY missing')
          return undefined
        }
        const { AnthropicProvider } = require('@merlin/llm')
        this.log(`summarization enabled: ${model}`)
        return new AnthropicProvider(apiKey, model)
      } else if (model.startsWith('gpt-')) {
        const apiKey = process.env.OPENAI_PROCESSOR_API_KEY || process.env.OPENAI_API_KEY
        if (!apiKey) {
          this.log('PROCESSOR_MODEL set to OpenAI but OPENAI_PROCESSOR_API_KEY/OPENAI_API_KEY missing')
          return undefined
        }
        const { OpenAIProvider } = require('@merlin/llm')
        this.log(`summarization enabled: ${model}`)
        return new OpenAIProvider(apiKey, model)
      } else if (model.startsWith('ollama:')) {
        const { OllamaProvider } = require('@merlin/llm')
        this.log(`summarization enabled: ${model}`)
        return new OllamaProvider(model.slice('ollama:'.length))
      } else {
        const apiKey = process.env.GEMINI_PROCESSOR_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
        if (!apiKey) {
          this.log('PROCESSOR_MODEL set but GEMINI_PROCESSOR_API_KEY/GEMINI_API_KEY missing')
          return undefined
        }
        const { GeminiProvider } = require('@merlin/llm')
        this.log(`summarization enabled: ${model}`)
        return new GeminiProvider(apiKey, model)
      }
    } catch (err) {
      this.log(`summarization disabled: ${err instanceof Error ? err.message : err}`)
      return undefined
    }
  }
}
