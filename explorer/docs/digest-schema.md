# Digest schema

Reference for `internal/model` (schema version 1). One JSON file per session. See
[PLAN.md](../PLAN.md) §5 for the rules behind it. `internal/model/schema_doc_test.go` fails
if a JSON key in the structs is missing from this file, so keep them in step.

Conventions: camelCase keys; timestamps RFC 3339 UTC (omitted when unknown); USD as
float64; token counts as int64; optional fields are omitted when empty. Every text is stored
whole, never truncated. Slices are ordered by time, then id. Nothing here is specific to one
harness.

## SessionKey

A session is identified by `(harness, id)`; `SessionKey.String()` gives `harness/id`.

| key | meaning |
|---|---|
| `harness` | which coding agent produced the session (`claude` today) |
| `id` | session id, unique within the harness |

## SessionDigest

| key | meaning |
|---|---|
| `schemaVersion` | version of this layout (`model.SchemaVersion`) |
| `parserVersion` | version of the parser that built it; a bump forces a rebuild |
| `source` | every file read, as `SourceFile`; this is the fingerprint |
| `error` | set on a stub written when building the digest failed; the stub keeps `source` so the session is retried only when its files change |
| `sourceMissing` | the source files have disappeared; the digest is kept as the ledger |
| `harness` | harness name, `claude` today |
| `id` | session id |
| `projectKey` | the harness's own storage key for the project |
| `project` | directory the session started in; the project's identity across harnesses |
| `cwd` | working directory at the end of the session (`project` is where it started) |
| `cwds` | every working directory seen, in order |
| `gitBranches` | every git branch seen, in order |
| `harnessVersions` | every harness version that wrote to the session, in order |
| `kind` | `interactive`, `sdk` (every record programmatic) or `background` |
| `title` | custom title, else generated title, else first line of the first prompt |
| `name` | session name given by the harness or user |
| `slug` | the harness's short slug for the session |
| `startedAt` | time of the first record |
| `lastActivityAt` | time of the last record |
| `endState` | how the last turn ended: `clean`, `interrupted`, `mid-turn`, `unknown` |
| `recaps` | the harness's own "where things stand" notes, as `Recap` |
| `lineage` | explicit fork and copy markers, as `Lineage` |
| `stats` | whole-session counters, as `Stats` |
| `cost` | attributed cost of the session including all agents, as `Cost` |
| `reported` | cost as reported by the harness, as `Reported`; never blended with `cost` |
| `compactions` | main-agent compactions, as `Compaction` |
| `turns` | the turns, as `Turn` |
| `agents` | flat list of sub-agents, as `Agent` |
| `messages` | one entry per billed API message, as `Message` |
| `diagnostics` | what the parser could not interpret, as `Diagnostics` |

## SourceFile

| key | meaning |
|---|---|
| `path` | absolute path of a file the digest was built from |
| `size` | its size in bytes when read |
| `mtimeNs` | its modification time in Unix nanoseconds when read |

## Recap

| key | meaning |
|---|---|
| `at` | when the recap was written |
| `text` | the recap, whole |

## Lineage

| key | meaning |
|---|---|
| `forkedFrom` | explicit fork marker, as `ForkRef`; absent when the session was not marked as a fork |
| `inheritedFrom` | ids of sessions that records were copied from, per explicit markers |

## ForkRef

| key | meaning |
|---|---|
| `sessionId` | the session forked from |
| `messageUuid` | the record in that session where the fork happened |

## Stats

| key | meaning |
|---|---|
| `humanTurns` | turns a person typed: origin `human` or `command`, abandoned ones excluded |
| `turns` | all turns |
| `assistantMessages` | distinct assistant API messages |
| `toolCalls` | tool calls made |
| `toolsByName` | tool calls per tool name |
| `linesAdded` | lines added, from the harness's own totals when present |
| `linesRemoved` | lines removed, from the harness's own totals when present |

## Cost (attributed)

Recomputed from token usage with the price table.

| key | meaning |
|---|---|
| `usd` | total dollars |
| `byModel` | per model, as `ModelCost` |

## ModelCost

Token counts are flattened beside `usd` (`Tokens`).

| key | meaning |
|---|---|
| `input` | uncached input tokens |
| `output` | output tokens, thinking included |
| `cacheRead` | cache-read tokens |
| `cacheWrite5m` | cache-write tokens with the 5-minute lifetime |
| `cacheWrite1h` | cache-write tokens with the 1-hour lifetime |
| `usd` | dollars for this model |

## Reported

| key | meaning |
|---|---|
| `totalUSD` | sum of the harness's own totals over `windows`; covers only those windows, not necessarily the whole session |
| `byModel` | per model, as `ReportedModel`, summed over `windows` |
| `windows` | the stretches of the session the harness reported on, as `ReportedWindow`, in time order |

## ReportedWindow

One process run of the harness: its cost counter started at `from` and was last written at `to`.
Spending outside every window was not reported and can only be attributed from token usage.

| key | meaning |
|---|---|
| `from` | when this run's cost counter started |
| `to` | timestamp of the last record before the counter was last written |
| `totalUSD` | the harness's total for this run |
| `byModel` | per model, as `ReportedModel` |

## ReportedModel

| key | meaning |
|---|---|
| `inputTokens` | input tokens as the harness reports them |
| `outputTokens` | output tokens |
| `thinkingTokens` | thinking tokens |
| `cacheReadTokens` | cache-read tokens |
| `cacheCreationTokens` | cache-write tokens (the harness does not split them by lifetime) |
| `webSearchRequests` | web searches |
| `usd` | dollars the harness reports for this model |

## Compaction

`postTokens` and `durationMs` are omitted when the harness did not record them.

| key | meaning |
|---|---|
| `at` | when the compaction happened |
| `turn` | index of the last turn started before the compaction; -1 if none |
| `trigger` | `auto` or `manual` |
| `preTokens` | context size before |
| `postTokens` | context size after |
| `durationMs` | how long the compaction took |
| `summary` | the summary text, whole; it is not a prompt and not a turn |

## Turn

| key | meaning |
|---|---|
| `index` | position among the session's turns, from 0 |
| `epoch` | number of compactions before this turn |
| `uuid` | uuid of the prompt record; lets the catalog match copied turns across sessions |
| `abandoned` | the turn is on a branch the session later rewound away from; its cost still counts |
| `startedAt` | time of the prompt |
| `endedAt` | time of the turn's last record |
| `durationMs` | duration of the turn |
| `origin` | who authored the prompt: `human`, `command`, `task-notification`, `peer`, `scheduled`, `sdk`, `continuation` |
| `userText` | the prompt, verbatim and complete |
| `images` | number of pasted images (image data is not stored) |
| `command` | slash command name, when `origin` is `command` |
| `finalText` | last assistant text of the turn, complete |
| `interrupted` | the user interrupted the turn |
| `assistantMessages` | assistant API messages of the main agent in this turn |
| `toolCalls` | tool calls of the main agent in this turn |
| `toolsByName` | tool calls per tool name |
| `filesTouched` | files read or changed by the turn's tool calls |
| `contextTokens` | context size at the end of the turn |
| `cost` | attributed cost of the main agent in this turn |
| `costWithAgents` | dollars including agents spawned in this turn |
| `spawned` | ids of agents spawned in this turn |

## Agent

| key | meaning |
|---|---|
| `id` | agent id |
| `kind` | `subagent`, `teammate`, `fork` or `compact` |
| `name` | teammate or given name |
| `agentType` | agent type, e.g. `general-purpose`, `Explore` |
| `description` | short description from the spawning call |
| `model` | model the agent ran on |
| `parentAgentId` | spawning agent's id; always present, `null` when spawned by the main agent |
| `spawnToolUseId` | id of the tool call that spawned it |
| `spawnTurn` | index of the turn that spawned it |
| `depth` | nesting depth; 1 for direct sub-agents |
| `background` | it ran in the background |
| `linkage` | how it was tied to its spawn: `meta`, `tool-result`, `name`, `prompt`, `unresolved` |
| `startedAt` | time of its first record |
| `endedAt` | time of its last record |
| `status` | `completed`, `killed` or `open` (no terminal marker in the files) |
| `prompt` | its first prompt, complete |
| `finalText` | its last assistant text, complete |
| `inbox` | later messages it received, as `InboxMessage` |
| `assistantMessages` | assistant API messages it made |
| `toolCalls` | tool calls it made |
| `toolsByName` | tool calls per tool name |
| `compactions` | its own compactions |
| `cost` | its own attributed cost |
| `subtreeUSD` | own dollars plus all descendants |

## InboxMessage

| key | meaning |
|---|---|
| `at` | when it arrived |
| `from` | sender, when known |
| `text` | the message, whole |

## Message

One billed API message. Token counts are flattened (`Tokens`: `input`, `output`,
`cacheRead`, `cacheWrite5m`, `cacheWrite1h`, as in `ModelCost`).

| key | meaning |
|---|---|
| `id` | the API message id; billed once globally |
| `at` | time of the message |
| `model` | model that produced it |
| `agentId` | agent that made it; omitted for the main agent |
| `turn` | index of the turn it belongs to, when any |
| `usd` | attributed dollars |

## Diagnostics

| key | meaning |
|---|---|
| `unknownTypes` | count of records per unknown record type |
| `badLines` | lines that could not be parsed |
| `unpricedModels` | models seen that have no price |
| `unresolvedAgents` | agents that could not be tied to their spawn |
