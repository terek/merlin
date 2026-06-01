/**
 * E2E security tests: verify that the relay + encryption provides
 * confidentiality and that pairing codes are the only way to obtain secrets.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  createRelay,
  decryptEnvelope,
  deriveSharedKey,
  encryptPayload,
  exportAesKey,
  generateKeypair,
} from '@merlin/relay'
import type { Server } from 'bun'
import { Daemon } from '../../src/daemon.ts'
import { TestClient } from '../test-client.ts'

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

function startRelay(): { url: string; wsUrl: string; server: Server } {
  relay = createRelay(0)
  const url = `http://localhost:${relay.port}`
  const wsUrl = `ws://localhost:${relay.port}`
  return { url, wsUrl, server: relay }
}

/** Helper: perform full pairing flow via HTTP endpoints. */
async function pairViaRelay(relayUrl: string) {
  const daemonKp = await generateKeypair()
  const clientKp = await generateKeypair()

  // Step 1: daemon creates pairing session
  const createRes = await fetch(`${relayUrl}/pair/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ daemonPubKey: daemonKp.publicKeySpki, daemonName: 'test-daemon' }),
  })
  const { code, sessionToken } = (await createRes.json()) as { code: string; sessionToken: string }

  // Step 2: client joins with code
  const joinRes = await fetch(`${relayUrl}/pair/join/${code}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientPubKey: clientKp.publicKeySpki }),
  })
  const joinData = (await joinRes.json()) as { sessionToken: string; daemonPubKey: string }

  // Step 3: both sides derive shared key
  const daemonKey = await deriveSharedKey(daemonKp.privateKey, clientKp.publicKeySpki)
  const clientKey = await deriveSharedKey(clientKp.privateKey, joinData.daemonPubKey)

  return { sessionToken, daemonKp, clientKp, daemonKey, clientKey, code }
}

// ── Pairing flow tests ────────────────────────────────────────────────────────

describe('Security — pairing flow', () => {
  test('full pairing: create code, join, derive shared key, communicate', async () => {
    const { url, wsUrl } = startRelay()
    const { sessionToken, daemonKey, clientKey } = await pairViaRelay(url)

    // Start daemon with the shared key
    daemon = new Daemon({
      log: () => {},
      instanceName: 'sec-daemon',
      relayUrl: wsUrl,
      token: sessionToken,
      sharedKey: daemonKey,
      skipLock: true,
      claudeDir: '/nonexistent',
      clerk: false,
    })
    await daemon.start()
    await new Promise((r) => setTimeout(r, 200))

    // Client connects and subscribes
    const client = new TestClient({ relayUrl: wsUrl, token: sessionToken, sharedKey: clientKey })
    await client.connect()
    cleanups.push(() => client.close())

    client.subscribeMetadata()
    const model = await client.waitForModel((m) => m.host.name !== '', 3000)
    expect(model.host.instanceName).toBe('sec-daemon')
  })

  test('pairing code is single-use', async () => {
    const { url } = startRelay()
    const daemonKp = await generateKeypair()

    const createRes = await fetch(`${url}/pair/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daemonPubKey: daemonKp.publicKeySpki }),
    })
    const { code } = (await createRes.json()) as { code: string }

    const clientKp = await generateKeypair()

    // First join succeeds
    const join1 = await fetch(`${url}/pair/join/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientPubKey: clientKp.publicKeySpki }),
    })
    expect(join1.status).toBe(200)

    // Second join with same code fails
    const join2 = await fetch(`${url}/pair/join/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientPubKey: clientKp.publicKeySpki }),
    })
    expect(join2.status).toBe(404)
  })

  test('invalid code returns 404', async () => {
    const { url } = startRelay()
    const clientKp = await generateKeypair()

    const res = await fetch(`${url}/pair/join/BADCODE`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientPubKey: clientKp.publicKeySpki }),
    })
    expect(res.status).toBe(404)
  })

  test('create requires daemonPubKey', async () => {
    const { url } = startRelay()
    const res = await fetch(`${url}/pair/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('join requires clientPubKey', async () => {
    const { url } = startRelay()
    const res = await fetch(`${url}/pair/join/ANYCODE`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

// ── Eavesdropping resistance ──────────────────────────────────────────────────

describe('Security — eavesdropping resistance', () => {
  test('relay only sees encrypted blobs, never plaintext', async () => {
    const { url, wsUrl } = startRelay()
    const { sessionToken, daemonKey, clientKey } = await pairViaRelay(url)

    // Start daemon
    daemon = new Daemon({
      log: () => {},
      instanceName: 'spy-test-daemon',
      relayUrl: wsUrl,
      token: sessionToken,
      sharedKey: daemonKey,
      skipLock: true,
      claudeDir: '/nonexistent',
      clerk: false,
    })
    await daemon.start()
    await new Promise((r) => setTimeout(r, 200))

    // Connect a raw WebSocket as the client to see what the relay forwards.
    // With 1:1 rooms, this is the only client — it receives daemon messages directly.
    const intercepted: string[] = []
    const spy = new WebSocket(`${wsUrl}/ws?side=client&token=${sessionToken}`)
    await new Promise<void>((resolve, reject) => {
      spy.onopen = () => resolve()
      spy.onerror = () => reject(new Error('spy connect failed'))
    })
    spy.onmessage = (event) => intercepted.push(event.data as string)
    cleanups.push(() => spy.close())

    // Send a subscribe message (encrypted with correct key) to trigger daemon responses
    const _client = new TestClient({ relayUrl: wsUrl, token: sessionToken, sharedKey: clientKey })
    // The TestClient will replace the spy in the room, but queued messages
    // from daemon (snapshot response) may have already been sent.
    // Instead, just directly encrypt and send a subscribe via the spy's socket:
    const subscribePayload = await encryptPayload({ type: 'subscribe', scope: 'metadata' } as any, clientKey)
    spy.send(JSON.stringify(subscribePayload))

    // Wait for daemon to respond
    await new Promise((r) => setTimeout(r, 500))

    // Spy received some messages
    expect(intercepted.length).toBeGreaterThan(0)

    // But none of them contain plaintext model data
    for (const raw of intercepted) {
      const parsed = JSON.parse(raw)
      expect(parsed).toHaveProperty('encrypted')
      expect(parsed).toHaveProperty('iv')
      expect(parsed).not.toHaveProperty('type')
      expect(parsed).not.toHaveProperty('scope')
      expect(parsed).not.toHaveProperty('data')
      expect(raw).not.toContain('spy-test-daemon')
      expect(raw).not.toContain('snapshot')
      expect(raw).not.toContain('metadata')
    }
  })

  test('eavesdropper with wrong key cannot decrypt messages', async () => {
    const { url, wsUrl } = startRelay()
    const { sessionToken, daemonKey, clientKey } = await pairViaRelay(url)

    // Attacker has their own keypair — not part of the pairing
    const attackerKp = await generateKeypair()
    const attackerKey = await deriveSharedKey(attackerKp.privateKey, (await generateKeypair()).publicKeySpki)

    // Start daemon
    daemon = new Daemon({
      log: () => {},
      instanceName: 'eavesdrop-daemon',
      relayUrl: wsUrl,
      token: sessionToken,
      sharedKey: daemonKey,
      skipLock: true,
      claudeDir: '/nonexistent',
      clerk: false,
    })
    await daemon.start()
    await new Promise((r) => setTimeout(r, 200))

    // Eavesdropper connects as the client and sends a properly encrypted
    // subscribe (using the legit key) to trigger daemon responses.
    // In real life the eavesdropper wouldn't have the key, but we need
    // the daemon to actually send something — the test then verifies the
    // eavesdropper can't decrypt with a WRONG key.
    const rawMessages: string[] = []
    const eavesdropper = new WebSocket(`${wsUrl}/ws?side=client&token=${sessionToken}`)
    await new Promise<void>((resolve, reject) => {
      eavesdropper.onopen = () => resolve()
      eavesdropper.onerror = () => reject(new Error('eavesdropper connect failed'))
    })
    eavesdropper.onmessage = (event) => rawMessages.push(event.data as string)
    cleanups.push(() => eavesdropper.close())

    // Send a subscribe with the correct key to trigger responses
    const subscribePayload = await encryptPayload({ type: 'subscribe', scope: 'metadata' } as any, clientKey)
    eavesdropper.send(JSON.stringify(subscribePayload))

    await new Promise((r) => setTimeout(r, 500))

    // Attacker tries to decrypt each message with the WRONG key — all should fail
    expect(rawMessages.length).toBeGreaterThan(0)
    for (const raw of rawMessages) {
      const envelope = JSON.parse(raw)
      await expect(decryptEnvelope(envelope, attackerKey)).rejects.toThrow()
    }
  })
})

// ── Attacker sending messages ─────────────────────────────────────────────────

describe('Security — message injection', () => {
  test('plaintext message from attacker is silently rejected by daemon', async () => {
    const { url, wsUrl } = startRelay()
    const { sessionToken, daemonKey, clientKey } = await pairViaRelay(url)

    // Start daemon
    daemon = new Daemon({
      log: () => {},
      instanceName: 'inject-daemon',
      relayUrl: wsUrl,
      token: sessionToken,
      sharedKey: daemonKey,
      skipLock: true,
      claudeDir: '/nonexistent',
      clerk: false,
    })
    await daemon.start()
    await new Promise((r) => setTimeout(r, 200))

    // Attacker connects as a "client" and sends a plaintext message
    const attacker = new WebSocket(`${wsUrl}/ws?side=client&token=${sessionToken}`)
    await new Promise<void>((resolve, reject) => {
      attacker.onopen = () => resolve()
      attacker.onerror = () => reject(new Error('attacker connect failed'))
    })
    cleanups.push(() => attacker.close())

    // Send a plaintext subscribe (not encrypted) — daemon should ignore it
    attacker.send(JSON.stringify({ type: 'subscribe', scope: 'metadata' }))

    // Legit client should still work fine
    const client = new TestClient({ relayUrl: wsUrl, token: sessionToken, sharedKey: clientKey })
    await client.connect()
    cleanups.push(() => client.close())
    client.subscribeMetadata()

    const model = await client.waitForModel((m) => m.host.name !== '', 3000)
    expect(model.host.instanceName).toBe('inject-daemon')
  })

  test('message encrypted with wrong key is rejected by daemon', async () => {
    const { url, wsUrl } = startRelay()
    const { sessionToken, daemonKey, clientKey } = await pairViaRelay(url)

    // Start daemon
    daemon = new Daemon({
      log: () => {},
      instanceName: 'wrongkey-daemon',
      relayUrl: wsUrl,
      token: sessionToken,
      sharedKey: daemonKey,
      skipLock: true,
      claudeDir: '/nonexistent',
      clerk: false,
    })
    await daemon.start()
    await new Promise((r) => setTimeout(r, 200))

    // Attacker generates their own key and encrypts a message
    const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const fakeEnvelope = await encryptPayload({ type: 'subscribe', scope: 'metadata' }, wrongKey)

    const attacker = new WebSocket(`${wsUrl}/ws?side=client&token=${sessionToken}`)
    await new Promise<void>((resolve, reject) => {
      attacker.onopen = () => resolve()
      attacker.onerror = () => reject(new Error('attacker connect failed'))
    })
    cleanups.push(() => attacker.close())

    attacker.send(JSON.stringify(fakeEnvelope))

    // Legit client should still work fine
    const client = new TestClient({ relayUrl: wsUrl, token: sessionToken, sharedKey: clientKey })
    await client.connect()
    cleanups.push(() => client.close())
    client.subscribeMetadata()

    const model = await client.waitForModel((m) => m.host.name !== '', 3000)
    expect(model.host.instanceName).toBe('wrongkey-daemon')
  })
})

// ── Token/session isolation ───────────────────────────────────────────────────

describe('Security — session isolation', () => {
  test('different pairing sessions are completely isolated', async () => {
    const { url, wsUrl } = startRelay()

    // Two separate pairings
    const pair1 = await pairViaRelay(url)
    const pair2 = await pairViaRelay(url)

    // Start first daemon
    daemon = new Daemon({
      log: () => {},
      instanceName: 'daemon-1',
      relayUrl: wsUrl,
      token: pair1.sessionToken,
      sharedKey: pair1.daemonKey,
      skipLock: true,
      claudeDir: '/nonexistent',
      clerk: false,
    })
    await daemon.start()
    await new Promise((r) => setTimeout(r, 200))

    // Client from pair2 connects with pair1's token but pair2's key → cannot decrypt
    const wrongClient = new TestClient({
      relayUrl: wsUrl,
      token: pair1.sessionToken, // right room, wrong key
      sharedKey: pair2.clientKey,
    })
    await wrongClient.connect()
    cleanups.push(() => wrongClient.close())
    wrongClient.subscribeMetadata()

    // Should timeout — messages are encrypted with pair1's key
    await expect(wrongClient.waitForModel((m) => m.host.name !== '', 1000)).rejects.toThrow('Timeout')

    // Correct client works
    const rightClient = new TestClient({
      relayUrl: wsUrl,
      token: pair1.sessionToken,
      sharedKey: pair1.clientKey,
    })
    await rightClient.connect()
    cleanups.push(() => rightClient.close())
    rightClient.subscribeMetadata()

    const model = await rightClient.waitForModel((m) => m.host.name !== '', 3000)
    expect(model.host.instanceName).toBe('daemon-1')
  })
})

// ── Pairing code security ─────────────────────────────────────────────────────

describe('Security — pairing code brute-force resistance', () => {
  test('codes are 6 chars from base-36 alphabet (alphanumeric)', async () => {
    const { url } = startRelay()
    const kp = await generateKeypair()

    const codes: string[] = []
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${url}/pair/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daemonPubKey: kp.publicKeySpki }),
      })
      const { code } = (await res.json()) as { code: string }
      codes.push(code)
    }

    for (const code of codes) {
      expect(code).toHaveLength(6)
      expect(code).toMatch(/^[0-9A-Z]{6}$/)
    }

    // All codes should be unique
    expect(new Set(codes).size).toBe(codes.length)
  })

  test('relay never exposes daemon private key or shared key', async () => {
    const { url } = startRelay()
    const daemonKp = await generateKeypair()

    // Create pairing
    const createRes = await fetch(`${url}/pair/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daemonPubKey: daemonKp.publicKeySpki, daemonName: 'test' }),
    })
    const createData = (await createRes.json()) as any

    // Create response only has code + sessionToken + expiresIn
    expect(Object.keys(createData).sort()).toEqual(['code', 'expiresIn', 'sessionToken'])
    // No private key in response
    expect(JSON.stringify(createData)).not.toContain('privateKey')

    // Join response
    const clientKp = await generateKeypair()
    const joinRes = await fetch(`${url}/pair/join/${createData.code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientPubKey: clientKp.publicKeySpki }),
    })
    const joinData = (await joinRes.json()) as any

    // Join response has sessionToken + daemonPubKey (public only!) + daemonName
    expect(joinData.daemonPubKey).toBe(daemonKp.publicKeySpki)
    expect(JSON.stringify(joinData)).not.toContain('privateKey')
    expect(JSON.stringify(joinData)).not.toContain('sharedKey')
  })

  test('knowing only the public key is not enough to derive the shared key', async () => {
    const { url } = startRelay()

    const { daemonKey, daemonKp, clientKp } = await pairViaRelay(url)

    // An attacker who knows both PUBLIC keys but neither PRIVATE key
    // tries to derive a key — they can only use their own private key
    const attackerKp = await generateKeypair()

    // Even with daemon's public key, attacker's derived key is different
    const attackerDerivedFromDaemon = await deriveSharedKey(attackerKp.privateKey, daemonKp.publicKeySpki)
    const attackerDerivedFromClient = await deriveSharedKey(attackerKp.privateKey, clientKp.publicKeySpki)

    const realKey = await exportAesKey(daemonKey)
    const fakeKey1 = await exportAesKey(attackerDerivedFromDaemon)
    const fakeKey2 = await exportAesKey(attackerDerivedFromClient)

    expect(fakeKey1).not.toBe(realKey)
    expect(fakeKey2).not.toBe(realKey)

    // Verify attacker cannot decrypt
    const envelope = await encryptPayload({ secret: 'data' }, daemonKey)
    await expect(decryptEnvelope(envelope, attackerDerivedFromDaemon)).rejects.toThrow()
    await expect(decryptEnvelope(envelope, attackerDerivedFromClient)).rejects.toThrow()
  })
})
