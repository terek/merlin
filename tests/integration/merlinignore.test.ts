/**
 * Integration test: .merlinignore overrides already-processed sessions.
 *
 * Verifies that once a session is ignored, it disappears from:
 * - Discovery results (ClaudeProjectDiscovery)
 * - Processor check results (Processor.checkProject)
 * - Processor process results (Processor.processProject)
 *
 * Even if lean session files already exist on disk from a previous run.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ClaudeProjectDiscovery } from '@merlin/cc'
import { cwdToProjectDirName, LeanSessionStore, Processor } from '@merlin/processor'

const tempDir = path.join(import.meta.dir, `.merlinignore-test-${Date.now()}`)
const homeDir = tempDir
const claudeProjectsDir = path.join(tempDir, '.claude', 'projects')
const merlinDir = path.join(tempDir, '.merlin')
const projectCwd = path.join(tempDir, 'my-project')
const projectDirName = cwdToProjectDirName(projectCwd)
const projectDir = path.join(claudeProjectsDir, projectDirName)

function makeSession(id: string, title: string) {
  const lines = [
    JSON.stringify({ type: 'system', sessionId: id, cwd: projectCwd }),
    JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-20T10:00:00Z',
      message: { role: 'user', content: `Do something for ${title}` },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-20T10:01:00Z',
      message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'text', text: `Done with ${title}` }] },
    }),
  ]
  writeFileSync(path.join(projectDir, `${id}.jsonl`), `${lines.join('\n')}\n`)
}

beforeAll(() => {
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(projectCwd, { recursive: true })
  makeSession('sess-keep', 'Kept Session')
  makeSession('sess-ignore', 'Ignored Session')
  makeSession('sess-also-keep', 'Also Kept')
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('.merlinignore overrides processed sessions', () => {
  test('without .merlinignore, all sessions are discovered and processed', async () => {
    const discovery = new ClaudeProjectDiscovery(claudeProjectsDir, homeDir)
    const projects = await discovery.discover()
    expect(projects).toHaveLength(1)
    expect(projects[0].sessions.map((s) => s.sessionId).sort()).toEqual(['sess-also-keep', 'sess-ignore', 'sess-keep'])

    const processor = new Processor({ merlinDir, claudeProjectsDir, minSizeBytes: 0, homeDir })
    const result = await processor.processProject(projectCwd)
    expect(result.processed.sort()).toEqual(['sess-also-keep', 'sess-ignore', 'sess-keep'])

    // Verify files exist on disk
    const store = new LeanSessionStore(merlinDir, projectDirName)
    expect(await store.readSession('sess-ignore')).not.toBeNull()
    expect(await store.readSession('sess-keep')).not.toBeNull()
  })

  test('after adding .merlinignore, ignored session disappears from discovery', async () => {
    // Derive the home-relative project path
    const projectRelative = projectCwd.slice(homeDir.length + 1)

    // Write .merlinignore that ignores one specific session
    writeFileSync(path.join(homeDir, '.merlinignore'), `${projectRelative}/sess-ignore\n`)

    const discovery = new ClaudeProjectDiscovery(claudeProjectsDir, homeDir)
    const projects = await discovery.discover()
    expect(projects).toHaveLength(1)
    const sessionIds = projects[0].sessions.map((s) => s.sessionId).sort()
    expect(sessionIds).toEqual(['sess-also-keep', 'sess-keep'])
    expect(sessionIds).not.toContain('sess-ignore')
  })

  test('after adding .merlinignore, ignored session disappears from checkProject', async () => {
    const processor = new Processor({ merlinDir, claudeProjectsDir, minSizeBytes: 0, homeDir })
    const checks = await processor.checkProject(projectCwd)
    const checkIds = checks.map((c) => c.sessionId).sort()
    expect(checkIds).toEqual(['sess-also-keep', 'sess-keep'])
    expect(checkIds).not.toContain('sess-ignore')
  })

  test('after adding .merlinignore, processProject skips ignored session', async () => {
    const processor = new Processor({ merlinDir, claudeProjectsDir, minSizeBytes: 0, homeDir })
    const result = await processor.processProject(projectCwd, { force: true })
    expect(result.processed.sort()).toEqual(['sess-also-keep', 'sess-keep'])
    expect(result.processed).not.toContain('sess-ignore')
    expect(result.skipped).toContain('sess-ignore')
  })

  test('stored lean session files still exist on disk (not deleted)', async () => {
    // .merlinignore is a filter, not a cleanup — old files remain
    const store = new LeanSessionStore(merlinDir, projectDirName)
    expect(await store.readSession('sess-ignore')).not.toBeNull()
  })

  test('wildcard ignore removes entire project from discovery', async () => {
    const projectRelative = projectCwd.slice(homeDir.length + 1)

    // Overwrite .merlinignore to ignore the whole project
    writeFileSync(path.join(homeDir, '.merlinignore'), `${projectRelative}/\n`)

    const discovery = new ClaudeProjectDiscovery(claudeProjectsDir, homeDir)
    const projects = await discovery.discover()
    expect(projects).toHaveLength(0)

    const processor = new Processor({ merlinDir, claudeProjectsDir, minSizeBytes: 0, homeDir })
    const checks = await processor.checkProject(projectCwd)
    expect(checks).toHaveLength(0)
  })
})
