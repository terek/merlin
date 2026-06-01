/**
 * Integration tests: full direct-mode flow.
 * Relay + Daemon + MockCC + TestClient, all in-process.
 * All relay communication is E2E encrypted.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ProcessScanner, type ProcessScannerDeps } from '@merlin/cc'
import { createRelay, deriveSharedKey, generateKeypair } from '@merlin/relay'
import { type SyncClient, SyncEngine } from '@merlin/sync'
import type { Server } from 'bun'
import { Daemon } from '../../src/daemon.ts'
import { ModelBuilder } from '../../src/discovery/builder.ts'
import { ModelStore } from '../../src/discovery/store.ts'
import { TestClient } from '../test-client.ts'

let relay: Server | null = null
let daemon: Daemon | null = null
let clients: TestClient[] = []

afterEach(async () => {
  for (const c of clients) c.close()
  clients = []
  await daemon?.stop()
  daemon = null
  relay?.stop(true)
  relay = null
})

function startRelay(): { url: string; wsUrl: string } {
  relay = createRelay(0)
  const url = `http://localhost:${relay.port}`
  const wsUrl = `ws://localhost:${relay.port}`
  return { url, wsUrl }
}

async function startDaemon(relayWsUrl: string, token: string, sharedKey: CryptoKey): Promise<Daemon> {
  daemon = new Daemon({
    log: () => {},
    instanceName: 'test-daemon',
    relayUrl: relayWsUrl,
    token,
    sharedKey,
    skipLock: true,
    claudeDir: '/nonexistent', // No real discovery in integration tests
    clerk: false,
  })
  await daemon.start()
  return daemon
}

async function startClient(relayWsUrl: string, token: string, sharedKey: CryptoKey): Promise<TestClient> {
  const client = new TestClient({ relayUrl: relayWsUrl, token, sharedKey })
  await client.connect()
  clients.push(client)
  return client
}

/** Generate a paired key set (daemon + client derive the same shared AES key). */
async function generatePairedKeys(): Promise<{ token: string; daemonKey: CryptoKey; clientKey: CryptoKey }> {
  const daemonKp = await generateKeypair()
  const clientKp = await generateKeypair()
  const daemonKey = await deriveSharedKey(daemonKp.privateKey, clientKp.publicKeySpki)
  const clientKey = await deriveSharedKey(clientKp.privateKey, daemonKp.publicKeySpki)
  const token = crypto.randomUUID()
  return { token, daemonKey, clientKey }
}

describe('Integration — direct mode with relay (encrypted)', () => {
  test('client connects and receives metadata snapshot', async () => {
    const { wsUrl } = startRelay()
    const { token, daemonKey, clientKey } = await generatePairedKeys()
    await startDaemon(wsUrl, token, daemonKey)

    // Wait for daemon to connect to relay
    await new Promise((r) => setTimeout(r, 200))

    const client = await startClient(wsUrl, token, clientKey)
    client.subscribeMetadata()

    const model = await client.waitForModel((m) => m.host.name !== '', 3000)
    expect(model.host.instanceName).toBe('test-daemon')
    expect(model.host.version).toBe('0.1.0')
  })
})

describe('Integration — direct mode in-process (no relay)', () => {
  test('in-process client receives metadata via SyncEngine', () => {
    const store = new ModelStore('test-host', 'test-instance', '0.1.0')
    const engine = new SyncEngine(store)
    engine.start()

    const received: any[] = []
    const client: SyncClient = {
      id: 'direct-1',
      sendMessage: (msg) => received.push(JSON.parse(msg)),
    }

    engine.addClient(client)
    engine.subscribeMetadata('direct-1')

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('snapshot')
    expect(received[0].data.host.name).toBe('test-host')

    // Mutate model
    store.upsertProject('/tmp/p', { displayName: 'project' })

    expect(received).toHaveLength(2)
    expect(received[1].type).toBe('patch')
    expect(received[1].ops.length).toBeGreaterThan(0)

    engine.stop()
  })

  test('session subscription + state changes', () => {
    const store = new ModelStore('host', 'inst', '0.1.0')
    const engine = new SyncEngine(store)
    engine.start()

    store.createActiveSession('s1', '/tmp')

    const received: any[] = []
    const client: SyncClient = {
      id: 'direct-1',
      sendMessage: (msg) => received.push(JSON.parse(msg)),
    }
    engine.addClient(client)
    engine.subscribeSession('direct-1', 's1')

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('snapshot')
    expect(received[0].data.state).toBe('starting')

    // Change state
    store.setSessionState('s1', 'idle')
    engine.flush()

    const patches = received.filter((m) => m.type === 'patch')
    expect(patches.length).toBeGreaterThan(0)

    engine.stop()
  })

  test('periodic refresh detects external process exit (CRITICAL)', async () => {
    // Simulate: external CC process is running, then quits.
    // Periodic refresh should update ownership from 'external' to 'available'.
    // The project is discovered ONLY via process scanner (not JSONL), which is
    // how it works when CC is running in a dir with no prior sessions.
    let externalPids: number[] = [99999]

    const mockDeps: ProcessScannerDeps = {
      pgrep: async () => externalPids,
      lsofCwd: async (pid) => (pid === 99999 ? '/tmp/ext-project' : null),
    }
    const scanner = new ProcessScanner(mockDeps)

    const store = new ModelStore('host', 'inst', '0.1.0')
    const engine = new SyncEngine(store)
    engine.start()

    const { ModelBuilder } = await import('../../src/discovery/builder.ts')
    const builder = new ModelBuilder(store, {
      instanceName: 'inst',
      claudeDir: '/nonexistent',
      scanner,
    })

    // First refresh: external process is running → project appears via scanner
    await builder.refresh()
    const model1 = store.getModel()
    expect(model1.projects['/tmp/ext-project']).toBeDefined()
    expect(model1.projects['/tmp/ext-project'].owner).toEqual({
      type: 'external',
      pids: [99999],
    })

    // Subscribe a client to observe the change
    const received: any[] = []
    const client: SyncClient = {
      id: 'c1',
      sendMessage: (msg) => received.push(JSON.parse(msg)),
    }
    engine.addClient(client)
    engine.subscribeMetadata('c1')

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('snapshot')
    expect(received[0].data.projects['/tmp/ext-project'].owner).toEqual({
      type: 'external',
      pids: [99999],
    })

    // Simulate: CC process exits
    externalPids = []

    // Second refresh: process is gone → project disappears (no JSONL, no process)
    await builder.refresh()
    const model2 = store.getModel()

    // Project should either be gone or marked available
    // Since it was only discovered via process scanner, it disappears entirely
    expect(model2.projects['/tmp/ext-project']).toBeUndefined()

    // Client should have received a patch reflecting the removal
    expect(received.length).toBeGreaterThan(1)
    const lastMsg = received[received.length - 1]
    expect(lastMsg.type).toBe('patch')

    engine.stop()
  })

  test('daemon periodic refresh pushes ownership change to client via relay', async () => {
    let externalPids: number[] = [77777]

    const mockDeps: ProcessScannerDeps = {
      pgrep: async () => externalPids,
      lsofCwd: async (pid) => (pid === 77777 ? '/tmp/watched-project' : null),
    }
    const scanner = new ProcessScanner(mockDeps)

    const { wsUrl } = startRelay()
    const { token, daemonKey, clientKey } = await generatePairedKeys()

    daemon = new Daemon({
      log: () => {},
      instanceName: 'test-daemon',
      relayUrl: wsUrl,
      token,
      sharedKey: daemonKey,
      skipLock: true,
      claudeDir: '/nonexistent',
      scanner,
      refreshIntervalMs: 500, // fast interval for testing
      clerk: false,
    })
    await daemon.start()
    await new Promise((r) => setTimeout(r, 300))

    const client = await startClient(wsUrl, token, clientKey)
    client.subscribeMetadata()

    // Client should see the external process
    const model1 = await client.waitForModel((m) => {
      const p = m.projects['/tmp/watched-project']
      return p != null && typeof p.owner === 'object'
    }, 3000)
    expect(model1.projects['/tmp/watched-project'].owner).toEqual({
      type: 'external',
      pids: [77777],
    })

    // Simulate: CC process exits
    externalPids = []

    // Wait for periodic refresh to fire and push a patch.
    // The project was only found via process scanner, so it disappears.
    const model2 = await client.waitForModel((m) => m.projects['/tmp/watched-project'] === undefined, 3000)
    expect(model2.projects['/tmp/watched-project']).toBeUndefined()
  })

  test('external CC process sets activePid via --resume flag (CRITICAL)', async () => {
    // CC process running with --resume <sessionId> in args.
    // After refresh, that specific session should have activePid; others should not.
    const tempDir = `/tmp/merlin-test-activepid-${Date.now()}`
    const projectDir = path.join(tempDir, '-home-test-myproject')
    mkdirSync(projectDir, { recursive: true })

    const projectCwd = '/home/test/myproject'
    const now = Date.now()
    const activeSessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const oldSessionId = 'bbbbbbbb-1111-2222-3333-444444444444'
    const ancientSessionId = 'cccccccc-1111-2222-3333-444444444444'

    function writeJsonl(sessionId: string, ts: number) {
      const content = `${[
        JSON.stringify({ type: 'system', cwd: projectCwd, sessionId, timestamp: ts }),
        JSON.stringify({ type: 'user', timestamp: ts + 1 }),
        JSON.stringify({ type: 'assistant', timestamp: ts + 2 }),
      ].join('\n')}\n`
      writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), content)
    }

    writeJsonl(activeSessionId, now - 5000)
    writeJsonl(oldSessionId, now - 86400000)
    writeJsonl(ancientSessionId, now - 172800000)

    // Mock scanner: CC process with --resume pointing to activeSessionId
    const mockDeps: ProcessScannerDeps = {
      pgrep: async () => [55555],
      lsofCwd: async (pid) => (pid === 55555 ? projectCwd : null),
      psArgs: async (pid) => (pid === 55555 ? `claude --resume ${activeSessionId}` : null),
    }
    const scanner = new ProcessScanner(mockDeps)

    const store = new ModelStore('host', 'inst', '0.1.0')
    const builder = new ModelBuilder(store, {
      instanceName: 'inst',
      claudeDir: tempDir,
      scanner,
    })

    await builder.refresh()
    const project = store.getModel().projects[projectCwd]

    try {
      expect(project).toBeDefined()
      expect(project.sessions).toHaveLength(3)

      const active = project.sessions.find((s) => s.sessionId === activeSessionId)!
      expect(active.activePid).toBe(55555)

      const old = project.sessions.find((s) => s.sessionId === oldSessionId)!
      expect(old.activePid).toBeUndefined()

      const ancient = project.sessions.find((s) => s.sessionId === ancientSessionId)!
      expect(ancient.activePid).toBeUndefined()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('multiple sessions active simultaneously get separate activePids', async () => {
    // Two CC processes in the same project, each with --resume pointing to different sessions.
    const tempDir = `/tmp/merlin-test-multipid-${Date.now()}`
    const projectDir = path.join(tempDir, '-home-test-multiproject')
    mkdirSync(projectDir, { recursive: true })

    const projectCwd = '/home/test/multiproject'
    const now = Date.now()
    const sessAId = 'aaaaaaaa-1111-2222-3333-444444444444'
    const sessBId = 'bbbbbbbb-1111-2222-3333-444444444444'
    const sessCId = 'cccccccc-1111-2222-3333-444444444444'

    function writeJsonl(sessionId: string, ts: number) {
      const content = `${[
        JSON.stringify({ type: 'system', cwd: projectCwd, sessionId, timestamp: ts }),
        JSON.stringify({ type: 'user', timestamp: ts + 1 }),
      ].join('\n')}\n`
      writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), content)
    }

    writeJsonl(sessAId, now - 3000)
    writeJsonl(sessBId, now - 2000)
    writeJsonl(sessCId, now - 86400000)

    // Two CC processes, each resuming a different session
    const mockDeps: ProcessScannerDeps = {
      pgrep: async () => [1001, 1002],
      lsofCwd: async (pid) => (pid === 1001 || pid === 1002 ? projectCwd : null),
      psArgs: async (pid) => {
        if (pid === 1001) return `claude --resume ${sessAId}`
        if (pid === 1002) return `claude --resume ${sessBId}`
        return null
      },
    }
    const scanner = new ProcessScanner(mockDeps)

    const store = new ModelStore('host', 'inst', '0.1.0')
    const builder = new ModelBuilder(store, {
      instanceName: 'inst',
      claudeDir: tempDir,
      scanner,
    })

    await builder.refresh()
    const project = store.getModel().projects[projectCwd]

    try {
      expect(project).toBeDefined()

      const sessA = project.sessions.find((s) => s.sessionId === sessAId)!
      const sessB = project.sessions.find((s) => s.sessionId === sessBId)!
      const sessC = project.sessions.find((s) => s.sessionId === sessCId)!

      expect(sessA.activePid).toBe(1001)
      expect(sessB.activePid).toBe(1002)
      expect(sessC.activePid).toBeUndefined()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('no activePid when no external process is running', async () => {
    const tempDir = `/tmp/merlin-test-nopid-${Date.now()}`
    const projectDir = path.join(tempDir, '-home-test-quietproject')
    mkdirSync(projectDir, { recursive: true })

    const projectCwd = '/home/test/quietproject'
    const now = Date.now()

    const content = `${[
      JSON.stringify({
        type: 'system',
        cwd: projectCwd,
        sessionId: 'dddddddd-1111-2222-3333-444444444444',
        timestamp: now - 1000,
      }),
      JSON.stringify({ type: 'user', timestamp: now }),
    ].join('\n')}\n`
    writeFileSync(path.join(projectDir, 'dddddddd-1111-2222-3333-444444444444.jsonl'), content)

    const mockDeps: ProcessScannerDeps = {
      pgrep: async () => [],
      lsofCwd: async () => null,
    }
    const scanner = new ProcessScanner(mockDeps)

    const store = new ModelStore('host', 'inst', '0.1.0')
    const builder = new ModelBuilder(store, {
      instanceName: 'inst',
      claudeDir: tempDir,
      scanner,
    })

    await builder.refresh()
    const project = store.getModel().projects[projectCwd]

    try {
      expect(project).toBeDefined()
      expect(project.sessions[0].activePid).toBeUndefined()
      expect(project.owner).toBe('available')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('external CC without --resume shows project-level indicator only', async () => {
    // CC process running without --resume (e.g., /resume inside CC).
    // No session gets activePid, but project is still marked external.
    const tempDir = `/tmp/merlin-test-noresume-${Date.now()}`
    const projectDir = path.join(tempDir, '-home-test-unknownproject')
    mkdirSync(projectDir, { recursive: true })

    const projectCwd = '/home/test/unknownproject'
    const now = Date.now()

    const content = `${[
      JSON.stringify({
        type: 'system',
        cwd: projectCwd,
        sessionId: 'eeeeeeee-1111-2222-3333-444444444444',
        timestamp: now - 1000,
      }),
      JSON.stringify({ type: 'user', timestamp: now }),
    ].join('\n')}\n`
    writeFileSync(path.join(projectDir, 'eeeeeeee-1111-2222-3333-444444444444.jsonl'), content)

    // CC process without --resume in args
    const mockDeps: ProcessScannerDeps = {
      pgrep: async () => [77777],
      lsofCwd: async (pid) => (pid === 77777 ? projectCwd : null),
      psArgs: async () => 'claude --dangerously-skip-permissions',
    }
    const scanner = new ProcessScanner(mockDeps)

    const store = new ModelStore('host', 'inst', '0.1.0')
    const builder = new ModelBuilder(store, {
      instanceName: 'inst',
      claudeDir: tempDir,
      scanner,
    })

    await builder.refresh()
    const project = store.getModel().projects[projectCwd]

    try {
      expect(project).toBeDefined()
      // Project should be marked as external
      expect(project.owner).toEqual({ type: 'external', pids: [77777] })
      // But no session gets activePid (we don't know which one)
      expect(project.sessions[0].activePid).toBeUndefined()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('client reconnection gets fresh snapshot (CRITICAL)', () => {
    const store = new ModelStore('host', 'inst', '0.1.0')
    const engine = new SyncEngine(store)
    engine.start()

    // Initial connect
    const c1: SyncClient = {
      id: 'c1',
      sendMessage: () => {},
    }
    engine.addClient(c1)
    engine.subscribeMetadata('c1')

    // Model changes while connected
    store.upsertProject('/tmp/p', { displayName: 'project' })

    // Disconnect
    engine.removeClient('c1')

    // Reconnect
    const received: any[] = []
    const c1b: SyncClient = {
      id: 'c1',
      sendMessage: (msg) => received.push(JSON.parse(msg)),
    }
    engine.addClient(c1b)
    engine.subscribeMetadata('c1')

    // Must get a full snapshot with the project
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('snapshot')
    expect(received[0].data.projects['/tmp/p']).toBeDefined()

    engine.stop()
  })
})
