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
| `harness` | which coding agent produced the session: `claude` (Claude Code) or `codex` (Codex CLI) |
| `id` | session id, unique within the harness |

## SessionDigest

| key | meaning |
|---|---|
| `schemaVersion` | version of this layout (`model.SchemaVersion`) |
| `parserVersion` | version of the parser that built it; a bump forces a rebuild |
| `source` | every file read, as `SourceFile`; this is the fingerprint |
| `error` | set on a stub written when building the digest failed; the stub keeps `source` so the session is retried only when its files change |
| `sourceMissing` | the source files have disappeared; the digest is kept as the ledger |
| `harness` | harness name, `claude` or `codex` |
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
| `workflows` | the workflow runs launched in the session, as `WorkflowRun`, ordered by start time |
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
| `messageUuid` | the record in that session where the fork happened (Codex: the id of the last turn the fork copied); empty when the harness does not say |

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
| `truncatedMessages` | how many of the summed messages are `truncated` (see `Message`); when non-zero, `usd` is a lower bound |

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
| `boilerplate` | the parts of `summary` the harness writes into every summary, as `TextSpan`; search skips them, `summary` itself stays whole; omitted when none were recognised |
| `summary` | the summary text, whole; it is not a prompt and not a turn |
| `call` | what the call that wrote the summary cost, as `CompactionCall`: an estimate, for a harness that does not record that call (Claude Code), or a description of the recorded call when `messageId` is set (Codex); omitted when the context size or the model's price is unknown |
| `messageId` | the billed message of the call that wrote the summary, for a harness that records it (Codex); that message is in `messages` and in the totals like any other |

## CompactionCall

The cost of a compaction's API call: the whole context as input, the summary as output.

- **Estimated** (Claude Code, `messageId` absent): never part of a recomputed total (`cost`,
  `turns[].cost`). Inside a reported window it is part of what the harness reported, as
  overhead; outside, it is in no figure at all. Validated against Claude Code's own totals
  (format notes §6a).
- **Recorded** (Codex, `messageId` set): the figures are that message's, which is in the totals
  like any other. `cache` is `cold` when less than half of the context came from the cache.

| key | meaning |
|---|---|
| `model` | the model of the main agent's previous call, which the compaction uses |
| `idleMs` | time since the agent's previous API call |
| `cache` | `warm` (the context was read from the cache) or `cold` (it was read again at full price); estimated from `idleMs` and the cache lifetime, or seen in the recorded call |
| `billing` | how the context was charged: `cache-read`; for a cold call `input` (Codex; Claude Code 2.1.269 and later) or `cache-write-1h` / `cache-write-5m` (earlier Claude Code versions, at the lifetime in use) |
| `inputTokens` | the context size before the compaction (`preTokens`) |
| `outputTokens` | the summary in tokens: from its length in characters, or recorded |
| `usd` | the estimate, or the recorded message's cost |
| `warmUSD` | what the same call would have cost had the cache been warm |

## TextSpan

A stretch of a text, as UTF-8 byte offsets.

| key | meaning |
|---|---|
| `from` | first byte of the span |
| `to` | first byte after the span |

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
| `userText` | the prompt as its author wrote it, complete. For a command, what was typed. For a prompt a machine delivered, only what was not recognised as a message or as the harness's own framing (normally nothing): the messages are in `inbox` |
| `inbox` | the messages a machine delivered as this prompt, as `InboxMessage`, in order; omitted for a typed prompt |
| `queued` | the prompts that arrived while the turn was running, as `QueuedPrompt`, in order; they start no turn |
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
| `kind` | what started it: `subagent` (a tool call of another agent), `compact`, `workflow` (an agent of a workflow run: started by the run's script, not by a tool call of its own), `review` (a code review the harness ran on the user's request, Codex `/review`) or `approval-review` (a call the harness made to judge whether an action needs the user's approval). Schema 1 also had `teammate` and `fork`: read them as `subagent` with `addressable` / `inheritsContext` |
| `name` | teammate or given name |
| `agentType` | agent type, e.g. `general-purpose`, `Explore` |
| `description` | short description from the spawning call |
| `model` | model the agent ran on |
| `inheritsContext` | it started with a copy of its parent's conversation rather than with only its prompt (a fork, and every kind `compact`: a compaction call is given the conversation to summarise); omitted when false |
| `addressable` | it could be sent more work after its launch (a Claude Code teammate, every Codex subagent), or was: another agent or the user sent it a message or a task (`inbox` holds one of kind `message` or `assignment`); omitted when false |
| `parentAgentId` | spawning agent's id; always present, `null` when spawned by the main agent |
| `spawnToolUseId` | id of the tool call that spawned it |
| `spawnTurn` | index of the turn that spawned it |
| `depth` | nesting depth; 1 for direct sub-agents |
| `background` | it ran in the background |
| `linkage` | how it was tied to its spawn: `meta`, `tool-result`, `name`, `prompt`, `run` (its directory names a workflow run a tool call launched), `unresolved` |
| `runId` | the workflow run it belongs to, for kind `workflow` |
| `phase` | the phase of the run its script put it in |
| `startedAt` | time of its first record |
| `endedAt` | time of its last record |
| `status` | `completed`, `killed` or `open` (no terminal marker in the files) |
| `prompt` | its first prompt, complete (for kind `compact`, the last: the instruction to summarise what came before); when it arrived as a delivered message, that message's text; for a workflow agent, the task its script computed, without the harness's frame |
| `promptEncrypted` | `true` when the harness keeps the prompt only encrypted (Codex 0.164 encrypts what agents send each other); `prompt` is then absent |
| `finalText` | its last assistant text, complete |
| `inbox` | later prompts it received, as `InboxMessage`, including those that arrived in the middle of a turn; a prompt that is not a delivered message is one entry of kind `message` with no sender |
| `assistantMessages` | assistant API messages it made |
| `toolCalls` | tool calls it made |
| `toolsByName` | tool calls per tool name |
| `compactions` | its own compactions |
| `turns` | its stretches of work, as `AgentTurn`, in order: the task it was started with, then each message or task that set it working again |
| `cost` | its own attributed cost |
| `subtreeUSD` | own dollars plus all descendants |

## AgentTurn

One stretch of work of an agent: from the task or message that set it working to the answer it
stopped with. The harness's "keep going" nudges (continuations) belong to the turn they continue.
What comes before the agent's own prompt (a fork's copy of its parent's conversation, a workflow
agent's relayed request) is part of the first turn: its tool calls count there, its texts do not.
The turns' messages, tool calls and costs add up to the agent's.

| key | meaning |
|---|---|
| `index` | position among the agent's turns, from 0 |
| `startedAt` | time of the prompt that started it |
| `endedAt` | time of its last record |
| `origin` | `spawn` for the first turn; later, who authored the prompt, as in `Turn.origin` |
| `prompt` | what it was asked: for the first turn the agent's `prompt`; later, the prompt as its author wrote it (delivered messages are in `inbox`, as with `Turn.userText`) |
| `promptEncrypted` | the first turn's prompt is encrypted, as `Agent.promptEncrypted` |
| `inbox` | the messages that started it, as `InboxMessage`; for the first turn, those delivered with the prompt after the first |
| `queued` | prompts that arrived while it ran, as `QueuedPrompt` |
| `finalText` | its last assistant text, complete |
| `interrupted` | it was interrupted |
| `rootTurn` | the main agent's turn this work belongs to. For the first turn of an agent the main agent spawned, its spawn turn; otherwise the turn that set it off when the harness records it, else the main turn running when it started (the last one started at or before it). Omitted when unknown |
| `assistantMessages` | API messages the agent billed in it |
| `toolCalls` | tool calls it made |
| `toolsByName` | tool calls per tool name |
| `cost` | attributed cost of its messages |

## QueuedPrompt

A prompt that arrived while a turn was running: a message the user typed without waiting for
the answer, or one a machine delivered. The agent reads it in the middle of the turn.

| key | meaning |
|---|---|
| `at` | when it arrived |
| `origin` | who authored it, as in `Turn.origin` (`human`, `task-notification`, `peer`) |
| `text` | the prompt as its author wrote it, complete; for a delivered prompt only what was not recognised, as in `Turn.userText` |
| `inbox` | the messages a machine delivered, as `InboxMessage` |

## WorkflowRun

One run of a workflow script, launched by one tool call. Its agents are in `agents` with
`runId` set; they are spawned by the launching turn.

| key | meaning |
|---|---|
| `id` | the run id |
| `name` | the workflow's name |
| `summary` | its one-line description |
| `taskId` | the id the run's task notification carries (`InboxMessage.taskId`) |
| `toolUseId` | the tool call that launched it; omitted when the launch was not found in the files |
| `turn` | the main agent's turn it was launched in; when an agent launched it, that agent's spawn turn |
| `agentId` | the agent that launched it; omitted for the main agent |
| `startedAt` | time of the launch, else of its first agent's first record |
| `endedAt` | time of its closing notification, else of its agents' last record |
| `status` | how the harness said it ended (`completed`, `failed`, `killed`), or `open` when the files hold no such notice |
| `agents` | how many agents it ran |
| `usd` | attributed dollars of its agents and everything below them |

## InboxMessage

One message an agent received that nobody typed. The harness wraps these in markup of its
own and adds instructions for the model; the digest stores the message and drops the
wrapping. Texts are whole.

| key | meaning |
|---|---|
| `at` | when it arrived |
| `kind` | `message` (text written by another agent), `idle` (a teammate stopped and is waiting), `task` (a background agent, command or monitor reported), `assignment` (a task was assigned to the receiver) |
| `from` | sender's name as the harness gives it, when known |
| `agentId` | the agent of this session that sent the message (matched by name) or that a `task` message is about; omitted when none was identified |
| `taskId` | the harness's id of the task, for `task` and `assignment` |
| `status` | `idle`: why the teammate stopped (`available`, `failed`); `task`: how it ended (`completed`, `failed`, `killed`); omitted when none was given |
| `summary` | the sender's or harness's one-line summary |
| `text` | the message, whole. `idle`: the teammate's last answer; `task`: the task's result or the event a monitor saw; `assignment`: the task's description |
| `error` | the failure the sender reported, when it stopped because of one |
| `encrypted` | `true` when the harness keeps the text only encrypted (Codex, between agents); `text` is then absent |

## Message

One billed API message. Token counts are flattened (`Tokens`: `input`, `output`,
`cacheRead`, `cacheWrite5m`, `cacheWrite1h`, as in `ModelCost`).

| key | meaning |
|---|---|
| `id` | the API message id; billed once globally |
| `at` | time of the message |
| `model` | model that produced it |
| `agentId` | agent that made it; omitted for the main agent |
| `turn` | index of the turn it belongs to, when any; for an agent's message, the main turn its top-level ancestor was spawned in |
| `agentTurn` | for an agent's message, the index of the agent's turn (`Agent.turns`) it belongs to |
| `usd` | attributed dollars |
| `truncated` | the harness wrote the message down before it finished (its last line has a null `stop_reason`), so its `output` count is partial and `usd` a lower bound; omitted when false |
| `fast` | the call was made in fast mode (Claude Code's fast speed, Codex's `priority` service tier); the prompt cache is not shared between fast and standard calls; omitted when false |

## Diagnostics

| key | meaning |
|---|---|
| `unknownTypes` | count of records per unknown record type |
| `badLines` | lines that could not be parsed |
| `unpricedModels` | models seen that have no price |
| `unresolvedAgents` | agents that could not be tied to their spawn |
