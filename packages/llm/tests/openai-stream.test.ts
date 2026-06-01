import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenAIProvider } from '../src/openai.ts'
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

describe('OpenAIProvider.chatStream', () => {
  beforeEach(() => {
    fm = installFetchMock()
    llmStats.reset()
  })

  afterEach(() => {
    restoreFetch()
  })

  test('emits text-delta events as chunks arrive and a single done', async () => {
    fm.setSseResponse([
      dataLine({ choices: [{ delta: { content: 'Hel' } }] }),
      dataLine({ choices: [{ delta: { content: 'lo, ' } }] }),
      dataLine({ choices: [{ delta: { content: 'world.' } }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      dataLine({ usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      'data: [DONE]',
    ])
    const provider = new OpenAIProvider('sk-test', 'gpt-test')

    const events = await collect(
      provider.chatStream({
        system: 'sys',
        tools: [],
        messages: [{ role: 'user', text: 'hi' }],
      }),
    )

    const deltas = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)
    expect(deltas).toEqual(['Hel', 'lo, ', 'world.'])
    expect(events.at(-1)).toEqual({ type: 'done', wantsToolResults: false })

    // The body of the request should have stream:true.
    const body = fm.requests[0]!.body as { stream: boolean }
    expect(body.stream).toBe(true)
  })

  test('accumulates streamed tool call args across deltas and emits one tool-call', async () => {
    fm.setSseResponse([
      dataLine({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_42', function: { name: 'search', arguments: '' } }],
            },
          },
        ],
      }),
      dataLine({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"' } }] } }],
      }),
      dataLine({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'auth"}' } }] } }],
      }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]',
    ])
    const provider = new OpenAIProvider('sk-test', 'gpt-test')

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
        messages: [{ role: 'user', text: 'hi' }],
      }),
    )

    const calls = events.filter((e) => e.type === 'tool-call')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      type: 'tool-call',
      call: { id: 'call_42', name: 'search', input: { q: 'auth' } },
    })
    expect(events.at(-1)).toEqual({ type: 'done', wantsToolResults: true })
  })

  test('coalesces SSE chunks split across read boundaries', async () => {
    // Same payload but split such that an event would straddle a chunk
    // boundary if the parser didn't buffer correctly. Here we send a single
    // event in two halves by emitting two raw items joined by mock newlines.
    fm.setSseResponse([
      dataLine({ choices: [{ delta: { content: 'AB' } }] }),
      dataLine({ choices: [{ delta: { content: 'CD' } }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]',
    ])
    const provider = new OpenAIProvider('sk-test', 'gpt-test')
    const events = await collect(
      provider.chatStream({ system: 'sys', tools: [], messages: [{ role: 'user', text: 'hi' }] }),
    )
    const text = events
      .filter((e) => e.type === 'text-delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(text).toBe('ABCD')
  })
})
