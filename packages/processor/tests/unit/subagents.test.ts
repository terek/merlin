import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseSessionJsonl } from '../../src/jsonl-parser.ts'
import { buildLeanSession, buildLeanSessionWithSubagents } from '../../src/lean-session.ts'
import { LeanSessionSchema } from '../../src/schema.ts'

const TEST_DIR = path.join(import.meta.dir, '..', '.test-subagents')
const SESSION_ID = 'aabbccdd-1111-2222-3333-444455556666'

function ts(minutesOffset: number): string {
  const base = new Date('2026-03-15T10:00:00.000Z')
  base.setMinutes(base.getMinutes() + minutesOffset)
  return base.toISOString()
}

function jsonl(...objects: Record<string, unknown>[]): string {
  return `${objects.map((o) => JSON.stringify(o)).join('\n')}\n`
}

function userEntry(text: string, minutesOffset: number): Record<string, unknown> {
  return {
    type: 'user',
    uuid: `u-${minutesOffset}`,
    parentUuid: null,
    sessionId: SESSION_ID,
    cwd: '/Users/test/project',
    version: '2.1.74',
    slug: 'test-session',
    timestamp: ts(minutesOffset),
    isSidechain: false,
    userType: 'external',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function assistantEntry(text: string, minutesOffset: number, usage?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: `a-${minutesOffset}`,
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: ts(minutesOffset),
    isSidechain: false,
    message: {
      id: `msg-${minutesOffset}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: usage || {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 30,
      },
    },
  }
}

function mainSessionContent(): string {
  return jsonl(
    userEntry('Analyze the codebase and fix bugs', 0),
    assistantEntry(
      "I'll analyze the codebase. Let me launch a subagent to explore the tests while I look at the main code.",
      1,
      {
        input_tokens: 200,
        output_tokens: 100,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 60,
      },
    ),
    userEntry('What did you find?', 10),
    assistantEntry(
      'Found 3 critical bugs in the authentication module. The subagent also found test coverage gaps.',
      12,
      {
        input_tokens: 300,
        output_tokens: 150,
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 90,
      },
    ),
  )
}

function subagentContent(agentId: string, launchMinute: number): string {
  return jsonl(
    {
      type: 'user',
      uuid: 'sub-u-1',
      parentUuid: null,
      isSidechain: true,
      agentId,
      sessionId: SESSION_ID,
      cwd: '/Users/test/project',
      version: '2.1.74',
      timestamp: ts(launchMinute),
      userType: 'external',
      message: {
        role: 'user',
        content: 'Explore the test directory and identify gaps in test coverage for the auth module.',
      },
    },
    {
      type: 'assistant',
      uuid: 'sub-a-1',
      parentUuid: 'sub-u-1',
      isSidechain: true,
      agentId,
      sessionId: SESSION_ID,
      timestamp: ts(launchMinute + 1),
      message: {
        id: 'msg-sub-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Let me look at the test files...' }],
        stop_reason: null,
        usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 },
      },
    },
    {
      type: 'assistant',
      uuid: 'sub-a-2',
      parentUuid: 'sub-a-1',
      isSidechain: true,
      agentId,
      sessionId: SESSION_ID,
      timestamp: ts(launchMinute + 3),
      message: {
        id: 'msg-sub-2',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Found significant gaps in auth module test coverage:\n1. No tests for token refresh flow\n2. Missing edge cases for expired sessions\n3. Rate limiting not tested at all\n\nRecommend adding 12 new test cases.',
          },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 80, output_tokens: 60, cache_read_input_tokens: 150, cache_creation_input_tokens: 20 },
      },
    },
  )
}

function setupSubagent(agentId: string, agentType: string, launchMinute = 2) {
  const subagentsDir = path.join(TEST_DIR, SESSION_ID, 'subagents')
  mkdirSync(subagentsDir, { recursive: true })
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), subagentContent(agentId, launchMinute))
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType }))
}

const BUILD_OPTS = {
  rawSizeBytes: 2000,
  rawLastModified: '2026-03-15T12:00:00.000Z',
  projectDirName: '-Users-test-project',
  sessionDir: TEST_DIR,
}

describe('subagent turns (nested)', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('without subagent dir, turns have empty subagents array', async () => {
    const parsed = parseSessionJsonl(mainSessionContent(), SESSION_ID)
    const session = buildLeanSession(parsed, { ...BUILD_OPTS, sessionDir: undefined })

    expect(session.turns).toHaveLength(2)
    for (const t of session.turns) {
      expect(t.subagents).toEqual([])
    }
  })

  test('subagent is nested inside the parent turn', async () => {
    setupSubagent('a1b2c3d4', 'Explore')

    const parsed = parseSessionJsonl(mainSessionContent(), SESSION_ID)
    const session = await buildLeanSessionWithSubagents(parsed, BUILD_OPTS)

    // Still only 2 top-level turns
    expect(session.turns).toHaveLength(2)

    // Subagent launched at t=2 should be nested in the first turn (user at t=0)
    expect(session.turns[0]!.subagents).toHaveLength(1)
    expect(session.turns[1]!.subagents).toHaveLength(0)

    const sub = session.turns[0]!.subagents[0]!
    expect(sub.agentId).toBe('a1b2c3d4')
    expect(sub.agentType).toBe('Explore')
  })

  test('subagent userText is the kickoff prompt', async () => {
    setupSubagent('a1b2c3d4', 'Explore')

    const parsed = parseSessionJsonl(mainSessionContent(), SESSION_ID)
    const session = await buildLeanSessionWithSubagents(parsed, BUILD_OPTS)

    const sub = session.turns[0]!.subagents[0]!
    expect(sub.userText).toContain('Explore the test directory')
  })

  test('subagent agentText is the last substantial response', async () => {
    setupSubagent('a1b2c3d4', 'Explore')

    const parsed = parseSessionJsonl(mainSessionContent(), SESSION_ID)
    const session = await buildLeanSessionWithSubagents(parsed, BUILD_OPTS)

    const sub = session.turns[0]!.subagents[0]!
    expect(sub.agentText).toContain('significant gaps')
    expect(sub.agentText).toContain('12 new test cases')
  })

  test('subagent usage is aggregated from all its assistant turns', async () => {
    setupSubagent('a1b2c3d4', 'Explore')

    const parsed = parseSessionJsonl(mainSessionContent(), SESSION_ID)
    const session = await buildLeanSessionWithSubagents(parsed, BUILD_OPTS)

    const sub = session.turns[0]!.subagents[0]!
    expect(sub.usage).not.toBeNull()
    expect(sub.usage!.inputTokens).toBe(130) // 50+80
    expect(sub.usage!.outputTokens).toBe(80) // 20+60
  })

  test('subagent has duration computed', async () => {
    setupSubagent('a1b2c3d4', 'Explore')

    const parsed = parseSessionJsonl(mainSessionContent(), SESSION_ID)
    const session = await buildLeanSessionWithSubagents(parsed, BUILD_OPTS)

    const sub = session.turns[0]!.subagents[0]!
    expect(sub.durationMs).not.toBeNull()
    expect(sub.durationMs).toBeGreaterThan(0)
  })

  test('header usage includes subagent usage', async () => {
    setupSubagent('a1b2c3d4', 'Explore')

    const parsed = parseSessionJsonl(mainSessionContent(), SESSION_ID)
    const session = await buildLeanSessionWithSubagents(parsed, BUILD_OPTS)

    // 2 main turns + 1 subagent = 3 apiCalls
    expect(session.header.usage).not.toBeNull()
    expect(session.header.usage!.apiCalls).toBe(3)
  })

  test('turnCount counts only main turns', async () => {
    setupSubagent('a1b2c3d4', 'Explore')

    const parsed = parseSessionJsonl(mainSessionContent(), SESSION_ID)
    const session = await buildLeanSessionWithSubagents(parsed, BUILD_OPTS)

    expect(session.header.turnCount).toBe(2)
    expect(session.header.userTurnCount).toBe(2)
  })

  test('multiple subagents nest into correct parent turns', async () => {
    const subagentsDir = path.join(TEST_DIR, SESSION_ID, 'subagents')
    mkdirSync(subagentsDir, { recursive: true })

    // Subagent launched at t=3 (during first main turn, user at t=0)
    const sub1 = jsonl(
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: true,
        agentId: 'early',
        sessionId: SESSION_ID,
        timestamp: ts(3),
        userType: 'external',
        cwd: '/test',
        message: { role: 'user', content: 'Early task' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        isSidechain: true,
        agentId: 'early',
        sessionId: SESSION_ID,
        timestamp: ts(4),
        message: {
          id: 'msg-e',
          role: 'assistant',
          type: 'message',
          content: [
            { type: 'text', text: 'Early result from the first subagent that was launched early in the session.' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    )
    // Subagent launched at t=11 (during second main turn, user at t=10)
    const sub2 = jsonl(
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: null,
        isSidechain: true,
        agentId: 'late',
        sessionId: SESSION_ID,
        timestamp: ts(11),
        userType: 'external',
        cwd: '/test',
        message: { role: 'user', content: 'Late task' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        isSidechain: true,
        agentId: 'late',
        sessionId: SESSION_ID,
        timestamp: ts(13),
        message: {
          id: 'msg-l',
          role: 'assistant',
          type: 'message',
          content: [
            { type: 'text', text: 'Late result from the second subagent that was launched later in the session.' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    )

    writeFileSync(path.join(subagentsDir, 'agent-early.jsonl'), sub1)
    writeFileSync(path.join(subagentsDir, 'agent-late.jsonl'), sub2)

    const parsed = parseSessionJsonl(mainSessionContent(), SESSION_ID)
    const session = await buildLeanSessionWithSubagents(parsed, BUILD_OPTS)

    expect(session.turns).toHaveLength(2)
    expect(session.turns[0]!.subagents).toHaveLength(1)
    expect(session.turns[0]!.subagents[0]!.agentId).toBe('early')
    expect(session.turns[1]!.subagents).toHaveLength(1)
    expect(session.turns[1]!.subagents[0]!.agentId).toBe('late')
  })

  test('subagent summaries use shared truncation', async () => {
    const subagentsDir = path.join(TEST_DIR, SESSION_ID, 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    const longResponse = 'A'.repeat(300)
    const content = jsonl(
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: true,
        agentId: 'longagent',
        sessionId: SESSION_ID,
        timestamp: ts(2),
        userType: 'external',
        cwd: '/test',
        message: { role: 'user', content: 'Do a detailed analysis' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        isSidechain: true,
        agentId: 'longagent',
        sessionId: SESSION_ID,
        timestamp: ts(5),
        message: {
          id: 'msg-long',
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: longResponse }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    )
    writeFileSync(path.join(subagentsDir, 'agent-longagent.jsonl'), content)

    const parsed = parseSessionJsonl(mainSessionContent(), SESSION_ID)
    const session = await buildLeanSessionWithSubagents(parsed, BUILD_OPTS)

    const sub = session.turns[0]!.subagents[0]!
    expect(sub.agentText.length).toBe(300)
    // Without a summarizer, no summaries are generated
    expect(sub.agentSummary).toBeUndefined()
  })

  test('validates against LeanSessionSchema', async () => {
    setupSubagent('a1b2c3d4', 'Explore')

    const parsed = parseSessionJsonl(mainSessionContent(), SESSION_ID)
    const session = await buildLeanSessionWithSubagents(parsed, BUILD_OPTS)

    const result = LeanSessionSchema.safeParse(session)
    if (!result.success) {
      console.error('Validation errors:', result.error.format())
    }
    expect(result.success).toBe(true)
  })
})
