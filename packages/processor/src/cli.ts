#!/usr/bin/env bun
/**
 * CLI entry point for the Processor.
 *
 * Usage:
 *   bun run process <folder>                      # process a project folder
 *   bun run process .                             # process current directory
 *   bun run process                               # process current directory (default)
 *   bun run process --force <folder>              # reprocess all sessions
 *   bun run process --summarize <folder>          # enable LLM summarization
 *   bun run process --summarize --force <folder>  # both
 *
 * LLM summarization requires ANTHROPIC_API_KEY env var.
 * Model defaults to gemini-2.0-flash (via PROCESSOR_MODEL env).
 */

import path from 'node:path'
import type { LLMProvider } from '@merlin/llm'
import { Processor } from './processor.ts'

const args = process.argv.slice(2)
const force = args.includes('--force')
const summarize = args.includes('--summarize')
const folder = args.find((a) => !a.startsWith('--')) || '.'
const projectCwd = path.resolve(folder)

let llmProvider: LLMProvider | undefined

if (summarize) {
  const model = process.env.PROCESSOR_MODEL || 'gemini-2.0-flash'

  if (model.startsWith('claude')) {
    const apiKey = process.env.ANTHROPIC_PROCESSOR_API_KEY || process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      console.error('ANTHROPIC_PROCESSOR_API_KEY or ANTHROPIC_API_KEY required for Claude summarization')
      process.exit(1)
    }
    const { AnthropicProvider } = await import('@merlin/llm')
    llmProvider = new AnthropicProvider(apiKey, model)
  } else if (model.startsWith('gpt-')) {
    const apiKey = process.env.OPENAI_PROCESSOR_API_KEY || process.env.OPENAI_API_KEY
    if (!apiKey) {
      console.error('OPENAI_PROCESSOR_API_KEY or OPENAI_API_KEY required for OpenAI summarization')
      process.exit(1)
    }
    const { OpenAIProvider } = await import('@merlin/llm')
    llmProvider = new OpenAIProvider(apiKey, model)
  } else if (model.startsWith('ollama:')) {
    const { OllamaProvider } = await import('@merlin/llm')
    llmProvider = new OllamaProvider(model.slice('ollama:'.length))
  } else {
    // Default to Gemini
    const apiKey = process.env.GEMINI_PROCESSOR_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    if (!apiKey) {
      console.error('GEMINI_PROCESSOR_API_KEY or GEMINI_API_KEY required for Gemini summarization')
      process.exit(1)
    }
    const { GeminiProvider } = await import('@merlin/llm')
    llmProvider = new GeminiProvider(apiKey, model)
  }
}

const flags = [force && 'force', summarize && 'summarize'].filter(Boolean).join(', ')
console.log(`Processing: ${projectCwd}${flags ? ` (${flags})` : ''}`)

const processor = new Processor({ llmProvider })
const result = await processor.processProject(projectCwd, { force })

console.log(
  `Done: ${result.processed.length} processed, ${result.skipped.length} skipped, ${result.errors.length} errors`,
)

if (result.errors.length > 0) {
  for (const { sessionId, error } of result.errors) {
    console.error(`  ${sessionId}: ${error}`)
  }
}

if (result.llmCosts) {
  console.error(result.llmCosts.summary)
}
