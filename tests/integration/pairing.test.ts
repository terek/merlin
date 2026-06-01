/**
 * Integration tests for the full pairing flow:
 * daemon initiates → relay creates code → client joins → key exchange → encrypted communication.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { ClientMessage, DaemonMessage } from '@merlin/protocol'
import {
  createRelay,
  decryptEnvelope,
  deriveSharedKey,
  encryptPayload,
  exportAesKey,
  generateKeypair,
  type RelayEnvelope,
} from '@merlin/relay'
import type { Server } from 'bun'
import { Daemon } from '../../src/daemon.ts'

let relay: Server | null = null
let daemon: Daemon | null = null
let cleanups: (() => void)[] = []

afterEach(async () => {
  for (const fn of cleanups) fn()
  cleanups = []
  await daemon?.stop()
  daemon = null
  relay?.stop(true)
  relay = null
})

function startRelay(): { httpUrl: string; wsUrl: string } {
  relay = createRelay(0)
  return {
    httpUrl: `http://localhost:${relay.port}`,
    wsUrl: `ws://localhost:${relay.port}`,
  }
}

describe('Pairing — full flow', () => {
  test('daemon creates code, client joins, both derive same key, communicate', async () => {
    const { httpUrl, wsUrl } = startRelay()

    // === Daemon side ===
    const daemonKp = await generateKeypair()

    // Step 1: Create pairing session
    const createRes = await fetch(`${httpUrl}/pair/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daemonPubKey: daemonKp.publicKeySpki, daemonName: 'test-host' }),
    })
    expect(createRes.status).toBe(200)
    const { code, sessionToken } = (await createRes.json()) as { code: string; sessionToken: string }
    expect(code).toMatch(/^[0-9A-Z]{6}$/)
    expect(sessionToken).toBeTruthy()

    // Daemon connects to relay and waits for key exchange
    const daemonWs = new WebSocket(`${wsUrl}/ws?side=daemon&token=${sessionToken}`)
    await new Promise<void>((resolve, reject) => {
      daemonWs.onopen = () => resolve()
      daemonWs.onerror = () => reject(new Error('daemon ws error'))
    })
    cleanups.push(() => daemonWs.close())

    // === Client side ===
    const clientKp = await generateKeypair()

    // Step 2: Client joins with code
    const joinRes = await fetch(`${httpUrl}/pair/join/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientPubKey: clientKp.publicKeySpki }),
    })
    expect(joinRes.status).toBe(200)
    const joinData = (await joinRes.json()) as { sessionToken: string; daemonPubKey: string; daemonName: string }
    expect(joinData.sessionToken).toBe(sessionToken)
    expect(joinData.daemonPubKey).toBe(daemonKp.publicKeySpki)
    expect(joinData.daemonName).toBe('test-host')

    // Client connects and sends key exchange
    const clientWs = new WebSocket(`${wsUrl}/ws?side=client&token=${sessionToken}`)
    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => resolve()
      clientWs.onerror = () => reject(new Error('client ws error'))
    })
    cleanups.push(() => clientWs.close())

    // Client sends its public key
    clientWs.send(JSON.stringify({ type: 'key_exchange', publicKey: clientKp.publicKeySpki }))

    // Daemon receives key exchange
    const clientPubKey = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('key exchange timeout')), 5000)
      daemonWs.onmessage = (event) => {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'key_exchange') {
          clearTimeout(timeout)
          resolve(msg.publicKey)
        }
      }
    })

    // Both derive shared key
    const daemonShared = await deriveSharedKey(daemonKp.privateKey, clientPubKey)
    const clientShared = await deriveSharedKey(clientKp.privateKey, joinData.daemonPubKey)

    // Verify they derived the same key
    const daemonKeyStr = await exportAesKey(daemonShared)
    const clientKeyStr = await exportAesKey(clientShared)
    expect(daemonKeyStr).toBe(clientKeyStr)

    // Daemon sends ack
    daemonWs.send(JSON.stringify({ type: 'key_exchange_ack' }))

    // === Encrypted communication ===
    // Daemon sends encrypted message
    const testMsg: DaemonMessage = {
      type: 'snapshot',
      scope: 'metadata',
      data: {
        host: { name: 'test', instanceName: 'test', version: '1.0', connectedClients: 0 },
        projects: {},
        ignoredProjectCount: 0,
        processingRuntime: { activeSessions: [], llmTotals: {} },
      },
    }
    const envelope = await encryptPayload(testMsg, daemonShared)
    daemonWs.send(JSON.stringify(envelope))

    // Client receives and decrypts
    const received = await new Promise<DaemonMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('message timeout')), 5000)
      clientWs.onmessage = async (event) => {
        try {
          const raw = JSON.parse(event.data as string)
          // Skip the key_exchange_ack
          if (raw.type === 'key_exchange_ack') return
          const decrypted = await decryptEnvelope(raw as RelayEnvelope, clientShared)
          clearTimeout(timeout)
          resolve(decrypted as DaemonMessage)
        } catch {
          /* skip non-encrypted messages */
        }
      }
    })

    expect(received.type).toBe('snapshot')
    if (received.type === 'snapshot' && received.scope === 'metadata') {
      expect(received.data.host.name).toBe('test')
    }
  })

  test('full pairing → daemon → encrypted metadata flow', async () => {
    const { httpUrl, wsUrl } = startRelay()

    // Daemon creates pairing
    const daemonKp = await generateKeypair()
    const createRes = await fetch(`${httpUrl}/pair/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daemonPubKey: daemonKp.publicKeySpki }),
    })
    const { code, sessionToken } = (await createRes.json()) as { code: string; sessionToken: string }

    // Daemon connects to relay (to receive key exchange)
    const daemonExchangeWs = new WebSocket(`${wsUrl}/ws?side=daemon&token=${sessionToken}`)
    await new Promise<void>((resolve) => {
      daemonExchangeWs.onopen = () => resolve()
    })
    cleanups.push(() => daemonExchangeWs.close())

    // Client joins
    const clientKp = await generateKeypair()
    const joinRes = await fetch(`${httpUrl}/pair/join/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientPubKey: clientKp.publicKeySpki }),
    })
    const { daemonPubKey } = (await joinRes.json()) as { daemonPubKey: string }

    // Client connects and sends key exchange
    const clientExchangeWs = new WebSocket(`${wsUrl}/ws?side=client&token=${sessionToken}`)
    await new Promise<void>((resolve) => {
      clientExchangeWs.onopen = () => resolve()
    })

    clientExchangeWs.send(JSON.stringify({ type: 'key_exchange', publicKey: clientKp.publicKeySpki }))

    // Daemon receives and derives key
    const clientPub = await new Promise<string>((resolve) => {
      daemonExchangeWs.onmessage = (event) => {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'key_exchange') resolve(msg.publicKey)
      }
    })
    const daemonShared = await deriveSharedKey(daemonKp.privateKey, clientPub)
    const clientShared = await deriveSharedKey(clientKp.privateKey, daemonPubKey)

    // Close exchange WebSockets
    daemonExchangeWs.close()
    clientExchangeWs.close()
    await new Promise((r) => setTimeout(r, 100))

    // Now start the real daemon with the derived key
    daemon = new Daemon({
      log: () => {},
      instanceName: 'paired-daemon',
      relayUrl: wsUrl,
      token: sessionToken,
      sharedKey: daemonShared,
      skipLock: true,
      claudeDir: '/nonexistent',
      clerk: false,
    })
    await daemon.start()
    await new Promise((r) => setTimeout(r, 200))

    // Client connects for real and subscribes (encrypted)
    const clientWs = new WebSocket(`${wsUrl}/ws?side=client&token=${sessionToken}`)
    await new Promise<void>((resolve) => {
      clientWs.onopen = () => resolve()
    })
    cleanups.push(() => clientWs.close())

    // Send encrypted subscribe
    const subEnvelope = await encryptPayload(
      { type: 'subscribe', scope: 'metadata' } satisfies ClientMessage,
      clientShared,
    )
    clientWs.send(JSON.stringify(subEnvelope))

    // Receive encrypted snapshot
    const snapshot = await new Promise<DaemonMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('snapshot timeout')), 5000)
      clientWs.onmessage = async (event) => {
        try {
          const raw = JSON.parse(event.data as string)
          const decrypted = await decryptEnvelope(raw as RelayEnvelope, clientShared)
          const msg = decrypted as DaemonMessage
          if (msg.type === 'snapshot') {
            clearTimeout(timeout)
            resolve(msg)
          }
        } catch {
          /* skip */
        }
      }
    })

    expect(snapshot.type).toBe('snapshot')
    if (snapshot.type === 'snapshot' && snapshot.scope === 'metadata') {
      expect(snapshot.data.host.instanceName).toBe('paired-daemon')
    }
  })
})
