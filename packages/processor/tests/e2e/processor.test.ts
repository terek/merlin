/**
 * E2E tests for the Processor.
 *
 * Creates a fully isolated fake environment:
 * - Fake ~/.claude/projects/ with synthetic JSONL sessions
 * - Fake ~/.merlin/ for output
 *
 * Tests the full pipeline: discovery -> parsing -> lean session build -> segmentation -> storage.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Processor } from '../../src/processor.ts'
import { FolderIndexSchema, LeanSessionSchema } from '../../src/schema.ts'
import { SegmentSchema } from '../../src/segment-schema.ts'
import { LeanSessionStore } from '../../src/store.ts'
import {
  incrementalSession,
  multiTurnSession,
  tinySession,
  toolUseSession,
  usageTrackingSession,
} from '../fixtures/sessions.ts'

const TEST_DIR = path.join(import.meta.dir, '..', '.test-e2e')
const CLAUDE_DIR = path.join(TEST_DIR, 'claude', 'projects')
const MERLIN_DIR = path.join(TEST_DIR, 'merlin')
const PROJECT_CWD = '/Users/test/myproject'
const PROJECT_DIR_NAME = '-Users-test-myproject'

function setupFakeProject(sessions: Record<string, string>) {
  const projectDir = path.join(CLAUDE_DIR, PROJECT_DIR_NAME)
  mkdirSync(projectDir, { recursive: true })
  for (const [id, content] of Object.entries(sessions)) {
    writeFileSync(path.join(projectDir, `${id}.jsonl`), content)
  }
}

function setupSubdirProject(subdir: string, sessions: Record<string, string>) {
  const projectDir = path.join(CLAUDE_DIR, `${PROJECT_DIR_NAME}-${subdir}`)
  mkdirSync(projectDir, { recursive: true })
  for (const [id, content] of Object.entries(sessions)) {
    writeFileSync(path.join(projectDir, `${id}.jsonl`), content)
  }
}

describe('Processor E2E', () => {
  let processor: Processor

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(CLAUDE_DIR, { recursive: true })
    processor = new Processor({
      merlinDir: MERLIN_DIR,
      claudeProjectsDir: CLAUDE_DIR,
      homeDir: '/Users/test',
    })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('processes a single session end-to-end', async () => {
    setupFakeProject({ 'session-001': multiTurnSession() })

    const result = await processor.processProject(PROJECT_CWD)
    expect(result.processed).toEqual(['session-001'])
    expect(result.skipped).toHaveLength(0)
    expect(result.errors).toHaveLength(0)

    // Verify stored lean session
    const store = new LeanSessionStore(MERLIN_DIR, PROJECT_DIR_NAME)
    const session = await store.readSession('session-001')
    expect(session).not.toBeNull()

    const validation = LeanSessionSchema.safeParse(session)
    expect(validation.success).toBe(true)

    expect(session!.header.title).toBe('Refactoring the auth module')
    expect(session!.header.turnCount).toBe(3)
    expect(session!.header.userTurnCount).toBe(3)
    expect(session!.header.agentTurnCount).toBe(3)
  })

  test('produces segments alongside lean session', async () => {
    setupFakeProject({ 'session-001': multiTurnSession() })
    await processor.processProject(PROJECT_CWD)

    const store = new LeanSessionStore(MERLIN_DIR, PROJECT_DIR_NAME)
    const segments = await store.readSegments('session-001')
    expect(segments).not.toBeNull()
    expect(segments!.length).toBeGreaterThan(0)

    // All turns are same day -> single segment
    expect(segments).toHaveLength(1)
    expect(segments![0]!.date).toBe('2026-03-15')
    expect(segments![0]!.userPrompts).toHaveLength(3)

    // Validate schema
    for (const seg of segments!) {
      const result = SegmentSchema.safeParse(seg)
      expect(result.success).toBe(true)
    }
  })

  test('folder-per-session layout: lean.jsonl + segments.json', async () => {
    setupFakeProject({ 'session-001': multiTurnSession() })
    await processor.processProject(PROJECT_CWD)

    const sessionDir = path.join(MERLIN_DIR, 'projects', PROJECT_DIR_NAME, 'session-001')
    expect(existsSync(sessionDir)).toBe(true)
    expect(existsSync(path.join(sessionDir, 'lean.jsonl'))).toBe(true)
    expect(existsSync(path.join(sessionDir, 'segments.json'))).toBe(true)
  })

  test('processes multiple sessions', async () => {
    setupFakeProject({
      'session-multi': multiTurnSession(),
      'session-tools': toolUseSession(),
      'session-usage': usageTrackingSession(),
    })

    const result = await processor.processProject(PROJECT_CWD)
    expect(result.processed.sort()).toEqual(['session-multi', 'session-tools', 'session-usage'].sort())
    expect(result.errors).toHaveLength(0)

    const store = new LeanSessionStore(MERLIN_DIR, PROJECT_DIR_NAME)
    const ids = await store.listSessionIds()
    expect(ids).toHaveLength(3)
    expect(ids.sort()).toEqual(['session-multi', 'session-tools', 'session-usage'].sort())
  })

  test('skips tiny sessions below size threshold', async () => {
    setupFakeProject({
      'session-real': multiTurnSession(),
      'session-tiny': tinySession(),
    })

    const result = await processor.processProject(PROJECT_CWD)
    expect(result.processed).toEqual(['session-real'])
    expect(result.skipped).toContain('session-tiny')

    const store = new LeanSessionStore(MERLIN_DIR, PROJECT_DIR_NAME)
    const ids = await store.listSessionIds()
    expect(ids).toContain('session-real')
    expect(ids).not.toContain('session-tiny')
  })

  test('skips already-processed unchanged sessions on re-run', async () => {
    setupFakeProject({ 'session-001': multiTurnSession() })

    // First run
    const result1 = await processor.processProject(PROJECT_CWD)
    expect(result1.processed).toHaveLength(1)

    // Second run -- same file, should skip
    const result2 = await processor.processProject(PROJECT_CWD)
    expect(result2.processed).toHaveLength(0)
    expect(result2.skipped.length).toBeGreaterThanOrEqual(1)
  })

  test('reprocesses session when raw file changes', async () => {
    setupFakeProject({ 'session-001': multiTurnSession() })

    // First run
    await processor.processProject(PROJECT_CWD)

    // Modify the file (append content)
    const filePath = path.join(CLAUDE_DIR, PROJECT_DIR_NAME, 'session-001.jsonl')
    const { extended } = incrementalSession()
    writeFileSync(filePath, extended)

    // Give filesystem time to update mtime
    const { utimesSync } = await import('node:fs')
    const future = new Date(Date.now() + 2000)
    utimesSync(filePath, future, future)

    // Second run -- file changed, should reprocess
    const result2 = await processor.processProject(PROJECT_CWD)
    expect(result2.processed).toHaveLength(1)
    expect(result2.skipped).toHaveLength(0)
  })

  test('creates project index as manifest (no status field)', async () => {
    setupFakeProject({
      'session-a': multiTurnSession(),
      'session-b': usageTrackingSession(),
    })

    await processor.processProject(PROJECT_CWD)

    const store = new LeanSessionStore(MERLIN_DIR, PROJECT_DIR_NAME)
    const index = await store.readIndex()
    expect(index).not.toBeNull()

    const validation = FolderIndexSchema.safeParse(index)
    expect(validation.success).toBe(true)

    expect(index!.projectPath).toBe(PROJECT_CWD)
    expect(index!.sessions).toHaveLength(2)
    expect(index!.lastProcessedAt).toBeTruthy()

    // Index entries should NOT have status field
    for (const entry of index!.sessions) {
      expect('status' in entry).toBe(false)
      expect('errorMessage' in entry).toBe(false)
      expect(entry.rawSizeBytes).toBeGreaterThan(0)
      expect(entry.rawLastModified).toBeTruthy()
    }
  })

  test('discovers subdirectory project sessions', async () => {
    setupFakeProject({ 'session-root': multiTurnSession() })
    setupSubdirProject('subpackage', { 'session-sub': usageTrackingSession() })

    const result = await processor.processProject(PROJECT_CWD)
    expect(result.processed).toHaveLength(2)
  })

  test('handles missing project directory gracefully', async () => {
    const result = await processor.processProject('/nonexistent/project')
    expect(result.processed).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  test('processSession works for a single session', async () => {
    setupFakeProject({ 'session-single': toolUseSession() })

    const filePath = path.join(CLAUDE_DIR, PROJECT_DIR_NAME, 'session-single.jsonl')
    const result = await processor.processSession(PROJECT_CWD, 'session-single', filePath)
    expect(result.ok).toBe(true)

    const store = new LeanSessionStore(MERLIN_DIR, PROJECT_DIR_NAME)
    const session = await store.readSession('session-single')
    expect(session).not.toBeNull()
    expect(session!.turns.length).toBeGreaterThan(0)

    const segments = await store.readSegments('session-single')
    expect(segments).not.toBeNull()
    expect(segments!.length).toBeGreaterThan(0)
  })

  test('processSession discovers raw path when not provided', async () => {
    setupFakeProject({ 'session-auto': multiTurnSession() })

    const result = await processor.processSession(PROJECT_CWD, 'session-auto')
    expect(result.ok).toBe(true)

    const store = new LeanSessionStore(MERLIN_DIR, PROJECT_DIR_NAME)
    const session = await store.readSession('session-auto')
    expect(session).not.toBeNull()
  })

  test('processSession returns error for nonexistent file', async () => {
    const result = await processor.processSession(PROJECT_CWD, 'ghost', '/nonexistent.jsonl')
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  test('token usage is preserved end-to-end', async () => {
    setupFakeProject({ 'session-usage': usageTrackingSession() })
    await processor.processProject(PROJECT_CWD)

    const store = new LeanSessionStore(MERLIN_DIR, PROJECT_DIR_NAME)
    const session = await store.readSession('session-usage')
    expect(session).not.toBeNull()

    expect(session!.header.usage).not.toBeNull()
    expect(session!.header.usage!.apiCalls).toBe(3)
    expect(session!.header.usage!.inputTokens).toBe(450)
    expect(session!.header.usage!.outputTokens).toBe(225)

    expect(session!.turns.every((t) => t.usage !== null)).toBe(true)

    const segments = await store.readSegments('session-usage')
    expect(segments).not.toBeNull()
    expect(segments![0]!.usage).not.toBeNull()
    expect(segments![0]!.usage!.inputTokens).toBe(450)
  })
})

describe('Processor.checkProject', () => {
  let processor: Processor

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(CLAUDE_DIR, { recursive: true })
    processor = new Processor({
      merlinDir: MERLIN_DIR,
      claudeProjectsDir: CLAUDE_DIR,
      homeDir: '/Users/test',
    })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('new sessions have stored=null', async () => {
    setupFakeProject({ 'session-new': multiTurnSession() })

    const checks = await processor.checkProject(PROJECT_CWD)
    expect(checks).toHaveLength(1)
    expect(checks[0]!.sessionId).toBe('session-new')
    expect(checks[0]!.stored).toBeNull()
    expect(checks[0]!.rawSizeBytes).toBeGreaterThan(0)
  })

  test('processed sessions have matching stored fingerprint', async () => {
    setupFakeProject({ 'session-ok': multiTurnSession() })
    await processor.processProject(PROJECT_CWD)

    const checks = await processor.checkProject(PROJECT_CWD)
    expect(checks).toHaveLength(1)
    expect(checks[0]!.stored).not.toBeNull()
    expect(checks[0]!.stored!.sizeBytes).toBe(checks[0]!.rawSizeBytes)
    expect(checks[0]!.stored!.lastModified).toBe(checks[0]!.rawLastModified)
  })

  test('changed sessions have mismatched stored fingerprint', async () => {
    setupFakeProject({ 'session-change': multiTurnSession() })
    await processor.processProject(PROJECT_CWD)

    // Modify the raw file
    const filePath = path.join(CLAUDE_DIR, PROJECT_DIR_NAME, 'session-change.jsonl')
    const { extended } = incrementalSession()
    writeFileSync(filePath, extended)
    const { utimesSync } = await import('node:fs')
    utimesSync(filePath, new Date(Date.now() + 2000), new Date(Date.now() + 2000))

    const checks = await processor.checkProject(PROJECT_CWD)
    expect(checks).toHaveLength(1)
    expect(checks[0]!.stored).not.toBeNull()
    // Fingerprints should NOT match (file changed)
    const sizeMatch = checks[0]!.stored!.sizeBytes === checks[0]!.rawSizeBytes
    const mtimeMatch = checks[0]!.stored!.lastModified === checks[0]!.rawLastModified
    expect(sizeMatch && mtimeMatch).toBe(false)
  })

  test('skips tiny sessions', async () => {
    setupFakeProject({
      'session-real': multiTurnSession(),
      'session-tiny': tinySession(),
    })

    const checks = await processor.checkProject(PROJECT_CWD)
    expect(checks).toHaveLength(1)
    expect(checks[0]!.sessionId).toBe('session-real')
  })
})

describe('LeanSessionStore deletion', () => {
  let store: LeanSessionStore

  beforeEach(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(CLAUDE_DIR, { recursive: true })
    const processor = new Processor({
      merlinDir: MERLIN_DIR,
      claudeProjectsDir: CLAUDE_DIR,
      homeDir: '/Users/test',
    })
    setupFakeProject({
      'session-a': multiTurnSession(),
      'session-b': usageTrackingSession(),
    })
    await processor.processProject(PROJECT_CWD)
    store = new LeanSessionStore(MERLIN_DIR, PROJECT_DIR_NAME)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('deleteSession removes folder and index entry', async () => {
    await store.deleteSession('session-a')

    expect(await store.readSession('session-a')).toBeNull()
    expect(await store.readSegments('session-a')).toBeNull()

    const ids = await store.listSessionIds()
    expect(ids).not.toContain('session-a')
    expect(ids).toContain('session-b')

    const index = await store.readIndex()
    expect(index!.sessions.find((s) => s.sessionId === 'session-a')).toBeUndefined()
    expect(index!.sessions.find((s) => s.sessionId === 'session-b')).toBeDefined()
  })

  test('deleteAllSessions removes all folders and resets index', async () => {
    await store.deleteAllSessions()

    const ids = await store.listSessionIds()
    expect(ids).toHaveLength(0)

    const index = await store.readIndex()
    expect(index!.sessions).toHaveLength(0)
  })

  test('deleteSession is idempotent for nonexistent session', async () => {
    await store.deleteSession('nonexistent')
    // Should not throw
  })
})

function _setupFakeProjectForDeletion() {
  const projectDir = path.join(CLAUDE_DIR, PROJECT_DIR_NAME)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(path.join(projectDir, 'session-a.jsonl'), multiTurnSession())
  writeFileSync(path.join(projectDir, 'session-b.jsonl'), usageTrackingSession())
}
