/**
 * Ollama LLM provider — uses the OpenAI-compatible API at localhost:11434/v1.
 * Supports tool use for the agent and plain completion for the summarizer.
 * Good for local dev/testing without burning cloud API credits.
 *
 * Usage:
 *   CLERK_MODEL=ollama:qwen3:8b        → Ollama agent with qwen3:8b
 *   PROCESSOR_MODEL=ollama:qwen3:8b  → Ollama summarizer
 *
 * Set OLLAMA_BASE_URL to override the default http://localhost:11434.
 */

import { parseOpenAISseStream } from './openai-stream.ts'
import type {
  ChatOpts,
  ConversationMessage,
  LLMProvider,
  LLMResponse,
  ParseOptions,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from './provider.ts'
import { toProviderSchema, validateResponse } from './schema-utils.ts'
import { llmStats } from './stats.ts'

export class OllamaProvider implements LLMProvider {
  private baseUrl: string
  private model: string

  constructor(model: string, baseUrl?: string) {
    this.model = model
    this.baseUrl = baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
  }

  async chat(opts: ChatOpts): Promise<LLMResponse> {
    const messages = toOllamaMessages(opts.system, opts.messages)
    const tools = opts.tools.length > 0 ? toOllamaTools(opts.tools) : undefined

    const body = JSON.stringify({ model: this.model, messages, tools, temperature: 0.3 })
    const t0 = performance.now()

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: opts.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Ollama error ${response.status}: ${text}`)
    }

    const json = (await response.json()) as OllamaChatResponse
    const result = parseResponse(json)

    const durationMs = performance.now() - t0
    const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    if (usage?.prompt_tokens != null && usage?.completion_tokens != null) {
      llmStats.recordTokens('ollama', this.model, usage.prompt_tokens, usage.completion_tokens, durationMs)
    } else {
      const outputChars = result.text.length + JSON.stringify(result.toolCalls).length
      llmStats.record('ollama', this.model, body.length, outputChars, durationMs)
    }

    return result
  }

  /**
   * Token-streamed chat. Same SSE format as OpenAI Chat Completions —
   * Ollama exposes an OpenAI-compatible endpoint at /v1/chat/completions.
   */
  async *chatStream(opts: ChatOpts): AsyncIterable<StreamEvent> {
    const messages = toOllamaMessages(opts.system, opts.messages)
    const tools = opts.tools.length > 0 ? toOllamaTools(opts.tools) : undefined

    const body = JSON.stringify({
      model: this.model,
      messages,
      tools,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.3,
    })
    const t0 = performance.now()

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: opts.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Ollama error ${response.status}: ${text}`)
    }
    if (!response.body) throw new Error('Ollama stream returned no body')

    yield* parseOpenAISseStream(response.body, {
      provider: 'ollama',
      model: this.model,
      startedAt: t0,
      inputCharsFallback: body.length,
    })
  }

  /** Simple completion (no tools) — used by the summarizer. */
  async complete(system: string, content: string): Promise<string> {
    const inputChars = system.length + content.length
    const t0 = performance.now()

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
        temperature: 0.2,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Ollama error ${response.status}: ${text}`)
    }

    const json = (await response.json()) as OllamaChatResponse
    const text = json.choices?.[0]?.message?.content || ''

    const durationMs = performance.now() - t0
    const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    if (usage?.prompt_tokens != null && usage?.completion_tokens != null) {
      llmStats.recordTokens('ollama', this.model, usage.prompt_tokens, usage.completion_tokens, durationMs)
    } else {
      llmStats.record('ollama', this.model, inputChars, text.length, durationMs)
    }

    return text
  }

  /**
   * Schema-enforced structured output via the `format` option (Ollama-native
   * JSON-schema enforcement, supported by all current Ollama models).
   */
  async parse<T extends import('zod').z.ZodType>(opts: ParseOptions<T>): Promise<import('zod').z.infer<T>> {
    const schema = toProviderSchema(opts.schema, 'ollama')
    const messages = toOllamaMessages(opts.system, opts.messages)

    const body = JSON.stringify({
      model: this.model,
      messages,
      format: schema,
      temperature: 0.2,
    })
    const t0 = performance.now()

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: opts.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Ollama error ${response.status}: ${text}`)
    }

    const json = (await response.json()) as OllamaChatResponse
    const text = json.choices?.[0]?.message?.content ?? ''

    const durationMs = performance.now() - t0
    const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    if (usage?.prompt_tokens != null && usage?.completion_tokens != null) {
      llmStats.recordTokens('ollama', this.model, usage.prompt_tokens, usage.completion_tokens, durationMs)
    } else {
      llmStats.record('ollama', this.model, body.length, text.length, durationMs)
    }

    return validateResponse(opts.schema, text, text)
  }
}

// --- Types ---

interface OllamaChatResponse {
  choices?: Array<{
    message?: {
      content?: string
      tool_calls?: Array<{
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
}

// --- Converters ---

function toOllamaMessages(system: string, messages: ConversationMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [{ role: 'system', content: system }]

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.text || '' })
    } else if (msg.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant' }
      if (msg.text) entry.content = msg.text
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }))
      }
      if (!entry.content && !entry.tool_calls) entry.content = ''
      result.push(entry)
    } else if (msg.role === 'tool_results') {
      for (const tr of msg.toolResults || []) {
        result.push({
          role: 'tool',
          tool_call_id: tr.callId,
          content: tr.content,
        })
      }
    }
  }

  return result
}

function toOllamaTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: t.parameters.properties,
        required: t.parameters.required,
      },
    },
  }))
}

function parseResponse(json: OllamaChatResponse): LLMResponse {
  const choice = json.choices?.[0]?.message
  const text = choice?.content || ''
  const toolCalls: ToolCall[] = []

  if (choice?.tool_calls) {
    for (const tc of choice.tool_calls) {
      if (tc.function?.name) {
        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse(tc.function.arguments || '{}')
        } catch {
          /* empty */
        }
        toolCalls.push({
          id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
          name: tc.function.name,
          input,
        })
      }
    }
  }

  return {
    text,
    toolCalls,
    wantsToolResults: toolCalls.length > 0,
  }
}
