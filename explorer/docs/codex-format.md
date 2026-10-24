# Codex rollout format

What `internal/codex` reads from `$CODEX_HOME` (default `~/.codex`) and how it becomes a digest.
Observed on Codex CLI 0.164 (October 2026) by a read-only scan of field names and counts; older
rollouts (0.10x–0.14x) have a different shape and are indexed only as far as it overlaps (see
the end).

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
| `event_msg/token_count` | running totals and plan rate limits | not used (the per-call records carry the same numbers) |
| `token_usage_record` | `response_id`, `turn_id`, `thread_id`, `usage`, `turn_token_usage`, `thread_token_usage` | **one billed API call** |
| `response_item/custom_tool_call`, `function_call` | `name`, `call_id`, `arguments` | tool calls; `spawn_agent`, `followup_task`, `send_message`, `interrupt_agent` arguments |
| `response_item/agent_message` | `author`, `recipient` (agent paths), `content` | messages between threads |
| `compacted` | `compaction_response_id`, `window_number`, encrypted replacement history | a compaction |
| `world_state`, `inter_agent_communication_metadata`, other `response_item`s | | ignored |

Any other record type is counted in `diagnostics.unknownTypes` (as `type` or `type/payload.type`).

### Tokens

`usage` is `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
reasoning_output_tokens, total_tokens}`. Cached input is part of `input_tokens`, reasoning part
of `output_tokens`, and `total = input + output`. The sum of a thread's records equals its last
`thread_token_usage` (checked on every recent thread). A message is priced as `input = input -
cached`, `cacheRead = cached`, `output = output`. `cache_write_input_tokens` has always been 0
and is not used.

Prices are OpenAI's standard API rates (`internal/pricing/prices.json`): a call in fast mode
(`service_tier: priority`) costs 2× every rate, and a call with more than 272K input tokens is
billed at the model's long-context rate in full. `codex-auto-review` is not on OpenAI's price
list and stays unpriced (`diagnostics.unpricedModels`).

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
`followup_task` that starts its next turn, the spawn prompt) is encrypted in the receiver's file:
the text is in the sender's call arguments, addressed by `target` (`/root`, an agent path, a task
name or a nickname). A subagent's final answer arrives at its parent as a plain-text
`agent_message`. The digest takes texts from the calls and the plain answers: a message that
arrives while a turn runs is queued in it, one that arrives between turns starts the next turn
unless the user typed it.

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
  `thread_settings_applied`.

## Compactions

`compacted` names the call that wrote the summary (`compaction_response_id`); that call has its
own `token_usage_record`, so its cost is recorded, in the totals, and named by
`Compaction.messageId`. Its input is the context size before (`preTokens`). The summary is
encrypted. A compaction in a turn nobody typed into (`/compact`) is `manual`; one inside other
work is taken as `auto` (not yet observed).

## Not recorded

- Approval decisions: only the policy, the command prefixes approved for the session and the
  approval reviewer threads.
- A dollar figure: costs are always recomputed from tokens (the plan's usage-limit percentages
  are in `token_count`, unused).

## Older rollouts

Rollouts from Codex 0.104–0.142 carry `session_meta`, turns and `event_msg/user_message` /
`agent_message` but no `token_usage_record`: they are indexed with their turns and no cost, and
their record types show up in `diagnostics.unknownTypes`.
