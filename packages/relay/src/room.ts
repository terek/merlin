import type { ServerWebSocket } from 'bun'

export interface QueuedMessage {
  data: string
  timestamp: number
}

const MAX_QUEUE = 100
const QUEUE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export interface SocketData {
  side: 'daemon' | 'client'
  token: string
}

/**
 * Per-token channel: one daemon + one client.
 * Messages from daemon go to client; messages from client go to daemon.
 * Queues messages when either side is offline (max 100, 5min TTL).
 */
export class Room {
  daemon: ServerWebSocket<SocketData> | null = null
  client: ServerWebSocket<SocketData> | null = null
  private daemonQueue: QueuedMessage[] = [] // queued for daemon when offline
  private clientQueue: QueuedMessage[] = [] // queued for client when offline

  addDaemon(ws: ServerWebSocket<SocketData>): void {
    this.daemon = ws
    this._flushQueue(this.daemonQueue, ws)
  }

  removeDaemon(ws: ServerWebSocket<SocketData>): void {
    if (this.daemon === ws) this.daemon = null
  }

  addClient(ws: ServerWebSocket<SocketData>): void {
    // If a client is already connected, kick the old one
    if (this.client) {
      this.client.close(1000, 'replaced')
    }
    this.client = ws
    this._flushQueue(this.clientQueue, ws)
  }

  removeClient(ws: ServerWebSocket<SocketData>): void {
    if (this.client === ws) this.client = null
  }

  /** Route a message from the daemon to the connected client. */
  sendToClient(data: string): void {
    if (!this.client) {
      this._enqueue(this.clientQueue, data)
      return
    }
    this.client.send(data)
  }

  /** Route a message from a client to the daemon. */
  sendToDaemon(data: string): void {
    if (!this.daemon) {
      this._enqueue(this.daemonQueue, data)
      return
    }
    this.daemon.send(data)
  }

  isEmpty(): boolean {
    return this.daemon === null && this.client === null
  }

  private _enqueue(queue: QueuedMessage[], data: string): void {
    const now = Date.now()
    while (queue.length > 0 && now - queue[0].timestamp > QUEUE_TTL_MS) {
      queue.shift()
    }
    if (queue.length >= MAX_QUEUE) {
      queue.shift()
    }
    queue.push({ data, timestamp: now })
  }

  private _flushQueue(queue: QueuedMessage[], ws: ServerWebSocket<SocketData>): void {
    const now = Date.now()
    const valid = queue.filter((m) => now - m.timestamp <= QUEUE_TTL_MS)
    for (const msg of valid) {
      ws.send(msg.data)
    }
    queue.length = 0
  }
}
