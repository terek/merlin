/**
 * Streaming-path tests for GeminiProvider.chatStream.
 * The @google/genai SDK uses fetch internally and parses the response as
 * SSE (`?alt=sse` query param), so the same fetch-mock can serve a
 * stream of `data: <GenerateContentResponse JSON>` events.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GeminiProvider } from '../src/gemini.ts'
import type { StreamEvent } from '../src/provider.ts'
import { llmStats } from '../src/stats.ts'
import { type FetchMock, installFetchMock, restoreFetch } from './_fetch-mock.ts'

let fm: FetchMock

function dataLine(payload: object): string {
  return `data: ${JSON.stringify(payload)}`
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

describe('GeminiProvider.chatStream', () => {
  beforeEach(() => {
    fm = installFetchMock()
    llmStats.reset()
  })

  afterEach(() => {
    restoreFetch()
  })

  test('emits text deltas as parts arrive and a single done', async () => {
    fm.setSseResponse([
      dataLine({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }],
        usageMetadata: { promptTokenCount: 9 },
      }),
      dataLine({
        candidates: [{ content: { role: 'model', parts: [{ text: 'lo.' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
      }),
    ])
    const provider = new GeminiProvider('gem-test', 'gemini-2.5-flash')

    const events = await collect(
      provider.chatStream({ system: 'sys', tools: [], messages: [{ role: 'user', text: 'hi' }] }),
    )

    const deltas = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)
    expect(deltas).toEqual(['Hel', 'lo.'])
    expect(events.at(-1)).toEqual({ type: 'done', wantsToolResults: false })

    // The Gemini SDK appends `?alt=sse` to the URL on streaming requests.
    expect(fm.requests[0]!.url).toContain('alt=sse')
  })

  test('emits a function call as a single tool-call event with wantsToolResults', async () => {
    fm.setSseResponse([
      dataLine({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'search', args: { q: 'auth' } } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5 },
      }),
    ])
    const provider = new GeminiProvider('gem-test', 'gemini-2.5-flash')

    const events = await collect(
      provider.chatStream({
        system: 'sys',
        tools: [
          {
            name: 'search',
            description: 'search',
            parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
          },
        ],
        messages: [{ role: 'user', text: 'find auth' }],
      }),
    )

    const calls = events.filter((e) => e.type === 'tool-call')
    expect(calls).toHaveLength(1)
    expect((calls[0] as { call: { name: string; input: Record<string, unknown> } }).call).toMatchObject({
      name: 'search',
      input: { q: 'auth' },
    })
    expect(events.at(-1)).toEqual({ type: 'done', wantsToolResults: true })
  })
})
