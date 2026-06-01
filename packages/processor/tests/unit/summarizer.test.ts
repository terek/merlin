import { describe, expect, test } from 'bun:test'
import type { LLMProvider, ParseOptions } from '@merlin/llm'
import type { z } from 'zod'
import type { SessionTask } from '../../src/schema.ts'
import { createLimiter, reconstructContext, SUMMARIZE_MIN_LENGTH, TurnSummarizer } from '../../src/summarizer.ts'

// ---------------------------------------------------------------------------
// Mock LLM provider
//
// The summarizer uses provider.parse() with Zod schemas. The mock returns
// the JS object the test wants to deliver and validates it against the
// caller-supplied schema, mirroring real-provider behavior.
// ---------------------------------------------------------------------------

interface RecordedCall {
  system: string
  messages: Array<{ role: string; text?: string }>
  schemaName?: string
}

type Responder = (input: string) => unknown

function mockProvider(responseObj: unknown | Responder): LLMProvider & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    async chat() {
      throw new Error('chat() should not be called — summarizer uses parse()')
    },
    async parse<T extends z.ZodType>(opts: ParseOptions<T>): Promise<z.infer<T>> {
      calls.push({
        system: opts.system,
        messages: opts.messages.map((m) => ({ role: m.role, text: m.text })),
        schemaName: opts.schemaName,
      })
      const input = opts.messages[0]?.text ?? ''
      const value = typeof responseObj === 'function' ? (responseObj as Responder)(input) : responseObj
      if (value instanceof Error) throw value
      const parsed = opts.schema.safeParse(value)
      if (!parsed.success) {
        throw new Error(`mock returned schema-invalid value (${parsed.error.message}): ${JSON.stringify(value)}`)
      }
      return parsed.data
    },
  }
}

function failingProvider(error: string): LLMProvider {
  return {
    async chat() {
      throw new Error('chat not used')
    },
    async parse() {
      throw new Error(error)
    },
  }
}

const noopLimiter = createLimiter(100)

// Texts that are always above/below threshold regardless of SUMMARIZE_MIN_LENGTH value
const belowThreshold = SUMMARIZE_MIN_LENGTH > 0 ? 'Fix the bug' : '' // empty is the only way to be <= 0
const aboveThreshold = 'A'.repeat(Math.max(SUMMARIZE_MIN_LENGTH, 1) + 100)
const canTestBelowThreshold = SUMMARIZE_MIN_LENGTH > 0

function makeSummarizer(provider: LLMProvider) {
  return new TurnSummarizer(provider, { limiter: noopLimiter })
}

// ---------------------------------------------------------------------------
// Context-blind summarizeTurn tests
// ---------------------------------------------------------------------------

describe('TurnSummarizer.summarizeTurn (context-blind)', () => {
  test.skipIf(!canTestBelowThreshold)('skips LLM call when both texts are below threshold', async () => {
    const provider = mockProvider({ userSummary: 'should not be called', agentSummary: null })
    const summarizer = makeSummarizer(provider)

    const result = await summarizer.summarizeTurn(belowThreshold, belowThreshold)

    expect(result).toEqual({})
    expect(provider.calls).toHaveLength(0)
  })

  test('calls LLM when user text is long', async () => {
    const provider = mockProvider({
      userSummary: 'User asked to fix a complex auth bug.',
      agentSummary: null,
    })
    const summarizer = makeSummarizer(provider)

    const result = await summarizer.summarizeTurn(aboveThreshold, aboveThreshold)

    expect(result.userSummary).toBe('User asked to fix a complex auth bug.')
    expect(provider.calls).toHaveLength(1)
  })

  test('calls LLM when both texts are long', async () => {
    const provider = mockProvider({
      userSummary: 'Requested full auth overhaul.',
      agentSummary: 'Rewrote auth with bcrypt and rate limiting.',
    })
    const summarizer = makeSummarizer(provider)

    const result = await summarizer.summarizeTurn(aboveThreshold, aboveThreshold)

    expect(result.userSummary).toBe('Requested full auth overhaul.')
    expect(result.agentSummary).toBe('Rewrote auth with bcrypt and rate limiting.')
  })

  test('falls back to truncation on LLM error', async () => {
    const provider = failingProvider('API rate limited')
    const summarizer = makeSummarizer(provider)

    const result = await summarizer.summarizeTurn(aboveThreshold, aboveThreshold)

    expect(result.userSummary).toBeDefined()
    expect(result.userSummary!.length).toBeLessThanOrEqual(200)
    expect(result.agentSummary).toBeDefined()
  })

  test('ignores null values in response', async () => {
    const provider = mockProvider({ userSummary: null, agentSummary: null })
    const summarizer = makeSummarizer(provider)

    const result = await summarizer.summarizeTurn(aboveThreshold, aboveThreshold)

    expect(result.userSummary).toBeUndefined()
    expect(result.agentSummary).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Context-aware summarizeSession tests
// ---------------------------------------------------------------------------

describe('TurnSummarizer.summarizeSession (context-aware, chunked)', () => {
  test('processes chunk in one LLM call and discovers tasks', async () => {
    const chunkResponse = {
      items: [
        {
          turn_index: 1,
          task_id: null,
          action: 'new',
          new_task: { id: 't1', description: 'Set up auth module' },
          gist: 'auth setup',
          summary: { user: 'Set up auth middleware with JWT', agent: 'Created auth/ with JWT verification' },
        },
        {
          turn_index: 2,
          task_id: 't1',
          action: 'extend',
          gist: 'add rate limiting',
          summary: {
            user: 'Add rate limiting to auth endpoints',
            agent: 'Added express-rate-limit to /login and /register',
          },
        },
        {
          turn_index: 3,
          task_id: null,
          action: 'new',
          new_task: { id: 't2', description: 'Fix dashboard rendering bug' },
          gist: 'dashboard fix',
          summary: { user: 'Fix blank dashboard on mobile', agent: 'Fixed CSS grid fallback for mobile viewports' },
        },
      ],
    }

    const provider = mockProvider(chunkResponse)
    const summarizer = makeSummarizer(provider)

    const turns = [
      { userText: 'Set up auth with JWT', agentText: 'Created auth module...' },
      { userText: 'Add rate limiting', agentText: 'Added rate limiting...' },
      { userText: 'Fix blank dashboard', agentText: 'Fixed CSS grid...' },
    ]

    const result = await summarizer.summarizeSession(turns)

    // One batched call for the whole 3-turn chunk
    expect(provider.calls).toHaveLength(1)

    // Verify tasks were discovered
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks[0]!.id).toBe('t1')
    expect(result.tasks[0]!.description).toBe('Set up auth module')
    expect(result.tasks[0]!.turns).toEqual([1, 2])
    expect(result.tasks[1]!.id).toBe('t2')
    expect(result.tasks[1]!.turns).toEqual([3])

    // Verify per-turn results
    expect(result.turnResults).toHaveLength(3)
    expect(result.turnResults[0]!.taskId).toBe('t1')
    expect(result.turnResults[0]!.userSummary).toBe('Set up auth middleware with JWT')
    expect(result.turnResults[1]!.taskId).toBe('t1')
    expect(result.turnResults[2]!.taskId).toBe('t2')
  })

  test('refine action updates task description within a chunk', async () => {
    const provider = mockProvider({
      items: [
        {
          turn_index: 1,
          task_id: null,
          action: 'new',
          new_task: { id: 't1', description: 'Add retry logic' },
          gist: 'retry logic',
          summary: { user: 'Add retry to fetchSession()', agent: null },
        },
        {
          turn_index: 2,
          task_id: 't1',
          action: 'refine',
          refined_description: 'Add retry logic with exponential backoff to fetchSession()',
          gist: 'exponential backoff',
          summary: { user: 'Use exponential backoff, 200ms base', agent: 'Implemented with configurable base delay' },
        },
      ],
    })
    const summarizer = makeSummarizer(provider)

    const result = await summarizer.summarizeSession([
      { userText: 'Add retry', agentText: 'Done' },
      { userText: 'Use exponential backoff', agentText: 'Implemented' },
    ])

    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0]!.description).toBe('Add retry logic with exponential backoff to fetchSession()')
    expect(result.tasks[0]!.turns).toEqual([1, 2])
  })

  test('passes context + turns array to the chunk LLM call', async () => {
    const provider = mockProvider({
      items: [
        {
          turn_index: 1,
          action: 'new',
          task_id: null,
          new_task: { id: 't1', description: 'task one' },
          gist: 'gist one',
          summary: { user: 'u1', agent: 'a1' },
        },
        {
          turn_index: 2,
          action: 'extend',
          task_id: 't1',
          gist: 'gist two',
          summary: { user: 'u2', agent: 'a2' },
        },
      ],
    })
    const summarizer = makeSummarizer(provider)

    await summarizer.summarizeSession([
      { userText: 'first', agentText: 'reply' },
      { userText: 'second', agentText: 'reply' },
    ])

    const input = JSON.parse(provider.calls[0]!.messages[0]!.text!)
    // Context reflects state BEFORE the chunk (empty for new session).
    expect(input.context.tasks).toEqual([])
    expect(input.context.recent).toEqual([])
    expect(input.context.turn_index).toBe(1)
    // Turns are indexed starting at context.turn_index.
    expect(input.turns).toHaveLength(2)
    expect(input.turns[0].turn_index).toBe(1)
    expect(input.turns[1].turn_index).toBe(2)
    expect(input.turns[0].user_message).toBe('first')
    expect(input.turns[1].user_message).toBe('second')
  })

  test('rolling context carries across chunks', async () => {
    let callIndex = 0
    const responses: unknown[] = [
      // First chunk: creates t1
      {
        items: [
          {
            turn_index: 1,
            action: 'new',
            task_id: null,
            new_task: { id: 't1', description: 'task one' },
            gist: 'gist one',
            summary: { user: 'u1', agent: 'a1' },
          },
          {
            turn_index: 2,
            action: 'extend',
            task_id: 't1',
            gist: 'gist two',
            summary: { user: 'u2', agent: 'a2' },
          },
        ],
      },
      // Second chunk: extends t1
      {
        items: [
          {
            turn_index: 3,
            action: 'extend',
            task_id: 't1',
            gist: 'gist three',
            summary: { user: 'u3', agent: 'a3' },
          },
          {
            turn_index: 4,
            action: 'new',
            task_id: null,
            new_task: { id: 't2', description: 'task two' },
            gist: 'gist four',
            summary: { user: 'u4', agent: 'a4' },
          },
        ],
      },
    ]

    const provider = mockProvider(() => responses[callIndex++]!)
    // Force 2-turn chunks so the 4-turn session splits into 2 chunks.
    const summarizer = new TurnSummarizer(provider, { limiter: noopLimiter, chunkSize: 2 })

    const result = await summarizer.summarizeSession([
      { userText: 'first', agentText: 'r' },
      { userText: 'second', agentText: 'r' },
      { userText: 'third', agentText: 'r' },
      { userText: 'fourth', agentText: 'r' },
    ])

    // Two chunked calls.
    expect(provider.calls).toHaveLength(2)

    // Second chunk sees state produced by first chunk.
    const secondInput = JSON.parse(provider.calls[1]!.messages[0]!.text!)
    expect(secondInput.context.tasks).toHaveLength(1)
    expect(secondInput.context.tasks[0].id).toBe('t1')
    expect(secondInput.context.tasks[0].turns).toEqual([1, 2])
    expect(secondInput.context.turn_index).toBe(3)
    expect(secondInput.context.recent.length).toBeGreaterThan(0)
    expect(secondInput.turns[0].turn_index).toBe(3)

    // Final state reflects both chunks applied in order.
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks[0]!.turns).toEqual([1, 2, 3])
    expect(result.tasks[1]!.turns).toEqual([4])
    expect(result.turnResults).toHaveLength(4)
  })

  test('falls back to per-turn when chunk parse() throws after retry', async () => {
    let callIndex = 0
    const singleTurnDelta = (user: string, agent: string) => ({
      action: 'new',
      task_id: null,
      new_task: { id: 't1', description: 'inferred' },
      gist: 'g',
      summary: { user, agent },
    })

    const provider = mockProvider(() => {
      callIndex++
      // 2 chunk parse() failures (initial + retry), then 2 single-turn fallback calls
      if (callIndex <= 2) return new Error('schema validation failed')
      return singleTurnDelta(`fallback u${callIndex}`, `fallback a${callIndex}`)
    })
    const summarizer = makeSummarizer(provider)

    const result = await summarizer.summarizeSession([
      { userText: 'first', agentText: 'r' },
      { userText: 'second', agentText: 'r' },
    ])

    // 2 chunk attempts + 2 single-turn fallback calls
    expect(provider.calls).toHaveLength(4)
    expect(result.turnResults).toHaveLength(2)
    expect(result.turnResults[0]!.userSummary).toBeDefined()
    expect(result.turnResults[1]!.userSummary).toBeDefined()
  })

  test('falls back to context-blind on parse failure after retry', async () => {
    let callIndex = 0
    const provider = mockProvider(() => {
      callIndex++
      if (callIndex <= 2) return new Error('schema parse error') // initial + retry both fail
      // 3rd call is the fallback context-blind call
      return { userSummary: 'fallback summary', agentSummary: null }
    })
    const summarizer = makeSummarizer(provider)

    const result = await summarizer.summarizeSession([{ userText: aboveThreshold, agentText: aboveThreshold }])

    expect(result.turnResults).toHaveLength(1)
    // Should have gotten a fallback summary
    expect(result.turnResults[0]!.userSummary).toBe('fallback summary')
  })

  test('resumes from initial context for incremental updates', async () => {
    const existingTasks: SessionTask[] = [{ id: 't1', description: 'Auth module', turns: [1, 2], contentHash: 'h1' }]

    const provider = mockProvider({
      action: 'extend',
      task_id: 't1',
      gist: 'add tests',
      summary: { user: 'Add auth tests', agent: 'Added test suite' },
    })
    const summarizer = makeSummarizer(provider)

    const initialContext = reconstructContext(existingTasks, [
      { userSummary: 'Set up auth', agentSummary: 'Done' },
      { userSummary: 'Add JWT', agentSummary: 'Done' },
    ])

    const result = await summarizer.summarizeSession(
      [{ userText: 'Add tests for auth', agentText: 'Added tests' }],
      initialContext,
    )

    // Task should have been extended
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0]!.turns).toEqual([1, 2, 3])

    // Verify context was passed to LLM
    const input = JSON.parse(provider.calls[0]!.messages[0]!.text!)
    expect(input.context.tasks).toHaveLength(1)
    expect(input.context.turn_index).toBe(3)
    expect(input.context.recent.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// reconstructContext tests
// ---------------------------------------------------------------------------

describe('reconstructContext', () => {
  test('builds context from tasks and turns', () => {
    const tasks: SessionTask[] = [{ id: 't1', description: 'Auth', turns: [1, 2], contentHash: 'h' }]
    const turns = [
      { userSummary: '- Set up auth', agentSummary: 'Created module' },
      { userSummary: '- Add JWT', agentSummary: 'Added verification' },
      { userSummary: '- Fix bug', agentSummary: 'Fixed' },
    ]

    const ctx = reconstructContext(tasks, turns)

    expect(ctx.tasks).toHaveLength(1)
    expect(ctx.tasks[0]!.turns).toEqual([1, 2])
    expect(ctx.turn_index).toBe(4) // 3 existing turns + 1
    expect(ctx.recent.length).toBe(3)
  })

  test('limits recent to 5 entries', () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      userSummary: `Summary ${i}`,
    }))

    const ctx = reconstructContext([], turns)

    expect(ctx.recent.length).toBeLessThanOrEqual(5)
    expect(ctx.turn_index).toBe(11)
  })

  test('deep-copies tasks to avoid mutation', () => {
    const tasks: SessionTask[] = [{ id: 't1', description: 'x', turns: [1], contentHash: 'h' }]
    const ctx = reconstructContext(tasks, [])

    ctx.tasks[0]!.turns.push(99)
    expect(tasks[0]!.turns).toEqual([1]) // original unchanged
  })
})

// ---------------------------------------------------------------------------
// createLimiter tests
// ---------------------------------------------------------------------------

describe('createLimiter', () => {
  test('limits concurrency', async () => {
    const limiter = createLimiter(2)
    let running = 0
    let maxRunning = 0

    const task = () =>
      limiter(async () => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise((r) => setTimeout(r, 20))
        running--
        return running
      })

    await Promise.all([task(), task(), task(), task(), task()])

    expect(maxRunning).toBe(2)
  })

  test('processes all tasks', async () => {
    const limiter = createLimiter(2)
    const results: number[] = []

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limiter(async () => {
          results.push(n)
        }),
      ),
    )

    expect(results.sort()).toEqual([1, 2, 3, 4, 5])
  })

  test('propagates errors without deadlocking', async () => {
    const limiter = createLimiter(1)

    const err = await limiter(async () => {
      throw new Error('boom')
    }).catch((e) => e)
    expect(err.message).toBe('boom')

    // Should not be stuck — next call should work
    const result = await limiter(async () => 42)
    expect(result).toBe(42)
  })
})
