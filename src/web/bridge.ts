/**
 * Bridge server: encrypting proxy between browser and relay.
 *
 * - Connects to the relay with AES-256-GCM encryption (reuses pairing)
 * - Serves the Vite-built web client as static files
 * - Exposes a local plaintext WebSocket at /ws for the browser
 *
 * Browser ←─ local WS (plaintext) ─→ Bridge ←─ relay WS (encrypted) ─→ Relay ←→ Daemon
 */

import { extname } from 'node:path'
import { decryptEnvelope, encryptPayload, loadPairing, loadSharedKey, type RelayEnvelope } from '@merlin/relay'
import type { Server, ServerWebSocket } from 'bun'

/** Explicit, in-process relay credentials (used by the unified `daemon -w` mode). */
export interface BridgeCredentials {
  token: string
  sharedKey: CryptoKey
  relayUrl: string
}

interface BridgeOptions {
  port: number
  /** Bind host. Undefined = Bun default (0.0.0.0). Set for portless dual-stack. */
  hostname?: string
  /** Disk pairing name (loaded from ~/.merlin). Ignored when `credentials` is set. */
  name?: string
  relay?: string
  /** Use these credentials directly instead of loading a pairing from disk. */
  credentials?: BridgeCredentials
  /** Log sink. Defaults to console.log. Pass the daemon TUI logger when embedded. */
  log?: (msg: string) => void
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export async function createBridge(opts: BridgeOptions): Promise<Server> {
  const log = opts.log ?? ((msg: string) => console.log(msg))

  // ── Resolve credentials ─────────────────────────────────────────────────────
  let sharedKey: CryptoKey
  let token: string
  let relayUrl: string

  if (opts.credentials) {
    // Unified mode: key shared in-process by the daemon, never touches disk.
    ;({ sharedKey, token, relayUrl } = opts.credentials)
  } else {
    const name = opts.name ?? 'client'
    const pairing = await loadPairing(name)
    if (!pairing) {
      throw new Error(`No pairing found for "${name}". Run: bun src/cli/tui.ts --pair --name ${name}`)
    }
    sharedKey = await loadSharedKey(pairing)
    token = pairing.sessionToken
    relayUrl = opts.relay ?? pairing.relayUrl
  }

  // ── Relay connection ────────────────────────────────────────────────────────
  const browserSockets = new Set<ServerWebSocket<{ type: 'browser' }>>()
  let relayWs: WebSocket | null = null
  let relayConnected = false

  function connectRelay() {
    const wsUrl = relayUrl.replace(/^http/, 'ws')
    relayWs = new WebSocket(`${wsUrl}/ws?side=client&token=${encodeURIComponent(token)}`)

    relayWs.onopen = async () => {
      relayConnected = true
      log('[bridge] Connected to relay')

      // Subscribe to metadata
      const envelope = await encryptPayload({ type: 'subscribe', scope: 'metadata' }, sharedKey)
      relayWs!.send(JSON.stringify(envelope))
    }

    relayWs.onmessage = async (event) => {
      try {
        const raw = JSON.parse(event.data as string) as RelayEnvelope
        const decrypted = await decryptEnvelope(raw, sharedKey)
        const plaintext = JSON.stringify(decrypted)

        // Fan out to all connected browsers
        for (const ws of browserSockets) {
          ws.send(plaintext)
        }
      } catch {
        /* ignore undecodable */
      }
    }

    relayWs.onclose = () => {
      relayConnected = false
      log('[bridge] Relay disconnected, reconnecting in 2s...')
      setTimeout(connectRelay, 2000)
    }

    relayWs.onerror = () => {}
  }

  connectRelay()

  // ── Static file serving ────────────────────────────────────────────────────
  // Assets come from src/web/client-assets.gen.ts (written by `bun run
  // web:build`). Those imports are `{ type: 'file' }` so `bun build --compile`
  // embeds them into the binary; from source they resolve on disk. The module
  // may be absent when iterating with `bun run web` (Vite serves the UI then),
  // so load it lazily and degrade gracefully instead of failing at import.
  let assets: Record<string, string> | null | undefined

  async function getAssets(): Promise<Record<string, string> | null> {
    if (assets !== undefined) return assets
    try {
      assets = (await import('./client-assets.gen.ts')).WEB_ASSETS
    } catch {
      assets = null // not built
    }
    return assets
  }

  async function serveStatic(pathname: string): Promise<Response> {
    const map = await getAssets()
    if (!map) {
      return new Response('Web UI not built. Run: bun run web:build', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    // Exact asset, else SPA fallback to index.html for client-side routes.
    const target = map[pathname] ?? map['/index.html']
    if (!target) return new Response('Not Found', { status: 404 })

    const ext = extname(map[pathname] ? pathname : '/index.html')
    return new Response(Bun.file(target), {
      headers: { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' },
    })
  }

  // ── Bun server ──────────────────────────────────────────────────────────────
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    async fetch(req, server) {
      const url = new URL(req.url)

      // WebSocket upgrade
      if (url.pathname === '/bridge') {
        const upgraded = server.upgrade(req, { data: { type: 'browser' } })
        if (upgraded) return undefined as unknown as Response
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      // Health check
      if (url.pathname === '/health') {
        return Response.json({ ok: true, relay: relayConnected })
      }

      // Static files
      return serveStatic(url.pathname === '/' ? '/index.html' : url.pathname)
    },

    websocket: {
      open(ws: ServerWebSocket<{ type: 'browser' }>) {
        browserSockets.add(ws)
        log(`[bridge] Browser connected (${browserSockets.size} total)`)
      },

      async message(_ws, message) {
        // Forward browser message to relay (encrypted)
        if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return
        try {
          const raw = typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer)
          const parsed = JSON.parse(raw)
          const envelope = await encryptPayload(parsed, sharedKey)
          relayWs.send(JSON.stringify(envelope))
        } catch {
          /* ignore */
        }
      },

      close(ws) {
        browserSockets.delete(ws)
        log(`[bridge] Browser disconnected (${browserSockets.size} total)`)
      },
    },
  })

  const displayHost = !opts.hostname || opts.hostname === '::' ? 'localhost' : opts.hostname
  log(`[bridge] Listening on http://${displayHost}:${server.port}`)
  log(`[bridge] Relay: ${relayUrl}`)
  log(`[bridge] Source: ${opts.credentials ? 'in-process (unified)' : `pairing "${opts.name ?? 'client'}"`}`)

  return server
}
