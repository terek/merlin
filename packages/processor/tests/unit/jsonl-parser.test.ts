import { describe, expect, test } from 'bun:test'
import { parseSessionJsonl } from '../../src/jsonl-parser.ts'
import {
  FIXTURE_SESSION_ID,
  interruptionSession,
  minimalSession,
  multiTurnSession,
  noUsageSession,
  splitAssistantSession,
  systemXmlSession,
} from '../fixtures/sessions.ts'

describe('parseSessionJsonl', () => {
  test('parses minimal session with one user + one assistant turn', () => {
    const result = parseSessionJsonl(minimalSession(), 'fallback-id')

    expect(result.sessionId).toBe(FIXTURE_SESSION_ID)
    expect(result.cwd).toBe('/Users/test/project')
    expect(result.slug).toBe('test-session')
    expect(result.ccVersion).toBe('2.1.74')
    expect(result.turns).toHaveLength(2)

    const [user, assistant] = result.turns
    expect(user!.role).toBe('user')
    expect(user!.text).toBe('Hello, help me with my project')
    expect(user!.timestamp).toBeTruthy()

    expect(assistant!.role).toBe('assistant')
    expect(assistant!.text).toContain('happy to help')
    expect(assistant!.usage).not.toBeNull()
    expect(assistant!.usage!.inputTokens).toBe(100)
    expect(assistant!.usage!.outputTokens).toBe(50)
  })

  test('extracts custom title', () => {
    const result = parseSessionJsonl(multiTurnSession(), 'fallback')
    expect(result.title).toBe('Refactoring the auth module')
  })

  test('parses multi-turn session', () => {
    const result = parseSessionJsonl(multiTurnSession(), 'fallback')
    // 3 user + 3 assistant = 6 turns
    expect(result.turns).toHaveLength(6)

    const userTurns = result.turns.filter((t) => t.role === 'user')
    const assistantTurns = result.turns.filter((t) => t.role === 'assistant')
    expect(userTurns).toHaveLength(3)
    expect(assistantTurns).toHaveLength(3)
  })

  test('merges split assistant messages with same message ID', () => {
    const result = parseSessionJsonl(splitAssistantSession(), 'fallback')

    // 1 user + 1 merged assistant = 2 turns
    expect(result.turns).toHaveLength(2)

    const assistant = result.turns[1]!
    expect(assistant.role).toBe('assistant')
    // Both text parts should be merged
    expect(assistant.text).toContain('three main tables')
    expect(assistant.text).toContain('Users - stores credentials')
    // Usage should keep highest output_tokens
    expect(assistant.usage!.outputTokens).toBe(80)
    // rawMessageCount should reflect 2 entries
    expect(assistant.rawMessageCount).toBe(2)
  })

  test('filters system XML from user messages', () => {
    const result = parseSessionJsonl(systemXmlSession(), 'fallback')

    const userTurns = result.turns.filter((t) => t.role === 'user')
    // System XML entries should be filtered — only real user prompts remain
    expect(userTurns).toHaveLength(2)
    expect(userTurns[0]!.text).toBe('What does this function do?')
    expect(userTurns[1]!.text).toBe('Thanks, now add error handling')
  })

  test('filters interruption-only user messages', () => {
    const result = parseSessionJsonl(interruptionSession(), 'fallback')

    const userTurns = result.turns.filter((t) => t.role === 'user')
    // "[Request interrupted by user for tool use]" and pure "[Request interrupted by user]" should be gone
    // Remaining: "Start the refactoring", the mixed interrupt+content, "Looks good, ship it"
    for (const t of userTurns) {
      expect(t.text).not.toBe('[Request interrupted by user for tool use]')
      expect(t.text).not.toBe('[Request interrupted by user]')
    }
  })

  test('handles missing usage data', () => {
    const result = parseSessionJsonl(noUsageSession(), 'fallback')
    const assistant = result.turns.find((t) => t.role === 'assistant')
    expect(assistant!.usage).toBeNull()
  })

  test('uses fallback session ID when not in JSONL', () => {
    const content = `${JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-03-15T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    })}\n`

    const result = parseSessionJsonl(content, 'my-fallback-id')
    expect(result.sessionId).toBe('my-fallback-id')
  })

  test('skips malformed JSON lines gracefully', () => {
    const content = [
      'not json at all',
      '{"type": "user", "broken json',
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId: 'test-session',
        timestamp: '2026-03-15T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      }),
    ].join('\n')

    const result = parseSessionJsonl(content, 'fallback')
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]!.text).toBe('hello')
  })

  test('reports rawLineCount', () => {
    const result = parseSessionJsonl(minimalSession(), 'fallback')
    expect(result.rawLineCount).toBeGreaterThan(0)
  })
})
