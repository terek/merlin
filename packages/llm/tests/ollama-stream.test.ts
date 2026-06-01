/**
 * Streaming-path tests for OllamaProvider.chatStream.
 * Ollama exposes an OpenAI-compatible SSE endpoint, so the underlying
 * parser is shared with OpenAIProvider — these tests focus on the wire
 * shape Ollama sees (URL, body, headers) and do one end-to-end smoke.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OllamaProvider } from '../src/ollama.ts'
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

describe('OllamaProvider.chatStream', () => {
  beforeEach(() => {
    fm = installFetchMock()
    llmStats.reset()
  })

  afterEach(() => {
    restoreFetch()
  })

  test('hits /v1/chat/completions with stream:true and yields text + done', async () => {
    fm.setSseResponse([
      dataLine({ choices: [{ delta: { content: 'hi' } }] }),
      dataLine({ choices: [{ delta: { content: ' there' } }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]',
    ])
    const provider = new OllamaProvider('qwen3:8b')

    const events = await collect(
      provider.chatStream({ system: 'sys', tools: [], messages: [{ role: 'user', text: 'hello' }] }),
    )

    expect(fm.requests[0]!.url).toContain('/v1/chat/completions')
    const body = fm.requests[0]!.body as { model: string; stream: boolean }
    expect(body.model).toBe('qwen3:8b')
    expect(body.stream).toBe(true)

    const deltas = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)
    expect(deltas).toEqual(['hi', ' there'])
    expect(events.at(-1)).toEqual({ type: 'done', wantsToolResults: false })
  })

  test('respects OLLAMA_BASE_URL override on the constructor', async () => {
    fm.setSseResponse([
      dataLine({ choices: [{ delta: { content: 'ok' } }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]',
    ])
    const provider = new OllamaProvider('qwen3:8b', 'http://elsewhere:9999')

    await collect(provider.chatStream({ system: 'sys', tools: [], messages: [{ role: 'user', text: 'go' }] }))

    expect(fm.requests[0]!.url).toBe('http://elsewhere:9999/v1/chat/completions')
  })
})
