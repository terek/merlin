import { describe, expect, test } from 'bun:test'
import { parseSessionJsonl } from '../../src/jsonl-parser.ts'
import { buildLeanSession, updateLeanSession } from '../../src/lean-session.ts'
import { LeanSessionSchema, LeanTurnSchema } from '../../src/schema.ts'
import {
  consecutiveUserPromptsSession,
  FIXTURE_SESSION_ID,
  FIXTURE_SESSION_PREFIX,
  incrementalSession,
  interruptionSession,
  minimalSession,
  multiResponseSession,
  multiTurnSession,
  noUsageSession,
  splitAssistantSession,
  toolUseSession,
  trailingPromptSession,
  usageTrackingSession,
} from '../fixtures/sessions.ts'

const BUILD_OPTS = {
  rawSizeBytes: 1000,
  rawLastModified: '2026-03-15T12:00:00.000Z',
  projectDirName: '-Users-test-project',
}

function buildFromFixture(fixture: string) {
  const parsed = parseSessionJsonl(fixture, FIXTURE_SESSION_ID)
  return buildLeanSession(parsed, BUILD_OPTS)
}

describe('buildLeanSession', () => {
  test('produces valid schema for minimal session', () => {
    const session = buildFromFixture(minimalSession())
    const result = LeanSessionSchema.safeParse(session)
    expect(result.success).toBe(true)
  })

  test('produces valid schema for every turn', () => {
    const session = buildFromFixture(multiTurnSession())
    for (const turn of session.turns) {
      const result = LeanTurnSchema.safeParse(turn)
      if (!result.success) {
        console.error('Turn validation failed:', result.error.format())
      }
      expect(result.success).toBe(true)
    }
  })

  test('minimal session: 1 pair = 1 lean turn', () => {
    const session = buildFromFixture(minimalSession())

    expect(session.header.turnCount).toBe(1)
    expect(session.header.userTurnCount).toBe(1)
    expect(session.header.agentTurnCount).toBe(1)
    expect(session.turns).toHaveLength(1)

    const turn = session.turns[0]!
    expect(turn.userText).toBe('Hello, help me with my project')
    expect(turn.agentText).toContain('happy to help')
  })

  test('turn IDs follow session-prefix + zero-padded index', () => {
    const session = buildFromFixture(multiTurnSession())

    expect(session.header.sessionPrefix).toBe(FIXTURE_SESSION_PREFIX)
    expect(session.turns[0]!.id).toBe(`${FIXTURE_SESSION_PREFIX}-0000`)
    expect(session.turns[1]!.id).toBe(`${FIXTURE_SESSION_PREFIX}-0001`)
    expect(session.turns[2]!.id).toBe(`${FIXTURE_SESSION_PREFIX}-0002`)
  })

  test('multi-turn session: 3 pairs = 3 lean turns', () => {
    const session = buildFromFixture(multiTurnSession())

    expect(session.header.turnCount).toBe(3)
    expect(session.header.userTurnCount).toBe(3)
    expect(session.header.agentTurnCount).toBe(3)
    expect(session.turns).toHaveLength(3)

    // Each turn has both user and agent text
    for (const turn of session.turns) {
      expect(turn.userText).toBeTruthy()
      expect(turn.agentText).toBeTruthy()
    }
  })

  test('header has correct metadata', () => {
    const session = buildFromFixture(multiTurnSession())

    expect(session.header.version).toBe(1)
    expect(session.header.sessionId).toBe(FIXTURE_SESSION_ID)
    expect(session.header.title).toBe('Refactoring the auth module')
    expect(session.header.projectPath).toBe('/Users/test/project')
    expect(session.header.projectDirName).toBe('-Users-test-project')
    expect(session.header.slug).toBe('test-session')
    expect(session.header.ccVersion).toBe('2.1.74')
    expect(session.header.startedAt).toBeTruthy()
    expect(session.header.endedAt).toBeTruthy()
    expect(session.header.rawSizeBytes).toBe(1000)
    expect(session.header.rawLastModified).toBe('2026-03-15T12:00:00.000Z')
  })

  test('split assistant messages are merged before collapsing', () => {
    const session = buildFromFixture(splitAssistantSession())

    expect(session.turns).toHaveLength(1)
    const turn = session.turns[0]!
    expect(turn.agentText).toContain('three main tables')
    expect(turn.agentText).toContain('Users - stores credentials')
  })

  test('filters interruption noise', () => {
    const session = buildFromFixture(interruptionSession())

    for (const turn of session.turns) {
      expect(turn.userText).not.toContain('[Request interrupted by user for tool use]')
      // Mixed interrupt message should have prefix stripped
      if (turn.userText.includes('API layer')) {
        expect(turn.userText).not.toStartWith('[Request interrupted')
        expect(turn.userText).toContain('focus on the API layer only')
      }
    }
  })

  test('merges consecutive user prompts when agent was interrupted', () => {
    const session = buildFromFixture(consecutiveUserPromptsSession())

    // Turn 0: initial brainstorm (has an agent response before the interruption)
    // Turn 1: merged consecutive user prompts → final agent response
    expect(session.turns).toHaveLength(2)

    // The merged turn should contain all three user attempts
    const merged = session.turns[1]!
    expect(merged.userText).toContain('The main questions for planning:')
    expect(merged.userText).toContain('sorry, cant type enter')
    expect(merged.userText).toContain('data model')

    // Timestamp should be from the first attempt (earliest)
    expect(merged.userTimestamp).toContain('10:03:') // minute 3

    // Agent response is the final comprehensive answer
    expect(merged.agentText).toContain('Data model')
    expect(merged.agentText).toContain('Sync')
  })

  test('multi-response: picks last substantial response', () => {
    const session = buildFromFixture(multiResponseSession())

    // First pair: "Refactor the database module" → 3 assistant turns collapsed
    const first = session.turns[0]!
    // Last turn "ok" is short (<80 chars), so should merge with previous
    expect(first.agentText).toContain('several issues')
    expect(first.agentText).toContain('ok')
  })

  test('drops trailing user prompt with no response', () => {
    const session = buildFromFixture(trailingPromptSession())

    // Only the first Q&A pair should survive
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0]!.userText).toBe('First question')
    expect(session.turns[0]!.agentText).toBeTruthy()
  })

  test('summaries are truncated for long text', () => {
    const longText = 'A'.repeat(300)
    const content =
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId: 'test',
        timestamp: '2026-03-15T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: longText }] },
      }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        sessionId: 'test',
        timestamp: '2026-03-15T10:01:00.000Z',
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'text', text: 'response' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }) +
      '\n'

    const parsed = parseSessionJsonl(content, 'test')
    const session = buildLeanSession(parsed, BUILD_OPTS)
    const turn = session.turns[0]!

    // Without a summarizer, no summaries are generated
    expect(turn.userSummary).toBeUndefined()
    // Full text is preserved
    expect(turn.userText.length).toBe(300)
  })

  test('computes duration from user prompt to agent response', () => {
    const session = buildFromFixture(multiTurnSession())

    // Each turn should have a duration (user → agent timestamp diff)
    for (const turn of session.turns) {
      expect(turn.durationMs).not.toBeNull()
      expect(turn.durationMs).toBeGreaterThan(0)
    }
  })

  test('computes total duration in header', () => {
    const session = buildFromFixture(multiTurnSession())
    expect(session.header.totalDurationMs).not.toBeNull()
    expect(session.header.totalDurationMs).toBeGreaterThan(0)
  })
})

describe('token usage aggregation', () => {
  test('aggregates usage across all turns', () => {
    const session = buildFromFixture(usageTrackingSession())

    expect(session.header.usage).not.toBeNull()
    expect(session.header.usage!.inputTokens).toBe(100 + 150 + 200)
    expect(session.header.usage!.outputTokens).toBe(50 + 75 + 100)
    expect(session.header.usage!.cacheReadTokens).toBe(200 + 300 + 400)
    expect(session.header.usage!.cacheWriteTokens).toBe(30 + 45 + 60)
    expect(session.header.usage!.apiCalls).toBe(3)
  })

  test('per-turn usage is preserved', () => {
    const session = buildFromFixture(usageTrackingSession())

    expect(session.turns[0]!.usage!.inputTokens).toBe(100)
    expect(session.turns[1]!.usage!.inputTokens).toBe(150)
    expect(session.turns[2]!.usage!.inputTokens).toBe(200)
  })

  test('null usage when no data', () => {
    const session = buildFromFixture(noUsageSession())
    expect(session.header.usage).toBeNull()
  })
})

describe('updateLeanSession', () => {
  test('returns null when raw file unchanged', async () => {
    const { base } = incrementalSession()
    const parsed = parseSessionJsonl(base, FIXTURE_SESSION_ID)
    const session = buildLeanSession(parsed, BUILD_OPTS)

    // Same size and mtime — no update
    const result = await updateLeanSession(session, parsed, BUILD_OPTS)
    expect(result).toBeNull()
  })

  test('rebuilds when raw file has grown', async () => {
    const { base, extended } = incrementalSession()
    const baseParsed = parseSessionJsonl(base, FIXTURE_SESSION_ID)
    const baseSession = buildLeanSession(baseParsed, BUILD_OPTS)

    const extendedParsed = parseSessionJsonl(extended, FIXTURE_SESSION_ID)
    const extendedOpts = { ...BUILD_OPTS, rawSizeBytes: 2000, rawLastModified: '2026-03-15T13:00:00.000Z' }

    const updated = await updateLeanSession(baseSession, extendedParsed, extendedOpts)
    expect(updated).not.toBeNull()
    expect(updated!.turns.length).toBeGreaterThan(baseSession.turns.length)
    expect(updated!.header.rawSizeBytes).toBe(2000)
  })
})

describe('schema validation', () => {
  test('full session validates against LeanSessionSchema', () => {
    const session = buildFromFixture(multiTurnSession())
    const result = LeanSessionSchema.safeParse(session)
    if (!result.success) {
      console.error('Validation errors:', result.error.format())
    }
    expect(result.success).toBe(true)
  })

  test('usage tracking session validates', () => {
    const session = buildFromFixture(usageTrackingSession())
    const result = LeanSessionSchema.safeParse(session)
    expect(result.success).toBe(true)
  })

  test('tool use session validates', () => {
    const session = buildFromFixture(toolUseSession())
    const result = LeanSessionSchema.safeParse(session)
    expect(result.success).toBe(true)
  })
})
