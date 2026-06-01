import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { OllamaProvider } from '../src/ollama.ts'
import { SchemaParseError } from '../src/provider.ts'
import { llmStats } from '../src/stats.ts'
import { type FetchMock, installFetchMock, restoreFetch } from './_fetch-mock.ts'

let fm: FetchMock

const personSchema = z.object({
  name: z.string(),
  count: z.number(),
})

describe('OllamaProvider.parse', () => {
  beforeEach(() => {
    fm = installFetchMock()
    llmStats.reset()
  })

  afterEach(() => {
    restoreFetch()
  })

  test('sends format with cleaned JSON schema', async () => {
    fm.setResponse({ choices: [{ message: { content: '{"name":"a","count":1}' } }] })
    const provider = new OllamaProvider('qwen3:8b', 'http://localhost:11434')

    await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'who?' }],
      schema: personSchema,
    })

    const body = fm.requests[0]!.body as { format: Record<string, unknown>; messages: unknown[] }
    expect(body.format.$schema).toBeUndefined()
    expect(body.format.type).toBe('object')
    expect(body.format.required).toEqual(['name', 'count'])
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'who?' })
  })

  test('returns the validated typed object', async () => {
    fm.setResponse({ choices: [{ message: { content: '{"name":"alice","count":42}' } }] })
    const provider = new OllamaProvider('qwen3:8b', 'http://localhost:11434')

    const out = await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'who?' }],
      schema: personSchema,
    })

    expect(out).toEqual({ name: 'alice', count: 42 })
  })

  test('throws SchemaParseError on schema mismatch', async () => {
    fm.setResponse({ choices: [{ message: { content: '{"name":"a","count":"nope"}' } }] })
    const provider = new OllamaProvider('qwen3:8b', 'http://localhost:11434')

    await expect(
      provider.parse({
        system: 'sys',
        messages: [{ role: 'user', text: 'go' }],
        schema: personSchema,
      }),
    ).rejects.toThrow(SchemaParseError)
  })

  test('throws on non-2xx response', async () => {
    fm.setResponse({ error: 'bad' }, { status: 500 })
    const provider = new OllamaProvider('qwen3:8b', 'http://localhost:11434')

    await expect(
      provider.parse({
        system: 'sys',
        messages: [{ role: 'user', text: 'go' }],
        schema: personSchema,
      }),
    ).rejects.toThrow(/Ollama error 500/)
  })

  test('records token usage when reported', async () => {
    fm.setResponse({
      choices: [{ message: { content: '{"name":"x","count":1}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    })
    const provider = new OllamaProvider('qwen3:8b', 'http://localhost:11434')

    await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'go' }],
      schema: personSchema,
    })

    const stats = llmStats.stats().get('ollama/qwen3:8b')!
    expect(stats.calls).toBe(1)
    expect(stats.inputTokens).toBe(100)
    expect(stats.outputTokens).toBe(10)
  })
})
