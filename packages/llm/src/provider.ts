/**
 * Provider-agnostic LLM interface.
 * Supports tool use (Anthropic, Gemini, Ollama, OpenAI), token-streamed
 * generation via `chatStream()`, and schema-enforced structured output
 * via `parse()`. The legacy `chat()` aggregates a stream into a single
 * response and is what most non-interactive callers want.
 */

import type { z } from 'zod'

// --- Tool use types ---

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description?: string }>
    required: string[]
  }
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  content: string
}

// --- Response ---

export interface LLMResponse {
  text: string
  toolCalls: ToolCall[]
  /** True if the model wants us to execute tools and continue the loop. */
  wantsToolResults: boolean
}

// --- Streaming events ---

/**
 * Tokens flow as `text-delta` events. Tool calls are buffered server-side
 * and emitted as a single `tool-call` once fully assembled (partial tool
 * args aren't useful since execution needs complete input). The stream
 * always ends with one `done`.
 */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'done'; wantsToolResults: boolean }

// --- Conversation ---

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool_results'
  text?: string
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
}

// --- Structured output ---

export interface ParseOptions<T extends z.ZodType> {
  system: string
  messages: ConversationMessage[]
  /** Zod schema to enforce on the response. Must describe an object at the top level. */
  schema: T
  /**
   * Name passed to providers that need one (Anthropic tool name, OpenAI
   * json_schema name). Must match `^[a-zA-Z0-9_-]+$`. Default: 'output'.
   */
  schemaName?: string
  signal?: AbortSignal
}

/** Thrown when the provider returned text that didn't satisfy the schema. */
export class SchemaParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'SchemaParseError'
  }
}

// --- Provider interface ---

export interface ChatOpts {
  system: string
  tools: ToolDefinition[]
  messages: ConversationMessage[]
  signal?: AbortSignal
}

export interface LLMProvider {
  /** Non-streaming chat — one round-trip, full response. */
  chat(opts: ChatOpts): Promise<LLMResponse>

  /**
   * Token-streamed chat. Yields `text-delta` events as text arrives and
   * `tool-call` events once each tool call is fully assembled, then a
   * single `done` event. Aborting `signal` cancels the underlying request
   * and ends the stream.
   */
  chatStream(opts: ChatOpts): AsyncIterable<StreamEvent>

  /**
   * Schema-enforced structured output. The provider uses its native
   * structured-output mechanism (tool-use enforcement, response_format,
   * responseSchema, etc.) and the result is Zod-validated before returning.
   *
   * Throws SchemaParseError if the response is non-JSON or fails validation.
   */
  parse<T extends z.ZodType>(opts: ParseOptions<T>): Promise<z.infer<T>>
}

// --- Stream → response aggregation ---

/** Default `chat()` implementation: drain `chatStream()` into an `LLMResponse`. */
export async function aggregateStream(stream: AsyncIterable<StreamEvent>): Promise<LLMResponse> {
  let text = ''
  const toolCalls: ToolCall[] = []
  let wantsToolResults = false
  for await (const ev of stream) {
    if (ev.type === 'text-delta') text += ev.text
    else if (ev.type === 'tool-call') toolCalls.push(ev.call)
    else if (ev.type === 'done') wantsToolResults = ev.wantsToolResults
  }
  return { text, toolCalls, wantsToolResults }
}
