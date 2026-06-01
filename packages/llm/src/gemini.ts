/**
 * Gemini LLM provider for the Clerk agent.
 * Uses the official @google/genai SDK so thought signatures are handled automatically.
 *
 * Key design: we maintain a persistent Chat object per conversation so the SDK
 * preserves thought signatures across the agentic tool-use loop.
 */

import {
  type Chat,
  type Content,
  type FunctionDeclaration,
  GoogleGenAI,
  type Part,
  type Schema,
  Type,
} from '@google/genai'
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

export class GeminiProvider implements LLMProvider {
  private client: GoogleGenAI
  private activeChat: Chat | null = null

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey })
  }

  async chat(opts: ChatOpts): Promise<LLMResponse> {
    const messages = opts.messages

    const lastMsg = messages[messages.length - 1]

    // Within an agentic tool-use loop, the SDK's Chat object preserves
    // thought signatures automatically. We create a new Chat when:
    // - there's no active chat
    // - the last message is a user message (new turn, not tool_results)
    const isNewTurn = lastMsg.role === 'user'
    if (!this.activeChat || isNewTurn) {
      const history = toContents(messages.slice(0, -1), messages)
      this.activeChat = this.client.chats.create({
        model: this.model,
        config: {
          systemInstruction: opts.system,
          tools: [{ functionDeclarations: toFunctionDeclarations(opts.tools) }],
          temperature: 0.3,
        },
        history,
      })
      this.lastSystemPrompt = opts.system
    }

    // Send the last message. For tool_results within the agentic loop,
    // the SDK already has the assistant response in its internal history,
    // so we only send the tool results.
    const parts = messageToParts(lastMsg, messages)
    const inputChars = opts.system.length + JSON.stringify(parts).length
    const t0 = performance.now()

    const response = await this.activeChat.sendMessage({ message: parts })
    const result = this.parseResponse(response)

    const durationMs = performance.now() - t0
    const um = (response as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
      .usageMetadata
    if (um?.promptTokenCount != null && um?.candidatesTokenCount != null) {
      llmStats.recordTokens('gemini', this.model, um.promptTokenCount, um.candidatesTokenCount, durationMs)
    } else {
      const outputChars = result.text.length + JSON.stringify(result.toolCalls).length
      llmStats.record('gemini', this.model, inputChars, outputChars, durationMs)
    }

    return result
  }

  /**
   * Token-streamed chat. Iterates `sendMessageStream` chunks and emits
   * text deltas as they arrive; function calls usually arrive whole as a
   * single part, so we yield them as one `tool-call` event.
   */
  async *chatStream(opts: ChatOpts): AsyncIterable<StreamEvent> {
    const messages = opts.messages
    const lastMsg = messages[messages.length - 1]
    const isNewTurn = lastMsg.role === 'user'
    if (!this.activeChat || isNewTurn) {
      const history = toContents(messages.slice(0, -1), messages)
      this.activeChat = this.client.chats.create({
        model: this.model,
        config: {
          systemInstruction: opts.system,
          tools: [{ functionDeclarations: toFunctionDeclarations(opts.tools) }],
          temperature: 0.3,
        },
        history,
      })
    }

    const parts = messageToParts(lastMsg, messages)
    const inputChars = opts.system.length + JSON.stringify(parts).length
    const t0 = performance.now()

    const stream = await this.activeChat.sendMessageStream({ message: parts })

    let outputText = ''
    let toolCalls = 0
    let inputTokens: number | null = null
    let outputTokens: number | null = null

    for await (const chunk of stream) {
      const candidate = (
        chunk as {
          candidates?: Array<{
            content?: {
              parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }>
            }
          }>
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
        }
      ).candidates?.[0]
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            outputText += part.text
            yield { type: 'text-delta', text: part.text }
          } else if (part.functionCall?.name) {
            toolCalls++
            yield {
              type: 'tool-call',
              call: {
                id: `call_${crypto.randomUUID().slice(0, 8)}`,
                name: part.functionCall.name,
                input: (part.functionCall.args || {}) as Record<string, unknown>,
              },
            }
          }
        }
      }
      const um = (chunk as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
        .usageMetadata
      if (um?.promptTokenCount != null) inputTokens = um.promptTokenCount
      if (um?.candidatesTokenCount != null) outputTokens = um.candidatesTokenCount
    }

    const durationMs = performance.now() - t0
    if (inputTokens != null && outputTokens != null) {
      llmStats.recordTokens('gemini', this.model, inputTokens, outputTokens, durationMs)
    } else {
      llmStats.record('gemini', this.model, inputChars, outputText.length, durationMs)
    }

    yield { type: 'done', wantsToolResults: toolCalls > 0 }
  }

  private parseResponse(response: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> }
    }>
  }): LLMResponse {
    let text = ''
    const toolCalls: ToolCall[] = []

    if (response.candidates?.[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.text) {
          text += part.text
        } else if (part.functionCall) {
          toolCalls.push({
            id: `call_${crypto.randomUUID().slice(0, 8)}`,
            name: part.functionCall.name!,
            input: (part.functionCall.args || {}) as Record<string, unknown>,
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

  /**
   * Schema-enforced structured output via responseMimeType + responseSchema.
   * Bypasses the persistent Chat object since structured-output calls are
   * single-shot and don't need thought-signature continuity.
   */
  async parse<T extends import('zod').z.ZodType>(opts: ParseOptions<T>): Promise<import('zod').z.infer<T>> {
    const responseSchema = toProviderSchema(opts.schema, 'gemini') as unknown as Schema
    const contents = toContents(opts.messages, opts.messages)

    const t0 = performance.now()
    const response = await this.client.models.generateContent({
      model: this.model,
      contents,
      config: {
        systemInstruction: opts.system,
        responseMimeType: 'application/json',
        responseSchema,
        temperature: 0.3,
      },
    })

    const durationMs = performance.now() - t0
    const um = (response as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
      .usageMetadata
    if (um?.promptTokenCount != null && um?.candidatesTokenCount != null) {
      llmStats.recordTokens('gemini', this.model, um.promptTokenCount, um.candidatesTokenCount, durationMs)
    }

    let text = ''
    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if (typeof (part as { text?: string }).text === 'string') text += (part as { text: string }).text
    }

    return validateResponse(opts.schema, text, text)
  }
}

// --- Converters ---

function toFunctionDeclarations(tools: ToolDefinition[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: Type.OBJECT,
      properties: Object.fromEntries(
        Object.entries(t.parameters.properties).map(([k, v]) => [
          k,
          {
            type:
              v.type === 'string'
                ? Type.STRING
                : v.type === 'number'
                  ? Type.NUMBER
                  : v.type === 'integer'
                    ? Type.INTEGER
                    : v.type === 'boolean'
                      ? Type.BOOLEAN
                      : Type.STRING,
            description: v.description,
          },
        ]),
      ),
      required: t.parameters.required,
    },
  }))
}

function messageToParts(msg: ConversationMessage, allMessages: ConversationMessage[]): Part[] {
  if (msg.role === 'user') {
    return [{ text: msg.text || '' }]
  } else if (msg.role === 'assistant') {
    const parts: Part[] = []
    if (msg.text) parts.push({ text: msg.text })
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.input } })
      }
    }
    return parts.length > 0 ? parts : [{ text: '' }]
  } else if (msg.role === 'tool_results') {
    return (msg.toolResults || []).map((tr) => ({
      functionResponse: {
        name: findToolName(allMessages, tr.callId),
        response: { result: tryParseJson(tr.content) },
      },
    }))
  }
  return [{ text: '' }]
}

function toContents(messages: ConversationMessage[], allMessages: ConversationMessage[]): Content[] {
  const contents: Content[] = []

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'model' : 'user' // tool_results go in user turn
    const parts = messageToParts(msg, allMessages)
    if (parts.length > 0) contents.push({ role, parts })
  }

  return contents
}

/** Find the tool name for a given call ID by searching preceding messages. */
function findToolName(messages: ConversationMessage[], callId: string): string {
  for (const msg of messages) {
    if (msg.toolCalls) {
      const tc = msg.toolCalls.find((t) => t.id === callId)
      if (tc) return tc.name
    }
  }
  return 'unknown'
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
