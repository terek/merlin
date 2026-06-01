/**
 * Anthropic LLM provider for the Clerk agent.
 */

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type {
  ChatOpts,
  ConversationMessage,
  LLMProvider,
  LLMResponse,
  ParseOptions,
  StreamEvent,
  ToolDefinition,
} from './provider.ts'
import { SchemaParseError } from './provider.ts'
import { llmStats } from './stats.ts'

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic
  private model: string

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model!
  }

  async chat(opts: ChatOpts): Promise<LLMResponse> {
    const messages = toAnthropicMessages(opts.messages)
    const tools = toAnthropicTools(opts.tools)

    const inputChars = opts.system.length + JSON.stringify(messages).length
    const t0 = performance.now()

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 8192,
        system: opts.system,
        tools,
        messages,
      },
      opts.signal ? { signal: opts.signal } : undefined,
    )

    // Extract text and tool calls
    let text = ''
    const toolCalls: LLMResponse['toolCalls'] = []

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        })
      }
    }

    const durationMs = performance.now() - t0
    const usage = response.usage
    if (usage?.input_tokens != null && usage?.output_tokens != null) {
      llmStats.recordTokens('anthropic', this.model, usage.input_tokens, usage.output_tokens, durationMs)
    } else {
      const outputChars = text.length + JSON.stringify(toolCalls).length
      llmStats.record('anthropic', this.model, inputChars, outputChars, durationMs)
    }

    return {
      text,
      toolCalls,
      wantsToolResults: response.stop_reason === 'tool_use' && toolCalls.length > 0,
    }
  }

  /**
   * Token-streamed chat. Text deltas come through `content_block_delta` /
   * `text_delta`; tool args through `input_json_delta` and are buffered
   * until `content_block_stop`, then emitted as a complete tool-call event.
   */
  async *chatStream(opts: ChatOpts): AsyncIterable<StreamEvent> {
    const messages = toAnthropicMessages(opts.messages)
    const tools = toAnthropicTools(opts.tools)

    const inputChars = opts.system.length + JSON.stringify(messages).length
    const t0 = performance.now()

    const stream = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 8192,
        system: opts.system,
        tools,
        messages,
        stream: true,
      },
      opts.signal ? { signal: opts.signal } : undefined,
    )

    // Per-block scratchpad: tool-use blocks buffer their JSON until stop.
    const blocks = new Map<number, { id: string; name: string; argsJson: string }>()
    let outputText = ''
    let outputToolCalls = 0
    let stopReason: string | null = null
    let inputTokens: number | null = null
    let outputTokens: number | null = null

    for await (const ev of stream) {
      if (ev.type === 'message_start') {
        inputTokens = ev.message.usage?.input_tokens ?? null
      } else if (ev.type === 'content_block_start') {
        if (ev.content_block.type === 'tool_use') {
          blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, argsJson: '' })
        }
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'text_delta') {
          outputText += ev.delta.text
          yield { type: 'text-delta', text: ev.delta.text }
        } else if (ev.delta.type === 'input_json_delta') {
          const block = blocks.get(ev.index)
          if (block) block.argsJson += ev.delta.partial_json
        }
      } else if (ev.type === 'content_block_stop') {
        const block = blocks.get(ev.index)
        if (block) {
          let input: Record<string, unknown> = {}
          try {
            input = block.argsJson ? (JSON.parse(block.argsJson) as Record<string, unknown>) : {}
          } catch {
            // leave empty — model produced invalid JSON, executor will surface the error
          }
          outputToolCalls++
          yield { type: 'tool-call', call: { id: block.id, name: block.name, input } }
          blocks.delete(ev.index)
        }
      } else if (ev.type === 'message_delta') {
        stopReason = ev.delta.stop_reason ?? stopReason
        outputTokens = ev.usage?.output_tokens ?? outputTokens
      }
    }

    const durationMs = performance.now() - t0
    if (inputTokens != null && outputTokens != null) {
      llmStats.recordTokens('anthropic', this.model, inputTokens, outputTokens, durationMs)
    } else {
      llmStats.record('anthropic', this.model, inputChars, outputText.length, durationMs)
    }

    yield { type: 'done', wantsToolResults: stopReason === 'tool_use' && outputToolCalls > 0 }
  }

  /**
   * Schema-enforced structured output via Anthropic's native `output_config.format`.
   * Uses the GA `messages.parse()` with `zodOutputFormat` from the SDK,
   * which sends `output_config.format` to the API and Zod-validates the
   * `parsed_output` for us. (See platform.claude.com/docs/build-with-claude/structured-outputs.)
   */
  async parse<T extends import('zod').z.ZodType>(opts: ParseOptions<T>): Promise<import('zod').z.infer<T>> {
    const messages = toAnthropicMessages(opts.messages)

    const t0 = performance.now()
    const response = await this.client.messages.parse(
      {
        model: this.model,
        max_tokens: 8192,
        system: opts.system,
        messages,
        output_config: { format: zodOutputFormat(opts.schema) },
      },
      opts.signal ? { signal: opts.signal } : undefined,
    )

    const durationMs = performance.now() - t0
    const usage = response.usage
    if (usage?.input_tokens != null && usage?.output_tokens != null) {
      llmStats.recordTokens('anthropic', this.model, usage.input_tokens, usage.output_tokens, durationMs)
    }

    if (!response.parsed_output) {
      const raw = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      throw new SchemaParseError('Anthropic returned no parsed_output', raw)
    }
    return response.parsed_output as import('zod').z.infer<T>
  }
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object' as const,
      properties: t.parameters.properties,
      required: t.parameters.required,
    },
  }))
}

function toAnthropicMessages(messages: ConversationMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.text || '' })
    } else if (msg.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = []
      if (msg.text) content.push({ type: 'text', text: msg.text })
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
        }
      }
      result.push({ role: 'assistant', content })
    } else if (msg.role === 'tool_results') {
      const content: Anthropic.ToolResultBlockParam[] = (msg.toolResults || []).map((tr) => ({
        type: 'tool_result' as const,
        tool_use_id: tr.callId,
        content: tr.content,
      }))
      result.push({ role: 'user', content })
    }
  }

  return result
}
