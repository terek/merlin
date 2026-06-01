import { beforeEach, describe, expect, test } from 'bun:test'
import { llmStats } from '../src/stats.ts'

describe('LLMStats', () => {
  beforeEach(() => {
    llmStats.reset()
  })

  test('empty stats', () => {
    expect(llmStats.callCount).toBe(0)
    expect(llmStats.stats().size).toBe(0)
    expect(llmStats.summary()).toBe('')
  })

  test('recordTokens with exact counts', () => {
    llmStats.recordTokens('gemini', 'gemini-2.0-flash', 1000, 500, 200)

    const stats = llmStats.stats()
    const entry = stats.get('gemini/gemini-2.0-flash')!
    expect(entry.calls).toBe(1)
    expect(entry.inputTokens).toBe(1000)
    expect(entry.outputTokens).toBe(500)
    expect(entry.totalMs).toBe(200)
  })

  test('record estimates tokens from chars', () => {
    llmStats.record('openai', 'gpt-4.1', 400, 200, 100)

    const stats = llmStats.stats()
    const entry = stats.get('openai/gpt-4.1')!
    expect(entry.inputTokens).toBe(100) // 400/4
    expect(entry.outputTokens).toBe(50) // 200/4
  })

  test('aggregates multiple calls for same model', () => {
    llmStats.recordTokens('gemini', 'gemini-2.0-flash', 100, 50, 100)
    llmStats.recordTokens('gemini', 'gemini-2.0-flash', 200, 75, 150)

    const stats = llmStats.stats()
    const entry = stats.get('gemini/gemini-2.0-flash')!
    expect(entry.calls).toBe(2)
    expect(entry.inputTokens).toBe(300)
    expect(entry.outputTokens).toBe(125)
    expect(entry.totalMs).toBe(250)
  })

  test('separates different models', () => {
    llmStats.recordTokens('gemini', 'gemini-2.0-flash', 100, 50, 100)
    llmStats.recordTokens('openai', 'gpt-4.1-mini', 200, 75, 150)

    const stats = llmStats.stats()
    expect(stats.size).toBe(2)
    expect(stats.get('gemini/gemini-2.0-flash')!.calls).toBe(1)
    expect(stats.get('openai/gpt-4.1-mini')!.calls).toBe(1)
  })

  test('cost for known Gemini model', () => {
    llmStats.recordTokens('gemini', 'gemini-3.1-flash-lite', 1_000_000, 1_000_000, 5000)

    const stats = llmStats.stats()
    const entry = stats.get('gemini/gemini-3.1-flash-lite')!
    expect(entry.costUsd).not.toBeNull()
    // $0.25/M input + $1.50/M output = $1.75
    expect(entry.costUsd).toBeCloseTo(1.75, 2)
  })

  test('cost for known Anthropic model', () => {
    llmStats.recordTokens('anthropic', 'claude-haiku-4-5', 500_000, 100_000, 3000)

    const stats = llmStats.stats()
    const entry = stats.get('anthropic/claude-haiku-4-5')!
    // $1/M * 0.5M input + $5/M * 0.1M output = $0.50 + $0.50 = $1.00
    expect(entry.costUsd).toBeCloseTo(1.0, 2)
  })

  test('cost for known OpenAI model', () => {
    llmStats.recordTokens('openai', 'gpt-4.1-mini', 1_000_000, 1_000_000, 5000)

    const stats = llmStats.stats()
    const entry = stats.get('openai/gpt-4.1-mini')!
    // $0.40/M input + $1.60/M output = $2.00
    expect(entry.costUsd).toBeCloseTo(2.0, 2)
  })

  test('cost is null for unknown model', () => {
    llmStats.recordTokens('openai', 'gpt-99-turbo', 1000, 500, 100)

    const stats = llmStats.stats()
    expect(stats.get('openai/gpt-99-turbo')!.costUsd).toBeNull()
  })

  test('cost via prefix match', () => {
    // "claude-sonnet-4-6" should match the pricing entry
    llmStats.recordTokens('anthropic', 'claude-sonnet-4-6-20250514', 1_000_000, 1_000_000, 5000)

    const stats = llmStats.stats()
    const entry = stats.get('anthropic/claude-sonnet-4-6-20250514')!
    // $3/M + $15/M = $18
    expect(entry.costUsd).toBeCloseTo(18.0, 2)
  })

  test('summary includes cost', () => {
    llmStats.recordTokens('gemini', 'gemini-2.0-flash', 100_000, 10_000, 500)

    const summary = llmStats.summary()
    expect(summary).toContain('gemini/gemini-2.0-flash')
    expect(summary).toContain('$')
  })

  test('summary with multiple models shows total', () => {
    llmStats.recordTokens('gemini', 'gemini-2.0-flash', 1000, 500, 100)
    llmStats.recordTokens('openai', 'gpt-4.1-mini', 2000, 1000, 200)

    const summary = llmStats.summary()
    expect(summary).toContain('total:')
    expect(summary).toContain('$')
  })

  test('reset clears everything', () => {
    llmStats.recordTokens('gemini', 'gemini-2.0-flash', 1000, 500, 100)
    llmStats.reset()

    expect(llmStats.callCount).toBe(0)
    expect(llmStats.stats().size).toBe(0)
  })
})
