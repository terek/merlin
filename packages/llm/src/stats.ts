/**
 * Singleton LLM usage tracker.
 * Providers call `llmStats.record(...)` after each API call.
 * Call `llmStats.summary()` to get a human-readable report.
 *
 * Token counts are estimated from character length (chars / 4) since
 * not all providers return exact token counts.
 *
 * Lifetime: module-level singleton. In Bun's test runner, all test files
 * share one process -> one singleton -> all calls aggregate automatically.
 * The summary is printed via a `beforeExit` hook (production daemon never
 * hits this -- it stays alive). For tests, the preload at
 * tests/preload.ts also hooks afterAll as a safety net.
 */

interface CallRecord {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  durationMs: number
}

export interface ModelStats {
  calls: number
  inputTokens: number
  outputTokens: number
  totalMs: number
  /** Estimated cost in USD, null if pricing unknown for this model. */
  costUsd: number | null
}

// ---------------------------------------------------------------------------
// Pricing table: $ per 1 million tokens [input, output]
// ---------------------------------------------------------------------------

const PRICING: Record<string, [number, number]> = {
  // Gemini
  'gemini-2.0-flash-lite': [0.075, 0.3],
  'gemini-2.0-flash': [0.1, 0.4],
  'gemini-2.5-flash-lite-preview-09-2025': [0.1, 0.4],
  'gemini-2.5-flash-lite': [0.1, 0.4],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-pro': [1.25, 10.0],
  'gemini-3-flash-preview': [0.5, 3.0],
  'gemini-3.1-flash-lite': [0.25, 1.5],
  'gemini-3.1-pro-preview': [2.0, 12.0],
  // Anthropic (aliases + dated IDs)
  'claude-haiku-4-5-20251001': [1.0, 5.0],
  'claude-haiku-4-5': [1.0, 5.0],
  'claude-sonnet-4-6-20250514': [3.0, 15.0],
  'claude-sonnet-4-6': [3.0, 15.0],
  'claude-opus-4-6-20250626': [5.0, 25.0],
  'claude-opus-4-6': [5.0, 25.0],
  // OpenAI
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
  'gpt-4.1': [2.0, 8.0],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4o': [2.5, 10.0],
  'gpt-5-mini': [0.25, 2.0],
  'gpt-5-nano': [0.05, 0.4],
  'gpt-5-pro': [15.0, 120.0],
  'gpt-5.1': [1.25, 10.0],
  'gpt-5.2-pro': [21.0, 168.0],
  'gpt-5.2': [1.75, 14.0],
  'gpt-5': [1.25, 10.0],
  // Embeddings (output cost is $0; only input is billed)
  'text-embedding-3-small': [0.02, 0.0],
  'text-embedding-3-large': [0.13, 0.0],
  'text-embedding-ada-002': [0.1, 0.0],
  'gemini-embedding-001': [0.15, 0.0],
  'gemini-embedding-2-preview': [0.15, 0.0],
  'text-embedding-004': [0.0, 0.0],
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  // Try exact match first, then prefix match (e.g. "claude-haiku-4-5" matches "claude-haiku-4-5-20251001")
  let pricing = PRICING[model]
  if (!pricing) {
    for (const [key, val] of Object.entries(PRICING)) {
      if (model.startsWith(key) || key.startsWith(model)) {
        pricing = val
        break
      }
    }
  }
  if (!pricing) return null
  return (inputTokens * pricing[0] + outputTokens * pricing[1]) / 1_000_000
}

class LLMStats {
  private records: CallRecord[] = []
  private _printed = false

  /** Record a single LLM API call with exact token counts from the API. */
  recordTokens(provider: string, model: string, inputTokens: number, outputTokens: number, durationMs: number): void {
    this.records.push({ provider, model, inputTokens, outputTokens, durationMs })
  }

  /** Record a single LLM API call, estimating tokens from character counts (chars / 4). */
  record(provider: string, model: string, inputChars: number, outputChars: number, durationMs: number): void {
    this.records.push({
      provider,
      model,
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: Math.ceil(outputChars / 4),
      durationMs,
    })
  }

  /** Get aggregated stats per model. */
  stats(): Map<string, ModelStats> {
    const map = new Map<string, ModelStats>()
    for (const r of this.records) {
      const key = `${r.provider}/${r.model}`
      const existing = map.get(key) || { calls: 0, inputTokens: 0, outputTokens: 0, totalMs: 0, costUsd: null }
      existing.calls++
      existing.inputTokens += r.inputTokens
      existing.outputTokens += r.outputTokens
      existing.totalMs += r.durationMs
      map.set(key, existing)
    }
    // Compute costs after aggregation
    for (const [key, s] of map) {
      const model = key.split('/')[1] || key
      s.costUsd = estimateCost(model, s.inputTokens, s.outputTokens)
    }
    return map
  }

  /** Human-readable summary string. */
  summary(): string {
    if (this.records.length === 0) return ''

    const stats = this.stats()
    const lines: string[] = ['', '\u2500\u2500 LLM usage \u2500\u2500']

    let totalCalls = 0,
      totalIn = 0,
      totalOut = 0,
      totalCost = 0,
      hasCost = false

    for (const [model, s] of stats) {
      totalCalls += s.calls
      totalIn += s.inputTokens
      totalOut += s.outputTokens
      const avgMs = Math.round(s.totalMs / s.calls)
      let line =
        `  ${model}: ${s.calls} call${s.calls !== 1 ? 's' : ''}, ` +
        `~${fmtTokens(s.inputTokens)} in / ~${fmtTokens(s.outputTokens)} out, ` +
        `${avgMs}ms avg`
      if (s.costUsd !== null) {
        line += `, $${fmtCost(s.costUsd)}`
        totalCost += s.costUsd
        hasCost = true
      }
      lines.push(line)
    }

    if (stats.size > 1) {
      let totalLine = `  total: ${totalCalls} calls, ~${fmtTokens(totalIn)} in / ~${fmtTokens(totalOut)} out`
      if (hasCost) totalLine += `, $${fmtCost(totalCost)}`
      lines.push(totalLine)
    }

    lines.push('')
    return lines.join('\n')
  }

  /** Print summary to stderr (idempotent -- only prints once). */
  printSummary(): void {
    if (this._printed) return
    this._printed = true
    const s = this.summary()
    if (s) process.stderr.write(s)
  }

  /** Reset all records. */
  reset(): void {
    this.records = []
    this._printed = false
  }

  get callCount(): number {
    return this.records.length
  }
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function fmtCost(usd: number): string {
  if (usd < 0.01) return usd.toFixed(4)
  if (usd < 1) return usd.toFixed(3)
  return usd.toFixed(2)
}

/** Global singleton -- import and use from any provider. */
export const llmStats = new LLMStats()
