# Architecture

## Packages

| Package | Role |
|---------|------|
| `@merlin/protocol` | Shared Zod schemas + types: world model (`MerlinModel`, `Project`, `ActiveSession`) and wire protocol (`ClientMessage`, `DaemonMessage`) |
| `@merlin/cc` | Claude Code interaction: session spawning (`CCSession`), project discovery (`ClaudeProjectDiscovery`), process scanning, session lockfiles |
| `@merlin/processor` | Session digestion: parse raw JSONL into lean sessions, segment by day, summarize via LLM, identify tasks. Includes `ProcessingQueue` (concurrency, dedup, persistence) and `ProcessingState` (status tracking) |
| `@merlin/sync` | State synchronization: shadow copies per client, JSON Patch (RFC 6902) diffing, generic `SyncStore` interface |
| `@merlin/relay` | Encrypted transport: AES-256-GCM WebSocket relay, ECDH key exchange, pairing flow, relay server |
| `@merlin/llm` | Pluggable LLM backends: Gemini, Anthropic, OpenAI, Ollama |
| `@merlin/ignore` | `.merlinignore` file support |

## Daemon layers

```
src/
  daemon.ts              orchestrator (~280 lines) — wires layers, dispatches messages
  discovery/             Layer 1: what exists on this machine
  processing/            Layer 2: derived data from raw sessions
  gateway/               Layer 3: client access & connectivity
  sessions/              Layer 4: interactive Claude process control
  clerk/                 Layer 5: AI actor — study-mode chat grounded in processed sessions
```

**Discovery** scans the host every 5s: Claude's JSONL files, running processes, session lockfiles, user preferences (archive/collapse). Produces a `MerlinModel` — the canonical world state.

**Processing** digests raw sessions into lightweight representations (lean turns, segments, tasks) with smart caching via fingerprints. Queue manages concurrency (max 2 jobs), deduplication, and persistence across restarts.

**Gateway** bridges the daemon to clients (web, mobile, TUI). SyncEngine sends incremental JSON Patches on state changes. RelayConnectors handle encrypted transport. DataHandlers serve session data on request.

**Sessions** spawns and controls live Claude Code processes on behalf of clients. Wires process output into the world model so discovery and sync propagate it.

**Clerk** is the AI actor layer (study mode). It runs a tool-using LLM agent, scoped per project, that answers questions grounded in the processed session data — recall across all of a project's sessions. Enabled when `CLERK_MODEL` is set; streamed to clients over the gateway. See [DESIGN-CLERK.md](DESIGN-CLERK.md).

## Data flow

```
Raw JSONL (~/.claude/projects/...)
  │
  ├─▶ Discovery → MerlinModel (projects, sessions, ownership)
  │     │
  │     └─▶ SyncEngine → JSON Patches → clients
  │
  └─▶ Processor → ~/.merlin/projects/... (lean sessions, segments, tasks)
        │
        └─▶ ProcessingState → merged into MerlinModel on refresh
```
