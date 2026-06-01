import { decryptEnvelope, encryptPayload, type RelayEnvelope } from './crypto/envelope.ts'

export interface RelayConnectorOptions<TReceive = unknown, _TSend = unknown> {
  relayUrl: string
  token: string
  sharedKey: CryptoKey
  /** Validate + parse a decrypted message. Return null to silently drop. */
  parseMessage: (raw: unknown) => TReceive | null
  onMessage: (msg: TReceive) => void
  onOpen?: () => void
  onClose?: () => void
}

/**
 * WebSocket client that connects to a relay with E2E encryption (AES-256-GCM).
 * Generic over message types — the caller provides a parseMessage validator.
 */
export class RelayConnector<TReceive = unknown, TSend = unknown> {
  private ws: WebSocket | null = null
  private opts: RelayConnectorOptions<TReceive, TSend>
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _closed = false

  constructor(opts: RelayConnectorOptions<TReceive, TSend>) {
    this.opts = opts
  }

  connect(): void {
    this._closed = false
    const url = `${this.opts.relayUrl}/ws?side=daemon&token=${encodeURIComponent(this.opts.token)}`
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.opts.onOpen?.()
    }

    this.ws.onmessage = async (event) => {
      try {
        const raw = JSON.parse(event.data as string)
        // Skip relay control messages
        if (raw._relay) return
        // Decrypt the envelope
        const decrypted = await decryptEnvelope(raw as RelayEnvelope, this.opts.sharedKey)
        const parsed = this.opts.parseMessage(decrypted)
        if (parsed !== null) {
          this.opts.onMessage(parsed)
        }
      } catch {
        // ignore non-JSON, decryption failures, or invalid messages
      }
    }

    this.ws.onclose = () => {
      this.opts.onClose?.()
      if (!this._closed) {
        this._scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  async send(msg: TSend): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const envelope = await encryptPayload(msg, this.opts.sharedKey)
      this.ws.send(JSON.stringify(envelope))
    }
  }

  close(): void {
    this._closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private _scheduleReconnect(): void {
    if (this._closed) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this._closed) this.connect()
    }, 2000)
  }
}
