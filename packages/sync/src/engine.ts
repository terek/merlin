import { generatePatch, snapshot } from './patch.ts'
import type { SyncStore } from './store.ts'

export interface SyncClient {
  id: string
  sendMessage(msg: string): void
}

interface ClientState {
  client: SyncClient
  metadataShadow: object | null
  sessionShadows: Map<string, object>
  subscribedSessions: Set<string>
  subscribedMetadata: boolean
}

/**
 * SyncEngine: maintains shadow copies per client, generates JSON Patch ops
 * on model changes, and sends incremental updates.
 *
 * Throttles session patches to max 4/sec (250ms debounce) during busy turns.
 */
export class SyncEngine {
  private clients = new Map<string, ClientState>()
  private sessionThrottleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private sessionPendingClients = new Map<string, Set<string>>()
  private unsubModel: (() => void) | null = null
  private unsubSession: (() => void) | null = null

  constructor(private store: SyncStore) {}

  start(): void {
    this.unsubModel = this.store.onModelChange(() => this._onModelChange())
    this.unsubSession = this.store.onSessionChange((id) => this._onSessionChange(id))
  }

  stop(): void {
    this.unsubModel?.()
    this.unsubSession?.()
    for (const timer of this.sessionThrottleTimers.values()) clearTimeout(timer)
    this.sessionThrottleTimers.clear()
    this.sessionPendingClients.clear()
  }

  // ── Client management ──────────────────────────────────────────────────────

  addClient(client: SyncClient): void {
    this.clients.set(client.id, {
      client,
      metadataShadow: null,
      sessionShadows: new Map(),
      subscribedSessions: new Set(),
      subscribedMetadata: false,
    })
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId)
  }

  /** Send a message directly to a specific client (for clerk responses, errors, etc.). */
  sendToClient(clientId: string, msg: object): void {
    const state = this.clients.get(clientId)
    if (state) {
      state.client.sendMessage(JSON.stringify(msg))
    }
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  subscribeMetadata(clientId: string): void {
    const state = this.clients.get(clientId)
    if (!state) return
    state.subscribedMetadata = true
    // Send full snapshot immediately
    const model = this.store.getModel()
    state.metadataShadow = snapshot(model)
    state.client.sendMessage(
      JSON.stringify({
        type: 'snapshot',
        scope: 'metadata',
        data: model,
      }),
    )
  }

  unsubscribeMetadata(clientId: string): void {
    const state = this.clients.get(clientId)
    if (!state) return
    state.subscribedMetadata = false
    state.metadataShadow = null
  }

  subscribeSession(clientId: string, sessionId: string): void {
    const state = this.clients.get(clientId)
    if (!state) return
    state.subscribedSessions.add(sessionId)
    // Send full snapshot immediately
    const session = this.store.getActiveSession(sessionId)
    if (session) {
      state.sessionShadows.set(sessionId, snapshot(session))
      state.client.sendMessage(
        JSON.stringify({
          type: 'snapshot',
          scope: 'session',
          sessionId,
          data: session,
        }),
      )
    } else {
      state.client.sendMessage(
        JSON.stringify({
          type: 'error',
          message: `Session ${sessionId} not found`,
        }),
      )
    }
  }

  unsubscribeSession(clientId: string, sessionId: string): void {
    const state = this.clients.get(clientId)
    if (!state) return
    state.subscribedSessions.delete(sessionId)
    state.sessionShadows.delete(sessionId)
  }

  // ── Internal: react to model changes ───────────────────────────────────────

  private _onModelChange(): void {
    const current = this.store.getModel()
    for (const state of this.clients.values()) {
      if (!state.subscribedMetadata || !state.metadataShadow) continue
      const ops = generatePatch(state.metadataShadow, current)
      if (ops.length > 0) {
        state.client.sendMessage(
          JSON.stringify({
            type: 'patch',
            scope: 'metadata',
            ops,
          }),
        )
        state.metadataShadow = snapshot(current)
      }
    }
  }

  private _onSessionChange(sessionId: string): void {
    // Throttle session patches: max 4/sec (250ms)
    let pending = this.sessionPendingClients.get(sessionId)
    if (!pending) {
      pending = new Set()
      this.sessionPendingClients.set(sessionId, pending)
    }

    // Collect all subscribed clients
    for (const [clientId, state] of this.clients) {
      if (state.subscribedSessions.has(sessionId)) {
        pending.add(clientId)
      }
    }

    // If no timer running, flush immediately and start debounce
    if (!this.sessionThrottleTimers.has(sessionId)) {
      this._flushSessionPatches(sessionId)
      this.sessionThrottleTimers.set(
        sessionId,
        setTimeout(() => {
          this.sessionThrottleTimers.delete(sessionId)
          // Flush any accumulated changes during the throttle window
          const stillPending = this.sessionPendingClients.get(sessionId)
          if (stillPending && stillPending.size > 0) {
            this._flushSessionPatches(sessionId)
          }
        }, 250),
      )
    }
  }

  private _flushSessionPatches(sessionId: string): void {
    const current = this.store.getActiveSession(sessionId)
    if (!current) return

    const pending = this.sessionPendingClients.get(sessionId)
    if (!pending) return

    for (const clientId of pending) {
      const state = this.clients.get(clientId)
      if (!state) continue

      const shadow = state.sessionShadows.get(sessionId)
      if (!shadow) continue

      const ops = generatePatch(shadow, current)
      if (ops.length > 0) {
        state.client.sendMessage(
          JSON.stringify({
            type: 'patch',
            scope: 'session',
            sessionId,
            ops,
          }),
        )
        state.sessionShadows.set(sessionId, snapshot(current))
      }
    }

    pending.clear()
  }

  /** Force-flush all pending session patches (useful for tests). */
  flush(): void {
    for (const [sessionId, pending] of this.sessionPendingClients) {
      if (pending.size > 0) {
        this._flushSessionPatches(sessionId)
      }
    }
  }
}
