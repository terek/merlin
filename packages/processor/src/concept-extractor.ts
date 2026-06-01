/**
 * Task-level concept extraction.
 *
 * For each task, extracts the concepts the work is actively forming, refining,
 * or extending — not concepts merely referenced in passing. Each concept is a
 * kebab-case name (1-3 words typical, longer when needed) plus a one-sentence
 * description written in local context, the way a developer would explain it
 * to a teammate while doing the work.
 *
 * These are aggregated at the project level later to track how concepts
 * evolve over time.
 *
 * Only re-extracts tasks whose contentHash has changed since last extraction.
 */

import type { LLMProvider } from '@merlin/llm'
import { z } from 'zod'
import type { InnerProgressEvent } from './progress.ts'
import type { LeanTurn, SessionTask, TaskConcept } from './schema.ts'

const ResponseSchema = z.object({
  concepts: z.array(z.object({ concept: z.string(), description: z.string() })),
})

const SYSTEM_PROMPT = `You list the concepts a coding task EXPLICITLY REFERS TO as named things. You're given a task description plus the verbatim user prompts that belong to it (and brief agent summaries for context only).

**Focus on noun phrases that appear in the USER's prompts.** The user's wording is the primary signal — those are the names a developer reaches for when talking about their own work. Do not extract concepts that exist only in the agent summaries or task description; those are context to disambiguate, not sources of names.

You are NOT describing what the task built or changed. You are extracting noun-form names that appear in the user's text as references to a thing in the codebase or domain.

A concept is a compact noun phrase used as a name — something a developer would shorthand when talking about the work. It must be grounded in wording actually present in the user's prompts, not inferred from what was done.

Include when a name is present in the user's text:
- "search bar for sessions" → concept \`session-search-bar\` ✓ (the user references it as a named thing)
- "the merlinignore file syntax" → \`merlinignore-file-syntax\` ✓
- "lean session" / "lean turns" → \`lean-session\`, \`lean-turn\` ✓
- "rolling summarization context" → \`rolling-summarization-context\` ✓

Exclude when the user only describes or asks for something without naming it:
- "build a search bar that is shown on the sessions page" → NO concept. The user describes something but hasn't named it. It may become a concept later when they refer back to it as "the session search bar".
- "add retry logic with exponential backoff" → NO concept unless the user also names it (e.g. "the retry policy").
- Generic nouns mentioned only incidentally (e.g. "the repo", "the build", "the code") → NO.
- Anything you can't point to a noun phrase for in the user's prompts → DON'T extract. Do not invent.

Concept name format:
- kebab-case, 1-3 words typical. Longer only when the referenced phrase is longer.
- Derived directly from the words the user used; no paraphrasing to a different term.

Description:
- One short sentence explaining what the concept refers to in this task's local context.
- Describe the thing, not what was done to it.

Output:
- 0 to 5 concepts. Empty array is the correct answer when the user doesn't reference any named concepts.
- Prefer under-extraction over over-extraction. A concept emerges by being named, not by being inferred.`

export interface ConceptExtractorOptions {
  /** Shared concurrency limiter. */
  limiter: <T>(fn: () => Promise<T>) => Promise<T>
}

export class TaskConceptExtractor {
  private provider: LLMProvider
  private limiter: <T>(fn: () => Promise<T>) => Promise<T>

  constructor(provider: LLMProvider, opts: ConceptExtractorOptions) {
    this.provider = provider
    this.limiter = opts.limiter
  }

  /**
   * Extract concepts for all tasks that need it (new or stale contentHash).
   * Mutates tasks in place, adding/updating the `concepts` field.
   * Returns the number of tasks that were (re)processed.
   */
  async extractConcepts(
    tasks: SessionTask[],
    turns: LeanTurn[],
    onEvent?: (e: InnerProgressEvent) => void,
  ): Promise<number> {
    const stale = tasks.filter((t) => !t.concepts || t.concepts.sourceHash !== t.contentHash)
    if (stale.length === 0) return 0

    const discovered = stale.length
    let completed = 0
    onEvent?.({ kind: 'log', msg: `extracting concepts: 0/${discovered} tasks` })
    onEvent?.({ kind: 'tasks', done: 0, discovered })

    const turnByIndex = new Map<number, LeanTurn>()
    for (const turn of turns) {
      turnByIndex.set(turn.index + 1, turn) // tasks use 1-based indices
    }

    await Promise.all(
      stale.map((task) =>
        this.limiter(async () => {
          const items = await this._extractOne(task, turnByIndex)
          task.concepts = { items, sourceHash: task.contentHash }
          completed++
          onEvent?.({ kind: 'log', msg: `extracting concepts: ${completed}/${discovered} tasks` })
          onEvent?.({ kind: 'tasks', done: completed, discovered })
        }),
      ),
    )

    return stale.length
  }

  private async _extractOne(task: SessionTask, turnByIndex: Map<number, LeanTurn>): Promise<TaskConcept[]> {
    const turnSummaries = task.turns
      .map((idx) => {
        const turn = turnByIndex.get(idx)
        if (!turn) return null
        const parts: string[] = []
        if (turn.userText) {
          parts.push(`User: ${turn.userText}`)
        }
        if (turn.userSummary) {
          parts.push(`User summary: ${turn.userSummary}`)
        }
        if (turn.agentSummary || turn.agentText) {
          parts.push(`Agent: ${turn.agentSummary ?? truncate(turn.agentText)}`)
        }
        return `[Turn ${idx}] ${parts.join(' | ')}`
      })
      .filter(Boolean)
      .join('\n')

    const input = `Task: ${task.description}\n\nTurns:\n${turnSummaries}`

    try {
      const result = await this.provider.parse({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', text: input }],
        schema: ResponseSchema,
        schemaName: 'task_concepts',
      })
      return result.concepts.slice(0, 5)
    } catch (err) {
      console.error(
        `[processor] concept extraction failed for task ${task.id}:`,
        err instanceof Error ? err.message : err,
      )
      return []
    }
  }
}

function truncate(text: string, maxLength = 150): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3)}...`
}
