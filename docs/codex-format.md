# Codex rollout format

What `internal/codex` reads from `$CODEX_HOME` (default `~/.codex`) and how it becomes a digest.
Observed on Codex CLI 0.164 (October 2026) by a read-only scan of field names and counts on one
machine; the public corpus (see [Corpus](#corpus)) holds no 0.164 rollout, only 0.116 and
0.137-alpha, so every 0.164-only claim below is still one machine's. Older rollouts (0.10x–0.14x)
have a different shape and are indexed as far as it overlaps (see [Older rollouts](#older-rollouts)).

## Files

- `sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`: one file per **thread** (a
  conversation of one agent). The user's conversation and every subagent, review and approval
  reviewer is a thread of its own.
- `session_index.jsonl`: one line per rename, `{"id", "thread_name", "updated_at"}`; the last
  line for an id wins. It is the session title, so it is part of every session's fingerprint.
- `state_5.sqlite`, `thread_history_1.sqlite`, `logs_*.sqlite`: Codex's own indexes. Not read.

## Records

Every line is `{"timestamp", "type", "ordinal", "payload"}`. `ordinal` numbers the records of a
thread; a fork continues its parent's numbering.

| type | payload | used for |
|---|---|---|
| `session_meta` | `id` (thread), `session_id` (the tree's root thread), `parent_thread_id`, `source`, `cwd`, `cli_version`, `originator`, `git.branch`, `agent_nickname`, `agent_path`, `forked_from_id`, `history_base`, `subagent_history_start_ordinal` | identity, tree, lineage, copied history |
| `turn_context` | `turn_id`, `model`, `effort` (null = the model's default), `cwd` | the model and effort of a turn |
| `event_msg/task_started` | `turn_id`, `turn_attribution.{parent_turn_id, turn_trigger}` | a turn starts; which parent turn set it off |
| `event_msg/task_complete` | `turn_id`, `duration_ms`, `last_agent_message`, `error.codex_error_info` | a turn ends (with an error such as `usage_limit_exceeded`) |
| `event_msg/turn_aborted` | `turn_id`, `reason` (`interrupted`) | a turn was interrupted (Esc, or `interrupt_agent`) |
| `event_msg/thread_settings_applied` | `thread_settings.{model, reasoning_effort, service_tier}` | fast mode: `service_tier: priority` appears only here |
| `event_msg/item_completed` | `item.type`: `UserMessage` (typed prompt, `local_image` parts), `AgentMessage` (`phase` commentary / final_answer), `FileChange` (`changes`: path → `add` with `content`, `update` with `unified_diff`, `delete`), `EnteredReviewMode`, `CommandExecution`, `McpToolCall`, `SubAgentActivity`, `CollabAgentToolCall`, `ContextCompaction`, … | prompts, final answers, files and lines changed, review turns |
| `event_msg/patch_apply_end` | `call_id`, `turn_id`, `status`, `success`, `changes` (the same entries as `FileChange`: path → `add` with `content`, `update` with `unified_diff`, `delete`, `move_path`) | the older form of `FileChange` (0.137–0.142): files and lines changed. It counts when `status` is `completed` (or empty) and `success` is not `false`; a missing `success` is not a failure. Every path is an edit in the turn's work directories whatever the outcome. Credited to the turn named by `turn_id`, else the current one |
| `event_msg/token_count` | `info.{last_token_usage, total_token_usage, model_context_window}` (null before the first call) and plan rate limits | not used when the thread has `token_usage_record`s (they carry the same numbers); otherwise each one whose running total changed is one call (see Tokens) |
| `event_msg/user_message`, `agent_message` | `message`, `images`, `local_images`, `text_elements`; `message`, `phase` | the older form of `item_completed` `UserMessage` / `AgentMessage` (0.116, 0.137): prompts and `final_answer` texts |
| `token_usage_record` | `response_id`, `turn_id`, `thread_id`, `usage`, `turn_token_usage`, `thread_token_usage` | **one billed API call** |
| `response_item/custom_tool_call`, `function_call` | `name`, `call_id`, `arguments` | tool calls; `spawn_agent`, `followup_task`, `send_message`, `interrupt_agent` arguments |
| `response_item/agent_message` | `author`, `recipient` (agent paths), `content` | messages between threads |
| `compacted` | `compaction_response_id`, `window_number`, encrypted replacement history | a compaction |
| `world_state`, `inter_agent_communication_metadata`, other `response_item`s | | ignored |

Any other record type is counted in `diagnostics.unknownTypes` (as `type` or `type/payload.type`).
So are an `item_completed` item of another type (`item_completed/<type>`; `(none)` when the payload
has no item), a `UserMessage` content part (`item_completed/UserMessage/<type>`), a `FileChange`
that is not `add`, `delete` or `update` (`item_completed/FileChange/<kind>`), a subagent source of a
kind the parser does not know (`session_meta/source/other`), and a fork whose parent or history base
is not on disk (`fork/parent_missing`, `fork/history_base_missing`). `McpToolCall`,
`SubAgentActivity`, `CollabAgentToolCall`, `ContextCompaction`, `Reasoning`, `FunctionCallOutput`
and `ExitedReviewMode` items are known and ignored (other records carry them). On one machine's 0.164
rollouts the remaining unknown item types are `Extension` and `ImageView`.

### Tokens

`usage` is `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
reasoning_output_tokens, total_tokens}`. Cached input is part of `input_tokens`, reasoning part
of `output_tokens`, and `total = input + output`. The sum of a thread's records equals its last
`thread_token_usage` (checked on every recent thread of one machine; the corpus can check only the
older form: 2 of 2 threads with `token_count` info hold, see Corpus run). A message is priced as `input = input -
cached`, `cacheRead = cached`, `output = output`. `cache_write_input_tokens` has always been 0
and is not used (the corpus's `token_count` usage objects have no such field: 0 of 6).

**Without `token_usage_record`** (0.116, 0.137) a call is a `token_count` whose `info.total_token_usage.total_tokens`
differs from the previous event's; its tokens are `info.last_token_usage` and its id is
`<thread id>#token_count<n>`. Codex repeats an event when nothing was billed in between, and writes
`info: null` first. On the two corpus threads that carry the info, the sum of these `last_token_usage`
equals the final `total_token_usage` (input, cached input and output) and the digest's token totals
equal it too.

Prices are OpenAI's standard API rates (`internal/pricing/prices.json`): a call in fast mode
(`service_tier: priority`) costs 2× every rate, and a call with more than 272K input tokens is
billed at the model's long-context rate in full. `codex-auto-review` (the approval reviewer) is
not on OpenAI's price list; it is priced as `gpt-6-luna`, reportedly the model behind it, as an
API-equivalent estimate (status `assumed`). Auto-review checks are free on ChatGPT-subscription
sign-ins from about 2026-10-06, so for those accounts its cost is notional.

## Session trees

A session is all threads sharing a `session_id`; its id is the root thread's. `source`:

| `source` | thread | digest |
|---|---|---|
| a string (`vscode`, `cli`, `exec`) | the user's conversation | main agent; `exec` (originator `codex_exec`) is a scripted run, kind `sdk` |
| `{"subagent": {"thread_spawn": {parent_thread_id, depth, agent_nickname, agent_path, agent_role}}}` | started by `spawn_agent` | agent of kind `subagent`, addressable |
| `{"subagent": "review"}` | a `/review` run | agent of kind `review` |
| `{"subagent": {"other": "guardian"}}` | the automatic approval reviewer (model `codex-auto-review`) | agent of kind `approval-review` |

An agent path is `/root/<task name>/<task name>…`. Its spawning call is the parent's
`spawn_agent` whose `task_name` is the path's last element; its `message` is the agent's prompt.

**Messages between threads.** What a thread receives from another (`send_message`, the
`followup_task` that starts its next turn, the spawn prompt) is encrypted in the receiver's file,
and in Codex 0.164 the sender's call arguments carry it encrypted too: every `message` of
`spawn_agent`, `send_message` and `followup_task` in 179 calls on this machine is a Fernet token
(the corpus has no such call: 0 of 7,166 tool calls, so it neither confirms nor contradicts this)
(`gAAAAA…`, URL-safe base64 of version byte 0x80, timestamp, IV, ciphertext, HMAC), so no copy is
in plain text. The call still says who sent what to whom (`target`: `/root`, an agent path, a task
name or a nickname). The digest marks such a message `encrypted` and keeps no text. A subagent's
final answer arrives at its parent as a plain-text `agent_message`. The digest takes texts from
the calls and the plain answers: a message that arrives while a turn runs is queued in it, one
that arrives between turns starts the next turn unless the user typed it.

**Root turns.** A subagent's turn names the parent turn that set it off
(`turn_attribution.parent_turn_id`), so `AgentTurn.rootTurn` is exact, through any depth.

**Review turns.** `/review` writes `EnteredReviewMode` between the turn that asked for it and the
turn that runs it; the root file then mirrors the review thread's `task_started` (whose
`parent_turn_id` is the root's own turn) and ends with that turn's `task_complete`. The review's
API calls are in the review thread only.

## Copies and forks

- **A subagent started with `fork_turns: all`** begins with a copy of its parent's records (a
  second `session_meta`, turns, messages; no `token_usage_record`) up to
  `subagent_history_start_ordinal`. Records with a smaller ordinal are skipped; the agent has
  `inheritsContext`.
- **A fork from the UI** starts a new session whose `session_meta` has `forked_from_id` and
  `history_base {thread_id, end_byte_offset, end_ordinal_exclusive}`: nothing is copied, the file
  points into the parent's. The digest reads the parent's file up to that point as inherited
  turns and messages (they share ids with the parent, so the catalog bills them once) and sets
  `lineage.forkedFrom` to the parent session and its last copied turn. The parent's file is part
  of the fork's fingerprint.
- **A fork started by the model** (`fork_thread`) has `forked_from_id` only; the catalog links it
  by the marker alone.
- **Resume** appends to the same file; there is no marker beyond a time gap and a new
  `thread_settings_applied`. In 0.137 each resume also writes another `session_meta` with the same
  `id` and `thread_source: user` (58 of the 62 `session_meta` records of the corpus's four threads
  are such repeats, which this reading takes as resumes; the threads have 16, 4, 39 and 3 records).
The parser reads the first and skips the rest.

## Compactions

`compacted` names the call that wrote the summary (`compaction_response_id`); that call has its
own `token_usage_record`, so its cost is recorded, in the totals, and named by
`Compaction.messageId`. Its input is the context size before (`preTokens`). The summary is
encrypted. A compaction in a turn nobody typed into (`/compact`) is `manual`; one inside other
work is taken as `auto` (not observed: the corpus has 0 `compacted` records, see Corpus run).
Codex 0.137 also writes `event_msg/context_compacted` (24 in the corpus, in 2 of 4 threads); it names
no call and no trigger, and is not read.

## Hooks

What `internal/codex/hooks` writes and reads, checked against Codex 0.164's own `hooks/list`
(app server) on a scratch `CODEX_HOME`.

- User hooks live in `$CODEX_HOME/hooks.json` (or inline `[hooks]` in `config.toml`; Codex
  merges both and warns). Same shape as Claude Code's: `{"hooks": {"<Event>": [{"matcher",
  "hooks": [{"type": "command", "command", "timeout"}]}]}}`, timeout in seconds (`SessionEnd`
  is capped at 3). Hooks are on by default (`[features] hooks = false` turns them off).
- Stdin: `session_id`, `transcript_path` (nullable), `cwd`, `hook_event_name`, `model`, and per
  event `turn_id`, `prompt`, `source`, `agent_id`, `agent_transcript_path`, `reason`, ….
  SessionStart stdout becomes developer context, so the hook prints nothing.
- **Trust.** A new or changed non-managed command hook is skipped until the user trusts it in
  `/hooks`. Codex records it in `config.toml` as `[hooks.state."<hooks.json path>:<event in
  snake_case>:<group index>:<handler index>"]` with `trusted_hash = "sha256:…"` (the hash of the
  entry, not of the script it runs) and `enabled = false` when disabled. Merlin's entries run a
  fixed script path, so trust survives reinstalls and binary upgrades. Merlin never writes
  `config.toml`; `merlin hooks status` reads it.

## Not recorded

- Approval decisions: only the policy, the command prefixes approved for the session and the
  approval reviewer threads.
- A dollar figure: costs are always recomputed from tokens (the plan's usage-limit percentages
  are in `token_count`, unused).

## Older rollouts

Rollouts from Codex 0.104–0.142 carry `session_meta`, turns, `event_msg/user_message` /
`agent_message` and `token_count` with usage, but no `token_usage_record`. They are indexed with
their turns, prompts, final answers and, from `token_count`, their cost (from parser version 8; before
that, no prompts and no cost). Their other record types show up in `diagnostics.unknownTypes`.
The two corpus versions (0.116.0 and 0.137.0-alpha.4) are of this kind.

Codex 0.137–0.142 records an applied patch as `event_msg/patch_apply_end`; 0.164 as
`item_completed` `FileChange`. Both are read by one function (parser version 9; before that the
older form was an unknown type and `files.touched` and `files.linesChanged` were 0 for it). A
`FileChange` item's `id` is a UUID and a `patch_apply_end`'s `call_id` is the tool call's id
(`call_...`): on one machine, 0 of 121 `FileChange` ids equal a tool call's `call_id` and no id
appears in both forms (74 `patch_apply_end`, all with a `call_id` that is a tool call's). The two
forms cannot be linked, so a record repeated within its own form (same `id`, or same `call_id`) is
counted once, and a rollout that has both forms for one patch would count it twice. No rollout
seen has both, and none repeats an id.

## Corpus

Raw Codex rollouts from public Hugging Face datasets, in `~/work/merlin-corpus/codex/<dataset>/`,
outside the repository. Nothing from them is copied into the repository, and this section records
counts only. All of it is best-effort redacted public data: a field the corpus lacks is *unknown*,
not absent.

| dataset | revision | licence | taken | threads | records | dated |
|---|---|---|---|---|---|---|
| cfahlgren1/codex-sessions | 87dcc5b0df77 | `other` (the card states no terms; nothing is redistributed) | all: 2 raw `rollout-*.jsonl`, 0.3 MB (`sessions.jsonl` repeats them, not read) | 2 | 130 | 2026-03-27 |
| build-small-hackathon/hackathon-advisor-codex-traces | c7a79f391597 | apache-2.0 | all: `codex_sessions.jsonl`, 14.6 MB, rows regrouped into 4 files (below) | 4 | 29,061 | 2026-06-06 .. 2026-06-08 |
| trace-commons/agent-traces | 112ebd4d03ce | cc-by-4.0 | none: the raw `sessions/codex/` folder holds only `.gitkeep` at this revision; the table (`data/*.parquet`, 67 MB, all harnesses) is flattened messages, not rollouts | 0 | 0 | |

The hackathon dataset is not a set of rollout files but one JSONL of rows `{schema_version,
session_id, record_index, timestamp, type, payload}`, where `{timestamp, type, payload}` is a rollout
line. Its four sessions were regrouped by `session_id`, ordered by `record_index`, with the three
wrapper keys dropped, one file per session, in a scratch `CODEX_HOME`; the payloads are untouched.
`record_index` has gaps: 8,052 of 37,113 positions are absent (the card: system and developer
prompts, encrypted payloads, compaction replacement history and tool metadata are excluded; long
texts are capped). The trace-commons parquet was not read (no parquet tool available), so whether it
holds Codex rows is unknown.

Versions: 0.116.0 (2 threads, `codex_exec`, source `exec`) and 0.137.0-alpha.4 (4 threads,
originator `Codex Desktop`, source `vscode`, `thread_source: user`). No 0.164 rollout, no
`token_usage_record`, no `ordinal` on any record (0 of 29,191), no `session_id` in any
`session_meta` (0 of 64), no `subagent` source, no fork marker. Placeholders: `[REDACTED_SECRET]` 45
(hackathon only); 0 in the other dataset. Bias: the 0.116 threads are two scripted runs; the
0.137 ones are one project's desktop sessions (16, 4, 39 and 3 `session_meta` records each).

## Corpus run

The harness over the corpus above (one scratch `MERLIN_HOME` and `CODEX_HOME` per dataset, empty
Claude and Pi homes, parser version 8; `merlin shape`, `scan`, `doctor`, `doctor --coverage`, and
throwaway scripts printing numbers only).

| | cfahlgren1 | hackathon |
|---|---|---|
| threads indexed / failures / bad lines | 2 / 0 / 0 | 4 / 0 / 0 |
| record types | `session_meta` 2, `turn_context` 2, `event_msg` 16, `response_item` 110 | `session_meta` 62, `turn_context` 136, `event_msg` 14,490, `response_item` 14,373 |
| `event_msg` types | agent_message 5, task_complete 2, task_started 2, token_count 5, user_message 2 | agent_message 4,421, thread_goal_updated 3,253, token_count 5,240, patch_apply_end 760, mcp_tool_call_end 456, task_started 112, task_complete 111, user_message 65, web_search_end 45, context_compacted 24, item_completed 2, image_generation_end 1 |
| `response_item` types | reasoning 50, web_search_call 45, message 11, function_call 2, function_call_output 2 | function_call 6,383, function_call_output 6,382, custom_tool_call 781, custom_tool_call_output 781, web_search_call 45, image_generation_call 1 |
| unknown types before this change (parser version 7) | event_msg/agent_message 5, event_msg/user_message 2 | 9 types, 9,026 records, including agent_message 4,421 and user_message 65, which carry prompts and answers |
| unknown types after (version 8) | none | context_compacted 24, image_generation_end 1, mcp_tool_call_end 456, patch_apply_end 760, thread_goal_updated 3,253, web_search_end 45, `item_completed/(none)` 2, `response_item/image_generation_call` 1 |
| `token_count` with `info` | 3 of 5 (the other 2 are `info: null`) | 0 of 5,240 (the payload is only `type`) |
| per-call sum of `last_token_usage` = final `total_token_usage` | 2 of 2 threads | cannot be checked (4 of 4) |
| digest token totals = final `total_token_usage` | 2 of 2 (input, cached, output) | cannot be checked |
| forks (`forked_from_id`, `history_base`) / parent or base missing | 0 / 0 | 0 / 0 |
| compactions: `compacted` records / `context_compacted` events | 0 / 0 | 0 / 24 (2 threads) |
| `turn_aborted`, `thread_settings_applied`, `EnteredReviewMode`, `FileChange`, task errors | 0 | 0 |
| spawn/followup/send/interrupt calls, Fernet tokens | 0, 0 | 0, 0 |
| cost | 2 sessions, 3 calls, model gpt-5.4, `unpriced` when that run was made (the table has had gpt-5.4 since) | no cost: unknown on 4 sessions |
| doctor coverage seen (of threads) | project 2/2, title 2/2, userText 2/2, finalText 2/2, tools 1/2, perMessage 2/2 | project 4/4, branch 4/4, title 4/4, userText 4/4, finalText 4/4, queued 2/4, tools 4/4, perMessage 0/4 |

Before the change (version 7) the two datasets also showed `userText` 0 of 2 and 0 of 4,
`cost.perMessage` 0 of 2 and 0 of 4, and `finalText` 0 of 4 on the hackathon threads (whose
`task_complete` has lost `last_agent_message`).

**Checks.** The invariant used is `event_msg/token_count` `payload.info`: the sum over events of
`last_token_usage.total_tokens` (all events, and with an event whose running total did not change
skipped; both agree) against the last `total_token_usage.total_tokens`. Fields compared in the digest:
`input + cacheRead` with `input_tokens`, `cacheRead` with `cached_input_tokens`, `output` with
`output_tokens`. For the `token_usage_record` form the corpus offers nothing.

**What the corpus does not show.** Everything specific to 0.164: `token_usage_record`, `ordinal`,
`session_id` and the tree fields, subagents, review mode, fast mode, Fernet messages, forks, `compacted`,
`session_index.jsonl`. In the hackathon data `task_complete.last_agent_message`, `token_count.info`,
`patch_apply_end` details, `item_completed.item` and `mcp_tool_call_end` details were removed by the
redactor, so whether the parser handles them is unknown. `patch_apply_end` (760) is the 0.137 form of
`FileChange`; it is read from parser version 9, but its `changes` were redacted here, so files and lines
for that era are unmeasured on the corpus (on the real machine: below).

## One machine, parser 7 against 8

The same `~/.codex` indexed read-only by parser 7 and parser 8 (scratch homes, numbers only;
25 sessions: 12 on 0.164, 8 on 0.104, 4 on 0.139, 1 on 0.142.3).

- **0.164:** tokens and cost identical on 12 of 12 (1,379 calls, $26.30). Every 0.164 file with
  `token_usage_record`s also has `token_count`s with `info` (40 of 40 files), and the
  fallback stays off for them, so no call is billed twice.
- **0.104–0.142:** 13 sessions went from no calls and no prompts to 339 calls and a prompt on every
  turn. All 339 were on models the table then had no price for (`gpt-5.5` 330, `gpt-5.3-codex` 6,
  `gpt-5.2-codex` 3), so the cost showed as a lower bound of $0. The table now prices all three: a
  rescan has 0 unpriced messages and those 339 calls cost $32.56 (gpt-5.5 $32.52, gpt-5.3-codex $0.03,
  gpt-5.2-codex $0.01).
- **Invariant on the old form:** of the 17 old rollout files, 6 have no `token_count` `info`; in 10
  of the other 11 the per-call sum equals the final `total_token_usage`. The exception has two
  `thread_rolled_back` events and its calls sum to 8,211 tokens more than the final total: the
  rolled-back calls were billed but are not in Codex's running total, and the parser counts them.

## One machine, parser 8 against 9

The same `~/.codex` indexed read-only (scratch homes, numbers only; 25 sessions). Files are unique
paths per session, summed.

| cli_version | sessions | files before / after | lines added before / after | lines removed before / after |
|---|---|---|---|---|
| 0.164.0 | 12 | 40 / 40 | 3,826 / 3,826 | 473 / 473 |
| 0.139.0 | 4 | 0 / 36 | 0 / 2,699 | 0 / 552 |
| 0.142.3 | 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| 0.104.0 | 8 | 0 / 0 | 0 / 0 | 0 / 0 |

Unknown types: `event_msg/patch_apply_end` 74 before, 0 after; the others are unchanged
(`item_completed/ImageView` 126, `item_completed/Extension` 80, `event_msg/agent_reasoning` 8,
`event_msg/thread_rolled_back` 2). The 0.142.3 session has no `patch_apply_end`. A separate count over the raw
`patch_apply_end` records (a script, not the parser) gives the same 74 records, all successful, 36
files, 2,699 lines added and 552 removed; the other 22 digests are byte-identical apart from the
parser version.
