import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseSessionJsonl } from '../../src/jsonl-parser.ts'
import { buildLeanSession } from '../../src/lean-session.ts'
import { FolderIndexSchema, LeanSessionSchema } from '../../src/schema.ts'
import { SegmentSchema } from '../../src/segment-schema.ts'
import { cwdToProjectDirName, LeanSessionStore, parseLeanSessionJsonl } from '../../src/store.ts'
import { FIXTURE_SESSION_ID, multiTurnSession } from '../fixtures/sessions.ts'

const TEST_DIR = path.join(import.meta.dir, '..', '.test-store')
const PROJECT_DIR_NAME = '-Users-test-project'

const BUILD_OPTS = {
  rawSizeBytes: 1000,
  rawLastModified: '2026-03-15T12:00:00.000Z',
  projectDirName: PROJECT_DIR_NAME,
}

function buildTestSession() {
  const parsed = parseSessionJsonl(multiTurnSession(), FIXTURE_SESSION_ID)
  return buildLeanSession(parsed, BUILD_OPTS)
}

describe('LeanSessionStore', () => {
  let store: LeanSessionStore

  beforeEach(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    store = new LeanSessionStore(TEST_DIR, PROJECT_DIR_NAME)
    await store.init()
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('init creates project directory', () => {
    expect(existsSync(store.getProjectDir())).toBe(true)
  })

  test('write and read session roundtrip', async () => {
    const session = buildTestSession()
    await store.writeSession(session)

    const loaded = await store.readSession(FIXTURE_SESSION_ID)
    expect(loaded).not.toBeNull()
    expect(loaded!.header.sessionId).toBe(FIXTURE_SESSION_ID)
    expect(loaded!.header.title).toBe('Refactoring the auth module')
    expect(loaded!.turns).toHaveLength(session.turns.length)

    // Validate schema after roundtrip
    const result = LeanSessionSchema.safeParse(loaded)
    expect(result.success).toBe(true)
  })

  test('stored in folder-per-session layout: <session-id>/lean.jsonl', async () => {
    const session = buildTestSession()
    await store.writeSession(session)

    const sessionDir = path.join(store.getProjectDir(), FIXTURE_SESSION_ID)
    expect(existsSync(sessionDir)).toBe(true)

    const filePath = path.join(sessionDir, 'lean.jsonl')
    const content = await Bun.file(filePath).text()
    const lines = content.trim().split('\n')

    // Line 1 = header, rest = turns
    expect(lines.length).toBe(1 + session.turns.length)

    const header = JSON.parse(lines[0]!)
    expect(header.version).toBe(1)
    expect(header.sessionId).toBe(FIXTURE_SESSION_ID)

    const firstTurn = JSON.parse(lines[1]!)
    expect(firstTurn.userText).toBeTruthy()
    expect(firstTurn.agentText).toBeTruthy()
    expect(firstTurn.id).toBeTruthy()
  })

  test('readSession returns null for nonexistent session', async () => {
    const result = await store.readSession('nonexistent')
    expect(result).toBeNull()
  })

  test('readHeader returns only the header', async () => {
    const session = buildTestSession()
    await store.writeSession(session)

    const header = await store.readHeader(FIXTURE_SESSION_ID)
    expect(header).not.toBeNull()
    expect(header!.sessionId).toBe(FIXTURE_SESSION_ID)
    expect(header!.turnCount).toBe(session.turns.length)
  })

  test('readHeader returns null for nonexistent session', async () => {
    const result = await store.readHeader('nonexistent')
    expect(result).toBeNull()
  })

  test('listSessionIds returns stored sessions', async () => {
    const session = buildTestSession()
    await store.writeSession(session)

    const ids = await store.listSessionIds()
    expect(ids).toContain(FIXTURE_SESSION_ID)
  })

  test('listSessionIds returns empty for fresh store', async () => {
    const ids = await store.listSessionIds()
    expect(ids).toHaveLength(0)
  })

  test('write and read index roundtrip', async () => {
    const index = {
      version: 1 as const,
      projectPath: '/Users/test/project',
      projectDirName: PROJECT_DIR_NAME,
      sessions: [
        {
          sessionId: FIXTURE_SESSION_ID,
          title: 'Test',
          startedAt: '2026-03-15T10:00:00.000Z',
          endedAt: '2026-03-15T11:00:00.000Z',
          turnCount: 6,
          userTurnCount: 3,
          rawSizeBytes: 1000,
          rawLastModified: '2026-03-15T12:00:00.000Z',
        },
      ],
      lastProcessedAt: '2026-03-15T12:00:00.000Z',
    }

    await store.writeIndex(index)
    const loaded = await store.readIndex()
    expect(loaded).not.toBeNull()

    const result = FolderIndexSchema.safeParse(loaded)
    expect(result.success).toBe(true)

    expect(loaded!.sessions).toHaveLength(1)
    expect(loaded!.sessions[0]!.sessionId).toBe(FIXTURE_SESSION_ID)
  })

  test('readIndex returns null when no index exists', async () => {
    const result = await store.readIndex()
    expect(result).toBeNull()
  })

  test('overwriting a session replaces it', async () => {
    const session1 = buildTestSession()
    await store.writeSession(session1)

    // Build a different session with same ID but modified title
    const parsed = parseSessionJsonl(multiTurnSession(), FIXTURE_SESSION_ID)
    parsed.title = 'Updated title'
    const session2 = buildLeanSession(parsed, BUILD_OPTS)
    await store.writeSession(session2)

    const loaded = await store.readSession(FIXTURE_SESSION_ID)
    expect(loaded!.header.title).toBe('Updated title')
  })

  // --- Segments ---

  test('write and read segments roundtrip', async () => {
    const segments = [
      {
        index: 0,
        date: '2026-03-15',
        topic: 'Auth module refactoring',
        summary: '1. Fix passwords 2. Add rate limiting',
        turnRange: [0, 3] as [number, number],
        userPrompts: ['Fix passwords', 'Add rate limiting'],
        timeRange: ['2026-03-15T10:00:00.000Z', '2026-03-15T10:15:00.000Z'] as [string, string],
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 30 },
      },
    ]

    await store.writeSegments(FIXTURE_SESSION_ID, segments)
    const loaded = await store.readSegments(FIXTURE_SESSION_ID)
    expect(loaded).not.toBeNull()
    expect(loaded).toHaveLength(1)
    expect(loaded![0]!.topic).toBe('Auth module refactoring')

    // Validate schema
    for (const seg of loaded!) {
      const result = SegmentSchema.safeParse(seg)
      expect(result.success).toBe(true)
    }
  })

  test('segments stored at <session-id>/segments.json', async () => {
    await store.writeSegments(FIXTURE_SESSION_ID, [])
    const filePath = path.join(store.getProjectDir(), FIXTURE_SESSION_ID, 'segments.json')
    expect(existsSync(filePath)).toBe(true)
  })

  test('readSegments returns null for nonexistent session', async () => {
    const result = await store.readSegments('nonexistent')
    expect(result).toBeNull()
  })
})

describe('parseLeanSessionJsonl', () => {
  test('parses valid JSONL content', () => {
    const session = buildTestSession()
    const lines = [JSON.stringify(session.header), ...session.turns.map((t) => JSON.stringify(t))].join('\n')

    const result = parseLeanSessionJsonl(lines)
    expect(result).not.toBeNull()
    expect(result!.header.sessionId).toBe(FIXTURE_SESSION_ID)
    expect(result!.turns).toHaveLength(session.turns.length)
  })

  test('returns null for empty content', () => {
    expect(parseLeanSessionJsonl('')).toBeNull()
  })

  test('returns null for invalid JSON', () => {
    expect(parseLeanSessionJsonl('not json')).toBeNull()
  })
})

describe('cwdToProjectDirName', () => {
  test('converts absolute path to dash-separated name', () => {
    expect(cwdToProjectDirName('/Users/alice/work/myapp')).toBe('-Users-alice-work-myapp')
  })

  test('handles root path', () => {
    expect(cwdToProjectDirName('/')).toBe('-')
  })

  test('handles nested paths', () => {
    expect(cwdToProjectDirName('/a/b/c/d')).toBe('-a-b-c-d')
  })
})
