import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { GeminiProvider } from '../src/gemini.ts'
import { SchemaParseError } from '../src/provider.ts'
import { llmStats } from '../src/stats.ts'
import { type FetchMock, installFetchMock, restoreFetch } from './_fetch-mock.ts'

let fm: FetchMock

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
})

function geminiResponse(text: string, usage = { promptTokenCount: 10, candidatesTokenCount: 5 }) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: usage,
  }
}

describe('GeminiProvider.parse', () => {
  beforeEach(() => {
    fm = installFetchMock()
    llmStats.reset()
  })

  afterEach(() => {
    restoreFetch()
  })

  test('sends responseMimeType + responseSchema with additionalProperties stripped', async () => {
    fm.setResponse(geminiResponse('{"name":"a","age":1}'))
    const provider = new GeminiProvider('test-key', 'gemini-2.5-flash')

    await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'who?' }],
      schema: personSchema,
    })

    const body = fm.requests[0]!.body as {
      generationConfig: { responseMimeType: string; responseSchema: Record<string, unknown> }
      systemInstruction: { parts: Array<{ text: string }> }
      contents: Array<{ role: string; parts: Array<{ text: string }> }>
    }
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    // The @google/genai SDK normalizes schema types to uppercase before sending,
    // but we never include additionalProperties (Gemini rejects it).
    expect(body.generationConfig.responseSchema.additionalProperties).toBeUndefined()
    expect(body.generationConfig.responseSchema.type).toMatch(/^(object|OBJECT)$/)
    expect(body.systemInstruction.parts[0]!.text).toBe('sys')
    expect(body.contents[0]!.parts[0]!.text).toBe('who?')
  })

  test('returns the validated typed object', async () => {
    fm.setResponse(geminiResponse('{"name":"alice","age":30}'))
    const provider = new GeminiProvider('test-key', 'gemini-2.5-flash')

    const out = await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'who?' }],
      schema: personSchema,
    })

    expect(out).toEqual({ name: 'alice', age: 30 })
  })

  test('throws SchemaParseError on schema mismatch', async () => {
    fm.setResponse(geminiResponse('{"name":"x","age":"nope"}'))
    const provider = new GeminiProvider('test-key', 'gemini-2.5-flash')

    await expect(
      provider.parse({
        system: 'sys',
        messages: [{ role: 'user', text: 'go' }],
        schema: personSchema,
      }),
    ).rejects.toThrow(SchemaParseError)
  })

  test('throws SchemaParseError on non-JSON response text', async () => {
    fm.setResponse(geminiResponse('not actually json'))
    const provider = new GeminiProvider('test-key', 'gemini-2.5-flash')

    await expect(
      provider.parse({
        system: 'sys',
        messages: [{ role: 'user', text: 'go' }],
        schema: personSchema,
      }),
    ).rejects.toThrow(SchemaParseError)
  })

  test('records token usage from usageMetadata', async () => {
    fm.setResponse(geminiResponse('{"name":"x","age":1}', { promptTokenCount: 250, candidatesTokenCount: 40 }))
    const provider = new GeminiProvider('test-key', 'gemini-2.5-flash')

    await provider.parse({
      system: 'sys',
      messages: [{ role: 'user', text: 'go' }],
      schema: personSchema,
    })

    const stats = llmStats.stats().get('gemini/gemini-2.5-flash')!
    expect(stats.calls).toBe(1)
    expect(stats.inputTokens).toBe(250)
    expect(stats.outputTokens).toBe(40)
  })
})
