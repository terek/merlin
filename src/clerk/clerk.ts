/**
 * Clerk — Study mode orchestrator.
 *
 * One active study session per project. The active session lives in
 * ~/.merlin/clerk/<project-slug>/active.json. On close (project switch is
 * not tracked here — close is triggered by idle timeout or daemon shutdown)
 * the session is compacted and pushed onto memory.jsonl, capped at the last
 * three. Past entries are injected into the next session's system prompt
 * as ambient memory, no retrieval tool needed.
 *
 * Provider is inferred from the model name:
 *   CLERK_MODEL=claude-sonnet-4-6       -> Anthropic
 *   CLERK_MODEL=gemini-2.5-flash        -> Gemini
 *   CLERK_MODEL=ollama:qwen3:8b         -> Ollama
 *   (anything else)                      -> Gemini
 *
 * Compaction uses a separate `summarizer` LLM (the processor model is the
 * natural fit — cheap, high-volume).
 */

import os from 'node:os'
import path from 'node:path'
import type { EmbeddingProvider, LLMProvider } from '@merlin/llm'
import { AnthropicProvider, GeminiProvider, OllamaProvider } from '@merlin/llm'
import type { ClerkMessageEntry, ClerkToolDef } from '@merlin/protocol'
import { type AgentCallbacks, buildStudySystemPrompt, ClerkAgent, STUDY_TOOLS } from './agent.ts'
import { compact, renderMemoryPreamble } from './compactor.ts'
import { type ActiveSession, ClerkMemory } from './memory-store.ts'
import { CodebaseTools } from './tools/codebase.ts'
import { StudyTools } from './tools/study-tools.ts'

/** Snapshot of the active session plus what the LLM would see on the next turn. */
export interface ActiveSessionSnapshot {
  messages: ClerkMessageEntry[]
  systemPrompt: string
  tools: ClerkToolDef[]
}

export type ProviderType = 'anthropic' | 'gemini' | 'ollama'

/** Idle window before an active session is auto-closed and compacted. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000

export interface ClerkOptions {
  /** Model used for chat. Required (env: CLERK_MODEL). */
  clerkModel?: string
  /** Override API key for the chat model. Otherwise resolved from env. */
  clerkApiKey?: string

  /** Where to persist active session + memory log. Default: ~/.merlin/clerk. */
  clerkDir?: string
  /** Merlin data root. Default: ~/.merlin. Used to locate processed sessions. */
  merlinDir?: string
  /** Claude Code projects dir. Default: ~/.claude/projects. Used to read raw JSONL. */
  claudeProjectsDir?: string

  /** Optional embedding provider for semantic task search inside Study tools. */
  embeddingProvider?: EmbeddingProvider
  /** Cheap LLM used to summarise closed sessions. Typically the processor model. */
  summarizer?: LLMProvider
}

interface SessionState {
  cwd: string
  memory: ClerkMemory
  agent: ClerkAgent | null
  /** In-memory copy of active.json. Persisted on every save. */
  session: ActiveSession | null
  /** When the active session is unloaded by idle timer / shutdown. */
  idleTimer: ReturnType<typeof setTimeout> | null
}

export class Clerk {
  private clerkDir: string
  private merlinDir: string
  private claudeProjectsDir: string
  private embeddingProvider?: EmbeddingProvider
  private summarizer?: LLMProvider
  private provider: LLMProvider
  private states = new Map<string, SessionState>()

  constructor(opts: ClerkOptions) {
    const home = process.env.HOME || os.homedir()
    this.clerkDir = opts.clerkDir || path.join(home, '.merlin', 'clerk')
    this.merlinDir = opts.merlinDir || path.join(home, '.merlin')
    this.claudeProjectsDir = opts.claudeProjectsDir || path.join(home, '.claude', 'projects')
    this.embeddingProvider = opts.embeddingProvider
    this.summarizer = opts.summarizer

    const clerkModel = opts.clerkModel || process.env.CLERK_MODEL
    if (!clerkModel) throw new Error('Set CLERK_MODEL (e.g., claude-sonnet-4-6)')
    const providerType = inferProvider(clerkModel)
    const apiKey = opts.clerkApiKey || resolveApiKey(providerType)
    this.provider = createProvider(providerType, apiKey, clerkModel)
  }

  // ── Public surface ──────────────────────────────────────────────────────

  /**
   * Return the active session for `cwd` together with the system prompt and
   * tool definitions the LLM would see on the next turn. Empty messages mean
   * no active session; the prompt and tools are still computed so the debug
   * view can preview what a fresh chat would look like.
   */
  async loadActive(cwd: string): Promise<ActiveSessionSnapshot> {
    const state = await this.ensureState(cwd)
    if (!state.session) {
      state.session = (await state.memory.readActive()) ?? null
    }
    const past = await state.memory.readMemory()
    return {
      messages: (state.session?.messages ?? []) as ClerkMessageEntry[],
      systemPrompt: buildStudySystemPrompt(cwd, renderMemoryPreamble(past)),
      tools: STUDY_TOOLS as ClerkToolDef[],
    }
  }

  async handleMessage(cwd: string, text: string, callbacks?: AgentCallbacks): Promise<void> {
    const state = await this.ensureState(cwd)
    if (!state.session) state.session = (await state.memory.readActive()) ?? state.memory.newActive()
    if (!state.agent) state.agent = await this.buildAgent(cwd, state.memory)

    this.armIdle(state)
    state.session.updatedAt = new Date().toISOString()
    await state.agent.chat(state.session, text, callbacks)
    state.session.updatedAt = new Date().toISOString()
    await state.memory.writeActive(state.session)
  }

  interrupt(cwd: string): void {
    this.states.get(cwd)?.agent?.interrupt()
  }

  /** Close the active session: compact, push to memory, delete active.json, drop in-memory state. */
  async close(cwd: string): Promise<void> {
    const state = this.states.get(cwd)
    if (!state) return
    if (state.idleTimer) clearTimeout(state.idleTimer)
    state.idleTimer = null

    const session = state.session ?? (await state.memory.readActive())
    if (session) {
      try {
        const entry = await compact(session, this.summarizer)
        if (entry) await state.memory.pushMemory(entry)
      } catch {
        // Never let compaction fail block shutdown.
      }
      await state.memory.deleteActive()
    }
    this.states.delete(cwd)
  }

  /** Close every active session. Used on daemon shutdown. */
  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.states.keys()).map((cwd) => this.close(cwd)))
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async ensureState(cwd: string): Promise<SessionState> {
    let state = this.states.get(cwd)
    if (!state) {
      const memory = new ClerkMemory(this.clerkDir, cwd)
      await memory.init()
      state = { cwd, memory, agent: null, session: null, idleTimer: null }
      this.states.set(cwd, state)
    }
    return state
  }

  private async buildAgent(cwd: string, memory: ClerkMemory): Promise<ClerkAgent> {
    const past = await memory.readMemory()
    return new ClerkAgent({
      provider: this.provider,
      cwd,
      studyTools: new StudyTools(this.merlinDir, this.claudeProjectsDir, cwd, this.embeddingProvider),
      codebaseTools: new CodebaseTools(cwd),
      memoryPreamble: renderMemoryPreamble(past),
    })
  }

  private armIdle(state: SessionState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer)
    state.idleTimer = setTimeout(() => {
      void this.close(state.cwd)
    }, IDLE_TIMEOUT_MS)
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function inferProvider(model: string): ProviderType {
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('ollama:')) return 'ollama'
  return 'gemini'
}

export function stripModelPrefix(model: string): string {
  const idx = model.indexOf(':')
  if (idx >= 0 && model.startsWith('ollama:')) return model.slice(idx + 1)
  return model
}

function resolveApiKey(provider: ProviderType): string {
  if (provider === 'ollama') return 'ollama'
  const p = provider.toUpperCase()
  const value = process.env[`${p}_CLERK_API_KEY`] || process.env[`${p}_API_KEY`]
  if (!value) throw new Error(`Set ${p}_CLERK_API_KEY or ${p}_API_KEY`)
  return value
}

function createProvider(type: ProviderType, apiKey: string, model: string): LLMProvider {
  const cleanModel = stripModelPrefix(model)
  if (type === 'ollama') return new OllamaProvider(cleanModel)
  if (type === 'gemini') return new GeminiProvider(apiKey, cleanModel)
  return new AnthropicProvider(apiKey, cleanModel)
}
