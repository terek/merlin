import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ClaudeProjectDiscovery } from '../../src/discovery.ts'

let tempDir: string

beforeEach(() => {
  tempDir = `/tmp/merlin-test-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`
  mkdirSync(tempDir, { recursive: true })
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeJsonl(projectSlug: string, sessionId: string, entries: Record<string, unknown>[]) {
  const dir = path.join(tempDir, projectSlug)
  mkdirSync(dir, { recursive: true })
  const content = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), content)
}

describe('ClaudeProjectDiscovery', () => {
  test('returns empty for nonexistent dir', async () => {
    const discovery = new ClaudeProjectDiscovery('/nonexistent')
    expect(await discovery.discover()).toEqual([])
  })

  test('discovers project with single session', async () => {
    writeJsonl('my-project', 'session-1', [
      { type: 'system', cwd: '/home/user/code', sessionId: 'session-1', timestamp: 1000 },
      { type: 'user', timestamp: 2000 },
      { type: 'assistant', timestamp: 3000 },
    ])

    const discovery = new ClaudeProjectDiscovery(tempDir)
    const projects = await discovery.discover()

    expect(projects).toHaveLength(1)
    expect(projects[0].cwd).toBe('/home/user/code')
    expect(projects[0].sessionId).toBe('session-1')
    expect(projects[0].lastTimestamp).toBe(3000)
    expect(projects[0].sessions).toHaveLength(1)
    expect(projects[0].sessions[0].userTurnCount).toBe(1)
  })

  test('discovers multiple sessions per project', async () => {
    writeJsonl('my-project', 'session-old', [
      { type: 'system', cwd: '/home/user/code', sessionId: 'session-old', timestamp: 1000 },
    ])
    writeJsonl('my-project', 'session-new', [
      { type: 'system', cwd: '/home/user/code', sessionId: 'session-new', timestamp: 5000 },
    ])

    const discovery = new ClaudeProjectDiscovery(tempDir)
    const projects = await discovery.discover()

    expect(projects).toHaveLength(1)
    expect(projects[0].sessions).toHaveLength(2)
    // Sorted newest first
    expect(projects[0].sessions[0].sessionId).toBe('session-new')
    expect(projects[0].sessions[1].sessionId).toBe('session-old')
    expect(projects[0].sessionId).toBe('session-new')
  })

  test('slug and customTitle extracted', async () => {
    writeJsonl('my-project', 'session-1', [
      {
        type: 'system',
        cwd: '/home/user/code',
        sessionId: 'session-1',
        slug: 'fancy-slug',
        customTitle: 'My Custom Title',
        timestamp: 1000,
      },
    ])

    const discovery = new ClaudeProjectDiscovery(tempDir)
    const projects = await discovery.discover()
    expect(projects[0].slug).toBe('fancy-slug')
    expect(projects[0].customTitle).toBe('My Custom Title')
  })

  test('skips macOS temp directories', async () => {
    writeJsonl('temp-project', 'session-1', [
      { type: 'system', cwd: '/tmp/some-temp-dir', sessionId: 'session-1', timestamp: 1000 },
    ])
    writeJsonl('private-var', 'session-2', [
      { type: 'system', cwd: '/private/var/folders/xy/abc123', sessionId: 'session-2', timestamp: 1000 },
    ])

    const discovery = new ClaudeProjectDiscovery(tempDir)
    const projects = await discovery.discover()
    expect(projects).toHaveLength(0)
  })

  test('skips Linux temp directories', async () => {
    writeJsonl('snap-project', 'session-1', [
      { type: 'system', cwd: '/snap/core/current', sessionId: 'session-1', timestamp: 1000 },
    ])
    writeJsonl('run-user', 'session-2', [
      { type: 'system', cwd: '/run/user/1000/tmp-thing', sessionId: 'session-2', timestamp: 1000 },
    ])

    const discovery = new ClaudeProjectDiscovery(tempDir)
    const projects = await discovery.discover()
    expect(projects).toHaveLength(0)
  })

  test('skips sessions with no timestamp', async () => {
    writeJsonl('my-project', 'no-timestamp', [{ type: 'system', cwd: '/home/user/code' }])

    const discovery = new ClaudeProjectDiscovery(tempDir)
    const projects = await discovery.discover()
    expect(projects).toHaveLength(0)
  })

  test('uses filename as fallback sessionId', async () => {
    writeJsonl('my-project', 'fallback-id', [{ type: 'system', cwd: '/home/user/code', timestamp: 1000 }])

    const discovery = new ClaudeProjectDiscovery(tempDir)
    const projects = await discovery.discover()
    expect(projects[0].sessions[0].sessionId).toBe('fallback-id')
  })

  test('getLatestJsonlPath returns newest session path', async () => {
    writeJsonl('my-project', 'old-session', [
      { type: 'system', cwd: '/home/user/code', sessionId: 'old-session', timestamp: 1000 },
    ])
    writeJsonl('my-project', 'new-session', [
      { type: 'system', cwd: '/home/user/code', sessionId: 'new-session', timestamp: 5000 },
    ])

    const discovery = new ClaudeProjectDiscovery(tempDir)
    const result = await discovery.getLatestJsonlPath('/home/user/code')
    expect(result).toContain('new-session.jsonl')
  })

  test('getLatestJsonlPath returns null for unknown cwd', async () => {
    const discovery = new ClaudeProjectDiscovery(tempDir)
    const result = await discovery.getLatestJsonlPath('/nonexistent')
    expect(result).toBeNull()
  })

  test('handles corrupt JSONL lines gracefully', async () => {
    const dir = path.join(tempDir, 'corrupt-project')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'session-1.jsonl'),
      '{"type":"system","cwd":"/home/user/code","sessionId":"s1","timestamp":1000}\nnot-json\n{"type":"user","timestamp":2000}\n',
    )

    const discovery = new ClaudeProjectDiscovery(tempDir)
    const projects = await discovery.discover()
    expect(projects).toHaveLength(1)
    expect(projects[0].sessions[0].userTurnCount).toBe(1)
  })

  test('projects sorted by lastTimestamp desc', async () => {
    writeJsonl('project-old', 'session-1', [
      { type: 'system', cwd: '/home/user/old', sessionId: 'session-1', timestamp: 1000 },
    ])
    writeJsonl('project-new', 'session-2', [
      { type: 'system', cwd: '/home/user/new', sessionId: 'session-2', timestamp: 5000 },
    ])

    const discovery = new ClaudeProjectDiscovery(tempDir)
    const projects = await discovery.discover()
    expect(projects).toHaveLength(2)
    expect(projects[0].cwd).toBe('/home/user/new')
    expect(projects[1].cwd).toBe('/home/user/old')
  })
})
