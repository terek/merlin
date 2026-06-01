/**
 * Shared SSE parser for OpenAI-compatible Chat Completions streams.
 * Used by the OpenAI and Ollama providers (Ollama exposes the same
 * `/v1/chat/completions` schema with `stream: true`).
 *
 * Translates the SSE feed into the provider-agnostic StreamEvent shape:
 * text deltas pass through, tool calls accumulate by index across chunks
 * and are emitted once on stream end, finally a `done` event.
 */

import type { StreamEvent, ToolCall } from './provider.ts'
import { llmStats } from './stats.ts'

interface SseStreamOpts {
  provider: 'openai' | 'ollama'
  model: string
  /** performance.now() at request start, for duration recording. */
  startedAt: number
  /** Used for char-based stat fallback if the API omits token usage. */
  inputCharsFallback: number
}

/**
 * Parse a Chat Completions SSE stream into our StreamEvent feed and
 * record usage stats once on completion.
 */
export async function* parseOpenAISseStream(
  body: ReadableStream<Uint8Array>,
  opts: SseStreamOpts,
): AsyncIterable<StreamEvent> {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  // Tool calls arrive piecemeal: each delta might add to id/name/arguments
  // for a given index. We finalise on stream end (or finish_reason).
  const tcByIndex = new Map<number, { id?: string; name?: string; argsJson: string }>()

  let outputText = ''
  let finishReason: string | null = null
  let inputTokens: number | null = null
  let outputTokens: number | null = null

  const reader = body.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE events are separated by a blank line.
      let eventEnd: number
      // biome-ignore lint/suspicious/noAssignInExpressions: standard SSE buffer drain
      while ((eventEnd = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, eventEnd)
        buffer = buffer.slice(eventEnd + 2)
        const data = extractDataLine(event)
        if (data == null) continue
        if (data === '[DONE]') continue

        let chunk: OpenAIStreamChunk
        try {
          chunk = JSON.parse(data) as OpenAIStreamChunk
        } catch {
          continue
        }

        const choice = chunk.choices?.[0]
        if (choice?.delta?.content) {
          outputText += choice.delta.content
          yield { type: 'text-delta', text: choice.delta.content }
        }
        if (choice?.delta?.tool_calls) {
          for (const td of choice.delta.tool_calls) {
            const idx = td.index ?? 0
            let entry = tcByIndex.get(idx)
            if (!entry) {
              entry = { argsJson: '' }
              tcByIndex.set(idx, entry)
            }
            if (td.id) entry.id = td.id
            if (td.function?.name) entry.name = td.function.name
            if (td.function?.arguments) entry.argsJson += td.function.arguments
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens
          outputTokens = chunk.usage.completion_tokens ?? outputTokens
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Emit assembled tool calls in index order.
  const indices = Array.from(tcByIndex.keys()).sort((a, b) => a - b)
  for (const idx of indices) {
    const entry = tcByIndex.get(idx)!
    if (!entry.name) continue
    let input: Record<string, unknown> = {}
    try {
      input = entry.argsJson ? (JSON.parse(entry.argsJson) as Record<string, unknown>) : {}
    } catch {
      // leave empty — invalid JSON from the model; downstream surfaces it.
    }
    const call: ToolCall = {
      id: entry.id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
      name: entry.name,
      input,
    }
    yield { type: 'tool-call', call }
  }

  const durationMs = performance.now() - opts.startedAt
  if (inputTokens != null && outputTokens != null) {
    llmStats.recordTokens(opts.provider, opts.model, inputTokens, outputTokens, durationMs)
  } else {
    llmStats.record(opts.provider, opts.model, opts.inputCharsFallback, outputText.length, durationMs)
  }

  yield {
    type: 'done',
    wantsToolResults: finishReason === 'tool_calls' && tcByIndex.size > 0,
  }
}

function extractDataLine(event: string): string | null {
  for (const line of event.split('\n')) {
    if (line.startsWith('data:')) return line.slice(5).trimStart()
  }
  return null
}

// Stream chunk shape (OpenAI Chat Completions, also Ollama-compatible).
interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}
