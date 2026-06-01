# @merlin/cc — Library Interface

Claude Code integration package. Discovers CC projects and sessions from disk, scans running processes, reads session lockfiles, and manages CC subprocess sessions via the `claude` CLI.

## Discovery (read-only)

Three parallel discovery mechanisms feed into the daemon's model builder:

| Export | Purpose |
|--------|---------|
| `ClaudeProjectDiscovery` | Discovers historical sessions from `~/.claude/projects/**/*.jsonl` |
| `ProcessScanner` | Finds running `claude` processes via `/proc` (Linux) or `lsof`/`ps` (macOS) |
| `SessionLockfileReader` | Reads `~/.merlin/sessions/<pid>.json` lockfiles from CC hooks |

### Discovery types

| Type | Description |
|------|-------------|
| `DiscoveredFolder` | Discovered project with path, cwd, sessions array |
| `ProcessHit` | Running process: pid, binaryName, optional sessionId |
| `SessionLock` | Lockfile entry: sessionId, pid, cwd, startedAt |

## Session Management

| Export | Purpose |
|--------|---------|
| `CCSession` | Spawns and controls a `claude --output-format stream-json` subprocess |
| `spawnCCSession(opts, jsonlPath?)` | Factory: create + optional history preload + start |

### Session types

| Type | Description |
|------|-------------|
| `CCSessionOptions` | Constructor config: id, workingDirectory, resumeSessionId, etc. |
| `CCSessionObserver` | Observer callbacks: onStateChange, onData, onExit |
| `StateChangeEvent` | Session state transition event |
| `SpawnOptions` | Factory config: id, cwd, ccSessionId |
| `SpecialKey` | Terminal key events (ctrl-c, enter, etc.) |

## Shared Types & Schemas

All schemas have corresponding Zod runtime validators (`*Schema`).

| Type | Description |
|------|-------------|
| `SessionSummary` | Session metadata: id, title, timestamps, size, turn count, subagent count, preprocessing status |
| `SessionState` | Session lifecycle: starting, idle, busy, waitingForInput, offeringChoices, exited |
| `PendingApproval` | Tool approval request: toolName, toolInput, options |
| `PendingQuestion` | User question from AskUserQuestion tool |
| `PreprocessingStatus` | Processing state enum: pending, processing, processed, outdated, error |

### CC event types (interfaces, no Zod)

| Type | Description |
|------|-------------|
| `CCEvent` | Base event from CC stream-json output |
| `CCJSONLEntry` | Raw JSONL line shape from `~/.claude/projects/` |
| `CCContentBlock` | Text, tool_use, or tool_result content block |

## Utilities

| Export | Description |
|--------|---------|
| `RollingBuffer` | Fixed-capacity circular string buffer (used for context lines) |

## Conventions

- Import from `@merlin/cc` — the barrel re-exports the public API.
- Do not import from `@merlin/cc/src/...` directly.
- Types re-exported by `src/types/model.ts` in the main project for backwards compatibility.
