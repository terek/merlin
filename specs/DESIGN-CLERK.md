# Merlin Clerk — Design

## Overview

The Clerk runs as a subsystem inside the daemon. It has two parts:

1. **Preprocessor** — background pipeline that segments and summarizes session JSONL files so recall is fast
2. **Agent** — an LLM conversation with custom tools, driven by architect messages from a client

The client sends text, the daemon routes it to the Clerk agent, streams text back. The Clerk agent has tools to search processed sessions, read the codebase, and dispatch prompts to CC sessions.

## Architecture

```
Daemon (src/daemon.ts — thin orchestrator)
├── discovery/          ModelStore + ModelBuilder + WorkspaceStore
├── processing/         ProcessingBridge → @merlin/processor (Processor, ProcessingQueue, ProcessingState)
├── gateway/            ConnectorManager + DataHandlers → @merlin/sync, @merlin/relay
├── sessions/           SessionManager → @merlin/cc (CCSession lifecycle)
└── clerk/              Agent + ConversationStore → @merlin/llm (provider-agnostic)
```

Note: Preprocessing was extracted from Clerk into `@merlin/processor` as a standalone package. The Clerk agent consumes processed data but does not own the pipeline.

The Preprocessor and the Agent use **separate API keys** so token usage can be monitored independently. Provider is inferred from the model name:
- `claude-*` → Anthropic
- `ollama:*` → Ollama (local, no API key needed)
- everything else → Gemini

- **Preprocessor**: Cheap model (Gemini Flash Lite, Claude Haiku, or local Ollama) — provider-agnostic via `Summarizer`
- **Agent**: Configurable — Anthropic Sonnet, Gemini Pro, or Ollama (for local dev/testing)

## Storage

```
~/.merlin/projects/<project-dir-name>/
  index.json                    # FolderIndex: session fingerprints + processing status
  <session-id>.json             # LeanSession with turns, tasks, segments

~/.merlin/clerk/<project-dir-name>/
  conversations/<conv-id>.json  # clerk chat history
```

Note: Processed session data moved from `clerk/` to `projects/` when preprocessing was extracted into `@merlin/processor`.

`<project-dir-name>` uses the same convention as `~/.claude/projects/`: the absolute path with `/` replaced by `-`. For example, `/Users/alice/work/myapp` → `-Users-alice-work-myapp`.

Raw JSONL files in `~/.claude/projects/` are never modified.

## Pre-processing

### When it runs

Pre-processing runs only for **active projects** (projects the architect has marked as active in the daemon). When a project becomes active, the daemon kicks off background preprocessing for all its sessions.

- Project becomes active: scan for unprocessed sessions, process them in background
- Session close (in active project): process the newly closed session
- On demand: if the Clerk agent needs a session that isn't processed yet

### Segmentation strategy

For now, segmentation is simple: **each calendar day within a session is its own segment**. A session that spans March 10–12 produces 3 segments.

The data structures support arbitrary segmentation (by turn range), so we can later introduce smarter splitting — e.g., detecting topic shifts within a day. But day boundaries are a good enough starting point and require no LLM call to determine.

### Pipeline

1. **Read** the session JSONL, parse each line
2. **Filter** to relevant events: `user`, `assistant`, `agent-name`, `custom-title`. Drop `progress`, `queue-operation`, all tool-related events
3. **Group** turns by calendar day → one segment per day
4. **For each segment**, prepare a summary prompt:
   - User prompts included verbatim
   - Assistant turns: text content only (no tool calls, no tool results)
   - Subagent launches: first user turn included verbatim, rest dropped
5. **Send to Gemini Flash Lite** for summarization: "Summarize what was accomplished in this segment. Preserve all user prompts verbatim. For assistant responses, produce a concise summary of what was done and decided — focus on outcomes, not mechanics."
6. **Store** the result in `segments/<session-id>.json`

### What goes into the summary prompt

The LLM receives a compressed version of the segment:

```
[Turn 0] USER: <verbatim prompt text>
[Turn 1] ASSISTANT: <text content only — no tool calls, no tool results>
[Turn 2] USER: <verbatim>
[Turn 3] ASSISTANT: <text content only>
...
```

Tool calls are completely omitted. The assistant's text content already explains what it did and why — the tool mechanics add noise.

### Subagent handling

Subagent sessions live in `~/.claude/projects/<project>/<session-id>/subagents/agent-<id>.jsonl`. CC stores them as nested JSONL files under the parent session — they never appear as top-level session files.

In the parent JSONL, a subagent lifecycle looks like:
1. Assistant `tool_use` with `name: "Agent"` (contains `description` and `prompt`)
2. `progress` lines with `data.type: "agent_progress"` (streaming updates, skipped by parser)
3. User `tool_result` (the agent's final answer, returned to the parent)

The parser does **not** read subagent JSONL files. Instead, it detects `Agent` tool_use blocks in assistant messages and appends a `[Subagent: description]` annotation to the assistant turn's text. This keeps subagent activity visible in both raw and compacted views without injecting separate turns or making LLM calls.

Example parsed output:
```
[Turn 0] USER: build a kanban board
[Turn 1] ASSISTANT: I'll start with the data model. [Subagent: Design data model architecture]
[Turn 2] ASSISTANT: Data model is ready. Now building the UI. [Subagent: Implement board components]
[Turn 3] ASSISTANT: Done — kanban board is fully functional.
```

The compactor preserves `[Subagent: ...]` markers when collapsing multi-turn assistant sequences, so the compacted view shows which subagents were involved even when intermediate turns are dropped.

## Data structures

### ProcessedSession (stored in `segments/<session-id>.json`)

```ts
interface ProcessedSession {
  sessionId: string
  projectPath: string          // git root
  title: string | null         // from custom-title event
  startedAt: string            // ISO timestamp of first turn
  endedAt: string              // ISO timestamp of last turn
  turnCount: number            // total user+assistant turns in raw JSONL
  segments: Segment[]
}

interface Segment {
  index: number                // 0-based within session
  date: string                 // "2026-03-10" — the calendar day
  topic: string                // short label from LLM: "relay 1:1 refactor"
  summary: string              // LLM-generated summary of what was done/decided
  turnRange: [number, number]  // [start, end) indices into filtered user/assistant turns
  userPrompts: string[]        // verbatim — the gold
  timeRange: [string, string]  // [startISO, endISO]
  // Subagent activity is captured as [Subagent: ...] annotations in assistant turn text
}
```

### SessionIndex (stored in `index.json`)

```ts
interface SessionIndex {
  projectPath: string
  projectDirName: string       // e.g., "-Users-alice-work-myapp"
  sessions: SessionEntry[]
  lastProcessedAt: string
}

interface SessionEntry {
  sessionId: string
  title: string | null
  startedAt: string
  endedAt: string
  turnCount: number
  segmentCount: number
  status: 'processed' | 'processing' | 'error' | 'outdated'
  errorMessage?: string        // populated when status === 'error'
  jsonlPath: string            // absolute path to source JSONL
  sizeBytes: number
  lastModified: string         // detect if JSONL changed since processing
}
```

### ClerkConversation (stored in `conversations/<conv-id>.json`)

```ts
interface ClerkConversation {
  id: string
  projectPath: string
  createdAt: string
  updatedAt: string
  // Messages stored in provider-agnostic format (ConversationMessage[])
  messages: Array<{
    role: 'user' | 'assistant' | 'tool_results'
    text?: string
    toolCalls?: Array<{ id: string, name: string, input: Record<string, unknown> }>
    toolResults?: Array<{ callId: string, content: string }>
  }>
}
```

## Preprocessing status

Preprocessing status is exposed in the MerlinModel so it flows to all clients via the normal sync pipeline.

### Per-session status

On `SessionSummary`:
- `ppStatus?: 'missing' | 'running' | 'processed' | 'outdated' | 'error'`
- `ppError?: string` — error message when status is `error`

Status transitions:
```
missing → running → processed
                  → error (API failure, bad JSONL, etc.)
processed → outdated (JSONL fingerprint changed: size + mtime)
outdated → running → processed / error
error → running → processed / error (on reprocess)
```

Sessions < 500 bytes are not preprocessed (metadata-only). They have no `ppStatus`.

### Per-project aggregate

On `Project`:
```ts
preprocessing?: {
  total: number      // preprocessable sessions (≥500 bytes)
  processed: number
  running: number
  error: number
  outdated: number
  missing: number    // discovered but never processed
}
```

### Staleness detection

The daemon runs `scanStaleness()` before each preprocessing cycle. This reads the index and stats each JSONL file:
- `processed` with different mtime → `outdated`
- `processing` (left over from crashed daemon) → `error` with "interrupted" message

### Client-triggered preprocessing

Preprocessing never runs automatically. Clients explicitly control it via protocol messages:

| Message | Description |
|---|---|
| `process_project` | Process all missing/error/outdated sessions for one project |
| `process_session` | Process a single session |
| `process_all` | Process all active (non-archived) projects |
| `delete_processing` | Delete processed data for a project or session |

All are fire-and-forget. The `ProcessingQueue` manages concurrency (max 2 concurrent jobs), cross-type deduplication (project job subsumes session jobs for the same cwd), and persistence across restarts (`~/.merlin/processing-queue.json`). Status updates flow back via the normal model patch pipeline as `Project.preprocessing` and `SessionSummary.ppStatus` change.

### Data flow

```
Client sends process_project / process_session / process_all
  → ProcessingQueue enqueues job → executes with concurrency control
  → Processor runs LLM summarization → ProcessingState updated
  → onProjectDrained → builder.refresh() → patches flow to clients
```

### UI

**TUI**: Projects screen shows a compact badge per project: `✓12` (all done), `✗2 ↻1 ✓9` (errors + outdated + done). `P` key triggers `preprocess_project`, `R` key triggers `reprocess_project`.

**iOS**: `PreprocessingStats` parsed from model JSON. Can be shown as a progress indicator or status badge on project rows.

**Web**: Store exposes `preprocessProject()`, `preprocessAll()`, `scanStaleness()`, `reprocessProject()`, `reprocessSession()`.

## Clerk agent

### LLM

Provider is inferred from the model name: `claude-*` → Anthropic (`@anthropic-ai/sdk`), `ollama:*` → Ollama (OpenAI-compatible API at `localhost:11434`), everything else → Gemini (`@google/genai`). All implement the `LLMProvider` interface defined in `src/clerk/llm-provider.ts`.

API keys per role for usage tracking: `{PROVIDER}_{ROLE}_API_KEY` > `{PROVIDER}_API_KEY` (e.g., `ANTHROPIC_CLERK_API_KEY` > `ANTHROPIC_API_KEY`). Ollama needs no key. Set `OLLAMA_BASE_URL` to override the default `http://localhost:11434`.

Example `.env` for local dev (no cloud API costs):
```
CLERK_MODEL=ollama:qwen3:8b
PROCESSOR_MODEL=ollama:qwen3:8b
```

The agent is a standard messages API conversation with tool use. Each architect message appends to the conversation, the full history is sent on each turn. The Gemini provider maintains a persistent `Chat` object across the agentic tool-use loop to preserve thought signatures automatically via the official SDK.

### Token optimization

Cache control breakpoints can be added to the Anthropic provider to reduce input token costs on repeated turns. The system prompt and conversation history before the current turn are good candidates for caching.

### System prompt

```
You are the Clerk, an orchestration and planning assistant for a software architect.

You have access to the complete history of all coding sessions in this project,
processed into searchable segments. You can recall what was discussed, what was
decided, and what was built — across all sessions and all days.

Your job:
- Answer questions about past work quickly and accurately
- Prepare plans and draft prompts for CC coding sessions
- Dispatch prompts to sessions when the architect says to
- Run errands (start a session to gather information) and report back

Your style:
- Be fast and concise
- Show user prompts verbatim — they are the source of truth
- Compress everything else
- Don't offer opinions or suggestions unless asked
- When the architect interrupts, drop what you're doing immediately
```

### Tools

#### Recall

**search_segments**
```ts
{
  name: "search_segments",
  description: "Search across all processed session segments by topic or content. Returns matching segments with their summaries and user prompts.",
  input: { query: string, limit?: number }
  output: Array<{
    sessionId: string, segmentIndex: number, topic: string,
    summary: string, userPrompts: string[], timeRange: [string, string]
  }>
}
```

**get_segment_detail**
```ts
{
  name: "get_segment_detail",
  description: "Get full detail of a specific segment including all user prompts, subagent launches, and the LLM summary.",
  input: { sessionId: string, segmentIndex: number }
  output: Segment
}
```

**get_raw_turns**
```ts
{
  name: "get_raw_turns",
  description: "Get raw conversation turns from the original JSONL file. Use sparingly — only when the processed segment doesn't have enough detail.",
  input: { sessionId: string, startTurn: number, endTurn: number }
  output: Array<{ index: number, role: string, text: string }>
}
```

**list_sessions**
```ts
{
  name: "list_sessions",
  description: "List all sessions in the project with their titles, dates, and segment topics.",
  input: {}
  output: Array<{
    sessionId: string, title: string | null, startedAt: string,
    endedAt: string, segmentTopics: string[]
  }>
}
```

#### Codebase

**read_file**
```ts
{
  name: "read_file",
  description: "Read a file from the project.",
  input: { path: string, startLine?: number, endLine?: number }
  output: string
}
```

**search_code**
```ts
{
  name: "search_code",
  description: "Search the codebase for a pattern.",
  input: { pattern: string, glob?: string, limit?: number }
  output: Array<{ file: string, line: number, text: string }>
}
```

**list_files**
```ts
{
  name: "list_files",
  description: "Find files matching a glob pattern.",
  input: { pattern: string }
  output: string[]
}
```

#### Session dispatch

**start_session**
```ts
{
  name: "start_session",
  description: "Start a new CC session with a prompt. Returns the session ID. Use this to dispatch prepared prompts or run errands.",
  input: { cwd: string, prompt: string, title?: string }
  output: { sessionId: string }
}
```

**send_to_session**
```ts
{
  name: "send_to_session",
  description: "Send a message to an existing idle CC session.",
  input: { sessionId: string, message: string }
  output: { success: boolean }
}
```

**get_session_state**
```ts
{
  name: "get_session_state",
  description: "Get the current state of a CC session: running, idle, or exited. If running, includes a brief description of what it's doing.",
  input: { sessionId: string }
  output: { state: string, lastActivity?: string }
}
```

## Protocol additions

### Client → Daemon

**clerk_message**
```ts
{ type: "clerk_message", cwd: string, text: string, conversationId?: string }
```
Send a message to the Clerk. If `conversationId` is omitted, starts a new conversation.

**clerk_interrupt**
```ts
{ type: "clerk_interrupt", cwd: string }
```
Interrupt the Clerk's current response. The agent stops generating, the partial response is kept in history.

**process_project**
```ts
{ type: "process_project", cwd: string }
```
Process all missing/error/outdated sessions in a project. Enqueued via `ProcessingQueue`.

**process_session**
```ts
{ type: "process_session", cwd: string, sessionId: string }
```
Process a single session. Dropped if a project job for the same cwd is already pending/running.

**process_all**
```ts
{ type: "process_all" }
```
Process all active (non-archived) projects. Resolves project list at execution time.

**delete_processing**
```ts
{ type: "delete_processing", cwd: string, sessionId?: string }
```
Delete processed data. If `sessionId` omitted, deletes all sessions for the project.

### Daemon → Client

**clerk_chunk**
```ts
{ type: "clerk_chunk", conversationId: string, text: string }
```
Streaming text chunk from the Clerk.

**clerk_tool_activity**
```ts
{ type: "clerk_tool_activity", conversationId: string, tool: string, description: string }
```
The Clerk is using a tool. For UI: "Searching past sessions...", "Reading src/relay/server.ts...", etc.

**clerk_done**
```ts
{ type: "clerk_done", conversationId: string }
```
The Clerk finished its response.

**clerk_error**
```ts
{ type: "clerk_error", conversationId: string, error: string }
```

## Implementation plan

### Phase 1: Preprocessor ✅

- JSONL parser (builds on existing `src/types/cc.ts`)
- Turn extractor (filters to user/assistant, strips tool calls)
- Day-based segmentation (group turns by calendar day)
- Summarization via LLM (provider-agnostic — Gemini or Anthropic)
- SegmentStore (read/write processed segments)
- Triggered when projects become active

### Phase 2: Agent core ✅

- Provider-agnostic LLM interface (`LLMProvider`) with Anthropic + Gemini adapters
- Clerk agent with system prompt and tool definitions
- Recall tools (search_segments, get_segment_detail, get_raw_turns, list_sessions)
- Codebase tools (read_file, search_code, list_files)
- ConversationStore (persist chat history)
- Provider inferred from model name, per-role API keys

### Phase 3: Session dispatch

- start_session and send_to_session tools
- Integration with daemon's session manager
- Errand tracking (know when a dispatched session finishes)

### Phase 4: Protocol + client

- clerk_message, clerk_interrupt, clerk_chunk, clerk_done in protocol types
- Client-side clerk chat UI (mobile and/or desktop)
- Interrupt handling (cancel in-flight API call)

## File layout

```
src/clerk/                        # Agent layer only — preprocessing is in @merlin/processor
  clerk.ts                        # top-level orchestrator, wired into daemon
  agent.ts                        # provider-agnostic agentic tool loop
  conversation-store.ts           # persist clerk chats
  tools/
    recall.ts                     # search_segments, get_segment_detail, get_raw_turns
    codebase.ts                   # read_file, search_code, list_files
    sessions.ts                   # (future) start_session, send_to_session, get_session_state

packages/processor/               # Extracted preprocessing pipeline
  src/
    processor.ts                  # orchestrator: parse → build → summarize → segment → store
    queue.ts                      # ProcessingQueue: concurrency, dedup, persistence
    processing-state.ts           # in-memory status tracking per session
    jsonl-parser.ts               # CC JSONL parser
    lean-session.ts               # builds LeanSession from parsed turns
    summarizer.ts                 # LLM summarization (provider-agnostic)
    segmenter.ts                  # day-based segmentation
    concept-extractor.ts          # per-task concept:description extraction
    store.ts                      # LeanSessionStore: read/write to disk
    schema.ts                     # Zod schemas for LeanTurn, SessionTask, etc.

packages/llm/                     # Extracted LLM providers
  src/
    provider.ts                   # LLMProvider interface
    gemini.ts, anthropic.ts, openai.ts, ollama.ts
```
