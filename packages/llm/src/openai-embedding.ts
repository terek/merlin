/**
 * OpenAI embeddings via the /v1/embeddings REST endpoint.
 *
 * Models: text-embedding-3-small (1536), text-embedding-3-large (3072),
 *         text-embedding-ada-002 (1536, legacy).
 */

import type { EmbeddingProvider, EmbeddingResult, EmbedOptions } from './embedding.ts'
import { llmStats } from './stats.ts'

const MAX_BATCH = 2048

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string
  private model: string
  private baseUrl: string

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.apiKey = apiKey
    this.model = model
    this.baseUrl = baseUrl || 'https://api.openai.com'
  }

  async embed(texts: string[], opts?: EmbedOptions): Promise<EmbeddingResult> {
    // OpenAI embeddings don't have an asymmetric task-type API; opts.taskType is ignored.
    if (texts.length === 0) return { vectors: [], model: this.model, dim: 0 }

    const vectors: number[][] = new Array(texts.length)
    let resolvedModel = this.model
    let dim = 0

    for (let start = 0; start < texts.length; start += MAX_BATCH) {
      const chunk = texts.slice(start, start + MAX_BATCH)
      const body = JSON.stringify({ model: this.model, input: chunk })
      const t0 = performance.now()

      const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: opts?.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`OpenAI embeddings error ${response.status}: ${text}`)
      }

      const json = (await response.json()) as OpenAIEmbeddingResponse
      const durationMs = performance.now() - t0

      if (json.model) resolvedModel = json.model

      const data = json.data || []
      for (const entry of data) {
        if (typeof entry.index !== 'number' || !entry.embedding) continue
        vectors[start + entry.index] = entry.embedding
        if (entry.embedding.length > dim) dim = entry.embedding.length
      }

      const tokens = json.usage?.prompt_tokens
      if (tokens != null) {
        llmStats.recordTokens('openai', resolvedModel, tokens, 0, durationMs)
      } else {
        const inputChars = chunk.reduce((sum, t) => sum + t.length, 0)
        llmStats.record('openai', resolvedModel, inputChars, 0, durationMs)
      }
    }

    return { vectors, model: resolvedModel, dim }
  }
}

interface OpenAIEmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>
  model?: string
  usage?: { prompt_tokens?: number; total_tokens?: number }
}
