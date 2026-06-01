import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { OpenAIProvider } from '../src/openai.ts'
import { SchemaParseError } from '../src/provider.ts'
import { llmStats } from '../src/stats.ts'

// ---------------------------------------------------------------------------
// Fake fetch — intercepts OpenAI API calls
// ---------------------------------------------------------------------------

let interceptedRequests: Array<{ url: string; body: any; headers: any }> = []
let nextResponse: any = {}

const originalFetch = globalThis.fetch

function installFetch() {
  interceptedRequests = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : null
    interceptedRequests.push({ url: url.toString(), body, headers: init?.headers })
    return new Response(JSON.stringify(nextResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as any
}

function restoreFetch() {
  globalThis.fetch = originalFetch
}

function setResponse(resp: any) {
  nextResponse = resp
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  return {
    choices: [{ message: { content: text } }],
    usage,
  }
}

function toolCallResponse(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: calls.map((c) => ({
            id: c.id,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAIProvider', () => {
  beforeEach(() => {
    installFetch()
    llmStats.reset()
  })

  afterEach(() => {
    restoreFetch()
  })

  test('sends correct request structure', async () => {
    setResponse(textResponse('Hello!'))
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1-mini')

    await provider.chat({
      system: 'You are helpful.',
      tools: [],
      messages: [{ role: 'user', text: 'Hi' }],
    })

    expect(interceptedRequests).toHaveLength(1)
    const req = interceptedRequests[0]!
    expect(req.url).toContain('/v1/chat/completions')
    expect(req.headers.Authorization).toBe('Bearer sk-test')
    expect(req.body.model).toBe('gpt-4.1-mini')
    expect(req.body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' })
    expect(req.body.messages[1]).toEqual({ role: 'user', content: 'Hi' })
  })

  test('parses text response', async () => {
    setResponse(textResponse('The answer is 42.'))
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1-mini')

    const result = await provider.chat({
      system: 'sys',
      tools: [],
      messages: [{ role: 'user', text: 'question' }],
    })

    expect(result.text).toBe('The answer is 42.')
    expect(result.toolCalls).toHaveLength(0)
    expect(result.wantsToolResults).toBe(false)
  })

  test('parses tool call response', async () => {
    setResponse(
      toolCallResponse([
        { id: 'call_1', name: 'search', args: { query: 'test' } },
        { id: 'call_2', name: 'read', args: { path: '/tmp/x' } },
      ]),
    )
    const provider = new OpenAIProvider('sk-test', 'gpt-5')

    const result = await provider.chat({
      system: 'sys',
      tools: [
        {
          name: 'search',
          description: 'search',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
        {
          name: 'read',
          description: 'read',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
      messages: [{ role: 'user', text: 'find it' }],
    })

    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0]!.id).toBe('call_1')
    expect(result.toolCalls[0]!.name).toBe('search')
    expect(result.toolCalls[0]!.input).toEqual({ query: 'test' })
    expect(result.toolCalls[1]!.name).toBe('read')
    expect(result.wantsToolResults).toBe(true)
  })

  test('sends tools in request when provided', async () => {
    setResponse(textResponse('ok'))
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1')

    await provider.chat({
      system: 'sys',
      tools: [
        {
          name: 'foo',
          description: 'does foo',
          parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        },
      ],
      messages: [{ role: 'user', text: 'go' }],
    })

    const body = interceptedRequests[0]!.body
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].type).toBe('function')
    expect(body.tools[0].function.name).toBe('foo')
  })

  test('omits tools when empty', async () => {
    setResponse(textResponse('ok'))
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1')

    await provider.chat({
      system: 'sys',
      tools: [],
      messages: [{ role: 'user', text: 'go' }],
    })

    expect(interceptedRequests[0]!.body.tools).toBeUndefined()
  })

  test('converts multi-turn conversation', async () => {
    setResponse(textResponse('final'))
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1')

    await provider.chat({
      system: 'sys',
      tools: [],
      messages: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi there' },
        { role: 'user', text: 'followup' },
      ],
    })

    const msgs = interceptedRequests[0]!.body.messages
    expect(msgs).toHaveLength(4) // system + 3 conversation
    expect(msgs[1]).toEqual({ role: 'user', content: 'hello' })
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'hi there' })
    expect(msgs[3]).toEqual({ role: 'user', content: 'followup' })
  })

  test('converts tool_results to tool role messages', async () => {
    setResponse(textResponse('done'))
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1')

    await provider.chat({
      system: 'sys',
      tools: [],
      messages: [
        { role: 'user', text: 'go' },
        { role: 'assistant', toolCalls: [{ id: 'c1', name: 'search', input: { q: 'x' } }] },
        { role: 'tool_results', toolResults: [{ callId: 'c1', content: 'found it' }] },
      ],
    })

    const msgs = interceptedRequests[0]!.body.messages
    // assistant with tool_calls
    expect(msgs[2].role).toBe('assistant')
    expect(msgs[2].tool_calls[0].id).toBe('c1')
    // tool result
    expect(msgs[3].role).toBe('tool')
    expect(msgs[3].tool_call_id).toBe('c1')
    expect(msgs[3].content).toBe('found it')
  })

  test('records exact token usage from API response', async () => {
    setResponse(textResponse('result', { prompt_tokens: 150, completion_tokens: 42 }))
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1-mini')

    await provider.chat({
      system: 'sys',
      tools: [],
      messages: [{ role: 'user', text: 'go' }],
    })

    const stats = llmStats.stats()
    const entry = stats.get('openai/gpt-4.1-mini')!
    expect(entry.calls).toBe(1)
    expect(entry.inputTokens).toBe(150)
    expect(entry.outputTokens).toBe(42)
  })

  test('falls back to char estimation when no usage in response', async () => {
    setResponse({ choices: [{ message: { content: 'hi' } }] }) // no usage field
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1-mini')

    await provider.chat({
      system: 'sys',
      tools: [],
      messages: [{ role: 'user', text: 'go' }],
    })

    const stats = llmStats.stats()
    const entry = stats.get('openai/gpt-4.1-mini')!
    expect(entry.calls).toBe(1)
    expect(entry.inputTokens).toBeGreaterThan(0)
  })

  test('uses custom base URL', async () => {
    setResponse(textResponse('ok'))
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1', 'https://my-proxy.example.com')

    await provider.chat({
      system: 'sys',
      tools: [],
      messages: [{ role: 'user', text: 'go' }],
    })

    expect(interceptedRequests[0]!.url).toBe('https://my-proxy.example.com/v1/chat/completions')
  })
})

// ---------------------------------------------------------------------------
// parse() — schema-enforced structured output via response_format json_schema
// ---------------------------------------------------------------------------

describe('OpenAIProvider.parse', () => {
  beforeEach(() => {
    installFetch()
    llmStats.reset()
  })

  afterEach(() => {
    restoreFetch()
  })

  const personSchema = z.object({
    name: z.string(),
    age: z.number(),
    tags: z.array(z.string()).optional(),
  })

  test('sends response_format json_schema with the cleaned Zod schema', async () => {
    setResponse({ choices: [{ message: { content: '{"name":"a","age":1}' } }] })
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1')

    await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'who?' }],
      schema: personSchema,
      schemaName: 'person',
    })

    const body = interceptedRequests[0]!.body
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema.name).toBe('person')
    const schema = body.response_format.json_schema.schema
    expect(schema.$schema).toBeUndefined()
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['name', 'age'])
  })

  test('returns the validated typed object', async () => {
    setResponse({ choices: [{ message: { content: '{"name":"alice","age":30,"tags":["a","b"]}' } }] })
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1')

    const out = await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'who?' }],
      schema: personSchema,
    })

    expect(out).toEqual({ name: 'alice', age: 30, tags: ['a', 'b'] })
  })

  test('defaults schemaName to "output"', async () => {
    setResponse({ choices: [{ message: { content: '{"name":"x","age":1}' } }] })
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1')

    await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'go' }],
      schema: personSchema,
    })

    expect(interceptedRequests[0]!.body.response_format.json_schema.name).toBe('output')
  })

  test('throws SchemaParseError on schema mismatch', async () => {
    setResponse({ choices: [{ message: { content: '{"name":"x","age":"not a number"}' } }] })
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1')

    await expect(
      provider.parse({
        system: 'sys',
        messages: [{ role: 'user', text: 'go' }],
        schema: personSchema,
      }),
    ).rejects.toThrow(SchemaParseError)
  })

  test('throws SchemaParseError on non-JSON response', async () => {
    setResponse({ choices: [{ message: { content: 'not actually json' } }] })
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1')

    await expect(
      provider.parse({
        system: 'sys',
        messages: [{ role: 'user', text: 'go' }],
        schema: personSchema,
      }),
    ).rejects.toThrow(SchemaParseError)
  })

  test('records token usage', async () => {
    setResponse({
      choices: [{ message: { content: '{"name":"x","age":1}' } }],
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    })
    const provider = new OpenAIProvider('sk-test', 'gpt-4.1-mini')

    await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'go' }],
      schema: personSchema,
    })

    const stats = llmStats.stats().get('openai/gpt-4.1-mini')!
    expect(stats.calls).toBe(1)
    expect(stats.inputTokens).toBe(80)
    expect(stats.outputTokens).toBe(20)
  })
})
