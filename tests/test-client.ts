import type { ActiveSession, ClientMessage, DaemonMessage, MerlinModel } from '@merlin/protocol'
import { decryptEnvelope, encryptPayload, type RelayEnvelope } from '@merlin/relay'
import { applyOps } from '@merlin/sync'

export interface TestClientOptions {
  relayUrl: string
  token: string
  sharedKey: CryptoKey
}

/**
 * TestClient: connects to the relay as a client, applies snapshots + patches,
 * and reconstructs the model locally. Used in integration tests.
 * All messages are E2E encrypted.
 */
export class TestClient {
  private ws: WebSocket | null = null
  private opts: TestClientOptions
  private _model: MerlinModel | null = null
  private _sessions = new Map<string, ActiveSession>()
  private _messages: DaemonMessage[] = []
  private _onMessage: ((msg: DaemonMessage) => void) | null = null
  private _openPromise: { resolve: () => void; reject: (e: Error) => void } | null = null

  constructor(opts: TestClientOptions) {
    this.opts = opts
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `${this.opts.relayUrl}/ws?side=client&token=${encodeURIComponent(this.opts.token)}`
      this.ws = new WebSocket(url)
      this._openPromise = { resolve, reject }

      this.ws.onopen = () => {
        this._openPromise?.resolve()
        this._openPromise = null
      }

      this.ws.onerror = (_err) => {
        if (this._openPromise) {
          this._openPromise.reject(new Error('WebSocket error'))
          this._openPromise = null
        }
      }

      this.ws.onmessage = async (event) => {
        try {
          const raw = JSON.parse(event.data as string)
          const decrypted = await decryptEnvelope(raw as RelayEnvelope, this.opts.sharedKey)
          this._handleMessage(decrypted as DaemonMessage)
        } catch {
          /* ignore */
        }
      }

      this.ws.onclose = () => {}
    })
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }

  async send(msg: ClientMessage): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const envelope = await encryptPayload(msg, this.opts.sharedKey)
      this.ws.send(JSON.stringify(envelope))
    }
  }

  // ── Convenience commands ───────────────────────────────────────────────────

  subscribeMetadata(): void {
    void this.send({ type: 'subscribe', scope: 'metadata' })
  }

  subscribeSession(sessionId: string): void {
    void this.send({ type: 'subscribe', scope: 'session', sessionId })
  }

  unsubscribeSession(sessionId: string): void {
    void this.send({ type: 'unsubscribe', scope: 'session', sessionId })
  }

  sendMessage(sessionId: string, text: string): void {
    void this.send({ type: 'send_message', sessionId, text })
  }

  openProject(cwd: string, ccSessionId?: string): void {
    void this.send({ type: 'open_project', cwd, ccSessionId })
  }

  killSession(sessionId: string): void {
    void this.send({ type: 'kill_session', sessionId })
  }

  refreshProjects(force?: boolean): void {
    void this.send({ type: 'refresh_projects', force })
  }

  approve(sessionId: string, optionKey: string): void {
    void this.send({ type: 'approve', sessionId, optionKey })
  }

  deny(sessionId: string): void {
    void this.send({ type: 'deny', sessionId })
  }

  clerkMessage(cwd: string, text: string): void {
    void this.send({ type: 'clerk_message', cwd, text })
  }

  clerkInterrupt(cwd: string): void {
    void this.send({ type: 'clerk_interrupt', cwd })
  }

  clerkLoad(cwd: string): void {
    void this.send({ type: 'clerk_load', cwd })
  }

  getSegments(cwd: string): void {
    void this.send({ type: 'get_segments', cwd })
  }

  // ── State access ───────────────────────────────────────────────────────────

  get model(): MerlinModel | null {
    return this._model
  }

  getSession(sessionId: string): ActiveSession | undefined {
    return this._sessions.get(sessionId)
  }

  get messages(): DaemonMessage[] {
    return this._messages
  }

  /**
   * Wait for a message matching the predicate, with timeout.
   */
  waitForMessage(predicate: (msg: DaemonMessage) => boolean, timeoutMs = 5000): Promise<DaemonMessage> {
    return new Promise((resolve, reject) => {
      // Check already received messages
      const existing = this._messages.find(predicate)
      if (existing) {
        resolve(existing)
        return
      }

      const timer = setTimeout(() => {
        this._onMessage = null
        reject(new Error(`Timeout waiting for message (${timeoutMs}ms)`))
      }, timeoutMs)

      const prev = this._onMessage
      this._onMessage = (msg) => {
        prev?.(msg)
        if (predicate(msg)) {
          clearTimeout(timer)
          this._onMessage = prev
          resolve(msg)
        }
      }
    })
  }

  /**
   * Wait until the model matches a predicate.
   */
  waitForModel(predicate: (model: MerlinModel) => boolean, timeoutMs = 5000): Promise<MerlinModel> {
    return new Promise((resolve, reject) => {
      if (this._model && predicate(this._model)) {
        resolve(this._model)
        return
      }

      const timer = setTimeout(() => {
        this._onMessage = null
        reject(new Error(`Timeout waiting for model condition (${timeoutMs}ms)`))
      }, timeoutMs)

      const prev = this._onMessage
      this._onMessage = (msg) => {
        prev?.(msg)
        if (this._model && predicate(this._model)) {
          clearTimeout(timer)
          this._onMessage = prev
          resolve(this._model)
        }
      }
    })
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _handleMessage(msg: DaemonMessage): void {
    this._messages.push(msg)

    switch (msg.type) {
      case 'snapshot':
        if (msg.scope === 'metadata') {
          this._model = msg.data
        } else if (msg.scope === 'session') {
          this._sessions.set(msg.sessionId, msg.data)
        }
        break

      case 'patch':
        if (msg.scope === 'metadata' && this._model) {
          this._model = applyOps(this._model, msg.ops)
        } else if (msg.scope === 'session') {
          const existing = this._sessions.get(msg.sessionId)
          if (existing) {
            this._sessions.set(msg.sessionId, applyOps(existing, msg.ops))
          }
        }
        break
    }

    this._onMessage?.(msg)
  }
}
