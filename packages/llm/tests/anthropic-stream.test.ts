/**
 * Streaming-path tests for AnthropicProvider.chatStream.
 * The Anthropic SDK uses fetch internally, so the same fetch-mock that
 * covers the non-streaming path can serve an SSE body for it to parse.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { AnthropicProvider } from '../src/anthropic.ts'
import type { StreamEvent } from '../src/provider.ts'
import { llmStats } from '../src/stats.ts'
import { type FetchMock, installFetchMock, restoreFetch } from './_fetch-mock.ts'

let fm: FetchMock

function sseEvent(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}`
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

describe('AnthropicProvider.chatStream', () => {
  beforeEach(() => {
    fm = installFetchMock()
    llmStats.reset()
  })

  afterEach(() => {
    restoreFetch()
  })

  test('emits text deltas in order and a single done event', async () => {
    fm.setSseResponse([
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      }),
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      }),
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'lo.' },
      }),
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 8 },
      }),
      sseEvent('message_stop', { type: 'message_stop' }),
    ])
    const provider = new AnthropicProvider('sk-test', 'claude-haiku-4-5-20251001')

    const events = await collect(
      provider.chatStream({ system: 'sys', tools: [], messages: [{ role: 'user', text: 'hi' }] }),
    )

    const deltas = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)
    expect(deltas).toEqual(['Hel', 'lo.'])
    expect(events.at(-1)).toEqual({ type: 'done', wantsToolResults: false })

    const body = fm.requests[0]!.body as { stream: boolean }
    expect(body.stream).toBe(true)
  })

  test('buffers input_json_delta until content_block_stop and emits one tool-call', async () => {
    fm.setSseResponse([
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      }),
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_42', name: 'search', input: {} },
      }),
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":"' },
      }),
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'auth"}' },
      }),
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 7 },
      }),
      sseEvent('message_stop', { type: 'message_stop' }),
    ])
    const provider = new AnthropicProvider('sk-test', 'claude-haiku-4-5-20251001')

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
    expect(calls[0]).toEqual({
      type: 'tool-call',
      call: { id: 'toolu_42', name: 'search', input: { q: 'auth' } },
    })
    expect(events.at(-1)).toEqual({ type: 'done', wantsToolResults: true })
  })
})
