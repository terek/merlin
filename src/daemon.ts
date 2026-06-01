/**
 * The Merlin daemon: thin orchestrator wiring discovery, processing,
 * session management, and gateway layers together.
 */

import os from 'node:os'
import { ProcessingQueue } from '@merlin/processor'
import type { ClientMessage } from '@merlin/protocol'
import { type SyncClient, SyncEngine } from '@merlin/sync'
import { Clerk, type ClerkOptions } from './clerk/clerk.ts'
import { ModelBuilder } from './discovery/builder.ts'
import { ModelStore } from './discovery/store.ts'
import { WorkspaceStore } from './discovery/workspace.ts'
import { ConnectorManager } from './gateway/connectors.ts'
import { DataHandlers } from './gateway/handlers.ts'
import { OrganizerHandler } from './gateway/organizer.ts'
import { acquireLock, releaseLock } from './lockfile.ts'
import { ProcessingBridge } from './processing/bridge.ts'
import { SessionManager } from './sessions/manager.ts'

export type LogFn = (message: string) => void

/** Coalesce streamed Clerk text into ~1 fps batches over the wire. */
const CLERK_CHUNK_FLUSH_MS = 1000

export interface RelayPairing {
  relayUrl: string
  token: string
  sharedKey: CryptoKey
}

export interface DaemonOptions {
  instanceName?: string
  /** Single relay pairing (legacy). Use `pairings` for multiple. */
  relayUrl?: string
  token?: string
  sharedKey?: CryptoKey
  /** Multiple relay pairings (one per client). */
  pairings?: RelayPairing[]
  claudeDir?: string
  /** If true, skip lockfile acquisition (for testing). */
  skipLock?: boolean
  /** Optional log function. Defaults to console.log with [daemon] prefix. */
  log?: LogFn
  /** Optional process scanner (for testing). */
  scanner?: import('@merlin/cc').ProcessScanner
  /** Periodic refresh interval in ms. 0 disables. Default: 30000. */
  refreshIntervalMs?: number
  /** Clerk options. If omitted, Clerk reads from env vars. Set to false to disable. */
  clerk?: ClerkOptions | false
  /** Override project settings store (for testing). */
  settingsStore?: WorkspaceStore
  /** Override home directory for .merlinignore resolution (for testing). */
  homeDir?: string
}

export class Daemon {
  readonly store: ModelStore
  readonly syncEngine: SyncEngine
  readonly queue: ProcessingQueue
  private builder: ModelBuilder
  private sessions: SessionManager
  private processing: ProcessingBridge
  private connectors: ConnectorManager
  private dataHandlers: DataHandlers
  private organizerHandler: OrganizerHandler
  private settings: WorkspaceStore
  private clerk: Clerk | null = null
  private instanceName: string
  private _started = false
  private _refreshTimer: ReturnType<typeof setInterval> | null = null
  private _startedAt = 0
  private log: LogFn

  constructor(private opts: DaemonOptions = {}) {
    this.instanceName = opts.instanceName ?? `${os.hostname()}-${process.pid}`
    this.log = opts.log ?? ((msg: string) => console.log(`[daemon] ${msg}`))
    const merlinDir = process.env.HOME ? `${process.env.HOME}/.merlin` : '~/.merlin'
    const claudeProjectsDir = opts.claudeDir ?? `${os.homedir()}/.claude/projects`

    // ── Layer 1: Discovery & World Model
    this.store = new ModelStore(os.hostname(), this.instanceName, '0.1.0')
    this.settings = opts.settingsStore ?? new WorkspaceStore()

    // ── Layer 2: Processing
    this.processing = new ProcessingBridge({ merlinDir, claudeProjectsDir, log: this.log, store: this.store })

    // ── Layer 3: Gateway
    this.syncEngine = new SyncEngine(this.store)
    this.connectors = new ConnectorManager(
      this.syncEngine,
      (clientId, msg) => this._handleClientMessage(clientId, msg),
      this.log,
    )
    this.dataHandlers = new DataHandlers(
      this.syncEngine,
      merlinDir,
      claudeProjectsDir,
      this.log,
      this.processing.embeddingProvider,
      () => this.store.getModel(),
    )
    this.organizerHandler = new OrganizerHandler(
      this.syncEngine,
      merlinDir,
      this.log,
      this.processing.llmProvider,
      () => this.store.getModel(),
    )

    // ── Layer 4: Session Management
    this.sessions = new SessionManager(this.store, this.instanceName, this.log)

    // ── Clerk (Study mode)
    if (opts.clerk !== false) {
      try {
        this.clerk = new Clerk({
          merlinDir,
          claudeProjectsDir,
          embeddingProvider: this.processing.embeddingProvider,
          summarizer: this.processing.llmProvider,
          ...(opts.clerk || {}),
        })
        this.log('clerk initialized')
      } catch (err) {
        this.log(`clerk disabled: ${err instanceof Error ? err.message : err}`)
      }
    }

    // ── Discovery builder (depends on processing state)
    this.builder = new ModelBuilder(this.store, {
      instanceName: this.instanceName,
      claudeDir: opts.claudeDir,
      homeDir: opts.homeDir,
      scanner: opts.scanner,
      settingsStore: this.settings,
      processingState: this.processing.state,
    })

    // ── Processing queue (depends on store + builder)
    this.queue = new ProcessingQueue(this.processing.processor, {
      maxConcurrent: 2,
      persistPath: `${merlinDir}/processing-queue.json`,
      resolveAllProjects: () => {
        const projects = this.store.getModel().projects
        return Object.keys(projects).filter((cwd) => !projects[cwd].archived)
      },
      onJobStart: (job) => this.processing.onJobStart(job, this.builder),
      onJobComplete: (job, result) => this.processing.onJobComplete(job, result),
      onJobError: (job, err) => this.processing.onJobError(job, err),
      onProjectDrained: (_cwd) => this.builder.refresh(),
    })
  }

  get startedAt(): number {
    return this._startedAt
  }
  get llmTotals(): ReadonlyMap<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> {
    return this.processing.llmTotals
  }

  async start(): Promise<void> {
    if (this._started) return

    if (!this.opts.skipLock) {
      if (!acquireLock(this.instanceName)) {
        throw new Error('Another daemon instance is already running')
      }
    }

    this.syncEngine.start()
    this.log(`starting (instance=${this.instanceName})`)

    // Connect to relay for each pairing
    this.connectors.connectAll(this._resolvePairings())

    // Initial discovery
    await this.builder.refresh()
    const projectCount = Object.keys(this.store.getModel().projects).length
    this.log(`discovery complete: ${projectCount} project(s)`)

    // Hydrate processing state from disk
    for (const cwd of Object.keys(this.store.getModel().projects)) {
      try {
        await this.processing.refreshState(cwd)
      } catch {
        /* non-critical */
      }
    }
    await this.builder.refresh()

    // Restore persisted queue and resume any interrupted jobs
    await this.queue.init()

    // Periodic re-scan to detect external process changes
    const intervalMs = this.opts.refreshIntervalMs ?? 5_000
    if (intervalMs > 0) {
      this.log(`periodic refresh every ${intervalMs}ms`)
      this._refreshTimer = setInterval(() => {
        void this.builder.refresh().catch((err) => {
          this.log(`periodic refresh failed: ${err}`)
        })
      }, intervalMs)
    }

    this._startedAt = Date.now()
    this._started = true
  }

  async stop(): Promise<void> {
    if (!this._started) return
    this.log('stopping')

    this.sessions.killAll()

    if (this._refreshTimer) {
      clearInterval(this._refreshTimer)
      this._refreshTimer = null
    }

    // Compact and persist any active Clerk sessions before tearing down.
    if (this.clerk) {
      try {
        await this.clerk.closeAll()
      } catch (err) {
        this.log(`clerk closeAll failed: ${err instanceof Error ? err.message : err}`)
      }
    }

    this.connectors.closeAll()
    this.syncEngine.stop()

    if (!this.opts.skipLock) {
      releaseLock()
    }

    this._started = false
    this.log('stopped')
  }

  // ── Public API ────────────────────────────────────────────────────────────

  handleClientMessage(clientId: string, msg: ClientMessage): void {
    this._handleClientMessage(clientId, msg)
  }

  addDirectClient(client: SyncClient): void {
    this.syncEngine.addClient(client)
  }

  removeDirectClient(clientId: string): void {
    this.syncEngine.removeClient(clientId)
  }

  addConnector(pairing: RelayPairing): void {
    this.connectors.addConnector(pairing)
  }

  reconnectPairings(pairings: RelayPairing[]): void {
    this.connectors.reconnectPairings(pairings)
  }

  getActiveCCSessions() {
    return this.sessions.getAll()
  }

  // ── Message dispatch ──────────────────────────────────────────────────────

  private _handleClientMessage(clientId: string, msg: ClientMessage): void {
    switch (msg.type) {
      // ── Gateway: sync subscriptions
      case 'subscribe':
        if (msg.scope === 'metadata') {
          this.log(`client ${clientId}: subscribe metadata`)
          this.syncEngine.subscribeMetadata(clientId)
        } else if (msg.scope === 'session') {
          this.log(`client ${clientId}: subscribe session ${msg.sessionId.slice(0, 8)}`)
          this.syncEngine.subscribeSession(clientId, msg.sessionId)
        }
        break
      case 'unsubscribe':
        if (msg.scope === 'metadata') {
          this.log(`client ${clientId}: unsubscribe metadata`)
          this.syncEngine.unsubscribeMetadata(clientId)
        } else if (msg.scope === 'session') {
          this.log(`client ${clientId}: unsubscribe session ${msg.sessionId.slice(0, 8)}`)
          this.syncEngine.unsubscribeSession(clientId, msg.sessionId)
        }
        break

      // ── Sessions: interactive control
      case 'send_message':
        this.log(`client ${clientId}: send_message to ${msg.sessionId.slice(0, 8)} (${msg.text.length} chars)`)
        if (!this.sessions.sendMessage(msg.sessionId, msg.text)) {
          this.syncEngine.sendToClient(clientId, { type: 'error', message: `Session ${msg.sessionId} not found` })
        }
        break
      case 'open_project':
        this.log(
          `client ${clientId}: open_project ${msg.cwd}${msg.ccSessionId ? ` (resume ${msg.ccSessionId.slice(0, 8)})` : ''}`,
        )
        void this.sessions.openProject(clientId, msg.cwd, this.builder.getDiscovery(), msg.ccSessionId, (cid, m) =>
          this.syncEngine.sendToClient(cid, { type: 'error', message: m }),
        )
        break
      case 'kill_session':
        this.log(`client ${clientId}: kill_session ${msg.sessionId.slice(0, 8)}`)
        this.sessions.kill(msg.sessionId)
        break
      case 'approve': {
        this.log(`client ${clientId}: approve ${msg.sessionId.slice(0, 8)} → ${msg.optionKey}`)
        this.sessions.approve(msg.sessionId, msg.optionKey)
        break
      }
      case 'deny': {
        this.log(`client ${clientId}: deny ${msg.sessionId.slice(0, 8)}`)
        this.sessions.deny(msg.sessionId)
        break
      }

      // ── Discovery: refresh & workspace
      case 'refresh_projects':
        this.log(`client ${clientId}: refresh_projects${msg.force ? ' (force)' : ''}`)
        void this.builder.refresh({ force: msg.force })
        break
      case 'archive':
        this.log(`client ${clientId}: archive ${msg.scope} ${msg.id}`)
        void this._handleArchive(msg.scope, msg.id, true)
        break
      case 'unarchive':
        this.log(`client ${clientId}: unarchive ${msg.scope} ${msg.id}`)
        void this._handleArchive(msg.scope, msg.id, false)
        break
      case 'collapse_project':
        this.log(`client ${clientId}: collapse_project ${msg.cwd}`)
        void this._handleCollapse(msg.cwd, true)
        break
      case 'uncollapse_project':
        this.log(`client ${clientId}: uncollapse_project ${msg.cwd}`)
        void this._handleCollapse(msg.cwd, false)
        break

      // ── Processing: queue management
      case 'process_project':
        this.log(`client ${clientId}: process_project ${msg.cwd}`)
        this.queue.enqueue({ type: 'project', cwd: msg.cwd })
        break
      case 'process_session':
        this.log(`client ${clientId}: process_session ${msg.sessionId.slice(0, 8)} in ${msg.cwd}`)
        this.queue.enqueue({ type: 'session', cwd: msg.cwd, sessionId: msg.sessionId })
        break
      case 'process_all':
        this.log(`client ${clientId}: process_all`)
        this.queue.enqueue({ type: 'all' })
        break
      case 'delete_processing':
        this.log(
          `client ${clientId}: delete_processing ${msg.cwd}${msg.sessionId ? ` session ${msg.sessionId.slice(0, 8)}` : ' (all)'}`,
        )
        void this.processing.deleteProcessing(msg.cwd, msg.sessionId, this.builder)
        break
      case 'reembed_project':
        this.log(`client ${clientId}: reembed_project ${msg.cwd}`)
        void this.processing.reembedProject(msg.cwd)
        break

      // ── Gateway: data serving
      case 'get_segments':
        this.log(`client ${clientId}: get_segments ${msg.cwd}`)
        void this.dataHandlers.handleGetSegments(clientId, msg.cwd)
        break
      case 'get_raw_turns':
        this.log(`client ${clientId}: get_raw_turns ${msg.sessionId.slice(0, 8)} in ${msg.cwd}`)
        void this.dataHandlers.handleGetRawTurns(clientId, msg.cwd, msg.sessionId, msg.offset, msg.limit)
        break
      case 'get_lean_turns':
        this.log(`client ${clientId}: get_lean_turns ${msg.sessionId.slice(0, 8)} in ${msg.cwd}`)
        void this.dataHandlers.handleGetLeanTurns(clientId, msg.cwd, msg.sessionId)
        break
      case 'get_session_segments':
        this.log(`client ${clientId}: get_session_segments ${msg.sessionId.slice(0, 8)} in ${msg.cwd}`)
        void this.dataHandlers.handleGetSessionSegments(clientId, msg.cwd, msg.sessionId)
        break
      case 'get_project_tasks':
        this.log(`client ${clientId}: get_project_tasks ${msg.cwd}`)
        void this.dataHandlers.handleGetProjectTasks(clientId, msg.cwd)
        break
      case 'search_tasks':
        this.log(`client ${clientId}: search_tasks ${msg.cwd} q="${msg.query.slice(0, 40)}"`)
        void this.dataHandlers.handleSearchTasks(clientId, msg.cwd, msg.query, msg.requestId, msg.limit)
        break
      case 'get_organizer':
        this.log(`client ${clientId}: get_organizer ${msg.cwd}${msg.refresh ? ' (refresh)' : ''}`)
        void this.organizerHandler.handle(clientId, msg.cwd, msg.refresh ?? false)
        break

      // ── Clerk (Study mode)
      case 'clerk_message':
        this.log(`client ${clientId}: clerk_message ${msg.cwd} (${msg.text.length} chars)`)
        void this._handleClerkMessage(clientId, msg.cwd, msg.text)
        break
      case 'clerk_interrupt':
        this.log(`client ${clientId}: clerk_interrupt ${msg.cwd}`)
        this.clerk?.interrupt(msg.cwd)
        break
      case 'clerk_load':
        this.log(`client ${clientId}: clerk_load ${msg.cwd}`)
        void this._handleClerkLoad(clientId, msg.cwd)
        break
    }
  }

  // ── Discovery helpers ─────────────────────────────────────────────────────

  private async _handleArchive(scope: 'project' | 'session', id: string, archive: boolean): Promise<void> {
    if (archive) {
      await this.settings.archive(scope, id)
    } else {
      await this.settings.unarchive(scope, id)
    }
    await this.builder.refresh()
  }

  private async _handleCollapse(cwd: string, collapse: boolean): Promise<void> {
    if (collapse) {
      await this.settings.collapse(cwd)
    } else {
      await this.settings.uncollapse(cwd)
    }
    await this.builder.refresh()
  }

  // ── Clerk ─────────────────────────────────────────────────────────────────

  private async _handleClerkMessage(clientId: string, cwd: string, text: string): Promise<void> {
    if (!this.clerk) {
      this.syncEngine.sendToClient(clientId, {
        type: 'clerk_error',
        cwd,
        error: 'Clerk is not available (missing CLERK_MODEL env var)',
      })
      return
    }
    // Coalesce streamed text deltas into ~1 fps batches before sending to
    // the client. The LLM produces tens of tokens/sec; the user only needs
    // perceived liveness, not per-token rendering.
    let pending = ''
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      if (!pending) return
      this.syncEngine.sendToClient(clientId, { type: 'clerk_chunk', cwd, text: pending })
      pending = ''
    }
    const armFlush = () => {
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        flush()
      }, CLERK_CHUNK_FLUSH_MS)
    }

    try {
      await this.clerk.handleMessage(cwd, text, {
        onTextChunk: (chunk) => {
          pending += chunk
          armFlush()
        },
        onToolActivity: (tool, description) => {
          // Tool boundaries are natural breakpoints: flush any pending text
          // first so the activity marker lands in the right place visually.
          if (flushTimer) {
            clearTimeout(flushTimer)
            flushTimer = null
          }
          flush()
          this.syncEngine.sendToClient(clientId, { type: 'clerk_tool_activity', cwd, tool, description })
        },
        onToolResult: (tool, content) => {
          // Same ordering rule as activity — make sure no buffered text comes
          // after the result on the wire.
          if (flushTimer) {
            clearTimeout(flushTimer)
            flushTimer = null
          }
          flush()
          this.syncEngine.sendToClient(clientId, { type: 'clerk_tool_result', cwd, tool, content })
        },
        onDone: () => {
          if (flushTimer) {
            clearTimeout(flushTimer)
            flushTimer = null
          }
          flush()
          this.syncEngine.sendToClient(clientId, { type: 'clerk_done', cwd })
        },
      })
    } catch (err) {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      flush()
      this.log(`clerk error: ${err instanceof Error ? err.message : err}`)
      this.syncEngine.sendToClient(clientId, {
        type: 'clerk_error',
        cwd,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async _handleClerkLoad(clientId: string, cwd: string): Promise<void> {
    const snapshot = this.clerk ? await this.clerk.loadActive(cwd) : { messages: [], systemPrompt: '', tools: [] }
    this.syncEngine.sendToClient(clientId, {
      type: 'clerk_active',
      cwd,
      messages: snapshot.messages,
      systemPrompt: snapshot.systemPrompt,
      tools: snapshot.tools,
    })
  }

  // ── Pairing resolution ────────────────────────────────────────────────────

  private _resolvePairings(): RelayPairing[] {
    if (this.opts.pairings && this.opts.pairings.length > 0) {
      return this.opts.pairings
    }
    if (this.opts.relayUrl && this.opts.token && this.opts.sharedKey) {
      return [{ relayUrl: this.opts.relayUrl, token: this.opts.token, sharedKey: this.opts.sharedKey }]
    }
    return []
  }
}
