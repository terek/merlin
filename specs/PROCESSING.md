# Preprocessing Pipeline

Transforms raw CC session JSONL files into searchable, summarized, task-clustered data for the Clerk agent and the web/TUI/iOS clients.

## Pipeline overview

```
JSONL file
  → Parse                      (no LLM)        → ParsedTurn[]
  → Filter interruptions       (no LLM)        → ParsedTurn[]
  → Collapse to lean turns     (no LLM)        → LeanTurn[]
  → Parse + nest subagents     (no LLM)        → LeanTurn[] with subagents[]
  → Carry-forward summaries    (incremental)   → LeanTurn[] with prior annotations
  → Summarize + cluster        (LLM, chunked)  → LeanTurn{userSummary, agentSummary, taskId}
                                               + SessionTask[]
  → Compute task time ranges   (no LLM)        → SessionTask{startedAt, endedAt}
  → Extract concepts           (LLM, parallel) → SessionTask{concepts}
  → Store to disk
```

A session with N new turns runs `ceil(N/15)` chunked LLM calls for summarization plus one parallel call per stale task for concept extraction. Subagents are summarized in parallel, context-blind. Incremental: turns whose annotations are still valid are carried forward and skipped.

Code lives in `packages/processor/src/`.

## Step 1: Parse (`jsonl-parser.ts`)

Reads the raw JSONL line by line. Each line is a CC event (`user`, `assistant`, `system`, `custom-title`, etc.).

**Keeps:**
- User prompts — verbatim
- Assistant text responses — merged by message ID (CC splits responses across multiple JSONL lines when they contain interleaved tool calls)
- Token usage per assistant turn (`message.usage`)

**Drops:**
- Tool use blocks, tool results, thinking blocks
- Progress events, queue operations, system entries
- System-injected XML: `<task-notification>`, `<command-name>`, `<local-command-caveat>`, `<teammate-message>`, `<system-reminder>`

**Output:** `ParsedSession { sessionId, cwd, title, slug, ccVersion, turns: ParsedTurn[], rawLineCount }`. `ParsedTurn` carries role, text, timestamp, optional `usage`, and `rawMessageCount`.

## Step 2: Filter interruptions (`lean-session.ts:240`)

- Drops user turns containing `[Request interrupted by user for tool use]` (subagent-spawn noise).
- Drops user turns whose trimmed text is exactly `[Request interrupted by user]` (Ctrl+C with no follow-up).
- For user turns that *start* with `[Request interrupted by user]` followed by content, strips the marker and keeps the rest.

## Step 3: Collapse to lean turns (`lean-session.ts:261`)

Groups parsed turns into `userText + agentText` pairs.

**Problem:** Between user messages the assistant emits many small turns ("let me check…", "creating files…", "build succeeded", "here's what was done"). These are tool-use mechanics, not content.

**Solution:** For each user prompt, collect the assistant turn sequence that follows and pick the **last substantial turn** as the response (`pickResponse()`, lean-session.ts:192):
- Single assistant turn → use as-is.
- Last turn ≥80 chars (`SUBSTANTIAL_RESPONSE_LENGTH`) → use it.
- Last turn too short → merge previous + last with `\n\n`.

**Also handles:**
- Consecutive user prompts (from interruptions) — merged with `\n\n`, earliest timestamp wins.
- Trailing user prompt with no response — dropped.
- Orphan assistant turns before first user — dropped.

**Per-turn output (`LeanTurn`, schema.ts:96):**
- `id` — `<sessionPrefix>-NNNN` (8-char session prefix + 4-digit zero-padded index)
- `index` — 0-based
- `userText`, `userTimestamp`
- `agentText`, `agentTimestamp`
- `durationMs` — null if missing or ≥24h
- `usage` — aggregated `TokenUsage` across the assistant sequence (input/output/cacheRead/cacheWrite tokens)
- `rawMessageCount` — number of raw assistant messages collapsed
- `subagents: []` — populated in step 4
- `userSummary`, `agentSummary`, `taskId`, `tags` — populated in step 6

## Step 4: Parse + nest subagents (`lean-session.ts:329`, `:428`)

Reads `<sessionDir>/<sessionId>/subagents/agent-<agentId>.jsonl` (and optional `agent-<agentId>.meta.json` for `agentType` like `Explore`, `general-purpose`).

Each subagent is parsed identically to a session (one user kickoff + picked response). Result is a `SubagentTurn` (schema.ts:53) with `agentId`, `agentType?`, `userText`/`userTimestamp`, `agentText`/`agentTimestamp`, `durationMs`, `usage`, `rawMessageCount`.

**Nesting:** each subagent is attached to the last main turn whose `userTimestamp ≤ subagent's launchTimestamp`. Falls back to the last turn if none qualifies. Subagents are sorted by launch timestamp before nesting.

## Step 5: Carry-forward summaries (`lean-session.ts:149`)

Before the LLM runs, copy `userSummary`, `agentSummary`, `taskId` from the previous lean session onto the new turns:
- Match by index for all turns except the **last** old turn.
- Last old turn matched by `userText` prefix (first 200 chars) — guards against an active session where the last turn's `agentText` was still streaming when previously processed.
- Subagents matched by `agentId`.

This means only genuinely new (or invalidated) turns hit the LLM in step 6.

## Step 6: Summarize + cluster (`summarizer.ts`)

Replaces both the old "compact" pairs view and the old "calendar-day segment + topic/summary" model. Turns are processed sequentially in **chunks of `DEFAULT_CHUNK_SIZE = 15`** with a **rolling `SummarizationContext`** that the LLM updates one turn at a time.

### SummarizationContext

```ts
SummarizationContext = {
  tasks:   SessionTask[],                       // discovered workstreams so far
  recent:  Array<{ turn, gist }>,               // sliding window, max 5
  turn_index: number                            // 1-based, advances per applied delta
}
```

Persisted alongside the session as `context.json` for exact incremental resume. If absent on incremental update, `reconstructContext()` (summarizer.ts:529) rebuilds it from stored tasks + last 5 summarized turns.

### LLM call (chunked, default path)

All summarizer LLM calls go through `LLMProvider.parse()` — schema-enforced structured output (Zod schema → provider-native JSON-Schema enforcement; see `@merlin/llm` `provider.ts` / `schema-utils.ts`). No manual JSON parsing.

System prompt: `SYSTEM_PROMPT_CHUNK` (summarizer.ts). User payload:

```json
{
  "context": <SummarizationContext>,
  "turns": [
    { "turn_index": <N>, "user_message": "...", "agent_message": "..." },
    ...
  ]
}
```

The provider returns a validated `{ items: LLMDelta[] }` with `items.length === turns.length` in input order (length checked by the summarizer; the LLM contract is enforced via `ChunkResponseSchema`). Tasks created in turn K of the chunk may be referenced by later turns in the same chunk.

### Per-turn delta schema (summarizer.ts:37)

```json
{
  "task_id": "t3" | null,
  "action": "extend" | "new" | "refine",
  "new_task": { "id": "t4", "description": "..." },
  "refined_description": "...",
  "gist": "one-liner" | null,
  "summary": { "user": "..." | null, "agent": "..." | null }
}
```

Actions:
- **`new`** — new workstream identified. `new_task.id` is the next available `tN`. Pushed to `ctx.tasks` with `turns: [turn_index]`.
- **`extend`** — turn belongs to existing task. Append `turn_index` to that task's `turns`.
- **`refine`** — turn updates understanding of existing task. Replace `description`, append `turn_index`.

Each application recomputes the task's `contentHash = hash(description + turns.join(','))` so downstream consumers (concept extractor, embedder) can detect staleness.

`gist` (when present) is pushed onto `ctx.recent`, evicting oldest when length > 5.

### Summary content rules

- Terse bullets (`- ` prefix) or a single statement. No narrative framing.
- Lead with the concrete thing: requirement, decision, file, API, bug, config.
- Preserve ALL technical specifics: paths, function names, flags, error messages.
- 1–5 bullets typical. `null` allowed when message is trivially short.
- Agent summary doesn't repeat what's in user summary.

### Fallback paths

Each `parse()` call is retried once on error (network failure, schema-validation throw, mismatched chunk length). If the retry also fails:

- **Single-turn path** (`_contextAwareCall`) — used for `chunkSize === 1` or trailing remainder of 1. Same delta schema, simpler `SYSTEM_PROMPT`, no `items[]` wrapper.
- **Per-turn fallback** — if the chunk call fails after retry, falls back to running each turn through the single-turn path sequentially.
- **Context-blind fallback** (`_fallbackCall` → `FALLBACK_SYSTEM_PROMPT` + `FallbackSummarySchema`) — if the single-turn path also fails, returns `{userSummary?, agentSummary?}` without touching tasks; advances `turn_index` so the rest of the chunk stays aligned.

### Subagent summarization

Always context-blind, in parallel, via `summarizeTurn()` using `FALLBACK_SYSTEM_PROMPT`. Result is `{userSummary?, agentSummary?}` only — subagents do not participate in task clustering.

### Output applied to LeanTurn

For each main turn the corresponding delta is applied to the rolling context, and:
- `turn.userSummary = delta.summary.user`  (if non-null)
- `turn.agentSummary = delta.summary.agent` (if non-null)
- `turn.taskId = applied task id`           (if any action assigned one)

Tasks live on `LeanSession.tasks[]` (single source of truth); `LeanTurn.taskId` is a back-reference.

## Step 7: Compute task time ranges (`lean-session.ts:404`)

Walks each `SessionTask`, looks up its turns by index, sets `startedAt = min(userTimestamp).getTime()` and `endedAt = max(agentTimestamp).getTime()` as unix ms. Tasks remember 1-based turn indices; this step bridges to the 0-based `LeanTurn.index`.

## Step 8: Extract concepts (`concept-extractor.ts`)

For each task whose `concepts.sourceHash !== contentHash` (i.e. new or stale), one **parallel** schema-enforced LLM call (`provider.parse()` with the concept-list Zod schema). Input: task description + every member turn's `userSummary`/`agentSummary` (or truncated raw text if no summary).

The goal is **not** to classify the task — it's to capture which concepts the work is **actively forming, refining, or extending**. Aggregated later at the project level to track how concepts evolve over time (what was in focus early in the product vs later).

Output (1–5 concepts):

```json
{ "concepts": [
    { "concept": "web-client",                description: "..." },
    { "concept": "merlinignore-file-syntax",  description: "..." }
] }
```

Concept rules:
- kebab-case, ideally 1–3 words; longer when needed (e.g. `turn-summarization-rolling-context`).
- Things the task is *actively building or shaping*, not things it merely uses or runs on.
- Description is one short sentence in local context — how a teammate would explain it while doing the work, not a globally precise definition.
- The action verb (introducing/refining/extending) is **not** captured — the task summary already covers what was done.

Stored as `task.concepts = { items, sourceHash: task.contentHash }`.

Note: `LeanTurn.tags` (schema.ts:37) is defined but **not currently produced** — concepts live at the task level, not per-turn. The schema is ready if/when per-turn tagging is added.

## Incremental processing

Fingerprint-based staleness detection at two levels:

**Session level (`updateLeanSession`, lean-session.ts:121):**
- Compares `rawSizeBytes` + `rawLastModified` against the stored header.
- Unchanged → return null, skip entirely.
- Changed → rebuild lean turns from raw, then carry forward summaries (step 5) so only new/changed turns reach the LLM.

**Turn level (`summarizeAllTurns`, lean-session.ts:454):**
- `firstNewIndex = turns.findIndex(needsSummarization)` — first turn lacking userSummary/agentSummary/taskId.
- LLM is called only on `turns.slice(firstNewIndex)`.
- Initial context priority: stored `summarizationContext` from disk → else `reconstructContext()` from existing tasks + last 5 summarized turns → else empty.

**Task level (`extractConcepts`, concept-extractor.ts):**
- `task.concepts.sourceHash !== task.contentHash` → re-extract, otherwise skip.
- `contentHash` changes whenever a task is extended or refined, so concepts naturally invalidate.

`ProcessingState` (in-memory) tracks per-session status: `missing` | `running` | `processed` | `outdated` | `error`. On restart, state is rehydrated from disk via `Processor.checkProject()`.

## Token usage

Extracted from `message.usage` in assistant JSONL entries:
- `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`
- Aggregated per `LeanTurn.usage` (across the assistant sequence)
- Aggregated per `LeanSessionHeader.usage` as `AggregateUsage` — same fields plus `apiCalls` (count of contributing assistant turns, including subagent turns)

## Storage

Each session lives in its own folder under the project dir. All file I/O goes through `LeanSessionStore` (`store.ts`).

```
~/.merlin/projects/<projectDirName>/
  index.json                    # FolderIndex: per-session fingerprints + status
  <sessionId>/
    lean.jsonl                  # LeanSessionHeader on line 1, then one LeanTurn per line
    tasks.json                  # SessionTask[] (pretty-printed)
    context.json                # SummarizationContext — final rolling state for incremental resume
    embeddings.json             # SessionEmbeddings: per-task vectors (see EMBEDDINGS spec)
    segments.json               # Segment[] — calendar-day grouping (legacy, see below)
```

### File details

- **`lean.jsonl`** — JSONL so the header (and individual turns) can be read without parsing the entire file. `readHeader()` slices to the first `\n` and `JSON.parse`s just that line.
- **`tasks.json`** — separate from `lean.jsonl` because `SessionTask` is mutated independently (extend/refine on every new turn, plus relabeling).
- **`context.json`** — the final `SummarizationContext` (`{tasks, recent[≤5], turn_index}`). Loaded on incremental update to prime the LLM with exact prior state; if absent, falls back to `reconstructContext()` from existing tasks + turn summaries.
- **`embeddings.json`** — `SessionEmbeddings { version, taskEmbeddings: { [taskId]: TaskEmbedding } }`. Each entry carries `sourceHash` matching `SessionTask.contentHash`; mismatch means re-embed.
- **`segments.json`** — `Segment[]` (`segment-schema.ts`). Vestigial calendar-day grouping with truncation-based topic/summary; **not produced by the current LLM pipeline** (the active path produces `tasks`, not `segments`). Kept for now; targeted for replacement by semantic segmentation.

### Project index

`index.json` is the project-level `FolderIndex` (`schema.ts:338`): `{ version, projectPath, projectDirName, sessions: FolderIndexEntry[], lastProcessedAt }`. Each `FolderIndexEntry` carries `sessionId`, `title`, `startedAt`/`endedAt`, `turnCount`/`userTurnCount`, and the raw fingerprint (`rawSizeBytes`, `rawLastModified`) used by `Processor.checkProject()` to decide what's stale on rehydration.

`listSessionIds()` enumerates session folders by reading the project dir and skipping `index.json`.

## What each view uses

| View | Data source | LLM needed? |
|---|---|---|
| **Raw**       | `parseSessionJsonl()` directly                       | No |
| **Lean turns**| `LeanSession.turns` (userText + agentText pairs)     | No (already produced during preprocessing) |
| **Summaries** | `LeanTurn.userSummary` / `agentSummary`              | Yes (chunked, context-aware) |
| **Tasks**     | `LeanSession.tasks` + `LeanTurn.taskId` cross-ref    | Yes (same call as summaries) |
| **Task concepts** | `SessionTask.concepts.items`                     | Yes (separate per-task pass) |
| **Timeline**  | `SessionTask.startedAt` / `endedAt` + member turns   | Yes (uses tasks + summaries) |
| **Search**    | Per-task embeddings keyed by `contentHash`           | Yes (separate embedder pass) |
