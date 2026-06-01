# @merlin/processor -- Library Interface

Parses raw Claude Code session JSONL files into lightweight **LeanSession** representations, segments them by calendar day, and stores results. Strips noise, collapses multi-message assistant sequences into single turns, nests subagent executions, computes token usage aggregates, and supports incremental updates.

The processor is a **pure transform + storage layer**. It does NOT track runtime state (processing, error, outdated) -- that's the caller's responsibility (e.g. the daemon keeps an in-memory state machine). The on-disk index is a manifest of successfully processed sessions with fingerprints for staleness detection.

## Data Flow

```
Raw JSONL (Claude Code)
  |
  v
parseSessionJsonl()  ->  ParsedSession (intermediate, not stored)
  |
  v
buildLeanSession()   ->  LeanSession { header, turns[] }
  |
  v
segmentByDay()       ->  Segment[] (day-boundary chunks with topic/summary)
  |
  v
LeanSessionStore     ->  ~/.merlin/projects/<dir>/<session-id>/
                           lean.jsonl      (header + turns)
                           segments.json   (array of segments)
```

## Storage Layout

```
~/.merlin/projects/<project-dir-name>/
  index.json                          # FolderIndex (manifest of processed sessions)
  <session-id-1>/
    lean.jsonl                        # LeanSessionHeader (line 1) + LeanTurn per line
    segments.json                     # Array of Segment objects
  <session-id-2>/
    lean.jsonl
    segments.json
  ...
```

## Public API

### Processor (`Processor`)

High-level orchestrator. Scans a project for raw sessions, builds lean sessions, segments them, and stores results. Supports incremental updates -- only reprocesses sessions whose raw files have changed.

| Method | Description |
|--------|-------------|
| `new Processor(opts?)` | Create with optional `merlinDir`, `claudeProjectsDir`, `minSizeBytes` |
| `processProject(cwd, opts?)` | Process all sessions for a project. Returns `ProcessResult` |
| `processSession(cwd, id, rawPath?)` | Process a single session. Discovers raw path if not provided |
| `checkProject(cwd)` | Compare raw files vs stored output. Returns `SessionCheck[]` for caller to determine pending/outdated/current |

### ProcessResult

Returned by `processProject()`. Contains per-session details so the caller can update its state:

```typescript
interface ProcessResult {
  processed: string[]                          // session IDs successfully processed
  skipped: string[]                            // unchanged or too small
  errors: { sessionId: string; error: string }[] // failed with details
}
```

### SessionCheck

Returned by `checkProject()`. The caller decides what's pending/outdated/current:

```typescript
interface SessionCheck {
  sessionId: string
  rawPath: string
  rawSizeBytes: number
  rawLastModified: string
  stored: { sizeBytes: number; lastModified: string } | null  // null = not yet processed
}
```

**Caller logic:**
- `stored === null` -> pending (new session, never processed)
- `stored.sizeBytes !== rawSizeBytes || stored.lastModified !== rawLastModified` -> outdated
- fingerprints match -> current (up to date)

### Data Models (`schema.ts` + `segment-schema.ts`)

All types have corresponding Zod schemas (`*Schema`) for runtime validation.

| Type | Description |
|------|-------------|
| `LeanSession` | Complete session: `{ header, turns[] }` |
| `LeanSessionHeader` | Metadata: title, timing, usage aggregates, raw file fingerprint |
| `LeanTurn` | One user prompt + agent response pair with usage, duration, subagents |
| `SubagentTurn` | Nested subagent execution record |
| `TokenUsage` | Per-turn token counts (input, output, cache read/write) |
| `AggregateUsage` | Summed usage with API call count |
| `Segment` | Day-boundary chunk: date, topic, summary, turnRange, userPrompts, usage |
| `FolderIndex` | Manifest: project path + array of successfully processed sessions |
| `FolderIndexEntry` | Per-session fingerprint: title, timing, turn counts, raw file size/mtime |

**Note:** `FolderIndexEntry` has no `status` or `errorMessage` field. Runtime state (processing, error, outdated) is the caller's concern, not the processor's.

### Segmentation

| Function | Description |
|----------|-------------|
| `segmentByDay(turns)` | Group lean turns by calendar date. Returns `Segment[]` |

> **Note**: `segmentByDay` topic/summary are truncation-based placeholders. Downstream processing now favors LLM **task** extraction over day-grouped segments (see `specs/PROCESSING.md`); `segments.json` is still written but is effectively vestigial, kept for backward compatibility.
> **TODO**: Semantic segmentation (detect topic shifts within a day).
> **TODO**: LLM-powered topic labels and summaries via `@merlin/llm`.

### Building

| Function | Description |
|----------|-------------|
| `buildLeanSession(parsed, opts)` | Sync build without subagents |
| `buildLeanSessionWithSubagents(parsed, opts)` | Async build with subagent parsing from disk |
| `updateLeanSession(existing, parsed, opts)` | Incremental update; returns `null` if unchanged |

### Parsing

| Function | Description |
|----------|-------------|
| `parseSessionJsonl(content, fallbackId)` | Parse raw Claude Code JSONL into `ParsedSession` |

### Storage & Discovery

| Export | Description |
|--------|-------------|
| `LeanSessionStore` | Read/write lean sessions, segments, and project index to disk |
| `LeanSessionStore.deleteSession(id)` | Remove session folder + index entry |
| `LeanSessionStore.deleteAllSessions()` | Remove all session folders + reset index |
| `discoverRawSessions(dir, name)` | Find raw session files (including subdirectory projects) |
| `cwdToProjectDirName(cwd)` | Convert `/Users/x/y` -> `-Users-x-y` |

### ProcessingQueue (`ProcessingQueue`)

Async job queue for controlled, deduplicated processing. Accepts project/session/all requests, persists state to disk, and resumes interrupted jobs on restart. The daemon instantiates this and wires callbacks for UI broadcasting.

| Method | Description |
|--------|-------------|
| `new ProcessingQueue(processor, opts?)` | Create with a `Processor` instance and options |
| `init()` | Load persisted state, restore interrupted jobs, begin draining |
| `enqueue(req)` | Add a job. Deduplicates silently. Synchronous |
| `pendingCount` | Number of queued jobs waiting to execute |
| `runningCount` | Number of currently executing jobs |
| `getState()` | Snapshot: `{ pending: ProcessingJob[], running: ProcessingJob[] }` |

#### ProcessingQueueOptions

| Field | Default | Description |
|-------|---------|-------------|
| `maxConcurrent` | `2` | Max jobs executing in parallel |
| `persistPath` | `~/.merlin/processing-queue.json` | Disk persistence file |
| `resolveAllProjects` | — | Callback returning current non-archived project cwds (for `all` job expansion) |
| `onJobStart` | — | Called when a job begins executing (may be async) |
| `onJobComplete` | — | Called when a job finishes successfully (may be async) |
| `onJobError` | — | Called when a job throws (may be async) |
| `onProjectDrained` | — | Called when the last active job for a cwd completes — use for batched UI refresh |

#### Job Types

```typescript
type EnqueueRequest =
  | { type: 'project'; cwd: string }
  | { type: 'session'; cwd: string; sessionId: string }
  | { type: 'all' }
```

- **`project`** — runs `processor.processProject(cwd)`. Sessions processed in parallel internally.
- **`session`** — runs `processor.processSession(cwd, sessionId)`. Lightweight single-session processing.
- **`all`** — expands into individual `project` jobs at execution time via `resolveAllProjects()`.

#### Deduplication Rules

| New job | Existing pending/running | Action |
|---------|--------------------------|--------|
| `project(cwd)` | `project(cwd)` | drop |
| `project(cwd)` | `session(cwd, *)` pending | cancel pending sessions (subsumed) |
| `session(cwd, id)` | `project(cwd)` | drop (project covers it) |
| `session(cwd, id)` | `session(cwd, id)` | drop |
| `all` | `all` pending | drop |

#### Per-Project Drain Tracking

The queue tracks active jobs per cwd. `onProjectDrained(cwd)` fires only when the last job for that cwd completes. This gives batched broadcasting:
- 3 session jobs for same project → one drain event after the last finishes
- 1 project job → one drain event after it completes
- Jobs from different projects → each drains independently

#### Persistence

Queue state is written to `persistPath` after every state change (fire-and-forget). On `init()`, jobs in `running` state are moved to `pending` (they were interrupted) and re-executed. Processing is idempotent — fingerprint checks skip unchanged sessions.

## Configuration

`ProcessorOptions` (all optional):

| Field | Default | Description |
|-------|---------|-------------|
| `merlinDir` | `~/.merlin` | Base directory for processed output |
| `claudeProjectsDir` | `~/.claude/projects` | Where raw Claude Code sessions live |
| `minSizeBytes` | `500` | Skip raw files smaller than this (metadata-only) |

## Conventions

- **Import from `@merlin/processor`** -- the barrel re-exports the public API.
- **Do not import from `@merlin/processor/src/...`** -- internal module paths are not part of the contract and may change.
- Internal helpers (`pickResponse`, `aggregateUsage`, `truncateSummary`, `computeDuration`, `formatTurnId`, `parseLeanSessionJsonl`) are deliberately excluded from the public API.
