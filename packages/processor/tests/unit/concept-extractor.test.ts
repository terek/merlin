import { describe, expect, test } from 'bun:test'
import type { LLMProvider, ParseOptions } from '@merlin/llm'
import type { z } from 'zod'
import { TaskConceptExtractor } from '../../src/concept-extractor.ts'
import type { LeanTurn, SessionTask } from '../../src/schema.ts'
import { createLimiter } from '../../src/summarizer.ts'

interface RecordedCall {
  system: string
  userText: string
  schemaName: string | undefined
}

/**
 * Mock provider that returns canned responses to `parse()`. The response
 * generator is given the user text so a test can decide what to return per
 * task. `chat` throws — we only exercise the structured-output path.
 */
function mockProvider(
  responder: (userText: string) => unknown | ((userText: string) => unknown),
): LLMProvider & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    async chat() {
      throw new Error('chat() should not be called — extractor uses parse()')
    },
    async parse<T extends z.ZodType>(opts: ParseOptions<T>): Promise<z.infer<T>> {
      const userText = opts.messages[0]?.text ?? ''
      calls.push({ system: opts.system, userText, schemaName: opts.schemaName })
      const value = typeof responder === 'function' ? responder(userText) : responder
      const parsed = opts.schema.safeParse(value)
      if (!parsed.success) throw new Error(`mock returned schema-invalid value: ${parsed.error.message}`)
      return parsed.data
    },
  }
}

const limiter = createLimiter(100)

function makeTurn(index: number, userSummary?: string, agentSummary?: string): LeanTurn {
  return {
    id: `test-${String(index).padStart(4, '0')}`,
    index,
    userText: `user text ${index}`,
    userSummary,
    userTimestamp: '2026-03-15T10:00:00.000Z',
    agentText: `agent text ${index}`,
    agentSummary,
    agentTimestamp: '2026-03-15T10:01:00.000Z',
    durationMs: 60000,
    usage: null,
    rawMessageCount: 1,
    subagents: [],
  }
}

describe('TaskConceptExtractor', () => {
  test('extracts concepts as {concept, description} pairs', async () => {
    const provider = mockProvider(() => ({
      concepts: [
        { concept: 'jwt-middleware', description: 'Express middleware that verifies bearer tokens on each request.' },
        { concept: 'auth-module', description: 'New top-level package owning sign-in and token handling.' },
      ],
    }))
    const extractor = new TaskConceptExtractor(provider, { limiter })

    const tasks: SessionTask[] = [
      {
        id: 't1',
        description: 'Set up JWT auth middleware',
        turns: [1, 2],
        contentHash: 'abc123',
      },
    ]
    const turns = [makeTurn(0, 'Set up auth', 'Created auth module'), makeTurn(1, 'Add JWT', 'Added verification')]

    const count = await extractor.extractConcepts(tasks, turns)

    expect(count).toBe(1)
    expect(tasks[0]!.concepts).toEqual({
      items: [
        { concept: 'jwt-middleware', description: 'Express middleware that verifies bearer tokens on each request.' },
        { concept: 'auth-module', description: 'New top-level package owning sign-in and token handling.' },
      ],
      sourceHash: 'abc123',
    })
  })

  test('passes schemaName to provider.parse', async () => {
    const provider = mockProvider(() => ({ concepts: [{ concept: 'x', description: 'y' }] }))
    const extractor = new TaskConceptExtractor(provider, { limiter })

    await extractor.extractConcepts([{ id: 't1', description: 'T', turns: [1], contentHash: 'h' }], [makeTurn(0)])

    expect(provider.calls[0]!.schemaName).toBe('task_concepts')
  })

  test('skips tasks with matching sourceHash', async () => {
    const provider = mockProvider(() => ({ concepts: [{ concept: 'x', description: 'y' }] }))
    const extractor = new TaskConceptExtractor(provider, { limiter })

    const tasks: SessionTask[] = [
      {
        id: 't1',
        description: 'Already extracted task',
        turns: [1],
        contentHash: 'abc123',
        concepts: {
          items: [{ concept: 'thing', description: 'a thing' }],
          sourceHash: 'abc123',
        },
      },
    ]

    const count = await extractor.extractConcepts(tasks, [makeTurn(0)])

    expect(count).toBe(0)
    expect(provider.calls).toHaveLength(0)
  })

  test('re-extracts when sourceHash is stale', async () => {
    const provider = mockProvider(() => ({ concepts: [{ concept: 'api-layer', description: 'rebuilt API.' }] }))
    const extractor = new TaskConceptExtractor(provider, { limiter })

    const tasks: SessionTask[] = [
      {
        id: 't1',
        description: 'Refactored API layer',
        turns: [1, 2, 3],
        contentHash: 'new-hash',
        concepts: {
          items: [{ concept: 'old-thing', description: 'stale.' }],
          sourceHash: 'old-hash',
        },
      },
    ]

    const count = await extractor.extractConcepts(tasks, [makeTurn(0), makeTurn(1), makeTurn(2)])

    expect(count).toBe(1)
    expect(tasks[0]!.concepts!.items).toEqual([{ concept: 'api-layer', description: 'rebuilt API.' }])
    expect(tasks[0]!.concepts!.sourceHash).toBe('new-hash')
  })

  test('caps at 5 concepts even when LLM returns more', async () => {
    const provider = mockProvider(() => ({
      concepts: Array.from({ length: 8 }, (_, i) => ({ concept: `c-${i}`, description: `d ${i}` })),
    }))
    const extractor = new TaskConceptExtractor(provider, { limiter })

    const tasks: SessionTask[] = [{ id: 't1', description: 'task', turns: [1], contentHash: 'h' }]
    await extractor.extractConcepts(tasks, [makeTurn(0)])

    expect(tasks[0]!.concepts!.items).toHaveLength(5)
  })

  test('includes turn summaries in LLM input', async () => {
    const provider = mockProvider(() => ({ concepts: [{ concept: 'x', description: 'y' }] }))
    const extractor = new TaskConceptExtractor(provider, { limiter })

    const tasks: SessionTask[] = [{ id: 't1', description: 'Add test suite', turns: [1], contentHash: 'x' }]
    const turns = [makeTurn(0, '- Add unit tests for auth module', '- Created 5 test files')]

    await extractor.extractConcepts(tasks, turns)

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.userText).toContain('Add test suite')
    expect(provider.calls[0]!.userText).toContain('Add unit tests for auth module')
  })

  test('handles LLM error gracefully — empty concepts, sourceHash recorded', async () => {
    const provider: LLMProvider = {
      async chat() {
        throw new Error('chat not used')
      },
      async parse() {
        throw new Error('rate limited')
      },
    }
    const extractor = new TaskConceptExtractor(provider, { limiter })

    const tasks: SessionTask[] = [{ id: 't1', description: 'Some task', turns: [1], contentHash: 'x' }]

    const count = await extractor.extractConcepts(tasks, [makeTurn(0)])

    expect(count).toBe(1)
    expect(tasks[0]!.concepts!.items).toEqual([])
    expect(tasks[0]!.concepts!.sourceHash).toBe('x')
  })
})
