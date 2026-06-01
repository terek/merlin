import type { Server, ServerWebSocket } from 'bun'
import { Room, type SocketData } from './room.ts'

interface PairingCode {
  sessionToken: string
  daemonPubKey: string
  daemonName?: string
  createdAt: number
}

const CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes

function generateCode(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  const num = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  return num.toString(36).toUpperCase().padStart(6, '0').slice(-6)
}

/**
 * Create a relay server on the given port. Port 0 = OS-assigned (for tests).
 * Returns the Bun server instance.
 */
export function createRelay(port: number = 0): Server {
  const rooms = new Map<string, Room>()
  const pairingCodes = new Map<string, PairingCode>()

  function getRoom(token: string): Room {
    let room = rooms.get(token)
    if (!room) {
      room = new Room()
      rooms.set(token, room)
    }
    return room
  }

  function cleanupRoom(token: string): void {
    const room = rooms.get(token)
    if (room?.isEmpty()) rooms.delete(token)
  }

  function purgeExpiredCodes(): void {
    const now = Date.now()
    for (const [code, data] of pairingCodes) {
      if (now - data.createdAt > CODE_TTL_MS) pairingCodes.delete(code)
    }
  }

  const server = Bun.serve<SocketData>({
    port,
    async fetch(req, server) {
      const url = new URL(req.url)

      // Health check
      if (url.pathname === '/health') {
        return new Response('ok')
      }

      // -- Pairing endpoints --

      if (req.method === 'POST' && url.pathname === '/pair/create') {
        const body = (await req.json()) as { daemonPubKey?: string; daemonName?: string }
        if (!body.daemonPubKey) {
          return Response.json({ error: 'daemonPubKey required' }, { status: 400 })
        }

        purgeExpiredCodes()

        const sessionToken = crypto.randomUUID()
        const code = generateCode()

        pairingCodes.set(code, {
          sessionToken,
          daemonPubKey: body.daemonPubKey,
          daemonName: body.daemonName,
          createdAt: Date.now(),
        })

        return Response.json({ code, sessionToken, expiresIn: 600 })
      }

      if (req.method === 'POST' && url.pathname.startsWith('/pair/join/')) {
        const code = url.pathname.split('/').pop()!
        const body = (await req.json()) as { clientPubKey?: string }
        if (!body.clientPubKey) {
          return Response.json({ error: 'clientPubKey required' }, { status: 400 })
        }

        purgeExpiredCodes()

        const stored = pairingCodes.get(code)
        if (!stored) {
          return Response.json({ error: 'Code not found or expired' }, { status: 404 })
        }

        // Single-use: delete code
        pairingCodes.delete(code)

        return Response.json({
          sessionToken: stored.sessionToken,
          daemonPubKey: stored.daemonPubKey,
          daemonName: stored.daemonName,
        })
      }

      // -- WebSocket upgrade --

      if (url.pathname === '/ws') {
        const side = url.searchParams.get('side') as 'daemon' | 'client' | null
        const token = url.searchParams.get('token')

        if (!side || !token || (side !== 'daemon' && side !== 'client')) {
          return new Response('Missing or invalid side/token', { status: 400 })
        }

        const upgraded = server.upgrade(req, {
          data: { side, token },
        })
        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 500 })
        }
        return undefined
      }

      return new Response('Not Found', { status: 404 })
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        const { side, token } = ws.data
        const room = getRoom(token)
        if (side === 'daemon') {
          room.addDaemon(ws)
        } else {
          room.addClient(ws)
        }
      },
      message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
        const { side, token } = ws.data
        const room = rooms.get(token)
        if (!room) return

        const data = typeof message === 'string' ? message : message.toString()
        if (side === 'daemon') {
          room.sendToClient(data)
        } else {
          room.sendToDaemon(data)
        }
      },
      close(ws: ServerWebSocket<SocketData>) {
        const { side, token } = ws.data
        const room = rooms.get(token)
        if (!room) return

        if (side === 'daemon') {
          room.removeDaemon(ws)
        } else {
          room.removeClient(ws)
        }
        cleanupRoom(token)
      },
    },
  })

  return server
}
