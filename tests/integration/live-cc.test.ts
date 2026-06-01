/**
 * Live integration tests: daemon + relay + TestClient + real Claude CLI.
 *
 * These tests actually spawn `claude` and exercise the full message path:
 *   client → relay → daemon → CC → daemon → relay → client
 *
 * All communication is E2E encrypted via ECDH + AES-256-GCM.
 *
 * Guarded: skipped if `claude` is not on PATH.
 *
 * Run explicitly:
 *   bun test tests/integration/live-cc.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRelay, deriveSharedKey, generateKeypair } from '@merlin/relay'
import type { Server } from 'bun'
import { Daemon } from '../../src/daemon.ts'
import { TestClient } from '../test-client.ts'

const CLAUDE = Bun.which('claude')

describe.skipIf(!CLAUDE)('@cc Live CC — full path through relay', () => {
  let relay: Server
  let daemon: Daemon
  let client: TestClient
  let testCwd: string
  let wsUrl: string

  beforeAll(async () => {
    // 1. Temp working directory with a file for CC to see
    testCwd = await mkdtemp(path.join(os.tmpdir(), 'merlin-live-'))
    await Bun.write(path.join(testCwd, 'hello.txt'), 'Hello from live integration test\n')

    // 2. Start relay on random port
    relay = createRelay(0)
    wsUrl = `ws://localhost:${relay.port}`

    // 3. Generate paired keys
    const daemonKp = await generateKeypair()
    const clientKp = await generateKeypair()
    const daemonKey = await deriveSharedKey(daemonKp.privateKey, clientKp.publicKeySpki)
    const clientKey = await deriveSharedKey(clientKp.privateKey, daemonKp.publicKeySpki)
    const token = `live-test-${Date.now()}`

    // 4. Start daemon (skip lockfile, use real discovery)
    daemon = new Daemon({
      instanceName: 'live-test-daemon',
      relayUrl: wsUrl,
      token,
      sharedKey: daemonKey,
      skipLock: true,
      clerk: false,
    })
    await daemon.start()

    // 5. Wait for daemon to connect to relay
    await new Promise((r) => setTimeout(r, 500))

    // 6. Start test client
    client = new TestClient({ relayUrl: wsUrl, token, sharedKey: clientKey })
    await client.connect()
  }, 15_000)

  afterAll(async () => {
    // Kill all CC sessions
    for (const [id] of daemon?.getActiveCCSessions() ?? []) {
      daemon.handleClientMessage('cleanup', { type: 'kill_session', sessionId: id })
    }
    // Wait for sessions to exit
    await new Promise((r) => setTimeout(r, 3000))

    client?.close()
    await daemon?.stop()
    relay?.stop(true)
    await rm(testCwd, { recursive: true, force: true }).catch(() => {})
  }, 15_000)

  // Track the active session ID across tests
  let activeSessionId: string

  test('open_project spawns a CC session that reaches idle', async () => {
    // Subscribe to metadata first
    client.subscribeMetadata()
    await client.waitForMessage((m) => m.type === 'snapshot', 3000)

    // Open a project — this spawns real `claude`
    client.openProject(testCwd)

    // Wait for model to show the project with an active session
    const model = await client.waitForModel((m) => {
      const p = m.projects[testCwd]
      return !!p?.activeSessionId
    }, 25_000)

    activeSessionId = model.projects[testCwd].activeSessionId!
    expect(activeSessionId).toBeTruthy()

    // Subscribe to the session
    client.subscribeSession(activeSessionId)

    // Wait for the session to reach idle
    const _idleMsg = await client.waitForMessage((m) => {
      if (m.type === 'snapshot' && 'data' in m && 'state' in (m as any).data) {
        return (m as any).data.state === 'idle'
      }
      if (m.type === 'patch' && 'scope' in m && (m as any).scope === 'session') {
        const session = client.getSession(activeSessionId)
        return session?.state === 'idle'
      }
      return false
    }, 20_000)

    const session = client.getSession(activeSessionId)
    expect(session).toBeDefined()
    expect(session!.state).toBe('idle')
  }, 35_000)

  test('send_message produces busy → idle with contextLines containing response', async () => {
    expect(activeSessionId).toBeTruthy()

    // Send a simple prompt
    client.sendMessage(activeSessionId, 'Reply with exactly one word: PONG')

    // Wait for session to go busy
    await client.waitForMessage((_m) => {
      const session = client.getSession(activeSessionId)
      return session?.state === 'busy'
    }, 10_000)

    // Wait for session to return to idle
    await client.waitForMessage((_m) => {
      const session = client.getSession(activeSessionId)
      return session?.state === 'idle' && session.contextLines.some((l) => l.includes('[turn complete]'))
    }, 90_000)

    const session = client.getSession(activeSessionId)!
    expect(session.state).toBe('idle')

    // contextLines should contain the response
    const hasAssistant = session.contextLines.some((l) => l.startsWith('[assistant]'))
    expect(hasAssistant).toBe(true)

    const hasTurnComplete = session.contextLines.some((l) => l === '[turn complete]')
    expect(hasTurnComplete).toBe(true)

    // The response should mention PONG (we asked it to reply with exactly that)
    const hasPong = session.contextLines.some((l) => l.startsWith('[assistant]') && l.toUpperCase().includes('PONG'))
    expect(hasPong).toBe(true)
  }, 120_000)

  test('second prompt works (session stays alive)', async () => {
    expect(activeSessionId).toBeTruthy()

    // Note the current number of [turn complete] lines
    const prevTurnCompletes = client
      .getSession(activeSessionId)!
      .contextLines.filter((l) => l === '[turn complete]').length

    client.sendMessage(activeSessionId, 'Reply with exactly one word: PING')

    // Wait for a new [turn complete] to appear
    await client.waitForMessage((_m) => {
      const session = client.getSession(activeSessionId)
      if (!session) return false
      const turnCompletes = session.contextLines.filter((l) => l === '[turn complete]').length
      return turnCompletes > prevTurnCompletes && session.state === 'idle'
    }, 90_000)

    const session = client.getSession(activeSessionId)!
    expect(session.state).toBe('idle')

    const hasPing = session.contextLines.some((l) => l.startsWith('[assistant]') && l.toUpperCase().includes('PING'))
    expect(hasPing).toBe(true)
  }, 120_000)

  test('ccSessionId is captured after first turn', () => {
    const session = client.getSession(activeSessionId)!
    expect(session.ccSessionId).toBeTruthy()
    expect(typeof session.ccSessionId).toBe('string')
  })

  test('kill_session removes the session', async () => {
    client.killSession(activeSessionId)

    // Wait for model to show no active session for this project
    await client.waitForModel((m) => {
      const p = m.projects[testCwd]
      return !p?.activeSessionId
    }, 15_000)

    const model = client.model!
    const project = model.projects[testCwd]
    expect(project?.activeSessionId).toBeUndefined()
  }, 25_000)
})

describe.skipIf(!CLAUDE)('@cc Live CC — discovery', () => {
  test('daemon discovers existing CC projects from ~/.claude/projects/', async () => {
    const relay = createRelay(0)
    const wsUrl = `ws://localhost:${relay.port}`

    const daemonKp = await generateKeypair()
    const clientKp = await generateKeypair()
    const daemonKey = await deriveSharedKey(daemonKp.privateKey, clientKp.publicKeySpki)
    const clientKey = await deriveSharedKey(clientKp.privateKey, daemonKp.publicKeySpki)
    const token = `discovery-test-${Date.now()}`

    const daemon = new Daemon({
      instanceName: 'discovery-test',
      relayUrl: wsUrl,
      token,
      sharedKey: daemonKey,
      skipLock: true,
      clerk: false,
    })
    await daemon.start()
    await new Promise((r) => setTimeout(r, 500))

    const client = new TestClient({ relayUrl: wsUrl, token, sharedKey: clientKey })
    await client.connect()
    client.subscribeMetadata()

    const _model = await client.waitForMessage((m) => m.type === 'snapshot', 3000)

    // If the user has any CC projects, they should appear.
    // We can't assert a specific project exists, but the model should be valid.
    expect(client.model).not.toBeNull()
    expect(client.model!.host.name).toBeTruthy()
    expect(typeof client.model!.projects).toBe('object')

    // Log discovered projects for visibility
    const projectCount = Object.keys(client.model!.projects).length
    console.log(`[discovery] Found ${projectCount} projects`)
    for (const [cwd, p] of Object.entries(client.model!.projects)) {
      console.log(`  ${cwd}: ${p.sessions.length} sessions, owner=${JSON.stringify(p.owner)}`)
    }

    client.close()
    await daemon.stop()
    relay.stop(true)
  }, 15_000)
})
