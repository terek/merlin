/**
 * @merlin/llm -- provider-agnostic LLM interface, implementations, and usage tracking.
 */

// --- Interface & types ---

export type {
  ChatOpts,
  ConversationMessage,
  LLMProvider,
  LLMResponse,
  ParseOptions,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from './provider.ts'
export { aggregateStream, SchemaParseError } from './provider.ts'

// --- Schema utilities (for tests, custom providers) ---

export { type JsonSchemaDialect, toProviderSchema, validateResponse } from './schema-utils.ts'

// --- Embeddings ---

export type { EmbeddingProvider, EmbeddingResult, EmbeddingTaskType, EmbedOptions } from './embedding.ts'
export { GeminiEmbeddingProvider } from './gemini-embedding.ts'
export { OpenAIEmbeddingProvider } from './openai-embedding.ts'

// --- Provider implementations ---

export { AnthropicProvider } from './anthropic.ts'
export { GeminiProvider } from './gemini.ts'
export { OllamaProvider } from './ollama.ts'
export { OpenAIProvider } from './openai.ts'

// --- Usage tracking ---

export type { ModelStats } from './stats.ts'
export { llmStats } from './stats.ts'
