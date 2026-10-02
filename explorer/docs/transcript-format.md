# Claude Code transcript format — field notes

Empirical notes from surveying one real `~/.claude/projects` tree on 2026-10-01:
3,826 transcript files, 486k lines, 1.5 GB, 95 Claude Code versions (2.1.31 → 2.1.287).
Nothing here is an official contract. The format drifts between versions, so the
parser must be tolerant: unknown record types and unknown fields are skipped and
counted, never fatal.

Statements marked **(verified)** were measured on that corpus. Statements marked
**(assumed)** still need checking by whoever implements the relevant piece.

## 1. Files on disk

```
~/.claude/projects/<project-key>/
    <session-uuid>.jsonl                          main transcript (one per session)
    <session-uuid>/subagents/agent-<agentId>.jsonl       one per subagent
    <session-uuid>/subagents/agent-<agentId>.meta.json   subagent metadata (newer versions)
    <session-uuid>/tool-results/*                 spilled tool outputs (ignore)
    <session-uuid>/custom-title.json              (ignore; title is also in the transcript)
    memory/, vercel-plugin/, sessions-index.json  not transcripts (ignore)

~/.claude/sessions/<pid>.json     live-process registry written by Claude Code itself
```

- `<project-key>` is the cwd with `/` replaced by `-` (`-Users-zsolt-work-merlin`).
  It is lossy; take the real cwd from the `cwd` field of records.
- Only accept `*.jsonl` whose basename is a UUID as a main transcript. Other jsonl
  files exist (`vercel-plugin/skill-injections.jsonl`) and have unrelated shapes.
- A project directory can contain another project directory (seen once:
  `<proj>/-Users-zsolt-work-merlin/<uuid>/subagents/...`). Walk recursively and treat
  "a `subagents` directory under a UUID directory" as the pattern, wherever it is.
- **Orphans (verified):** 87 subagent files sit under a session directory whose main
  `<uuid>.jsonl` no longer exists (all from CC ≤ 2.1.71). The session still has to be
  indexed, built from its subagents alone.
- Agent file names: `agent-<hex16-17>.jsonl` (plain subagent), `agent-a<name>-<hex16>.jsonl`
  (named teammate), `agent-acompact-<hex>.jsonl` (compaction agent, old versions),
  `agent-a<hex7>.jsonl` (very old).
- Sizes: largest file 52 MB; **1,768 lines exceed 64 KB and 23 exceed 1 MB** (largest
  1.36 MB). Go's `bufio.Scanner` default buffer will fail on these — read with
  `bufio.Reader.ReadBytes('\n')` or an explicitly sized buffer.
- Files are mostly append-only but **not guaranteed to be**: the user runs a redaction
  script that rewrites transcripts in place. Detect rewrites; never assume append-only.
- A file being written can end in a partial line. Only consume lines terminated by `\n`.

## 2. Record envelope

Every line is one JSON object. Conversation records share an envelope:

| field | notes |
|---|---|
| `type` | `user`, `assistant`, `system`, `attachment`, `progress`, plus metadata types (§7) |
| `uuid`, `parentUuid` | record id and predecessor; forms a tree (rewinds create branches) |
| `timestamp` | RFC 3339 UTC |
| `sessionId` | always equals the file's session id — rewritten on copied records (verified: 0 mismatches) |
| `session_id` | present in some versions; when it differs from `sessionId` the record was inherited from that session |
| `isSidechain` | `true` in every subagent file, `false` in main files (verified: no sidechain records inside main files) |
| `agentId` | subagent files only; equals the file's agent id |
| `cwd`, `gitBranch`, `version`, `entrypoint`, `slug` | context; `cwd` can change mid-session (worktrees) |
| `sessionKind` | `"bg"` for background sessions |
| `forkedFrom` | `{sessionId, messageUuid}` on records copied in by an explicit fork |
| `isMeta`, `isCompactSummary` | flags on `user` records (§4, §6) |

`entrypoint` values: `cli` (interactive) and `sdk-cli` (programmatic `claude -p`).
**3,131 of 3,347 main transcripts are single-prompt `sdk-cli` sessions**; only ~200 are
interactive. The two populations must be separable everywhere.

## 3. Assistant records and token usage

`message` is an Anthropic API message: `id`, `model`, `content[]`, `stop_reason`, `usage`.
`requestId` is on the envelope.

**One API response is written as several lines** — one per content block — all with the
same `message.id`. (verified: 110k assistant lines, 55k distinct message ids; `usage`
differs between lines of the same message in 15k cases.)

> **Rule: group assistant lines by `message.id`; take `usage` from the last line; count
> the message once.** With this rule and the price table in §8, cost recomputed for 1,530
> SDK sessions matches Claude Code's own figure to the cent.

- `content[].type`: `text`, `thinking`, `tool_use` (and rarely `fallback`).
- `model: "<synthetic>"` marks locally generated messages (API errors, interruptions). No cost.
- `isApiErrorMessage: true` marks error placeholders.
- `usage` fields: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`,
  `server_tool_use.{web_search_requests, web_fetch_requests}`, `speed` (`standard`|`fast`),
  `service_tier`, `iterations[]`, `output_tokens_details.thinking_tokens`.
- `output_tokens` already includes thinking tokens.
- Context size at a given message = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
- `stop_reason`: `tool_use`, `end_turn`, `stop_sequence`, or `null` on non-final lines.

## 4. User records

`message.content` is a string or an array of blocks.

| shape | meaning |
|---|---|
| array containing `tool_result` (+ envelope `toolUseResult`) | tool output — not a prompt (22k) |
| string, or array of `text`/`image` | a prompt or an injected message (6.4k) |
| `isMeta: true` | harness-injected (caveats, skill bodies) — not a prompt |
| `isCompactSummary: true` | compaction summary (§6) — not a prompt |

Who authored a prompt:

- Newer versions carry `origin: {kind}` — `human`, `task-notification`, `peer`,
  `auto-continuation` — plus `promptSource` (`typed`, `queued`, `suggestion_accepted`,
  `sdk`, `system`) and `turnOrigin`.
- Older versions carry nothing; classify by text prefix:
  - `<task-notification>` — a background agent finished; not typed by the user
  - `<command-name>` / `<command-message>` — slash command; the command and its args are what the user typed
  - `<local-command-stdout>`, `<bash-input>`, `<bash-stdout>` — local command output / `!` shell
  - `[Request interrupted by user]`, `[Request interrupted by user for tool use]` — interruption marker
  - anything else — typed by the user

## 5. Subagents

Spawned by an `Agent` tool_use block in the parent (main or another subagent). Input keys:
`description`, `prompt`, optional `subagent_type`, `model`, `name`, `run_in_background`, `isolation`.

`agent-<id>.meta.json` (present for 417 of 488 agent files):

| key | notes |
|---|---|
| `agentType` | `general-purpose`, `Explore`, `fork`, a custom type, or the teammate's name |
| `description` | from the Agent tool input |
| `toolUseId` | the spawning `tool_use` id — direct parent link (121 files) |
| `spawnDepth` | 0 for teammates, 1 for direct subagents, 2+ nested |
| `parentAgentId` | present when spawned by another subagent (21 files) |
| `model` | alias (`sonnet`, `inherit`) |
| `name`, `teamName`, `taskKind: "in_process_teammate"`, `color` | teammates (276 files) |
| `isFork` | fork agents |

The parent's `tool_result` for the spawn carries envelope `toolUseResult`:

- `status: "completed"` — synchronous: `agentId`, `content`, `totalTokens`, `totalDurationMs`, `totalToolUseCount`, `usage`
- `status: "async_launched"` — background: `agentId`, `description`, `resolvedModel`, `outputFile`
- `status: "teammate_spawned"` — `name`, `team_name`, `agent_id` (`<name>@<team>`), `model`

Linking an agent file to its spawn, in priority order:

1. `meta.toolUseId` → the `tool_use` block with that id (verified: resolves for all 121)
2. `toolUseResult.agentId == <agentId>` on a tool_result → that result's `tool_use_id`
3. teammates: `meta.name` == `input.name` of an `Agent` tool_use in the same session (earliest unclaimed)
4. first prompt text of the agent file == `input.prompt` of an `Agent` tool_use
5. no link: attach to the session root and flag `linkage: "unresolved"`

The tool_use may be inside another subagent's file (nested); `meta.parentAgentId` says which.
Agent files with no meta (71) are all orphans from old versions.

Other subagent records: `progress` (bash progress; ignore), `fork-context-ref`
(`{agentId, parentSessionId, parentLastUuid, contextLength}` — a fork referencing its
parent's context instead of copying it), `system/compact_boundary` (subagents compact too).

## 6. Compaction

Two adjacent records, in main or subagent files:

```
{type:"system", subtype:"compact_boundary", parentUuid:null, logicalParentUuid:<last uuid before>,
 compactMetadata:{trigger:"auto"|"manual", preTokens, postTokens, durationMs,
                  cumulativeDroppedTokens, preservedSegment:{headUuid,anchorUuid,tailUuid}, ...}}
{type:"user", isCompactSummary:true, isVisibleInTranscriptOnly:true,
 message:{content:"This session is being continued from a previous conversation ..."}}
```

Measured over all 79 boundaries (46 files; 74 manual, 5 auto):

- **Compaction is append-only (verified).** The file keeps everything before the
  boundary — 77 of 79 boundaries have the earlier conversation in the same file. Only
  the model's context is reset (median 224k → 11k tokens).
- 2 boundaries are the first conversation record of their file: a session or agent that
  started from another one's compacted context.
- The summary record follows the boundary at offset +1 (76 cases) or +2 (2 cases); one
  boundary has no summary. Summary text: median 17k characters, max 35k.
- `preservedSegment` / `preservedMessages` are pointers to earlier records, not copies:
  of the uuids they name, 278 are before the boundary, 5 after, 99 not in the file.
- **`logicalParentUuid` does not resolve in 10 of 79 cases.** Order by file position;
  never follow it.
- **3 files contain repeated record uuids** (546 uuids). Skip a record whose uuid was
  already seen in the same file.
- `postTokens` / `cumulativeDroppedTokens` are missing in older versions.
- One main session compacted 9 times. Subagent files compact too (5 boundaries).
- Old versions wrote the compaction call as `agent-acompact-*.jsonl`. Recent versions do
  not appear to record its usage anywhere in the transcript (to be confirmed).

## 7. Metadata records (no `uuid`, no envelope)

| type | use |
|---|---|
| `ai-title` `{aiTitle}`, `custom-title` `{customTitle}` | session title; custom wins; last one wins |
| `agent-name` `{agentName}` | session name |
| `last-prompt` `{lastPrompt, leafUuid}` | last prompt text and the active leaf |
| `cost-state` | Claude Code's own running totals (§8) |
| `worktree-state`, `relocated` `{relocatedCwd}` | cwd moves |
| `system/away_summary` `{content}` | Claude Code's own recap of where things stand — free "where did I leave off" text |
| `system/turn_duration` `{durationMs, messageCount}` | end-of-turn marker |
| `system/agents_killed`, `system/api_error`, `system/model_refusal_fallback` | events |
| `queue-operation`, `mode`, `permission-mode`, `atis-latch`, `bridge-session`, `file-history-*`, `frame-link`, `artifact-*`, `agent-setting`, `agent-color` | ignore |

`attachment` records (hook results, reminders, environment, file edits) make up half of
all lines. Ignore them.

## 8. Cost

### Price table ($ per million tokens)

| model | input | output | cache read | status |
|---|---|---|---|---|
| `claude-fable-5-1` | 10 | 50 | 0.25 | verified against `cost-state` |
| `claude-fable-5` | 10 | 50 | 1.00 | verified against `cost-state` (5 of 6 windows exact to the cent) |
| `claude-opus-5-5` | 4 | 20 | 0.20 | verified |
| `claude-opus-5` | 5 | 25 | 0.50 | verified |
| `claude-opus-4-8`, `-4-7`, `-4-6` | 5 | 25 | 0.50 | cache read assumed |
| `claude-sonnet-5-5` | 2 | 10 | 0.20 | cache read from docs |
| `claude-sonnet-5` | 2 | 10 | 0.20 | verified |
| `claude-sonnet-4-6` | 3 | 15 | 0.30 | cache read assumed |
| `claude-haiku-4-5-20251001` | 1 | 5 | 0.10 | verified (input/output) |

- Cache write = input price × 1.25 for `ephemeral_5m`, × 2 for `ephemeral_1h` (verified:
  main sessions write 1h, subagents write 5m).
- Cache read is **not** a fixed fraction of input; it is per model.
- `usage.speed == "fast"` doubles the price (opus 5 / 5.5 / 4.8 only) (assumed).
- `cost-state.modelUsage` keys can carry a `[1m]` suffix (`claude-opus-5-5[1m]`); strip it.
- A model missing from the table must be reported as unpriced, not priced at zero silently.

### `cost-state` records

```
{type:"cost-state", totalCostUSD, startTime, totalAPIDuration, totalLinesAdded, totalLinesRemoved,
 modelUsage:{<model>:{inputTokens, outputTokens, thinkingTokens, cacheReadInputTokens,
                      cacheCreationInputTokens, webSearchRequests, costUSD}}}
```

- Written at certain moments (at least on exit) by CC ≥ ~2.1.250. Present in 74
  interactive and 1,530 SDK sessions here. The record has no timestamp; its position in
  the file is the only clue to when it was written.
- It is a running total for one **process run**, which starts at `startTime` (epoch ms).
  A resumed session usually restores the counter and keeps the same `startTime`
  (verified: totals never decrease while `startTime` is unchanged). A run that does not
  restore it gets a new `startTime` and starts again near zero (1 session).
- So a session has one **window** per distinct `startTime`: from `startTime` to the
  timestamp of the last record before that window's last `cost-state`. The window's
  total is its last record. **Spending outside every window is not reported at all**:
  before the first window (runs on an older CC, or runs that never wrote a record),
  between windows, and after the last write (a live or crashed run).
- Includes subagents and calls that never appear in any transcript (a haiku line is
  always present; no haiku message is).

### How close is transcript-derived cost?

Recomputing from transcripts (main + subagents) and comparing with `cost-state`:

| population | reported | recomputed | ratio |
|---|---|---|---|
| 1,530 SDK sessions | $32.41 | $32.41 | 1.000 |
| 74 interactive sessions, whole session | $2,682.89 | $2,630.26 | 0.980 — misleading, see below |
| 74 interactive sessions, inside reported windows only | $2,682.89 | $2,484.99 | 0.926 overall; per session median 0.934, 10th percentile 0.861, never above 1.0 |

The whole-session comparison mixes two effects that pull in opposite directions:

- **Inside a window the transcript always undercounts**, by ~7%. Output tokens match
  within ~1%; the shortfall is cache-read and input tokens, i.e. requests that are billed
  but not written to a transcript. Measured in `validation.md`: about a quarter is output
  tokens truncated on agent messages whose last line has `stop_reason: null`, about half is
  main-model calls that track recaps, about a quarter is calls of background subagents; the
  compaction call is under 3%.
- **Outside the windows nothing is reported.** Of the $2,630 recomputed, $145 falls
  outside every window: $113 before the first (sessions begun on a CC version without
  `cost-state`, or in a run that left no record), $30 between two windows (a run that
  spent $30 after its last write, then a fresh run), $2 after the last write (a session
  that is still running). Five sessions are affected; in the worst the reported total is
  $2.66 against $31 actually spent.

Every session whose recomputed cost exceeded the reported one is explained by spend
outside the windows. There is no evidence of an overpriced table entry.

### Double counting across files (verified)

Assistant records with the same `uuid`, `message.id` and `timestamp` appear in more than
one file: 2,115 duplicate records across 21 file pairs.

- Resumed, forked or background-continued sessions start with a copy of the earlier
  session's history. Only some copies are marked: `forkedFrom` on 256 records,
  `session_id != sessionId` on 120, **no marker at all on 1,240**.
- Fork subagents share records with sibling subagents in the same session (499 records, no marker).

> **Rule: a `message.id` is billed once, globally.** Summing per-file costs overstates.

## 9. Branching and forking

Measured on the 197 interactive sessions.

### Inside one file: rewinds, edits, retries

Records form a tree through `parentUuid`. Attachment records are part of the chain, so
the tree must be built from **all** records with a uuid, not only user/assistant ones;
across a compaction, follow `logicalParentUuid`. Built that way, almost every session is
a single tree (201 roots for 197 sessions; 5 dangling parents).

- A branch point is a record with two or more children whose subtrees each contain a
  prompt or an assistant line. 136 branch points in 62 sessions.
- The side branches are small here: median 1 conversation record, max 6, never more than
  3 assistant lines. Typically a prompt that was replaced before or just after the
  response started. Larger abandoned branches are possible in principle (rewinding
  several turns) but do not occur in this corpus.
- `last-prompt.leafUuid` names the active leaf. It is present and resolves in all 197
  sessions, but it is only written at certain moments, so the last conversation record
  in the file is the safer leaf.
- Per session, the share of assistant messages off the active path: median 0, p90 1%.
- Parallel tool calls also give a record several children, but only one child subtree
  continues the conversation, so they are not branch points under the definition above.

### Between files: forks and continuations

A new session file can begin with a copy of another session's records. Copies keep the
original `uuid`, `message.id` and `timestamp`; `sessionId` is rewritten to the new file.
Nine pairs of main sessions share history:

| marker on the copied records | pairs | notes |
|---|---|---|
| `forkedFrom: {sessionId, messageUuid}` | 2 | explicit fork (CC 2.1.116); the parent kept going afterwards |
| `session_id` ≠ `sessionId` | 1 | continued as a background session, starting from a compaction summary |
| none | 6 | 4 mix `cli` and `sdk-cli` records in the copy; 1 moved to background with the parent stopping; 1 old unmarked fork whose parent kept going |

- Whether the parent has its own records after the copy point separates a fork (both
  continue) from a continuation (the parent stops).
- **Which side is the copy.** A copy is a snapshot, so a child holds nothing dated
  before the copy point that its parent lacks. If one session has messages of its own
  (its subagents included — a copy does not carry subagent files) dated before the
  latest shared message and the other has none, the first is the parent. Checked on all
  nine pairs: it decides five and is never wrong; the other four are decided by a marker
  or by which session stopped first.
- **The entrypoint does not identify the copy.** In the pair examined, the copied records
  were stamped `sdk-cli` and the new ones `cli`. Timestamps are kept by a copy, so both
  sessions appear to start at the same moment.
- A copy is not always the whole parent: 46–100% of the parent's records were copied in
  these pairs (after a compaction only the tail is carried over).
- Because some sessions mix entrypoints, "scripted" must mean *every* record is
  `sdk-cli`, not just the first one.

### Fork subagents

Agent meta `isFork: true` / `agentType: "fork"` (12 files): a subagent that inherits its
parent's context. Newer versions write a `fork-context-ref` record pointing at the parent
context instead of copying it; older ones share message ids with sibling agent files.

## 10. Live-session signals

- `~/.claude/sessions/<pid>.json`: `{pid, sessionId, cwd, startedAt, kind, entrypoint, name,
  status: "busy"|"idle", updatedAt, ...}`. Written by Claude Code; removed on exit. Check
  the pid is alive before trusting it. Version-dependent — treat as optional.
- Hooks receive JSON on stdin with `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, and for `SubagentStop` also `agent_id` / `agent_transcript_path`
  (confirmed against the hooks documentation; see [hooks.md](hooks.md)). `SubagentStop`'s
  documented example omits `transcript_path` and `cwd`.
- **SessionStart hook stdout is injected into the model's context.** A hook used for
  notification must print nothing and exit 0.
