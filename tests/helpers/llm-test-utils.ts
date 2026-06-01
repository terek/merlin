/**
 * Shared helpers for @llm integration tests.
 * Handles provider detection, API key resolution, and Ollama availability checks.
 */

import { inferProvider } from '../../src/clerk/clerk.ts'

/** Resolve API key for a model+role. Returns 'ollama' for Ollama models. */
export function resolveKey(model: string | undefined, role: 'CLERK' | 'PROCESSOR'): string | undefined {
  if (!model) return undefined
  const provider = inferProvider(model)
  if (provider === 'ollama') return 'ollama'
  const p = provider.toUpperCase()
  return process.env[`${p}_${role}_API_KEY`] || process.env[`${p}_API_KEY`]
}

/** Check if Ollama is reachable (for skip logic). Caches the result. */
let _ollamaChecked = false
let _ollamaAvailable = false

export async function isOllamaAvailable(): Promise<boolean> {
  if (_ollamaChecked) return _ollamaAvailable
  _ollamaChecked = true
  try {
    const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(2000) })
    _ollamaAvailable = res.ok
  } catch {
    _ollamaAvailable = false
  }
  return _ollamaAvailable
}

/** Should @llm tests be skipped? Pass the models and resolved keys. */
export async function shouldSkipLlm(opts: {
  models: (string | undefined)[]
  keys: (string | undefined)[]
}): Promise<boolean> {
  // Skip if any model or key is missing
  if (opts.models.some((m) => !m) || opts.keys.some((k) => !k)) return true

  // If any model is Ollama, check connectivity
  const hasOllama = opts.models.some((m) => m && inferProvider(m) === 'ollama')
  if (hasOllama && !(await isOllamaAvailable())) return true

  return false
}

/**
 * Test timeout in ms, scaled for local models.
 * Cloud APIs: 15s base. Ollama: 10x (models are slower, especially cold starts).
 */
export function llmTimeout(baseMs: number = 15_000): number {
  const models = [process.env.CLERK_MODEL, process.env.PROCESSOR_MODEL]
  const hasOllama = models.some((m) => m && inferProvider(m) === 'ollama')
  return hasOllama ? baseMs * 10 : baseMs
}
