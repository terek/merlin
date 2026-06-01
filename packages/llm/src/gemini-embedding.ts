/**
 * Gemini embeddings via the @google/genai SDK.
 *
 * Models: gemini-embedding-001, gemini-embedding-2-preview, text-embedding-004.
 * The SDK accepts an array of contents per call; the API caps batch size, so
 * we chunk defensively.
 */

import { GoogleGenAI } from '@google/genai'
import type { EmbeddingProvider, EmbeddingResult, EmbedOptions } from './embedding.ts'
import { llmStats } from './stats.ts'

const MAX_BATCH = 100

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private client: GoogleGenAI
  private model: string

  constructor(apiKey: string, model: string) {
    this.client = new GoogleGenAI({ apiKey })
    this.model = model
  }

  async embed(texts: string[], opts?: EmbedOptions): Promise<EmbeddingResult> {
    if (texts.length === 0) return { vectors: [], model: this.model, dim: 0 }

    const vectors: number[][] = new Array(texts.length)
    let dim = 0
    const config = opts?.taskType ? { taskType: opts.taskType } : undefined

    for (let start = 0; start < texts.length; start += MAX_BATCH) {
      const chunk = texts.slice(start, start + MAX_BATCH)
      const t0 = performance.now()

      const response = (await this.client.models.embedContent({
        model: this.model,
        contents: chunk,
        ...(config ? { config } : {}),
      })) as GeminiEmbedResponse

      const durationMs = performance.now() - t0
      const embeddings = response.embeddings ?? []

      for (let i = 0; i < embeddings.length; i++) {
        const values = embeddings[i]?.values
        if (!values) continue
        vectors[start + i] = values
        if (values.length > dim) dim = values.length
      }

      // Gemini doesn't reliably return token counts on embedContent; estimate.
      const um = response.usageMetadata
      if (um?.totalTokenCount != null) {
        llmStats.recordTokens('gemini', this.model, um.totalTokenCount, 0, durationMs)
      } else {
        const inputChars = chunk.reduce((sum, t) => sum + t.length, 0)
        llmStats.record('gemini', this.model, inputChars, 0, durationMs)
      }
    }

    return { vectors, model: this.model, dim }
  }
}

interface GeminiEmbedResponse {
  embeddings?: Array<{ values?: number[] }>
  usageMetadata?: { totalTokenCount?: number }
}
