/**
 * Tests that incremental updates only summarize NEW turns, not re-summarize
 * turns that already have summaries from a previous run.
 *
 * This is a regression test — the bug was that updateLeanSession rebuilt
 * all turns from scratch and then ran the summarizer on everything,
 * ignoring that existing turns already had summaries.
 */

import { describe, expect, test } from 'bun:test'
import type { LLMProvider, ParseOptions } from '@merlin/llm'
import type { z } from 'zod'
import { parseSessionJsonl } from '../../src/jsonl-parser.ts'
import { buildLeanSessionWithSubagents, updateLeanSession } from '../../src/lean-session.ts'
import { createLimiter, TurnSummarizer } from '../../src/summarizer.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    sessionId: 'test-session-id',
    cwd: '/test',
    version: '2.1.74',
    slug: 'test',
    timestamp: ts(minutesOffset),
    isSidechain: false,
    userType: 'external',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function assistantEntry(text: string, minutesOffset: number): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: `a-${minutesOffset}`,
    parentUuid: null,
    sessionId: 'test-session-id',
    timestamp: ts(minutesOffset),
    isSidechain: false,
    message: {
      id: `msg-${minutesOffset}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }
}

/** A session with 2 turns. */
function baseContent(): string {
  return jsonl(
    userEntry('Implement the login page with email and password fields', 0),
    assistantEntry(
      "I've created the login page with email/password fields, validation, and error handling. The component is at src/Login.tsx.",
      2,
    ),
    userEntry('Now add forgot password functionality with email reset flow', 5),
    assistantEntry(
      'Added forgot password flow: ForgotPassword.tsx sends reset emails, ResetPassword.tsx handles the token-based reset. Both integrated into the router.',
      8,
    ),
  )
}

/** Same session extended with a 3rd turn. */
function extendedContent(): string {
  return (
    baseContent() +
    jsonl(
      userEntry('Add two-factor authentication using TOTP', 15),
      assistantEntry(
        'Implemented TOTP-based 2FA: setup page with QR code generation, verification step during login, and backup codes. Used otpauth library.',
        20,
      ),
    )
  )
}

/** Mock LLM provider that counts parse() calls and returns canned summaries.
 *  Routes by schemaName (set by the summarizer): chunk_deltas, turn_delta, turn_summary. */
function countingProvider(): LLMProvider & { callCount: number; calls: string[] } {
  const state = { callCount: 0, calls: [] as string[], turnCounter: 0, taskCounter: 0 }
  const makeDelta = () => {
    state.turnCounter++
    state.taskCounter++
    return {
      action: 'new' as const,
      task_id: null,
      new_task: { id: `t${state.taskCounter}`, description: `Task ${state.taskCounter}` },
      gist: `gist #${state.turnCounter}`,
      summary: {
        user: `Summary of user prompt #${state.turnCounter}`,
        agent: `Summary of agent response #${state.turnCounter}`,
      },
    }
  }
  return {
    get callCount() {
      return state.callCount
    },
    get calls() {
      return state.calls
    },
    async chat() {
      throw new Error('chat() should not be called — summarizer uses parse()')
    },
    async parse<T extends z.ZodType>(opts: ParseOptions<T>): Promise<z.infer<T>> {
      state.callCount++
      const input = opts.messages[0]?.text || ''
      state.calls.push(input.slice(0, 80))

      let value: unknown
      switch (opts.schemaName) {
        case 'chunk_deltas': {
          const parsed = JSON.parse(input) as { turns: unknown[] }
          value = { items: parsed.turns.map(() => makeDelta()) }
          break
        }
        case 'turn_delta':
          value = makeDelta()
          break
        case 'turn_summary':
          state.turnCounter++
          value = {
            userSummary: `Summary of user prompt #${state.turnCounter}`,
            agentSummary: `Summary of agent response #${state.turnCounter}`,
          }
          break
        default:
          throw new Error(`unexpected schemaName: ${opts.schemaName}`)
      }

      const r = opts.schema.safeParse(value)
      if (!r.success) throw new Error(`mock returned schema-invalid value: ${r.error.message}`)
      return r.data
    },
  }
}

function makeSummarizer(provider: LLMProvider): TurnSummarizer {
  return new TurnSummarizer(provider, { limiter: createLimiter(100) })
}

const BASE_OPTS = {
  rawSizeBytes: 1000,
  rawLastModified: '2026-03-15T12:00:00.000Z',
  projectDirName: '-test',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('incremental summarization', () => {
  test('initial build summarizes all turns in a single chunked call', async () => {
    const provider = countingProvider()
    const parsed = parseSessionJsonl(baseContent(), 'test-session-id')
    const session = await buildLeanSessionWithSubagents(parsed, {
      ...BASE_OPTS,
      summarizer: makeSummarizer(provider),
    })

    // 2 turns fit in one chunk → one LLM call, two per-turn deltas
    expect(session.turns).toHaveLength(2)
    expect(provider.callCount).toBe(1)

    // All turns should have summaries
    for (const turn of session.turns) {
      expect(turn.userSummary).toBeDefined()
      expect(turn.agentSummary).toBeDefined()
    }
  })

  test('updateLeanSession only summarizes NEW turns', async () => {
    // Step 1: Build initial session with summaries
    const provider1 = countingProvider()
    const baseParsed = parseSessionJsonl(baseContent(), 'test-session-id')
    const baseSession = await buildLeanSessionWithSubagents(baseParsed, {
      ...BASE_OPTS,
      summarizer: makeSummarizer(provider1),
    })

    // 2 turns fit in one chunk → one LLM call
    expect(provider1.callCount).toBe(1)
    expect(baseSession.turns).toHaveLength(2)

    // Verify summaries exist
    expect(baseSession.turns[0]!.userSummary).toBeDefined()
    expect(baseSession.turns[1]!.userSummary).toBeDefined()

    // Step 2: Update with extended content (1 new turn)
    const provider2 = countingProvider()
    const extendedParsed = parseSessionJsonl(extendedContent(), 'test-session-id')
    const extendedOpts = {
      ...BASE_OPTS,
      rawSizeBytes: 2000,
      rawLastModified: '2026-03-15T13:00:00.000Z',
      summarizer: makeSummarizer(provider2),
    }

    const updated = await updateLeanSession(baseSession, extendedParsed, extendedOpts)

    expect(updated).not.toBeNull()
    expect(updated!.turns).toHaveLength(3)

    // KEY ASSERTION: Only 1 LLM call for the new turn, not 3
    expect(provider2.callCount).toBe(1)

    // Old turns should still have their original summaries (carried forward)
    expect(updated!.turns[0]!.userSummary).toBe('Summary of user prompt #1')
    expect(updated!.turns[1]!.userSummary).toBe('Summary of user prompt #2')

    // New turn should have a fresh summary
    expect(updated!.turns[2]!.userSummary).toBe('Summary of user prompt #1') // provider2's first call
  })

  test('re-processing unchanged session makes zero LLM calls', async () => {
    // Build initial session
    const provider1 = countingProvider()
    const parsed = parseSessionJsonl(baseContent(), 'test-session-id')
    const session = await buildLeanSessionWithSubagents(parsed, {
      ...BASE_OPTS,
      summarizer: makeSummarizer(provider1),
    })
    expect(provider1.callCount).toBe(1)

    // "Re-process" with same fingerprint — should return null (no changes)
    const provider2 = countingProvider()
    const result = await updateLeanSession(session, parsed, {
      ...BASE_OPTS,
      summarizer: makeSummarizer(provider2),
    })

    expect(result).toBeNull()
    expect(provider2.callCount).toBe(0)
  })

  test('re-processing with changed fingerprint but same content reuses summaries', async () => {
    // Build initial session
    const provider1 = countingProvider()
    const parsed = parseSessionJsonl(baseContent(), 'test-session-id')
    const session = await buildLeanSessionWithSubagents(parsed, {
      ...BASE_OPTS,
      summarizer: makeSummarizer(provider1),
    })
    expect(provider1.callCount).toBe(1)

    // "Re-process" with different fingerprint but same content
    // (e.g. file was touched but content didn't change)
    const provider2 = countingProvider()
    const result = await updateLeanSession(session, parsed, {
      ...BASE_OPTS,
      rawSizeBytes: 1001, // different fingerprint
      rawLastModified: '2026-03-15T13:00:00.000Z',
      summarizer: makeSummarizer(provider2),
    })

    expect(result).not.toBeNull()
    // Content is the same, so summaries should be carried forward — zero LLM calls
    expect(provider2.callCount).toBe(0)

    // Summaries should be preserved
    expect(result!.turns[0]!.userSummary).toBe('Summary of user prompt #1')
    expect(result!.turns[1]!.userSummary).toBe('Summary of user prompt #2')
  })
})
