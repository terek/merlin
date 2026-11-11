# Pi session format

What a Pi (pi.dev, package `@earendil-works/pi-coding-agent`, formerly `@mariozechner/pi-coding-agent`)
session file holds, what Merlin Explorer should make of it, what was observed on which files, and
what is still unknown. Written for the Pi harness bead (merlin-1es.6). Two kinds of evidence are
used and labelled everywhere:

- **from source (commit 085c84e)**: Pi's own types and code at upstream
  `earendil-works/pi` commit `085c84e98e7f4c950f2be606466fff4f75d8fe7c` (2026-11-06), read as text
  (`session-manager.ts`, `docs/session-format.md`, `docs/sessions.md`, `docs/compaction.md`,
  `ai/src/types.ts`, `agent/src/types.ts`, the API clients under `ai/src/api/`, the tools).
- **seen in N of M sessions**: counted by `merlin shape` and by scripts that print only field names,
  enum tokens and numbers, over public datasets (see Corpus). Nothing from a session's text is
  recorded here.

A field that is in the source but not in the corpus is **unknown**, never absent: the corpus is
redacted, small, and ends on 2026-09-28.

## Corpus

Raw JSONL only, in `~/work/merlin-corpus/pi/<dataset>/`, outside the repository. Nothing from it is
copied into the repository. 305 MB, 824 `.jsonl` files = 820 sessions + 4 manifest files
(`{file, source_hash, redacted_hash, redaction_key}` per line, not sessions), 820 headers and 53,244
entries, no unparseable line.

| dataset | revision | licence | sessions | headers dated |
|---|---|---|---|---|
| julien-c/pi-sessions | 700416886204 | cc-by-4.0 | 17 | 2026-04-13 .. 2026-05-13 |
| championswimmer/pi-coding-sessions (`_upload_staging/`) | f655c6c2aabf | mit | 26 | 2026-03-11 .. 2026-04-03 |
| grfwings/pi-session-traces (`_upload_staging/`) | bdb8de4ea047 | other | 1 | 2026-05-08 |
| thomasmustier/pi-mono-sessions | c69a50cb9b94 | mit | 150 | 2026-01-06 .. 2026-09-28 |
| bhollmann/pi-mono | 9101a5388ff8 | other | 626 | 2026-01-16 .. 2026-04-06 |

The grfwings card says `license: other` and states no terms; it only describes the redaction
(deterministic secret redaction plus an LLM review) and warns that the data is best-effort redacted.
The bhollmann card is the same text, also `other`. For both, nothing is redistributed.

Everything was exported with `pi-share-hf`, so all of it is **public redacted** data. Placeholders
found: 44 in all, only in tool-result text (`[REDACTED]` 26, `[REDACTED_PERSONAL_EMAIL]` 15,
`[REDACTED_OAUTH_CODE]` 2, `[REDACTED_TRACKING_ID]` 1). Header `cwd` is an absolute path in 820 of 820
sessions, so it is usable (whether the directory still exists on the reader's machine is another
matter). Every usage and cost field is present. Redaction seems to touch text only, but that is a
guess: it cannot be shown that a redactor dropped no field.

Bias: most sessions are by Pi's authors and contributors working on Pi itself (extensions,
subagents, goal and messenger plugins, many models), 12 of 820 call a subagent-like tool. Seven
pairs of files are the same session exported twice (same header id, one a prefix of the other); the
totals below count both, which repeats about 160 assistant messages. Providers seen: openai-codex
(12,642 assistant messages), anthropic (7,278), openai (962), LlamaBarn (403, local), github-copilot
(690), and 15 more with fewer than 300 each (`merlin shape` prints github-copilot as `other` because
its token filter is stricter).

## Files

- `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<session id>.jsonl`: one file per session. `<cwd>` is
  the working directory with the leading separator removed and every `/`, `\` and `:` replaced by
  `-`; `<timestamp>` is the header time with `:` and `.` replaced by `-`. (from source, commit
  085c84e)
- The agent directory is `~/.pi/agent` or `$PI_CODING_AGENT_DIR` (the variable's prefix is the
  application name in the package's `piConfig`, so a rebranded build uses another name and another
  config directory). The sessions directory can be replaced by `--session-dir`,
  `$PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting, in that order of precedence. A session
  directory given this way holds the `.jsonl` files directly, with no `--<cwd>--` level. (from source,
  commit 085c84e: `config.ts`, `session-manager.ts`, `docs/sessions.md`)
- A bug in Pi 0.30.0 saved sessions in `~/.pi/agent/*.jsonl`; Pi moves them into the per-directory layout on start, by the header's `cwd`. (from source)
- A file is created only once the session holds a user or assistant message; the first write
  puts every entry so far in the file, later entries are appended one line each. `--no-session`
  writes nothing. (from source)
- The dataset files are renamed; the on-disk names were not seen.

## Records

Every line is JSON with a `type`. The first line is the header; every other line is an entry with
`id`, `parentId` (null at a root), `timestamp` (RFC 3339, set when the entry is appended) and, for
`message`, a nested `message` object whose own `timestamp` is Unix milliseconds. The counts are over
the 820 sessions.

| type | fields | seen | used for |
|---|---|---|---|
| `session` (header) | `version`, `id`, `timestamp`, `cwd`, `parentSession` (optional) | 820 of 820; `parentSession` in 1 | identity, lineage |
| `message`, role `user` | `content`: string or text/image blocks | 820 of 820 (always blocks; 2 sessions have images) | prompt, turn start |
| `message`, role `assistant` | `content` (blocks `text`, `thinking`, `toolCall`), `api`, `provider`, `model`, `usage`, `stopReason`, `timestamp`; optional `responseId`, `responseModel`, `errorMessage`, `rawStopReason`, `diagnostics`, `thinkingLevel`, `providerThinkingLevel`, `endTurn`, `durationMs` | 820 of 820 | **one billed API call** |
| `message`, role `toolResult` | `toolCallId`, `toolName`, `content` (text/image), `isError`, `details`, `timestamp`; optional `usage`, `nestedCalls`, `durationMs` | 737 of 820 | tool results |
| `message`, role `bashExecution` | `command`, `output`, `exitCode`, `cancelled`, `truncated`, `excludeFromContext`, `fullOutputPath` | 89 of 820 | a command the user ran with `!` or `!!`; not an API call |
| `message`, role `system` | `content`, `sections` (name to text, null removes), `toolsAdded`, `toolsRemoved` | 2 of 820 (3 records, all from Sept 2026) | prompt and tool loadout |
| `message`, role `custom` / `hookMessage` | extension message (`hookMessage` was renamed `custom` in v3) | 0 | not seen |
| `model_change` | `provider`, `modelId` | 811 of 820 | selected model |
| `thinking_level_change` | `thinkingLevel` (`off`, `minimal`..`max`; seen `off`, `medium`, `high`) | 820 of 820 | selected effort |
| `compaction` | `summary`, `firstKeptEntryId`, `tokensBefore`, `details {readFiles, modifiedFiles}`, `fromHook`; optional `usage`, `systemMessage` | 32 of 820 (64 records; `usage` on 18 in 5 sessions; `systemMessage` never) | compaction |
| `branch_summary` | `fromId`, `summary`, `details`, `fromHook`; optional `usage` | 1 of 820 (1 record, no `usage`) | `/tree` away from a branch |
| `usage` | `kind` (free string, e.g. `cache_warm`), `provider`, `model`, `usage`, `note` | 0 | spend that is not an assistant message |
| `context_edit` | `targetId`, `replacement` (null or `{content}`) | 0 | edit of what the model sees |
| `custom` | `customType`, `data` | 66 of 820 | extension state; not sent to the model |
| `custom_message` | `customType`, `content`, `display`, `details` | 13 of 820 | extension text that is sent to the model |
| `label` | `targetId`, `label` | 4 of 820 | bookmark |
| `session_info` | `name` | 299 of 820 | session title; the last one on the file wins, empty clears it |

Role `system` messages, `usage`, `context_edit`, `compaction.systemMessage`, `thinkingLevel` and
`providerThinkingLevel` on assistant messages, `responseModel`, `durationMs`, `endTurn`,
`toolResult.usage` and `nestedCalls` are in the source's types and **not or
barely in the corpus**: whether Pi writes them in the versions the corpus covers, or the exporter
dropped them, is unknown. `ToolCall` in the source has `thoughtSignature`, `namespace`,
`argumentsError`; the files also hold a `partialJson` string on tool-call blocks (in 357 of 626
bhollmann sessions and 20 of the 44 sessions of the first three datasets), which is not in the source's types
(stream residue). Unknown types and fields must be counted, not rejected; the source says so for
`usage.kind` too.

A tool call is a `toolCall` block `{id, name, arguments}` in an assistant message; its result is a
`toolResult` message whose `toolCallId` is that id. 75 calls have no result (an aborted run); no
result is without a call.

### Tools

Names are open: Pi's built-ins plus whatever extensions and MCP bridges register. Counts are tool
calls over the 820 sessions.

| tool | calls | arguments (key names) | what the result records |
|---|---|---|---|
| `bash` | 12,241 | `command`, `timeout`; `description` in 28 | `isError`; `details` only `truncation`, `fullOutputPath` |
| `read` | 7,262 | `path`, `offset`, `limit` | `details.truncation` |
| `edit` | 2,641 | `path`, `edits` (list of `oldText`/`newText`) in 648; `oldText`, `newText` directly in 1,965 (single-edit form); `patch` in 19 | `details.diff`, `details.firstChangedLine` (2,493), sometimes `patch`, `diffViewer` |
| `write` | 423 | `path`, `content` | |
| `grep`, `find`, `ls` | 2, 3, 3 | `pattern`, `path`, `glob`, `limit` | |
| `ffgrep`, `fffind` | 23, 6 | `pattern`, `path`, `limit` | extension variants of grep and find |
| `exec_command` | 10 | `cmd`, `workdir` | `details.exit_code` (10 of 10) |
| extension and MCP tools | the rest | `perplexity_perplexity_search`, `context7_query-docs` (server and tool joined by `_`), `mcp`, `fetch_content`, `web_search`, `subagent`, `Task`, `oracle`, `pinet`, `pi_messenger`, `todo`, ... | free-form `details` |

- **Shell tool.** `bash` is the built-in shell tool; its command is `arguments.command`. A
  non-zero exit sets `isError: true` and the result text ends with `Command exited with code N`:
  that was found in 1,076 of 1,119 error results (exit 1: 840, 2: 115, 127: 23, other: 98); the
  rest are aborts (29), timeouts (8) and 6 others. There is no exit code field on a `bash` result
  (`details` holds only truncation data in all 12,213 results), although the source builds an
  `exit_code` in a `structuredContent` it does not seem to persist. So for bead events, the command
  comes from the call, success from `isError`.
- **User shell.** `!` and `!!` write a `bashExecution` message with `exitCode`; `!!` sets
  `excludeFromContext` (89 of 136). These are not calls to a model.
- **Files touched.** `read`, `edit`, `write` take `path` (relative or absolute, resolved against the
  session's `cwd`); `grep`, `find`, `ls` take an optional `path`. Lines changed come from
  `edit`'s `details.diff` text (added and removed) plus the line count of each successful
  `write`'s `content` argument (added only: a trailing newline adds no line, empty content is 0).
  Pi records nothing about the old content of an overwritten file, so a write's added lines are
  an upper bound and its removals are unknown. Extension tools use other keys (`filePath` in one, `file` in one);
  not worth chasing.
- 62 calls have a tool name that is not token-shaped (counted as `other`); all 62 results are errors.

## Tokens and cost

`usage` is `{input, output, cacheRead, cacheWrite, totalTokens, cost {input, output, cacheRead,
cacheWrite, total}}` plus optional `cacheWrite1h` and `reasoning`.

- **The buckets are disjoint.** `input` excludes cache reads and writes (the OpenAI clients subtract
  them, Anthropic's API reports them separately; from source, `openai-completions.ts`,
  `openai-responses-shared.ts`, `anthropic-messages.ts`; the Google and Bedrock clients were not read;
  in the corpus cache reads are 1,491 M against 95 M input),
  `totalTokens = input + output + cacheRead + cacheWrite` (22,845 of 22,845 assistant messages),
  `output` includes `reasoning` (reasoning > output in 0 of 3,141 messages that have it; from source).
- `cacheWrite1h`, when present, is the part of `cacheWrite` written with 1-hour retention; only
  the Anthropic client sets it (from source). Seen on 1,477 messages in 14 sessions (July 2026
  on), always 0 (so never above `cacheWrite`). Other providers' `cacheWrite` (opencode,
  github-copilot, bedrock, minimax, gitlab-duo, opencode-go, custom-anthropic; 0.58 M of 27.05 M cache-write
  tokens) has no retention class.
- **Cost is Pi's catalog estimate**, not an invoice: `calculateCost` multiplies tokens by the
  model's catalog rates (a tier by input size, 1-hour writes at 2x input, service-tier
  multiplier for OpenAI), unless the provider reports a billed amount (OpenRouter), in which case
  `cost.total` is that and `cost.totalFromProvider` is true (from source). `cost.total` equals the
  sum of its four parts in 22,845 of 22,845 messages.
- **`usage.cost` is never missing** on an assistant message (22,845 of 22,845 have `usage` and
  `cost`), and it is a zero object when Pi has no price:

| provider | messages | tokens 0 | tokens > 0, cost 0 | tokens > 0, cost > 0 |
|---|---|---|---|---|
| openai-codex | 12,642 | 238 | 265 (`gpt-5.2-codex` 177, `gpt-5.3-codex-spark` 88) | 12,139 |
| anthropic | 7,278 | 108 | 0 | 7,170 |
| openai | 962 | 8 | 0 | 954 |
| github-copilot | 690 | 10 | 680 | 0 |
| LlamaBarn, llama-cpp (local) | 415 | 28 | 387 | 0 |
| google-gemini-cli | 60 | 7 | 53 | 0 |
| kimi-coding | 19 | 1 | 18 | 0 |
| opencode | 137 | 11 | 2 | 124 |
| all other providers (15) | 642 | 127 | 0 | 515 |

  So zero cost with real tokens (1,405 messages, 6% of all) means "no price in Pi's catalog":
  local models, subscription routes (github-copilot even for Claude models, gemini-cli, codex
  models without a list price), free tiers. It is not "free". Zero tokens (538 messages) are almost
  all aborted (371) or error (158) responses. From source: a custom model with no `cost` in
  `models.json`, or a catalog model without a price, reports tokens at no cost; a price-free case
  exists by design (`virtual-models.ts` sets all rates to 0; `docs/models.md` says models without a
  price report tokens "at no cost").
- Aborted and error responses can still carry tokens (65 aborted, 12 error): whether those counts
  are partial is unknown.

### Spend outside assistant messages

By the source, session totals add up assistant `usage`, `usage` entries, `toolResult.usage`
(a tool that called a model, e.g. a classifier), `compaction.usage` and `branch_summary.usage`
(`usage-totals.ts`, `getUsageCostBreakdown`). In the corpus:

| source | records | tokens (all buckets) | cost |
|---|---|---|---|
| assistant message | 22,845 | 1,621.2 M | $1,095.79 |
| `compaction.usage` | 18 (of 64 compactions, 5 sessions, July and August 2026) | 0.59 M | $2.12 |
| `usage` entry | 0 | 0 | 0 |
| `branch_summary.usage` | 0 (1 branch summary) | 0 | 0 |
| `toolResult.usage` | 0 | 0 | 0 |

0.036% of tokens and 0.19% of cost lie outside assistant messages, all of it compaction. Seen in 5
of 820 sessions. The other three kinds are unknown in practice, certain in source.

## Tree, branches, forks and copies

- **Ids.** `id` is 8 lowercase hex characters (`randomUUID().slice(0, 8)`, checked against the
  file's own ids), falling back to a full UUID after 100 collisions (from source). Seen: 53,244 of
  53,244 entries have 8 hex characters; no id repeats within a file (0 of 820 sessions); the
  session id in the header is a UUID (v4 in 758, v7 in 62; the source makes v7 now). Ids are only
  unique within a file by construction: across files, 491 ids occur in more than one file, of which
  490 are real copies (identical line, timestamp and usage; see below) and 1 is a chance collision
  of an assistant message with a tool result in two unrelated sessions (32 bits: about 0.3 collisions
  expected in 53,000 ids).
- **Response id.** `AssistantMessage.responseId` is "the provider's response or message identifier
  when the upstream API exposes one" (from source). Seen on 8,980 of 22,845 messages (231 of 820
  sessions), first in sessions created in March 2026; by provider: 656 of 690 github-copilot, 383 of 403
  LlamaBarn, 12 of 12 llama-cpp; 5,137 of 12,642 openai-codex; 1,992 of 7,278 anthropic; none
  of bedrock, gitlab-duo, kimi-coding, opencode-go. It never repeats within a file (0); its 190
  repeats across files are all in the copied entries.
- **Tree.** `parentId` points at an earlier line (0 of 53,244 entries have a parent that appears
  later; 3 entries in 1 session point at a missing parent, cause unknown). A session has exactly one
  root (820 of 820; the root is a `model_change` in 808, a `thinking_level_change` in 12; the header
  is not part of the tree). The source allows several roots (`resetLeaf()` when editing the first
  prompt); none seen.
- **The leaf.** Pi keeps the leaf only in memory. On load it is the last non-header entry in the
  file; every append becomes a child of the current leaf and moves it. `/tree` navigation
  (`branch()`, `resetLeaf()`) moves the in-memory leaf **and writes nothing**; only the next entry
  (or a `branch_summary` when summarising) records where the branch left. After a restart without
  new entries the leaf is the last appended entry again. (from source, `session-manager.ts`
  `_buildIndex`, `branch`.) Seen: the last entry has no children in 820 of 820 sessions, and the
  path from it to the root holds 99.5% of the entries (53,244 minus 290).
- **Abandoned branches.** An entry is abandoned when it is off the path from the last entry to the
  root. Seen in 24 of 820 sessions (24 have more than one leaf, at most 4): 290 of 53,244 entries,
  of which 96 assistant messages (0.42% of 22,845) costing $3.12 (0.28% of the total) and 32 user
  messages. There are 28 branch points: 18 have only user messages as children (a prompt
  re-edited), 16 sit under an assistant message, 1 has a `branch_summary` child. Abandoned messages were
  billed like any other, so their spend belongs in totals; only the turn is abandoned.
- **`/fork` and `/clone`.** Both start a new session (`docs/sessions.md`). The code that copies the
  entries (`createBranchedSession`, `SessionManager.forkFrom`) writes a **new file** with a new
  session id whose header has `parentSession`: the parent's file path (from source). Which command
  uses which function was not checked. Entries are copied **with their ids, parent ids and timestamps**;
  labels on the path are re-chained (new label entries get new ids) and `firstKeptEntryId` of a
  compaction is rewritten if it pointed at a label. Seen: 1 session has `parentSession` (a
  path ending in `<timestamp>_<parent session id>.jsonl`); its parent is in the corpus; all 69 of its
  entries are in the parent (75 entries), identical in every field, a prefix of the child,
  created 13 minutes after the parent. So 1 of 1 forks copied entries with their ids.
  `forkFrom` (a session from another project) copies every entry, all branches included.
  `parentSession` is the path, not an id; the id is the part of the file name after the last `_`.
- **Resume** appends to the same file. A load of a v3 file rewrites nothing.

## Compaction

`compaction` is an entry on the path. It names `firstKeptEntryId` (the first entry kept from before
it; an ancestor of the compaction entry in 64 of 64; the entry's own id means "keep none", 0 seen)
and `tokensBefore` (an estimate of the context size before). The summary is plain text in
`summary`. Entries before `firstKeptEntryId` are dropped from the model's context, not from the
file. The latest compaction on the path decides the context (from source).

- Trigger and cost: the source calls the model for the summary (two calls for a split turn,
  `combineUsage`) and stores their summed usage in `compaction.usage`; that call is not an
  assistant message. Seen on 18 of 64 compactions (all July 2026 onward); the other 46 have no
  usage, so their cost was **not recorded** or was paid by an extension. `fromHook` is documented
  as "generated by an extension", but 46 of 64 have `fromHook: true` including 17 of the 18 with
  usage, so it does not tell manual from automatic; there is no trigger field. Whether a
  compaction was `/compact` or automatic is unknown.
- `details {readFiles, modifiedFiles}` in 64 of 64.
- No post-compaction size and no duration are recorded; the next assistant message's usage gives
  the new context size.
- Branch summaries (`/tree` with summary) are separate entries (`fromId` is the abandoned leaf,
  `parentId` where the new branch continues); with an LLM summary they may carry `usage`.

## Live and hooks

- Pi appends one line per entry with `appendFileSync` as it happens; a file is only ever appended
  to, except for a migration or a new branched file (see below). A watcher can tail it. An
  assistant entry is appended **after** its response ends: its `timestamp` is a median 5.0 s (p90
  17 s, maximum 88 minutes) after the nested `message.timestamp`, which is the request start.
- Pi has **no settings-file hook list** like Claude Code or Codex. It has TypeScript
  *extensions* (`~/.pi/agent/extensions/*.ts`, `.pi/extensions/` per project, settings `extensions`
  and `packages`) with events (`session_start` with reason `startup|reload|new|resume|fork`,
  `session_shutdown`, `agent_end`, `agent_settled`, `turn_end`, `message_end`, tool events) (from
  source, `docs/extensions.md`). A Merlin hook for Pi would be an extension file; none is
  designed here, and no live signal beyond the file is assumed.

## Subagents

Pi's core has no subagents; extensions add them by starting a child `pi` process. The evidence for
this section is three-fold, and every claim names which: **from source** (Pi 1.5.0,
`examples/extensions/subagent/index.ts`), **demo** (two sessions the user made on Pi 1.5.0 on
2026-11-08: a bash-spawned child with and without `--no-session`, and the example extension in
single, chain and parallel mode), and **public corpus** (the tools `Task` and `oracle`, seen in
the public datasets). Everything below is read from the parent's own session file; what a child
wrote elsewhere is not read.

**A. The example extension's convention.** From source, the extension spawns
`pi --mode json -p --no-session` for each agent, so the child leaves no session file; it returns
what it saw in the tool result's `details`. Recognised by shape, not by tool name: a `toolResult`
whose `details.results` is a list of objects that carry `messages` (a list) and/or `usage` (an
object). `details.mode` is `single`, `parallel` or `chain`, `details.agentScope` a string (demo:
all three modes). Each element of `results`:

| key | value |
|---|---|
| `agent`, `agentSource`, `task` | strings: the agent's name, where its definition came from, the task it was given |
| `exitCode`, `stderr` | integer, string |
| `messages` | the child's full Pi messages: roles `system`, `user`, `assistant`, `toolResult`; the assistant ones in exactly the shape of the parent's (provider, model, `usage` with `cost.total`, `responseId`, `content` with `toolCall` blocks, `timestamp` in ms) |
| `usage` | `{input, output, cacheRead, cacheWrite, cost, contextTokens, turns}`; `cost` is a number and equals the sum of the assistant messages' `usage.cost.total` (demo) |
| `model` | `"provider/id"`, when given |
| `stopReason`, `errorMessage`, `step` | optional; `step` in chain mode |

A malformed call returns `results: []`: no agent ran. A result may have `usage` and no `messages`
(seen in another extension, not named here), or neither.
A child's `messages` may themselves contain tool results with `details.results` (nested
subagents): the shape allows it; whether it occurs in a real session is unknown.

**B. A bash call that spawns `pi --no-session`.** An assistant `toolCall` block
`{name: "bash", arguments: {command, timeout}}` whose command runs `pi` with `--no-session` (demo).
The child wrote no file anywhere, and the parent's file records nothing of its tokens or cost: its
spend is unknown. Without `--no-session`, the demo's child wrote a session file of its own, which
Merlin indexes as any other session. Its header has no `parentSession`, and nothing else in either
file names the other (demo). Merlin links them by a heuristic, never explicit: the parent's digest
keeps a spawn hint per such `pi` command (the call's time and result time, the working directory,
the prompt arguments), and the catalog links the one session of the same harness that started in
that directory within 2 s of the call (to 2 s after the result) and whose first user message is
exactly one of the prompts. Calls with `--session`, `--continue`/`-c`, `--resume`/`-r`, `--fork`
or `--session-id` reuse or copy an existing session and give no hint; more than one matching
session means no link.

**C. `Task` and `oracle` (public corpus).** The tool result's `details` is `{kind, mode, model,
description?, thinking?, run}` with `run` = `{kind, mode, model ("provider/id"), ok, exitCode,
aborted, timedOut, durationMs, stopReason, text, thinking, stderr, error?, artifacts {dir,
sessionPath, eventsPath, inputPath, metaPath, stderrPath}}`. There is no usage at all, and the
child's session file lies outside Pi's sessions directory, so the run is known and its spend is
not. `artifacts.sessionPath` is not read.

**What Merlin makes of it.** Each A result, each B spawn and each C run is an agent (kind
`subagent`, linkage `tool-result`, parent the main agent or, for a nested one, the child). An A
child's assistant messages are billed like the parent's, with the ids of the parent's tool-result
entry plus `.sub.<result>.<message>`, so a fork that copies the entry bills them once. An A result
with `usage` and no `messages` is one message carrying the totals. An A result with neither, and
every B and C run, is an agent flagged `unrecorded` and counted in `cost.unrecordedAgents`: its
spend is unknown, so the session's dollars are a lower bound.

## Not recorded

- The Pi version (see question 2). The only version in a file is the format version.
- A trigger on compactions, the context size afterwards, and the compaction's cost when not
  written by Pi's own summary call.
- The assistant's request-end time on the message itself (`durationMs` exists in the source; not
  seen).
- A subagent relationship in Pi's core: it has no subagents (see Subagents for what extensions
  leave in a session file). A child started with `--no-session` writes no file anywhere.
- The current leaf, and which branch the user was on when a session was closed (see Tree).
- A billed amount, except `cost.totalFromProvider: true` (Pi 1.5.0 on OpenRouter writes it on every call; the corpus above predates it).
- Git branch, app mode, plan or permission settings: none in the header.

## Older versions

- `version` is the **format** version: absent or 1 (linear, no ids), 2 (tree: `id`, `parentId`),
  3 (current; `hookMessage` role renamed `custom`). Pi migrates on load and, when it did,
  **rewrites the whole file in place** (`_rewriteFile`). (from source) Seen: 820 of 820 headers
  say 3; no v1 or v2, no `hookMessage`, no entry without an id, no `firstKeptEntryIndex`.
- Version 3 has grown without a bump (per the source and its docs): `usage` entries,
  `context_edit`, the `system` role, `compaction.systemMessage`, `thinkingLevel` on assistant
  messages, `responseModel`, `durationMs` and others. So `version` cannot say which Pi wrote a file.
  What can be seen is a dialect: the first month of a header at which a feature appears (a
  long session can use a later one than its header says):

| feature | first header month | sessions with it |
|---|---|---|
| `responseId` | 2026-03 | 231 |
| `diagnostics` on an assistant message | 2026-05 | 5 |
| `usage.reasoning`, `usage.cacheWrite1h` | 2026-07 | 41, 14 |
| `rawStopReason` | 2026-07 | 6 |
| `compaction.usage` | 2026-07 | 5 |
| `message.role: system` | 2026-09 | 2 |
| `usage` entry, `context_edit`, `thinkingLevel`, `responseModel`, `durationMs`, `toolResult.usage`, `compaction.systemMessage` | not seen | 0 |

  The header month is the session's creation month (headers range 2026-01 to 2026-09; 292, 186, 234,
  61, 2, 4, 31, 7, 3 sessions in 01..09). Gaps in the sequence are the datasets' dates, not Pi's.
- A `bash` result's missing `exit_code`, the `edit` tool's single versus list form, and
  `partialJson` residue differ across files too, with no version to tie them to.
- The session-file move from `~/.pi/agent/*.jsonl` (v0.30) is handled by Pi at start.

## The ten questions

| # | question | answer | evidence |
|---|---|---|---|
| 1 | Entry types and fields; which version wrote a file? | The types are the table in Records; `version` is the format version (3) and cannot tell the Pi version or dialect; use the feature table in Older versions. | types from source (commit 085c84e); version 3 in 820 of 820 sessions; dialect features seen as listed |
| 2 | Is an app version recorded? | No. The header has only `type`, `version` (format), `id`, `timestamp`, `cwd`, `parentSession`. No other field in any entry is named like a version (the matches are inside extension `data` and tool `details`). Doctor can group by dialect (feature set) or by header month, not by app version. | from source (commit 085c84e: `SessionHeader`); seen in 0 of 820 sessions |
| 3 | Id length and uniqueness; do `/fork` and `/clone` copy ids; response id? | 8 hex characters, unique in a file, not across files. Fork and clone copy entries with their ids, parent ids, timestamps and usage. An assistant message has an optional `responseId`, not always. | length and uniqueness seen in 820 of 820 sessions; copying from source (commit 085c84e) and seen in 1 of 1 session with `parentSession`; `responseId` seen in 231 of 820 sessions (8,980 of 22,845 messages) |
| 4 | Current leaf; abandoned entries? | The leaf is the last appended entry; navigation writes nothing. Abandoned = off the path from the last entry to the root. | leaf from source (commit 085c84e); last entry childless in 820 of 820; off-path entries in 24 of 820 sessions (290 of 53,244) |
| 5 | Spend outside assistant messages? | `usage` entries, `toolResult.usage`, `compaction.usage`, `branch_summary.usage` are all in Pi's totals. Only compaction usage occurs: 18 records, 0.036% of tokens, 0.19% of cost. | kinds from source (commit 085c84e); compaction usage seen in 5 of 820 sessions; the others unknown in data |
| 6 | When is cost missing or 0? Local models? Unknown price? | Never missing on an assistant message. Zero object when Pi has no catalog price: local models (LlamaBarn, llama-cpp), github-copilot, gemini-cli, some codex models, kimi-coding. 1,405 messages have tokens and zero cost. Billed-amount flag never seen. | field present on 22,845 of 22,845 messages; zero cost with tokens on 7 providers (1,405 messages); formula from source (commit 085c84e) |
| 7 | Tool names; shell tool; file tools? | `bash` (argument `command`, success from `isError`, exit code only in the error text); `read`, `edit`, `write` take `path`. Extension tools vary. | built-ins from source (commit 085c84e); counts seen in 820 sessions (`bash` in 12,241 calls); error text in 1,076 of 1,119 `bash` errors |
| 8 | Subagents? `parentSession` path or id? | Core Pi has none. Extensions provide `subagent`, `Task`, `oracle` tools; the shapes of their `details` are in Subagents. The example extension's children write no session file (`--no-session`); a bash-spawned `pi` writes one unless it has `--no-session`. `parentSession` is the parent file's path and is set only by `/fork` and `/clone`. | none in core, from source (commit 085c84e); example extension from source (Pi 1.5.0) and demo; extension tools seen in 12 of 820 sessions; `parentSession` in 1 of 820 (path form) |
| 9 | Does Pi rewrite old files on load? | Yes, once, and only when the format version is below 3: the whole file is rewritten with new ids (v1) and the role renamed (v2). A v3 file is only appended to. For fingerprints: size and modification time change on append only; a migrated file changes completely once. | from source (commit 085c84e); the migration itself unseen (0 of 820 sessions are below v3) |
| 10 | Where do sessions live, with environment overrides? | `~/.pi/agent/sessions/--<cwd>--/`; `$PI_CODING_AGENT_DIR` moves the agent directory; `--session-dir`, `$PI_CODING_AGENT_SESSION_DIR` or `sessionDir` move the sessions directory, with files directly in it. | from source (commit 085c84e) |

## What the corpus cannot show

- Versions before 2026-01 and after 2026-09-28; any v1 or v2 file; a file that Pi migrated.
- The newest additions (system role from only 3 records; no `usage` entry, `context_edit`,
  `thinkingLevel`, `responseModel`, `durationMs`, `toolResult.usage`, `compaction.systemMessage`).
- Whether the exporter removed fields (`pi-share-hf` redacts text; `parentSession` appears once, and
  no field was seen missing from the types that the source marks required).
- Branch summaries with usage, `/tree` navigation without a new message, several roots.
- Windows paths and sessions with a custom session directory.
- Cost accuracy: the figures are Pi's estimates (tokens x its catalog), never invoices.
- A representative user: the sessions are mostly Pi's developers.

## Open questions

1. When did Pi start writing `usage` entries, `context_edit`, the system role, `thinkingLevel` and
   `compaction.systemMessage`? (git history of the source, not read)
2. Are aborted and error responses' token counts partial?
3. Does `bash` ever persist an exit code field (`structuredContent`)?
4. What does `fromHook: true` on 46 of 64 compactions mean in practice?
5. Why does one session have 3 entries pointing at a missing parent (a branch removed by the
   exporter, or a Pi bug)?
6. How do subagent extensions store their child runs, and does any write a session file with
   `parentSession`? Answered in part, see Subagents. From source (Pi 1.5.0
   `examples/extensions/subagent`): the example spawns `pi --mode json -p --no-session` and returns
   `results[]` in the tool result's `details`; no session file. From the two demo sessions (Pi
   1.5.0, 2026-11-08): a bash-spawned child with `--no-session` leaves no file and no figure; one
   without it writes its own session file; the example extension in single, chain and parallel
   mode returns `results[]` with the child's messages. The demo's bash-spawned child without
   `--no-session` wrote a file whose header has no `parentSession`; Merlin links it by cwd, time window and exact
   first prompt (merlin-1es.15, heuristic). Still
   unknown: where other extensions keep child runs.
7. Does `/clone` differ from `/fork` in the file, and which one uses which copy function?
8. Is a Pi extension the right hook point for a live signal, or is tailing the file enough?

## Recommendations for the Pi harness (merlin-1es.6)

Implemented in `internal/pi` (parser version 1) unless a paragraph says otherwise. Where the
code differs from a paragraph, the paragraph ends with **Differs**.

**Message.ID.** Use the entry `id` joined with the nested `message.timestamp` in milliseconds,
`<id>.<ms>`. Evidence: entries are copied into forks with the same id, timestamp and usage (490 of
491 shared ids identical), so the catalog bills a copy once; 8 hex characters are not unique across a
history (one chance collision between unrelated sessions among 53,244 ids; about 100 expected
among a million) and the added timestamp separates them without breaking copies. Not
`responseId`: present on only 39% of messages (none for bedrock, gitlab-duo, kimi-coding) and
absent when the provider gives none. Keep `responseId` for nothing but display. A compaction's
usage, and any `usage`, `toolResult.usage` or `branch_summary.usage`, is its own message: the entry
id, the entry's `timestamp` and a suffix (`<id>.<timestamp>.compaction`, `.usage`, `.tool`,
`.branch`). The timestamp matters for the same reason as above: a bare entry id is not unique across
sessions. `Turn.UUID` uses `<id>.<ms>` too, so a fork's copied turns are recognised as shared.
*Implemented.* A usage-bearing `toolResult` gets `<id>.<entry timestamp>.tool`.

**Billed messages.** Every assistant message with `totalTokens > 0` (22,307 of 22,845; the 538 with
zero tokens are aborted or error responses and bill nothing), on any branch. Also: `compaction.usage`
(attach it as `Compaction.MessageID`), `branch_summary.usage`, `usage` entries and `toolResult.usage`
when present, each priced with the model named on it (`usage` entries name `provider` and `model`;
the others need the model of the neighbouring assistant message, which is a guess: mark it so).
*Implemented, except the marking:* the guess is made (the call's assistant message for a tool
result, the nearest assistant message or `model_change` above for a compaction or branch summary)
but no field on `Message` says so; the support table's `cost.perMessage` note does. **Differs.**
Not billed: `bashExecution`, `custom`, `custom_message`, `label`, `session_info`, `model_change`.
Cost: Pi's `usage.cost.total` when it is above 0; otherwise the price table by model; local
providers and models no table knows stay `Unpriced`. A cost of 0 with tokens is "Pi has no price",
not "free" (1,405 messages; github-copilot, LlamaBarn, llama-cpp, gemini-cli, codex models). `cost`
is never absent, so absence needs no handling, only a fallback for 0. A `totalFromProvider` of
true means a billed amount: seen with OpenRouter (`z-ai/glm-5.3`, Pi 1.5.0), on every one of 179
calls of a user's sessions there.
*Implemented.* `Message.Recorded` marks a message whose dollars are Pi's figure; the catalog flag
`recorded` means no reported windows and every priced owned message is `Recorded` (a mix stays
`estimated`). A local provider (`llama-cpp`, `LlamaBarn`, `ollama`, `lmstudio`, `vllm`, `localai`,
`local`) with a zero cost stays `Unpriced` without asking the table. `Message.Billed` (with
`Recorded`) marks a call whose `cost.totalFromProvider` is true: the figure is the provider's charge,
not Pi's catalog estimate; the catalog flag `billed` means every priced owned message is `Billed`.

**Current path and abandoned turns.** Read the file whole, index by id, take the last non-header
entry as the leaf and walk `parentId` to the root: that is the current path. Evidence: the source
defines the leaf that way and writes nothing on navigation; the last entry had no children in 820 of
820 sessions. A turn starts at a `user` message and runs through the assistant and tool-result
messages below it up to the next user message on the same branch. A `custom_message` starts no turn
(13 of 820 sessions; what triggers a reply is not recorded): anything it sets off belongs to the turn
before it, and its text is dropped for now, which the support table says. A `bashExecution` starts no
turn either; it feeds bead events only. A turn is `Abandoned` when its user message is off the path.
Abandoned assistant messages stay in `Messages` and in the totals (96 messages, 0.28% of cost in the
corpus); a compaction or branch summary off the path should not become a `Compaction` of the
current path. Orphans (a missing parent) are roots of their own; do not drop them. Order slices by
time, then id, from entry timestamps; use `message.timestamp` (request start) as `Message.At`.

**cacheWrite buckets.** `CacheWrite1h = usage.cacheWrite1h` (0 when absent); `CacheWrite5m =
usage.cacheWrite - usage.cacheWrite1h`. Evidence: `calculateCost` prices
`cacheWrite - cacheWrite1h` at the short rate and `cacheWrite1h` at twice the input rate (from
source, `models.ts`); `cacheWrite1h` was 0 in all 1,477 messages that carry it (no 1-hour write seen). Providers other than Anthropic report `cacheWrite` with no
retention class; treat as 5m. `Input = usage.input` as is (already without cache), `Output =
usage.output` (includes reasoning). *Implemented* (`cacheWrite1h` is clamped to `cacheWrite`).

**Smaller points.** Title is the last `session_info.name` on the file (empty clears it). Model of a
message is `message.model` (the selected `model_change` differed in 150 of 22,077 checked, 0.7%;
a virtual model answers with a physical one). Header `cwd` is the working directory (820 of 820
absolute); the directory name of the file is a lossy encoding of it, so use the header. `bash` tool
calls feed bead events: command from `arguments.command`, failure from `isError`. A parser must
accept `message.content` as a string or a block list (always blocks here), count unknown entry
types and roles, and treat `usage.kind` as open. Do not mark any capability `absent` from this
corpus; mark `parsed` the types in the table that the corpus has, `unknown` the ones it lacks.
Treat a second file with the same header id as a re-export, not a fork: keep the longer file (seven
pairs, one a prefix of the other) and warn. Discovery: walk the sessions directory recursively for
`*.jsonl` whose first line is a `session` header (the corpus is flat and has manifest files), and read
`PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` from the environment. The `sessionDir` setting
and `--session-dir` are not followed yet. *Implemented* (`paths.PiAgentDir`, `paths.PiSessionsDir`;
headers are cached by path and size like Codex's). Title, cwd, `bash` bead events, a re-export
(the longer file is kept, with a warning) and the fork's `parentSession` id are implemented as
written. The support table marks `absent` only what the source shows absent (git branch,
recaps, a reported total, a compaction trigger, agents); everything else is `parsed`, `dropped`
or `unknown`.

## Corpus run

The harness run over the corpus above (scratch home, empty Claude and Codex directories,
`PI_CODING_AGENT_SESSION_DIR` on the corpus, parser version 1; `merlin scan`, `merlin doctor
--json`, and throwaway scripts printing numbers only). Counts only; nothing of a session's text is
recorded here.

| | |
|---|---|
| files walked / sessions indexed | 824 / 813 (4 manifest files skipped silently; 7 re-exports: the longer file kept, 7 warnings) |
| failures, error stubs, bad lines | 0, 0, 0 |
| unknown entry types, unknown roles | none of either (every type and role in the corpus is one the parser knows) |
| assistant messages after removing identical lines | 22,615 |
| entries (not counting the header) by type | message 49,184 (user 3,537, assistant 22,615, toolResult 22,898, bashExecution 131, system 3), thinking_level_change 1,281, model_change 1,142, session_info 597, custom 446, custom_message 33, compaction 63, label 7, branch_summary 1 |
| turns / abandoned turns | 3,539 / 32 |
| compactions on the path / with a recorded call | 63 / 18 |
| lineage links in the catalog | 1 (the one fork; `lineage.fork` seen in 1 session). No false link: sessions that share an 8-hex entry id are not linked |
| messages shared between sessions | 30 (the fork's copies, billed once), of 22,109 distinct message ids |
| unpriced messages | 311 on 7 models (181 + 12 + 8 on three local GGUF/llama.cpp models, 88 on gpt-5.3-codex-spark, 18 on kimi k2p5, 2 on gemini-3-pro-preview, 2 on kimi-k2.5-free): zero in Pi's catalog and with no source for a price. The first run had 1,219 (59.4 M tokens) on 16 models, mostly gpt-5.x codex, gemini-3.x and claude-opus-4.5 and 4.6 as github-copilot spells them; adding those prices (and the `claude-opus-4.5`, `claude-opus-4.6` aliases) raised the catalog's best cost from $1,096.43 to $1,114.78 (+$18.35, all of it on the 908 messages that were unpriced) |
| cost flags | recorded 731, estimated 80 (every billed message in them is unpriced, so none is a recorded one; `lowerBound`), unknown 2, exact 0, partial 0. After the prices of merlin-1es.12: recorded 715, estimated 96 (16 sessions now mix Pi's figures with table prices, which the rule flags `estimated`) |
| doctor coverage contradictions for Pi | 1: `links.beads` parsed but seen in 0 of 813 sessions (no `bd` call in the corpus; may be right) |

**Total.** The catalog's best cost is $1,096.4338. The sum over the corpus of every assistant
`usage.cost.total` ($1,094.3098) and every `compaction.usage.cost.total` ($2.1240, 18 records),
with identical lines removed (so the 490 copied entries and the seven re-exports count once), is
$1,096.4338: equal to the cent and to the fourth decimal. No `usage` entry, `branch_summary.usage`
or `toolResult.usage` exists. In that run nothing came from our price table: every message with tokens and a
zero cost (1,219 after de-duplication) is on a model it does not know, so it is `Unpriced`, not priced. There is no difference to
explain. The two figures were computed by separate code (the Go digest and a script over the raw
lines). With the prices added in merlin-1es.12 the best cost is $1,114.78: the same $1,096.43 from
Pi's figures plus $18.35 from our table on 908 messages Pi has no price for.

**Our table against Pi's figure.** The table now prices 26 provider/model pairs that carry a Pi
cost: 20,351 messages and $1,085.29 of Pi's $1,094.31 on messages (99%; before, 7 models and 26%).
Our price of the tokens (one script over the raw lines, identical lines removed) equals Pi's cost
for 23 of the 26. By model:
claude-fable-5 1.000 (746 messages, $145.35 by Pi), claude-opus-4-5 1.000 ($239.28, 4,353),
gpt-5.3-codex, gpt-5.2-codex, gpt-5.5 and gpt-6-astra 1.000, and 1.000 for claude-opus-4-8, -4-6,
-4-7, claude-sonnet-4-6, claude-haiku-4-5 and the other small ones. Three are off, each for a
reason in the data. gpt-5.4 on openai-codex is 1.0995 ($223.59 by Pi, $245.84 ours): 103 of its
4,353 messages have more than 272,000 input tokens, OpenAI's page bills them at the long-context
rate and Pi's catalog has no tier for it; without those 103 the ratio is 1.000. gpt-5.6-sol is
0.782 ($125.61 by Pi, $98.19 ours): Pi recorded 5 / 30 / 0.5 per million tokens on its July to
September messages and the page now shows 4 / 20 / 0.4, labelled promotional until 2026-11-30, so our entry is `assumed`.
gitlab-duo's gpt-5-codex is 0.676 ($0.15 vs $0.10): Pi recorded 2.5 / 10 and no cache read, which
looks like GitLab's own price rather than OpenAI's. **The earlier 1.015 on claude-fable-5 was not a price difference.**
Per class, Pi's costs on the 746 messages imply exactly 10, 50, 1.00 and 12.50 per million tokens
for input, output, cache read and cache write (no 1h writes occur), the same as our table. The
Go digest groups 754 messages under claude-fable-5 with 142,066 input and 29,287 output tokens
more than the messages carry: those are the `compaction.usage` records of the session, which Pi
priced at 1.75 / 14 (a gpt-5.x model) and we priced as the session's model, claude-fable-5. That
adds $2.89 by our rates against $0.66 by Pi's, which is the $148.23 against $146.01 (the token and cost
figures match to the cent). This is the guess described under Billed messages: a compaction's usage
names no model, so the parser takes the nearest assistant message's, and here Pi's own cost shows a
different model made the call. Totals use Pi's figure and are right; the per-model split is not
(merlin-1es.9). The models Pi recorded a cost for and our table still lacks are the
small ones (bedrock, gitlab-duo, antigravity and opencode spellings, glm, kimi, qwen, minimax,
gemini-3-pro-high and -low).

**Unknown sessions.** Two sessions have the flag `unknown`, where zero were expected: in both,
every assistant message (5 and 4) has zero tokens and zero cost (one stopped by an abort), yet the
turn ran 5 and 4 tool calls. The catalog's rule applies as designed (work, no billed message): the
cost was not recorded, so it is unknown, not $0.
