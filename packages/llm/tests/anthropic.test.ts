import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { AnthropicProvider } from '../src/anthropic.ts'
import { SchemaParseError } from '../src/provider.ts'
import { llmStats } from '../src/stats.ts'
import { type FetchMock, installFetchMock, restoreFetch } from './_fetch-mock.ts'

let fm: FetchMock

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
})

function textResponse(text: string, opts: { input_tokens?: number; output_tokens?: number } = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: opts.input_tokens ?? 100,
      output_tokens: opts.output_tokens ?? 20,
    },
  }
}

describe('AnthropicProvider.parse', () => {
  beforeEach(() => {
    fm = installFetchMock()
    llmStats.reset()
  })

  afterEach(() => {
    restoreFetch()
  })

  test('sends output_config.format with the Zod-derived JSON schema', async () => {
    fm.setResponse(textResponse('{"name":"a","age":1}'))
    const provider = new AnthropicProvider('sk-test', 'claude-haiku-4-5-20251001')

    await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'who?' }],
      schema: personSchema,
    })

    const body = fm.requests[0]!.body as {
      output_config: { format: { type: string; schema: Record<string, unknown> } }
      messages: Array<{ role: string; content: unknown }>
      system: string
      tools?: unknown
    }
    expect(body.output_config.format.type).toBe('json_schema')
    expect(body.output_config.format.schema.type).toBe('object')
    expect(body.output_config.format.schema.required).toEqual(['name', 'age'])
    expect(body.output_config.format.schema.additionalProperties).toBe(false)
    expect(body.tools).toBeUndefined() // no tool-use trick anymore
    expect(body.system).toBe('sys')
    expect(body.messages[0]).toEqual({ role: 'user', content: 'who?' })
  })

  test('hits the GA /v1/messages endpoint (not the beta endpoint)', async () => {
    fm.setResponse(textResponse('{"name":"a","age":1}'))
    const provider = new AnthropicProvider('sk-test', 'claude-haiku-4-5-20251001')

    await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'go' }],
      schema: personSchema,
    })

    const url = fm.requests[0]!.url
    expect(url).toContain('/v1/messages')
    expect(url).not.toContain('beta')
  })

  test('returns the validated typed object from parsed_output', async () => {
    fm.setResponse(textResponse('{"name":"alice","age":30}'))
    const provider = new AnthropicProvider('sk-test', 'claude-haiku-4-5-20251001')

    const out = await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'who?' }],
      schema: personSchema,
    })

    expect(out).toEqual({ name: 'alice', age: 30 })
  })

  test('throws when the model returns text that does not match the schema', async () => {
    fm.setResponse(textResponse('{"name":"a","age":"not a number"}'))
    const provider = new AnthropicProvider('sk-test', 'claude-haiku-4-5-20251001')

    await expect(
      provider.parse({
        system: 'sys',
        messages: [{ role: 'user', text: 'go' }],
        schema: personSchema,
      }),
    ).rejects.toThrow()
  })

  test('throws SchemaParseError when there is no parsed output', async () => {
    fm.setResponse({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [], // empty — no text block at all
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const provider = new AnthropicProvider('sk-test', 'claude-haiku-4-5-20251001')

    await expect(
      provider.parse({
        system: 'sys',
        messages: [{ role: 'user', text: 'go' }],
        schema: personSchema,
      }),
    ).rejects.toThrow(SchemaParseError)
  })

  test('records token usage', async () => {
    fm.setResponse(textResponse('{"name":"x","age":1}', { input_tokens: 200, output_tokens: 30 }))
    const provider = new AnthropicProvider('sk-test', 'claude-haiku-4-5-20251001')

    await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'go' }],
      schema: personSchema,
    })

    const stats = llmStats.stats().get('anthropic/claude-haiku-4-5-20251001')!
    expect(stats.calls).toBe(1)
    expect(stats.inputTokens).toBe(200)
    expect(stats.outputTokens).toBe(30)
  })
})
