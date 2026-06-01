/**
 * TUI smoke tests: verify the full pairing + metadata flow produces
 * correct render output without flicker/empty-state issues.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ClientMessage, DaemonMessage, MerlinModel } from '@merlin/protocol'
import {
  createRelay,
  decryptEnvelope,
  deriveSharedKey,
  encryptPayload,
  generateKeypair,
  type RelayEnvelope,
} from '@merlin/relay'
import { applyOps } from '@merlin/sync'
import type { Server } from 'bun'
import { Daemon } from '../../src/daemon.ts'
import { render } from '../../src/tui/render.ts'

// Isolated fixture: fake Claude projects dir with synthetic sessions
const tempDir = path.join(import.meta.dir, `.tui-smoke-${Date.now()}`)
const claudeProjectsDir = path.join(tempDir, 'claude-projects')
const projectCwd = path.join(tempDir, 'fake-project')
const projectDirName = projectCwd.replace(/\//g, '-')
const projectDir = path.join(claudeProjectsDir, projectDirName)

beforeAll(() => {
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(projectCwd, { recursive: true })
  // Create two fake sessions
  for (const [id, title] of [
    ['sess-aaa', 'Feature A'],
    ['sess-bbb', 'Feature B'],
  ]) {
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id, cwd: projectCwd }),
      JSON.stringify({
        type: 'user',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      }),
    ]
    writeFileSync(path.join(projectDir, `${id}.jsonl`), `${lines.join('\n')}\n`)
  }
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

let relay: Server | null = null
let daemon: Daemon | null = null
let clientWs: WebSocket | null = null

afterEach(async () => {
  clientWs?.close()
  clientWs = null
  await daemon?.stop()
  daemon = null
  relay?.stop(true)
  relay = null
})

async function setup() {
  relay = createRelay(0)
  const wsUrl = `ws://localhost:${relay.port}`

  const daemonKp = await generateKeypair()
  const clientKp = await generateKeypair()
  const daemonKey = await deriveSharedKey(daemonKp.privateKey, clientKp.publicKeySpki)
  const clientKey = await deriveSharedKey(clientKp.privateKey, daemonKp.publicKeySpki)
  const token = crypto.randomUUID()

  daemon = new Daemon({
    log: () => {},
    instanceName: 'tui-test-daemon',
    relayUrl: wsUrl,
    token,
    sharedKey: daemonKey,
    skipLock: true,
    clerk: false,
    claudeDir: claudeProjectsDir,
    homeDir: tempDir,
  })
  await daemon.start()
  await new Promise((r) => setTimeout(r, 300))

  clientWs = new WebSocket(`${wsUrl}/ws?side=client&token=${token}`)
  await new Promise<void>((resolve, reject) => {
    clientWs!.onopen = () => resolve()
    clientWs!.onerror = () => reject(new Error('ws error'))
  })

  return { clientKey, token }
}

/** Subscribe and collect all messages until model has projects, or timeout. */
async function subscribeAndCollect(
  ws: WebSocket,
  key: CryptoKey,
  timeoutMs = 5000,
): Promise<{
  messages: DaemonMessage[]
  model: MerlinModel | null
  renders: string[]
}> {
  const messages: DaemonMessage[] = []
  const renders: string[] = []
  let model: MerlinModel | null = null

  // Subscribe
  const sub = await encryptPayload({ type: 'subscribe', scope: 'metadata' } satisfies ClientMessage, key)
  ws.send(JSON.stringify(sub))

  return new Promise((resolve, _reject) => {
    const timeout = setTimeout(() => {
      resolve({ messages, model, renders })
    }, timeoutMs)

    ws.onmessage = async (event) => {
      try {
        const raw = JSON.parse(event.data as string)
        const decrypted = (await decryptEnvelope(raw as RelayEnvelope, key)) as DaemonMessage
        messages.push(decrypted)

        if (decrypted.type === 'snapshot' && decrypted.scope === 'metadata') {
          model = decrypted.data
        } else if (decrypted.type === 'patch' && decrypted.scope === 'metadata' && model) {
          model = applyOps(model, decrypted.ops)
        }

        // Capture what the TUI would render at each message
        renders.push(render(model, 'test-host', true))

        // Resolve early if we have projects
        if (model && Object.keys(model.projects).length > 0) {
          clearTimeout(timeout)
          // Wait a bit more for additional patches
          setTimeout(() => resolve({ messages, model, renders }), 200)
        }
      } catch {
        /* skip */
      }
    }
  })
}

describe('TUI smoke — metadata display', () => {
  test('first snapshot already contains projects (no empty-state flicker)', async () => {
    const { clientKey } = await setup()
    const { messages, model, renders } = await subscribeAndCollect(clientWs!, clientKey)

    expect(model).not.toBeNull()
    expect(messages.length).toBeGreaterThan(0)

    // The FIRST snapshot should already contain discovered projects.
    // If it doesn't, the client sees a brief "No projects discovered" flash.
    const firstSnapshot = messages.find((m) => m.type === 'snapshot' && m.scope === 'metadata')
    expect(firstSnapshot).toBeDefined()
    if (firstSnapshot?.type === 'snapshot' && firstSnapshot.scope === 'metadata') {
      const projectCount = Object.keys(firstSnapshot.data.projects).length
      // NOTE: If this fails, it means the daemon sends an empty snapshot first,
      // then patches in the projects — causing a "No projects" flash in the TUI.
      expect(projectCount).toBeGreaterThan(0)
    }

    // Verify no render contains "No projects discovered"
    for (const r of renders) {
      expect(r).not.toContain('No projects discovered')
    }
  })

  test('render output contains project names and session details', async () => {
    const { clientKey } = await setup()
    const { model, renders } = await subscribeAndCollect(clientWs!, clientKey)

    expect(model).not.toBeNull()
    const lastRender = renders[renders.length - 1]

    // Should contain real project data
    expect(lastRender).toContain('Projects')
    // Should show host info in footer
    expect(lastRender).toContain('v0.1.0')
    // Should show keyboard hints
    expect(lastRender).toContain('r=refresh')
    expect(lastRender).toContain('q=quit')

    // Each project should have its display name
    for (const p of Object.values(model!.projects)) {
      expect(lastRender).toContain(p.displayName)
    }
  })

  test('render shows session summary lines with turn counts', async () => {
    const { clientKey } = await setup()
    const { renders } = await subscribeAndCollect(clientWs!, clientKey)

    const lastRender = renders[renders.length - 1]

    // Check that at least one session summary line is rendered
    // These contain "N turns" text
    expect(lastRender).toMatch(/\d+ turns?/)
  })

  test('model updates via patches produce updated renders', async () => {
    const { clientKey } = await setup()
    const { messages, renders } = await subscribeAndCollect(clientWs!, clientKey, 2000)

    // If we received patches after snapshot, the renders should reflect updates
    const patchCount = messages.filter((m) => m.type === 'patch').length
    if (patchCount > 0) {
      // Each patch should produce a new render
      expect(renders.length).toBe(messages.length)
    }
    // At minimum we have the snapshot render
    expect(renders.length).toBeGreaterThan(0)
  })
})

// Helper: extract session lines (indented lines with LED ● or ○)
function getSessionLines(output: string): string[] {
  return output.split('\n').filter((l) => /^\s{4}/.test(l) && /[●○◑]/.test(l))
}

describe('TUI smoke — session display names', () => {
  test('user-named sessions show customTitle, others show short session ID', () => {
    const model: MerlinModel = {
      host: { name: 'h', instanceName: 'i', version: '1.0', connectedClients: 0 },
      projects: {
        '/tmp/proj': {
          cwd: '/tmp/proj',
          displayName: 'my-project',
          lastTimestamp: Date.now(),
          sessions: [
            {
              sessionId: 'abc123def456',
              slug: 'proud-tumbling-rocket',
              customTitle: 'My Feature Work',
              lastTimestamp: Date.now(),
              sizeBytes: 1000,
              userTurnCount: 10,
              subagentCount: 0,
            },
            {
              sessionId: '789xyz000111',
              slug: 'proud-tumbling-rocket',
              lastTimestamp: Date.now() - 86400000,
              sizeBytes: 500,
              userTurnCount: 5,
              subagentCount: 0,
            },
          ],
          owner: 'available',
        },
      },
    }
    const output = render(model, 'host', true)
    const sessionLines = getSessionLines(output)
    expect(sessionLines).toHaveLength(2)
    // User-named session shows customTitle
    expect(sessionLines[0]).toContain('My Feature Work')
    // Auto-named session shows short session ID, not slug
    expect(sessionLines[1]).toContain('789xyz00')
    expect(sessionLines[1]).not.toContain('proud-tumbling-rocket')
  })

  test('auto-generated slugs are not shown', () => {
    const model: MerlinModel = {
      host: { name: 'h', instanceName: 'i', version: '1.0', connectedClients: 0 },
      projects: {
        '/tmp/proj': {
          cwd: '/tmp/proj',
          displayName: 'my-project',
          lastTimestamp: Date.now(),
          sessions: [
            {
              sessionId: 'abc123def456',
              slug: 'quick-fox',
              lastTimestamp: Date.now(),
              sizeBytes: 1000,
              userTurnCount: 10,
              subagentCount: 0,
            },
            {
              sessionId: '789xyz000111',
              slug: 'lazy-dog',
              lastTimestamp: Date.now() - 86400000,
              sizeBytes: 500,
              userTurnCount: 5,
              subagentCount: 0,
            },
          ],
          owner: 'available',
        },
      },
    }
    const output = render(model, 'host', true)
    const sessionLines = getSessionLines(output)
    expect(sessionLines).toHaveLength(2)
    // Slugs should not appear — short session IDs instead
    expect(sessionLines[0]).not.toContain('quick-fox')
    expect(sessionLines[0]).toContain('abc123de')
    expect(sessionLines[1]).not.toContain('lazy-dog')
    expect(sessionLines[1]).toContain('789xyz00')
  })
})

describe('TUI smoke — per-session LED indicators', () => {
  test('session with activePid shows yellow LED, others dim', () => {
    const now = Date.now()
    const model: MerlinModel = {
      host: { name: 'h', instanceName: 'i', version: '1.0', connectedClients: 0 },
      projects: {
        '/tmp/proj': {
          cwd: '/tmp/proj',
          displayName: 'my-project',
          lastTimestamp: now,
          sessions: [
            {
              sessionId: 'live-sess',
              slug: 'doing-stuff',
              lastTimestamp: now,
              sizeBytes: 5000,
              userTurnCount: 10,
              subagentCount: 0,
              activePid: 12345,
            },
            {
              sessionId: 'old-sess',
              slug: 'finished-task',
              lastTimestamp: now - 86400000,
              sizeBytes: 2000,
              userTurnCount: 3,
              subagentCount: 0,
            },
          ],
          owner: 'available',
        },
      },
    }
    const output = render(model, 'host', true)
    const sessionLines = getSessionLines(output)
    expect(sessionLines).toHaveLength(2)
    const liveLine = sessionLines.find((l) => l.includes('live-ses'))!
    const deadLine = sessionLines.find((l) => l.includes('old-sess'))!
    // Live session: yellow LED
    expect(liveLine).toContain('\x1b[33m●')
    // Dead session: dim LED
    expect(deadLine).toContain('\x1b[90m○')
  })

  test('multiple sessions in same project can be live simultaneously', () => {
    const now = Date.now()
    const model: MerlinModel = {
      host: { name: 'h', instanceName: 'i', version: '1.0', connectedClients: 0 },
      projects: {
        '/tmp/proj': {
          cwd: '/tmp/proj',
          displayName: 'my-project',
          lastTimestamp: now,
          sessions: [
            {
              sessionId: 's1',
              slug: 'terminal-1',
              lastTimestamp: now,
              sizeBytes: 5000,
              userTurnCount: 10,
              subagentCount: 0,
              activePid: 1001,
            },
            {
              sessionId: 's2',
              slug: 'terminal-2',
              lastTimestamp: now - 100,
              sizeBytes: 3000,
              userTurnCount: 7,
              subagentCount: 0,
              activePid: 1002,
            },
            {
              sessionId: 's3',
              slug: 'old-session',
              lastTimestamp: now - 86400000,
              sizeBytes: 1000,
              userTurnCount: 2,
              subagentCount: 0,
            },
          ],
          owner: 'available',
        },
      },
    }
    const output = render(model, 'host', true)
    const sessionLines = getSessionLines(output)
    expect(sessionLines).toHaveLength(3)
    // Both active sessions get yellow LED
    expect(sessionLines.find((l) => l.includes('s1'))!).toContain('\x1b[33m●')
    expect(sessionLines.find((l) => l.includes('s2'))!).toContain('\x1b[33m●')
    // Historical session gets dim LED
    expect(sessionLines.find((l) => l.includes('s3'))!).toContain('\x1b[90m○')
  })

  test('daemon-managed session shows green LED, external shows yellow', () => {
    const now = Date.now()
    const model: MerlinModel = {
      host: { name: 'h', instanceName: 'i', version: '1.0', connectedClients: 0 },
      projects: {
        '/tmp/proj': {
          cwd: '/tmp/proj',
          displayName: 'my-project',
          lastTimestamp: now,
          sessions: [
            {
              sessionId: 'daemon-sess',
              slug: 'our-session',
              lastTimestamp: now,
              sizeBytes: 5000,
              userTurnCount: 10,
              subagentCount: 0,
            },
            {
              sessionId: 'ext-sess',
              slug: 'user-terminal',
              lastTimestamp: now - 100,
              sizeBytes: 3000,
              userTurnCount: 7,
              subagentCount: 0,
              activePid: 9999,
            },
            {
              sessionId: 'dead-sess',
              slug: 'old-work',
              lastTimestamp: now - 86400000,
              sizeBytes: 1000,
              userTurnCount: 2,
              subagentCount: 0,
            },
          ],
          owner: { type: 'daemon', instanceName: 'i' },
          activeSessionId: 'daemon-sess',
        },
      },
    }
    const output = render(model, 'host', true)
    const sessionLines = getSessionLines(output)
    expect(sessionLines).toHaveLength(3)
    // Daemon's session: green LED
    expect(sessionLines.find((l) => l.includes('daemon-s'))!).toContain('\x1b[32m●')
    // External CC process: yellow LED
    expect(sessionLines.find((l) => l.includes('ext-sess'))!).toContain('\x1b[33m●')
    // No process: dim LED
    expect(sessionLines.find((l) => l.includes('dead-ses'))!).toContain('\x1b[90m○')
  })

  test('external project without identified session shows half LED on all sessions', () => {
    const now = Date.now()
    const model: MerlinModel = {
      host: { name: 'h', instanceName: 'i', version: '1.0', connectedClients: 0 },
      projects: {
        '/tmp/proj': {
          cwd: '/tmp/proj',
          displayName: 'mystery-project',
          lastTimestamp: now,
          sessions: [
            {
              sessionId: 's1',
              slug: 'session-a',
              lastTimestamp: now - 3600000,
              sizeBytes: 5000,
              userTurnCount: 10,
              subagentCount: 0,
            },
            {
              sessionId: 's2',
              slug: 'session-b',
              lastTimestamp: now - 86400000,
              sizeBytes: 2000,
              userTurnCount: 3,
              subagentCount: 0,
            },
          ],
          owner: { type: 'external', pids: [12345] },
        },
      },
    }
    const output = render(model, 'host', true)
    // Project name line should NOT have a LED anymore
    const projectLine = output.split('\n').find((l) => l.includes('mystery-project'))!
    expect(projectLine).not.toContain('●')
    // Session lines should all show yellow half LED (◑)
    const sessionLines = getSessionLines(output)
    expect(sessionLines).toHaveLength(2)
    for (const line of sessionLines) {
      expect(line).toContain('\x1b[33m◑')
    }
  })

  test('all sessions without activePid or activeSessionId show dim LED', () => {
    const now = Date.now()
    const model: MerlinModel = {
      host: { name: 'h', instanceName: 'i', version: '1.0', connectedClients: 0 },
      projects: {
        '/tmp/proj': {
          cwd: '/tmp/proj',
          displayName: 'free-project',
          lastTimestamp: now,
          sessions: [
            {
              sessionId: 's1',
              slug: 'session-a',
              lastTimestamp: now - 3600000,
              sizeBytes: 5000,
              userTurnCount: 10,
              subagentCount: 0,
            },
            {
              sessionId: 's2',
              slug: 'session-b',
              lastTimestamp: now - 86400000,
              sizeBytes: 2000,
              userTurnCount: 3,
              subagentCount: 0,
            },
          ],
          owner: 'available',
        },
      },
    }
    const output = render(model, 'host', true)
    const sessionLines = getSessionLines(output)
    expect(sessionLines).toHaveLength(2)
    // All dim
    for (const line of sessionLines) {
      expect(line).toContain('\x1b[90m○')
      expect(line).not.toContain('\x1b[32m●')
      expect(line).not.toContain('\x1b[33m●')
    }
  })
})

describe('TUI smoke — render edge cases', () => {
  test('null model renders waiting state', () => {
    const output = render(null, 'test-host', true)
    expect(output).toContain('Waiting for data')
    expect(output).toContain('test-host')
    expect(output).toContain('connected')
  })

  test('disconnected state shown correctly', () => {
    const output = render(null, 'test-host', false)
    expect(output).toContain('disconnected')
  })

  test('empty projects renders helpful message', () => {
    const emptyModel: MerlinModel = {
      host: { name: 'host', instanceName: 'inst', version: '1.0', connectedClients: 0 },
      projects: {},
      ignoredProjectCount: 0,
      processingRuntime: { activeSessions: [], llmTotals: {} },
    }
    const output = render(emptyModel, 'host', true)
    expect(output).toContain('No projects discovered')
  })

  test('archived projects shown in collapsed section', () => {
    const now = Date.now()
    const model: MerlinModel = {
      host: { name: 'h', instanceName: 'i', version: '1.0', connectedClients: 0 },
      projects: {
        '/tmp/active': {
          cwd: '/tmp/active',
          displayName: 'active-proj',
          lastTimestamp: now,
          sessions: [{ sessionId: 's1', lastTimestamp: now, sizeBytes: 1000, userTurnCount: 5, subagentCount: 0 }],
          owner: 'available',
        },
        '/tmp/archived': {
          cwd: '/tmp/archived',
          displayName: 'old-proj',
          lastTimestamp: now - 86400000,
          sessions: [
            { sessionId: 's2', lastTimestamp: now - 86400000, sizeBytes: 500, userTurnCount: 2, subagentCount: 0 },
          ],
          owner: 'available',
          archived: true,
        },
      },
    }
    const output = render(model, 'host', true)
    // Active project in main section
    expect(output).toContain('active-proj')
    // Archived section exists
    expect(output).toContain('Archived')
    expect(output).toContain('old-proj')
    // Footer shows active vs archived counts
    expect(output).toContain('1 active')
    expect(output).toContain('1 archived')
  })

  test('archived sessions shown as count within active project', () => {
    const now = Date.now()
    const model: MerlinModel = {
      host: { name: 'h', instanceName: 'i', version: '1.0', connectedClients: 0 },
      projects: {
        '/tmp/proj': {
          cwd: '/tmp/proj',
          displayName: 'my-project',
          lastTimestamp: now,
          sessions: [
            { sessionId: 'live', lastTimestamp: now, sizeBytes: 1000, userTurnCount: 5, subagentCount: 0 },
            {
              sessionId: 'old1',
              lastTimestamp: now - 86400000,
              sizeBytes: 500,
              userTurnCount: 2,
              subagentCount: 0,
              archived: true,
            },
            {
              sessionId: 'old2',
              lastTimestamp: now - 172800000,
              sizeBytes: 300,
              userTurnCount: 1,
              subagentCount: 0,
              archived: true,
            },
          ],
          owner: 'available',
        },
      },
    }
    const output = render(model, 'host', true)
    const sessionLines = getSessionLines(output)
    // Only the non-archived session should be shown as a session line
    expect(sessionLines).toHaveLength(1)
    expect(sessionLines[0]).toContain('live')
    // Archived count shown
    expect(output).toContain('2 archived')
  })

  test('active session shown in Projects section', () => {
    const model: MerlinModel = {
      host: { name: 'h', instanceName: 'i', version: '1.0', connectedClients: 0 },
      projects: {
        '/tmp/proj': {
          cwd: '/tmp/proj',
          displayName: 'my-project',
          lastTimestamp: Date.now(),
          sessions: [],
          owner: { type: 'daemon', instanceName: 'i' },
          activeSessionId: 'sess-1',
        },
      },
    }
    const output = render(model, 'host', true)
    expect(output).toContain('Projects')
    expect(output).toContain('my-project')
  })
})
