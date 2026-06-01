/**
 * Bun test preload — runs before any test file.
 * Prints LLM usage summary after all tests complete.
 */

import { afterAll } from 'bun:test'
import { llmStats } from '@merlin/llm'

afterAll(() => {
  llmStats.printSummary()
})
