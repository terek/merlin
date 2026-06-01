/**
 * Provider-agnostic embedding interface.
 *
 * Implementations transform an array of texts into an array of dense
 * float vectors. Pricing differs (no output tokens), so usage is reported
 * via llmStats.recordTokens(provider, model, inputTokens, 0, durationMs).
 */

export interface EmbeddingResult {
  /** One vector per input text, same order. */
  vectors: number[][]
  /** Resolved model identifier (may differ from request, e.g. dated alias). */
  model: string
  /** Vector dimensionality (same for every entry in `vectors`). */
  dim: number
}

/**
 * Asymmetric retrieval modes.
 * - `RETRIEVAL_DOCUMENT`: embedding will be stored and retrieved against later.
 * - `RETRIEVAL_QUERY`:    embedding represents the live search query.
 *
 * Providers that don't support asymmetric task types (e.g. OpenAI) ignore this.
 */
export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' | 'SEMANTIC_SIMILARITY'

export interface EmbedOptions {
  signal?: AbortSignal
  /** Asymmetric retrieval hint. Ignored by providers without task-type support. */
  taskType?: EmbeddingTaskType
}

export interface EmbeddingProvider {
  /** Embed a batch of texts. Implementations may chunk internally for API limits. */
  embed(texts: string[], opts?: EmbedOptions): Promise<EmbeddingResult>
}
