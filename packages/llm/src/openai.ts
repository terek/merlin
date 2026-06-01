/**
 * OpenAI LLM provider — uses the OpenAI Chat Completions API.
 *
 * Usage:
 *   PROCESSOR_MODEL=gpt-4.1-mini OPENAI_PROCESSOR_API_KEY=sk-...
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

export class OpenAIProvider implements LLMProvider {
  private apiKey: string
  private model: string
  private baseUrl: string

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.apiKey = apiKey
    this.model = model
    this.baseUrl = baseUrl || 'https://api.openai.com'
  }

  async chat(opts: ChatOpts): Promise<LLMResponse> {
    const messages = toOpenAIMessages(opts.system, opts.messages)
    const tools = opts.tools.length > 0 ? toOpenAITools(opts.tools) : undefined

    const body = JSON.stringify({ model: this.model, messages, tools })
    const t0 = performance.now()

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
      signal: opts.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OpenAI error ${response.status}: ${text}`)
    }

    const json = (await response.json()) as OpenAIChatResponse
    const result = parseResponse(json)

    const durationMs = performance.now() - t0
    const usage = json.usage
    if (usage?.prompt_tokens != null && usage?.completion_tokens != null) {
      llmStats.recordTokens('openai', this.model, usage.prompt_tokens, usage.completion_tokens, durationMs)
    } else {
      const outputChars = result.text.length + JSON.stringify(result.toolCalls).length
      llmStats.record('openai', this.model, body.length, outputChars, durationMs)
    }

    return result
  }

  /**
   * Token-streamed chat. Uses Chat Completions with `stream: true` and
   * parses the resulting SSE feed. Tool calls arrive piecemeal — keyed by
   * `index`, with `function.arguments` streamed character-by-character —
   * and are emitted as a single `tool-call` once the stream ends.
   */
  async *chatStream(opts: ChatOpts): AsyncIterable<StreamEvent> {
    const messages = toOpenAIMessages(opts.system, opts.messages)
    const tools = opts.tools.length > 0 ? toOpenAITools(opts.tools) : undefined

    const body = JSON.stringify({
      model: this.model,
      messages,
      tools,
      stream: true,
      stream_options: { include_usage: true },
    })
    const t0 = performance.now()

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
      signal: opts.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OpenAI error ${response.status}: ${text}`)
    }
    if (!response.body) throw new Error('OpenAI stream returned no body')

    yield* parseOpenAISseStream(response.body, {
      provider: 'openai',
      model: this.model,
      startedAt: t0,
      inputCharsFallback: body.length,
    })
  }

  /**
   * Schema-enforced structured output via response_format: json_schema.
   * Returns the validated typed object.
   */
  async parse<T extends import('zod').z.ZodType>(opts: ParseOptions<T>): Promise<import('zod').z.infer<T>> {
    const name = opts.schemaName ?? 'output'
    const schema = toProviderSchema(opts.schema, 'openai')
    const messages = toOpenAIMessages(opts.system, opts.messages)

    const body = JSON.stringify({
      model: this.model,
      messages,
      response_format: { type: 'json_schema', json_schema: { name, schema } },
    })
    const t0 = performance.now()

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
      signal: opts.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OpenAI error ${response.status}: ${text}`)
    }

    const json = (await response.json()) as OpenAIChatResponse
    const text = json.choices?.[0]?.message?.content ?? ''

    const durationMs = performance.now() - t0
    const usage = json.usage
    if (usage?.prompt_tokens != null && usage?.completion_tokens != null) {
      llmStats.recordTokens('openai', this.model, usage.prompt_tokens, usage.completion_tokens, durationMs)
    } else {
      llmStats.record('openai', this.model, body.length, text.length, durationMs)
    }

    return validateResponse(opts.schema, text, text)
  }
}

// --- Types ---

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string
      tool_calls?: Array<{
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

// --- Converters ---

function toOpenAIMessages(system: string, messages: ConversationMessage[]): Array<Record<string, unknown>> {
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

function toOpenAITools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
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

function parseResponse(json: OpenAIChatResponse): LLMResponse {
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
