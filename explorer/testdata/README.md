# Explorer test fixtures

Synthetic Claude Code transcripts. Every prompt, reply and path is invented (`/home/dev/acme/...`).
The tree is usable directly as `CLAUDE_CONFIG_DIR=explorer/testdata/claude`; transcripts live under
`claude/projects/<project-key>/`. `internal/fixtures` locates the tree and validates it.

Regenerate with `bun explorer/testdata/generate.ts` (rewrites `claude/` and this file). The committed
files are authoritative; the generator only keeps ids, timestamps, copied records and costs consistent.

Conventions

- Session ids: `SSSSSSSS-0000-4000-8000-00000000000V` where SS is the scenario number repeated four times (scenario 05: `05050505`)
  and V the variant. Record uuids: `SSFF0000-0000-4000-9000-<seq>` (FF = file index inside the scenario).
  Agent ids: `aSSe0c0de000000N` (16 hex). Message ids `msg_<name>_NN`, tool ids `toolu_<name>_NN`.
- Timestamps: RFC 3339 UTC, base `2026-09-SST10:00:00Z` (SS = scenario number), non-decreasing inside every file,
  and consistent between a parent and its subagent files. Copied records keep their original timestamps.
- Default model `claude-sonnet-5-5` (input $2, output $10, cache read $0.20 per million). Cache write = input price x 1.25
  (5m) or x 2 (1h); main sessions write 1h, subagents write 5m. Prices for other models are in transcript-format.md section 8.
- A *turn* is a human prompt (including a slash command) and everything until the next one. "Abandoned" = on a branch
  the session later rewound away from. Token counts are small round numbers; arithmetic is shown per message below
  (each message id is billed once; for split messages the last line's usage counts).
- Most scenarios use `cli` / version 2.1.200 with `origin`+`promptSource` on prompts. Scenario 03 mimics an older
  version (2.1.150) with no `origin`; 15 and 16 use 2.1.280.
- turn_duration system records are written with the full envelope (uuid, parentUuid) and sit in the parentUuid chain.
- Files that must be ignored by a scan: see scenario 21.

## Scenario table

| # | scenario | project key | session id(s) | headline facts |
|---|---|---|---|---|
| 01 | plain | `-home-dev-acme-plain` | `01010101-0000-4000-8000-000000000001` | 2 turns, 5 assistant messages, ai-title "Add login page", cost $0.02124 |
| 02 | multi-line message | `-home-dev-acme-multi-line` | `02020202-0000-4000-8000-000000000001` | 1 turn, 2 distinct messages (5 assistant lines), cost $0.01285 |
| 03 | slash commands, titles | `-home-dev-acme-slash` | `03030303-0000-4000-8000-000000000001` | title "My logout work" (custom beats ai-title), 2 model-answered turns, cost $0.0132 |
| 04 | interruption | `-home-dev-acme-interrupt` | `04040404-0000-4000-8000-000000000001` | 8 turns; 4 interrupted; cost $0.02088 |
| 05a | compaction, two pairs | `-home-dev-acme-s05-compaction` | `05050505-0000-4000-8000-000000000001` | 4 turns, 2 compactions, cost $0.01796 |
| 05b | file begins with boundary | `-home-dev-acme-s05-compaction` | `05050505-0000-4000-8000-000000000002` | 1 turn, 1 compaction (leading), cost $0.0056 |
| 05c | repeated uuid | `-home-dev-acme-s05-compaction` | `05050505-0000-4000-8000-000000000003` | 2 turns, 2 messages, cost $0.0119 |
| 05d | subagent that compacts | `-home-dev-acme-s05-compaction` | `05050505-0000-4000-8000-000000000004`<br>`a05e0c0de0000001` | 1 turn, 1 agent with 1 compaction, cost $0.0222 |
| 06 | sync subagent | `-home-dev-acme-subsync` | `06060606-0000-4000-8000-000000000001`<br>`a06e0c0de0000001` | 1 turn, 1 agent (meta link), cost $0.02132 |
| 07 | background subagent | `-home-dev-acme-subbg` | `07070707-0000-4000-8000-000000000001`<br>`a07e0c0de0000001` | 2 human turns + 1 task-notification turn, 1 background agent, cost $0.02408 |
| 08 | nested subagent | `-home-dev-acme-subnest` | `08080808-0000-4000-8000-000000000001`<br>`a08e0c0de0000001`<br>`a08e0c0de0000002` | 1 turn, agents A (depth 1) and B (depth 2, parent A), cost $0.02622 |
| 09 | teammate | `-home-dev-acme-team` | `09090909-0000-4000-8000-000000000001`<br>`areviewer-09e0c0de00000001` | 2 human turns, 1 teammate "reviewer" with 1 inbox message, cost $0.02625 |
| 10 | fork agents | `-home-dev-acme-fork` | `10101010-0000-4000-8000-000000000001`<br>`a10e0c0de0000001`<br>`a10e0c0de0000002`<br>`a10e0c0de0000003` | 1 turn, 3 fork agents, 1 message shared by two of them, cost $0.02101 |
| 11 | linkage fallbacks | `-home-dev-acme-linkage` | `11111111-0000-4000-8000-000000000001`<br>`a11e0c0de0000001`<br>`a11e0c0de0000002`<br>`a11e0c0de0000003` | 1 turn, 3 agents: tool-result, prompt, unresolved; cost $0.02556 |
| 12 | orphan | `-home-dev-acme-orphan` | `12121212-0000-4000-8000-000000000001`<br>`a12e0c0de0000001`<br>`a1b2c3d`<br>`acompact-12e0c0de` | no main file, 3 agent files, cost $0.0131 |
| 13a | copy: continuation, unmarked | `-home-dev-acme-s13a-continuation` | `13131313-0000-4000-8000-000000000001`<br>`13131313-0000-4000-8000-000000000002` | B copies all of A then adds 1 turn; unique cost $0.01712 |
| 13b | copy: fork, unmarked | `-home-dev-acme-s13b-fork-unmarked` | `13131313-0000-4000-8000-000000000003`<br>`13131313-0000-4000-8000-000000000004` | both continue after the copy point; unique cost $0.01874 |
| 13c | copy: fork, forkedFrom | `-home-dev-acme-s13c-fork-marked` | `13131313-0000-4000-8000-000000000005`<br>`13131313-0000-4000-8000-000000000006` | like 13b, copied records carry forkedFrom; unique cost $0.01874 |
| 13d | copy: partial, session_id | `-home-dev-acme-s13d-partial-copy` | `13131313-0000-4000-8000-000000000007`<br>`13131313-0000-4000-8000-000000000008` | B = boundary + summary + A's tail (session_id marked) + 1 turn; unique cost $0.0187 |
| 13e | copy: SDK pickup | `-home-dev-acme-s13e-sdk-pickup` | `13131313-0000-4000-8000-000000000009`<br>`13131313-0000-4000-8000-000000000010` | B mixes cli and sdk-cli records, not scripted; unique cost $0.01712 |
| 14 | rewind in one file | `-home-dev-acme-rewind` | `14141414-0000-4000-8000-000000000001` | 6 prompts, 4 active turns, 2 abandoned, 2 branch points, cost $0.01976 |
| 15 | sdk one-shot | `-home-dev-acme-sdk` | `15151515-0000-4000-8000-000000000001` | 1 turn, all sdk-cli, cost-state at end, transcript cost $0.0124 |
| 16 | cost-state, many models | `-home-dev-acme-coststate` | `16161616-0000-4000-8000-000000000001`<br>`a16e0c0de0000001` | 3 turns, models opus/sonnet/fable + haiku agent, 2 cost-state records, transcript cost $0.1157 |
| 17 | hostile input | `-home-dev-acme-hostile` | `17171717-0000-4000-8000-000000000001` | 3 turns, 1 corrupt line, 1 unknown type, 1 line over 1 MB, partial tail, 1 synthetic message, cost $0.01394 |
| 18 | cwd change | `-home-dev-acme-cwdchange` | `18181818-0000-4000-8000-000000000001` | 3 turns, cwd and branch change twice, cost $0.01364 |
| 19 | day boundary | `-home-dev-acme-daybound` | `19191919-0000-4000-8000-000000000001` | 3 turns, tz America/New_York, cost $0.01668 |
| 20 | pricing edges | `-home-dev-acme-pricing` | `20202020-0000-4000-8000-000000000001` | 1 turn, 4 messages, unpriced model, fast speed, mixed cache writes |
| 21 | non-transcript files | `-home-dev-acme-misc` | `21212121-0000-4000-8000-000000000001` | 1 turn; notes.jsonl, vercel-plugin/, sessions-index.json, memory/ ignored; cost $0.0105 |
| 22 | nested project dir | `-home-dev-acme-nest` | `22222222-0000-4000-8000-000000000001`<br>`22222222-0000-4000-8000-000000000002`<br>`a22e0c0de0000001` | outer session, plus inner project directory with a session and 1 agent; cost $0.0246 |

Also: `claude/sessions/4242.json` (pid 4242, session 01010101-0000-4000-8000-000000000001, busy) and `claude/sessions/4343.json` (pid 4343, session 03030303-0000-4000-8000-000000000001, idle).
Neither pid is expected to be alive. `startedAt`/`updatedAt` there are epoch milliseconds (assumed).

## Details and expected costs

### 01 plain
Prompts: "add a login page" (turn 1, ends end_turn, turn_duration 12000 ms), "now add a logout button" (turn 2, 8000 ms). 5 assistant
messages, 3 tool_use. An attachment record follows the first prompt. ai-title "Add login page". Final text turn 1 "Done, 3 files changed".
Live registry file sessions/4242.json points here.

- `msg_plain_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 100 out x $10/M = $0.001 + 2000 cache-write-1h x $4/M = $0.008 = **$0.011**
- `msg_plain_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 200 out x $10/M = $0.002 + 2000 cache-read x $0.2/M = $0.0004 + 500 cache-write-1h x $4/M = $0.002 = **$0.0046**
- `msg_plain_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 2500 cache-read x $0.2/M = $0.0005 = **$0.0012**
- `msg_plain_04` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 150 out x $10/M = $0.0015 + 3000 cache-read x $0.2/M = $0.0006 + 200 cache-write-1h x $4/M = $0.0008 = **$0.0031**
- `msg_plain_05` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 3200 cache-read x $0.2/M = $0.00064 = **$0.00134**
- **total 01: $0.02124**

### 02 multi-line message
`msg_multi_01` is 3 lines (thinking, text, tool_use) with output tokens 10, 60, 120 (last wins; other usage fields equal); `msg_multi_02` is 2 lines
(output 30, 45). Count: 2 messages, 1 turn, 1 tool call. Naive per-line summing would give wrong cost.

- `msg_multi_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 120 out x $10/M = $0.0012 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0112**
- `msg_multi_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 45 out x $10/M = $0.00045 + 3000 cache-read x $0.2/M = $0.0006 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00165**
- **total 02: $0.01285**

### 03 slash commands and titles (older version, no origin fields)
Records in order: isMeta caveat (not a prompt); `/model sonnet` command + its `<local-command-stdout>` (a command turn with no model response; stdout record is not a prompt);
"add a logout button" (typed turn); `/review the login page` (command turn, command "review" with args, model response); `!ls src` bash-input + bash-stdout (local, no response).
Titles: ai-title "Logout button task", then custom-title "My logout work", then ai-title "Logout and review": expected title **"My logout work"**.
Model-answered turns: 2. Live registry file sessions/4343.json points here.

- `msg_slash_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 80 out x $10/M = $0.0008 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0108**
- `msg_slash_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 60 out x $10/M = $0.0006 + 2000 cache-read x $0.2/M = $0.0004 + 300 cache-write-1h x $4/M = $0.0012 = **$0.0024**
- **total 03: $0.0132**

### 04 interruption
1. "refactor the router": assistant text with stop_reason null, then a bare string `[Request interrupted by user]` -> turn 1 **interrupted**; the marker is not a turn.
2. "actually, rename router.ts to routes.ts": complete.
3. "add tests for routes.ts": tool_use, error tool_result, bare array-form `[Request interrupted by user for tool use]` -> turn 3 **interrupted**.
4. "use the built-in runner instead": a normal prompt after the marker, complete.
5. "rename routes.ts to paths.ts": partial answer, then ONE record with content array [marker text, "stop, keep the old name"] -> turn 5 **interrupted**, and
   a new turn 6 with the marker stripped: "stop, keep the old name" (answered "Okay, keeping routes.ts").
6. "add a changelog entry": partial answer, then a string `[Request interrupted by user]use tabs not spaces` -> turn **interrupted**, new turn "use tabs not spaces".
Totals: turns = 8 (refactor, rename, tests, built-in runner, rename-again, stop-keep, changelog, use-tabs); interrupted = 4 (refactor, tests, rename-again, changelog).
(The marker-with-text forms in 5 and 6 are my reading of PLAN.md section 5 "With text after it, the marker is stripped and the rest is a turn".)

- `msg_int_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 40 out x $10/M = $0.0004 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0104**
- `msg_int_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 80 out x $10/M = $0.0008 + 2000 cache-read x $0.2/M = $0.0004 + 300 cache-write-1h x $4/M = $0.0012 = **$0.0026**
- `msg_int_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 2400 cache-read x $0.2/M = $0.00048 = **$0.00098**
- `msg_int_04` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 60 out x $10/M = $0.0006 + 2500 cache-read x $0.2/M = $0.0005 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0017**
- `msg_int_05` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 2700 cache-read x $0.2/M = $0.00054 = **$0.00124**
- `msg_int_06` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 20 out x $10/M = $0.0002 + 2800 cache-read x $0.2/M = $0.00056 = **$0.00096**
- `msg_int_07` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 20 out x $10/M = $0.0002 + 2900 cache-read x $0.2/M = $0.00058 = **$0.00098**
- `msg_int_08` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 20 out x $10/M = $0.0002 + 3000 cache-read x $0.2/M = $0.0006 = **$0.001**
- `msg_int_09` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 20 out x $10/M = $0.0002 + 3100 cache-read x $0.2/M = $0.00062 = **$0.00102**
- **total 04: $0.02088**

### 05 compaction (project -home-dev-acme-s05-compaction, 4 sessions)
- **05a** `05050505-0000-4000-8000-000000000001`: turns 1-2 before, boundary #1 (**auto**, preTokens 150000, postTokens 12000, durationMs 8000, logicalParentUuid resolves, summary at +1),
  turn 3 between, boundary #2 (**manual**, preTokens 90000, **no postTokens**, logicalParentUuid `05010000-ffff-4000-9000-000000000999` is **not in the file**,
  an attachment record sits between boundary and summary so the summary is at +2), turn 4 after. 4 turns, 2 compactions, 2 epoch changes.
- **05b** `05050505-0000-4000-8000-000000000002`: the file BEGINS with a manual boundary (logicalParentUuid not in file) + summary, then one turn. 1 compaction at epoch 0, no earlier turns.
- **05c** `05050505-0000-4000-8000-000000000003`: 2 turns. Two trailing records repeat the uuid of the first prompt and of the first assistant message (with different text and a huge usage,
  message id `msg_cmpc_dup`); both must be **skipped**, so turns = 2 and cost is unaffected.
- **05d** `05050505-0000-4000-8000-000000000004` + agent `a05e0c0de0000001`: the agent file contains a manual boundary (pre 80000, post 9000) + summary; 1 compaction on the agent.

05a
- `msg_cmpa_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 100 out x $10/M = $0.001 + 2000 cache-write-1h x $4/M = $0.008 = **$0.011**
- `msg_cmpa_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2000 cache-read x $0.2/M = $0.0004 + 500 cache-write-1h x $4/M = $0.002 = **$0.003**
- `msg_cmpa_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2500 cache-read x $0.2/M = $0.0005 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0015**
- `msg_cmpa_04` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 1500 cache-read x $0.2/M = $0.0003 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0012**
- `msg_cmpa_05` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 1800 cache-read x $0.2/M = $0.00036 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00126**
- **total 05a: $0.01796**

05b
- `msg_cmpb_01` (claude-sonnet-5-5): 500 in x $2/M = $0.001 + 60 out x $10/M = $0.0006 + 1000 cache-write-1h x $4/M = $0.004 = **$0.0056**
- **total 05b: $0.0056**

05c
- `msg_cmpc_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 50 out x $10/M = $0.0005 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0105**
- `msg_cmpc_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2000 cache-read x $0.2/M = $0.0004 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0014**
- **total 05c: $0.0119**

05d
- `msg_cmpd_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 80 out x $10/M = $0.0008 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0108**
- `msg_cmpd_a1` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 60 out x $10/M = $0.0006 + 1000 cache-write-5m x $2.5/M = $0.0025 = **$0.0051**
- `msg_cmpd_a2` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 1000 cache-read x $0.2/M = $0.0002 + 500 cache-write-5m x $2.5/M = $0.00125 = **$0.00195**
- `msg_cmpd_a3` (claude-sonnet-5-5): 200 in x $2/M = $0.0004 + 40 out x $10/M = $0.0004 + 900 cache-write-5m x $2.5/M = $0.00225 = **$0.00305**
- `msg_cmpd_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 2000 cache-read x $0.2/M = $0.0004 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0013**
- **total 05d: $0.0222**

### 06 sync subagent
Main prompt, Agent tool_use `toolu_sync_01` (subagent_type Explore), agent `a06e0c0de0000001` (meta.toolUseId `toolu_sync_01`, spawnDepth 1), tool_result with
toolUseResult status completed (agentId, totalTokens, totalDurationMs). Linkage "meta". Agent cost uses 5m cache writes. Also present and to be ignored:
`<session>/tool-results/toolu_sync_01.txt`, `<session>/custom-title.json`.

- `msg_sync_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 80 out x $10/M = $0.0008 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0108**
- `msg_sync_a1` (claude-sonnet-5-5): 2000 in x $2/M = $0.004 + 60 out x $10/M = $0.0006 + 1000 cache-write-5m x $2.5/M = $0.0025 = **$0.0071**
- `msg_sync_a2` (claude-sonnet-5-5): 300 in x $2/M = $0.0006 + 40 out x $10/M = $0.0004 + 3000 cache-read x $0.2/M = $0.0006 + 200 cache-write-5m x $2.5/M = $0.0005 = **$0.0021**
- `msg_sync_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 2100 cache-read x $0.2/M = $0.00042 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00132**
- **total 06: $0.02132**

### 07 background subagent
Agent `a07e0c0de0000001` launched by `toolu_bg_01` (run_in_background); tool_result status async_launched with agentId and outputFile. It runs 20s-60s after the start.
At +120 s a user record with origin task-notification (and the `<task-notification>` text prefix, `<task-id>` = agent id) starts a model response: that is
a turn of origin task-notification, not human. Turns: human "run the slow audit..." , task-notification, human "fix the first issue" = 3 turns, 2 human.

- `msg_bg_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 80 out x $10/M = $0.0008 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0108**
- `msg_bg_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 2100 cache-read x $0.2/M = $0.00042 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00132**
- `msg_bg_a1` (claude-sonnet-5-5): 2000 in x $2/M = $0.004 + 60 out x $10/M = $0.0006 + 1000 cache-write-5m x $2.5/M = $0.0025 = **$0.0071**
- `msg_bg_a2` (claude-sonnet-5-5): 300 in x $2/M = $0.0006 + 40 out x $10/M = $0.0004 + 3000 cache-read x $0.2/M = $0.0006 + 200 cache-write-5m x $2.5/M = $0.0005 = **$0.0021**
- `msg_bg_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 2300 cache-read x $0.2/M = $0.00046 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00136**
- `msg_bg_04` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 2500 cache-read x $0.2/M = $0.0005 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0014**
- **total 07: $0.02408**

### 08 nested subagent
Main spawns A (`a08e0c0de0000001`, toolu_nest_01, depth 1); A's file contains the Agent tool_use `toolu_nest_02` that spawns B (`a08e0c0de0000002`, depth 2, meta.parentAgentId = A).
Both agent files sit flat in the same `subagents/` directory. Subtree cost of A = A + B.

- `msg_nest_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 80 out x $10/M = $0.0008 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0108**
- `msg_nest_a1` (claude-sonnet-5-5): 2000 in x $2/M = $0.004 + 60 out x $10/M = $0.0006 + 1000 cache-write-5m x $2.5/M = $0.0025 = **$0.0071**
- `msg_nest_b1` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 40 out x $10/M = $0.0004 + 500 cache-write-5m x $2.5/M = $0.00125 = **$0.00365**
- `msg_nest_b2` (claude-sonnet-5-5): 200 in x $2/M = $0.0004 + 30 out x $10/M = $0.0003 + 1500 cache-read x $0.2/M = $0.0003 + 100 cache-write-5m x $2.5/M = $0.00025 = **$0.00125**
- `msg_nest_a2` (claude-sonnet-5-5): 300 in x $2/M = $0.0006 + 40 out x $10/M = $0.0004 + 3000 cache-read x $0.2/M = $0.0006 + 200 cache-write-5m x $2.5/M = $0.0005 = **$0.0021**
- `msg_nest_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 2100 cache-read x $0.2/M = $0.00042 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00132**
- **total 08: $0.02622**

### 09 teammate
Agent tool_use `toolu_team_01` has `name: "reviewer"`, team_name acme-team; result status teammate_spawned (`agent_id: reviewer@acme-team`). Agent file
`agent-areviewer-09e0c0de00000001.jsonl` (agentId `areviewer-09e0c0de00000001`), meta agentType/name reviewer, teamName acme-team, taskKind in_process_teammate, spawnDepth 0, **no toolUseId**
(so linkage must be by name). Turn 2 sends a SendMessage; the agent file then gets a user record origin peer with a `<teammate-message ...>` body: 1 inbox message
("Please also check the tests."). Agent has 3 assistant messages.

- `msg_team_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 80 out x $10/M = $0.0008 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0108**
- `msg_team_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 2100 cache-read x $0.2/M = $0.00042 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00132**
- `msg_team_a1` (claude-sonnet-5-5): 2000 in x $2/M = $0.004 + 60 out x $10/M = $0.0006 + 1000 cache-write-5m x $2.5/M = $0.0025 = **$0.0071**
- `msg_team_a2` (claude-sonnet-5-5): 300 in x $2/M = $0.0006 + 40 out x $10/M = $0.0004 + 3000 cache-read x $0.2/M = $0.0006 + 200 cache-write-5m x $2.5/M = $0.0005 = **$0.0021**
- `msg_team_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 60 out x $10/M = $0.0006 + 2300 cache-read x $0.2/M = $0.00046 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00166**
- `msg_team_a3` (claude-sonnet-5-5): 300 in x $2/M = $0.0006 + 30 out x $10/M = $0.0003 + 3500 cache-read x $0.2/M = $0.0007 + 100 cache-write-5m x $2.5/M = $0.00025 = **$0.00185**
- `msg_team_04` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 2600 cache-read x $0.2/M = $0.00052 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00142**
- **total 09: $0.02625**

### 10 fork agents
Main has one message `msg_fork_01` in 3 lines, each an Agent tool_use (fork type). Agents: `a10e0c0de0000001` (sqlite) and `a10e0c0de0000002` (postgres) are old-style forks: each starts with the same
two context records (same uuid and timestamp: a user prompt and assistant `msg_fork_ctx_01`), then its own; `a10e0c0de0000003` (mysql) is new-style: a `fork-context-ref` record
(no uuid) instead of copied context. All three: meta isFork true, agentType fork. `msg_fork_ctx_01` is billed **once**.
Naive per-file sums: agent-a10e0c0de0000001.jsonl = $0.00525, agent-a10e0c0de0000002.jsonl = $0.00525, agent-a10e0c0de0000003.jsonl = $0.00155 (sums of fork files exceed the true total).

- `msg_fork_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 80 out x $10/M = $0.0008 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0108**
- `msg_fork_ctx_01` (claude-sonnet-5-5): 500 in x $2/M = $0.001 + 20 out x $10/M = $0.0002 + 1000 cache-write-5m x $2.5/M = $0.0025 = **$0.0037**
- `msg_fork_f1_01` (claude-sonnet-5-5): 300 in x $2/M = $0.0006 + 40 out x $10/M = $0.0004 + 1500 cache-read x $0.2/M = $0.0003 + 100 cache-write-5m x $2.5/M = $0.00025 = **$0.00155**
- `msg_fork_f2_01` (claude-sonnet-5-5): 300 in x $2/M = $0.0006 + 40 out x $10/M = $0.0004 + 1500 cache-read x $0.2/M = $0.0003 + 100 cache-write-5m x $2.5/M = $0.00025 = **$0.00155**
- `msg_fork_f3_01` (claude-sonnet-5-5): 300 in x $2/M = $0.0006 + 40 out x $10/M = $0.0004 + 1500 cache-read x $0.2/M = $0.0003 + 100 cache-write-5m x $2.5/M = $0.00025 = **$0.00155**
- `msg_fork_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2300 cache-read x $0.2/M = $0.00046 + 200 cache-write-1h x $4/M = $0.0008 = **$0.00186**
- **total 10: $0.02101**

### 11 linkage fallbacks
Main message `msg_link_01` spawns two agents (`toolu_link_01` "Find the entry point.", `toolu_link_02` "List the config files.").
- `a11e0c0de0000001`: meta without toolUseId; its first prompt ("Context: the repo is small. Find the entry point.") does not equal the input prompt; the `toolu_link_01` result has toolUseResult.agentId -> linkage **tool-result**.
- `a11e0c0de0000002`: meta without toolUseId; the `toolu_link_02` result has no agentId; first prompt equals input.prompt exactly -> linkage **prompt**.
- `a11e0c0de0000003`: no meta file, prompt matches nothing, no result names it -> **unresolved** (attached to the session root).

- `msg_link_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 80 out x $10/M = $0.0008 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0108**
- `msg_link_a1` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 30 out x $10/M = $0.0003 + 800 cache-write-5m x $2.5/M = $0.002 = **$0.0043**
- `msg_link_a2` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 40 out x $10/M = $0.0004 + 800 cache-write-5m x $2.5/M = $0.002 = **$0.0044**
- `msg_link_a3` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 20 out x $10/M = $0.0002 + 800 cache-write-5m x $2.5/M = $0.002 = **$0.0042**
- `msg_link_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2300 cache-read x $0.2/M = $0.00046 + 200 cache-write-1h x $4/M = $0.0008 = **$0.00186**
- **total 11: $0.02556**

### 12 orphan
`projects/-home-dev-acme-orphan/12121212-0000-4000-8000-000000000001/subagents/` holds `agent-a12e0c0de0000001.jsonl` (+meta whose toolUseId matches nothing), `agent-a1b2c3d.jsonl` (old style, no meta) and
`agent-acompact-12e0c0de.jsonl` (compaction agent, no meta). There is **no** `12121212-0000-4000-8000-000000000001.jsonl`. Records have sessionId 12121212-0000-4000-8000-000000000001, version 2.1.71.

- `msg_orph_a1` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 30 out x $10/M = $0.0003 + 800 cache-write-5m x $2.5/M = $0.002 = **$0.0043**
- `msg_orph_a2` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 20 out x $10/M = $0.0002 + 800 cache-write-5m x $2.5/M = $0.002 = **$0.0042**
- `msg_orph_a3` (claude-sonnet-5-5): 2000 in x $2/M = $0.004 + 60 out x $10/M = $0.0006 = **$0.0046**
- **total 12: $0.0131**

### 13 copied history
Copied records keep uuid, message.id, timestamp; sessionId is rewritten. Common conversation (A): "add a search box" (tool_use, result, answer, turn_duration) and "style the search box".
Naive per-file sums are shown to demonstrate the double counting; the unique cost is what counts.
- **13a** continuation, unmarked: `13131313-0000-4000-8000-000000000001` (A) has 2 turns and stops. `13131313-0000-4000-8000-000000000002` (B) = all of A's records + turn "add a clear button". A has no records after the copy point. Per file: 13131313-0000-4000-8000-000000000001.jsonl = $0.0156, 13131313-0000-4000-8000-000000000002.jsonl = $0.01712.
- **13b** fork, unmarked: A `13131313-0000-4000-8000-000000000003` has 2 turns then its own "add search history" 5 minutes later; B `13131313-0000-4000-8000-000000000004` copies A's first 2 turns, then "add search suggestions". Both continue. Per file: 13131313-0000-4000-8000-000000000003.jsonl = $0.01712, 13131313-0000-4000-8000-000000000004.jsonl = $0.01722.
- **13c** fork marked: same shape as 13b (A `13131313-0000-4000-8000-000000000005`, B `13131313-0000-4000-8000-000000000006`) but every copied record in B has `forkedFrom: {sessionId: A, messageUuid: <its own uuid>}`. Per file: 13131313-0000-4000-8000-000000000005.jsonl = $0.01712, 13131313-0000-4000-8000-000000000006.jsonl = $0.01722.
- **13d** partial copy: A `13131313-0000-4000-8000-000000000007` has 3 turns (the third is "add a reset button"). B `13131313-0000-4000-8000-000000000008` begins with a compact boundary (auto) + summary, then **only A's third turn** copied with `session_id` = A and `sessionId` = B,
  then B's own "add a disabled state". The copied head's parentUuid points to a record that is not in B. Boundary and summary timestamps precede the copied tail so the file stays ordered. Per file: 13131313-0000-4000-8000-000000000007.jsonl = $0.01714, 13131313-0000-4000-8000-000000000008.jsonl = $0.0031.
- **13e** SDK pickup: A `13131313-0000-4000-8000-000000000009` all `cli`; B `13131313-0000-4000-8000-000000000010`'s copied records are `cli`, its own turn "add a clear button" is `sdk-cli` (promptSource sdk). B must be classified **interactive**, not sdk. Per file: 13131313-0000-4000-8000-000000000009.jsonl = $0.0156, 13131313-0000-4000-8000-000000000010.jsonl = $0.01712.

13a
- `msg_cpa_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 100 out x $10/M = $0.001 + 2000 cache-write-1h x $4/M = $0.008 = **$0.011**
- `msg_cpa_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 2000 cache-read x $0.2/M = $0.0004 + 500 cache-write-1h x $4/M = $0.002 = **$0.0031**
- `msg_cpa_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2500 cache-read x $0.2/M = $0.0005 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0015**
- `msg_cpa_b1` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2600 cache-read x $0.2/M = $0.00052 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00152**
- **total 13a: $0.01712**

13b
- `msg_cpb_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 100 out x $10/M = $0.001 + 2000 cache-write-1h x $4/M = $0.008 = **$0.011**
- `msg_cpb_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 2000 cache-read x $0.2/M = $0.0004 + 500 cache-write-1h x $4/M = $0.002 = **$0.0031**
- `msg_cpb_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2500 cache-read x $0.2/M = $0.0005 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0015**
- `msg_cpb_a1` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2600 cache-read x $0.2/M = $0.00052 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00152**
- `msg_cpb_b1` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 2600 cache-read x $0.2/M = $0.00052 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00162**
- **total 13b: $0.01874**

13c
- `msg_cpc_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 100 out x $10/M = $0.001 + 2000 cache-write-1h x $4/M = $0.008 = **$0.011**
- `msg_cpc_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 2000 cache-read x $0.2/M = $0.0004 + 500 cache-write-1h x $4/M = $0.002 = **$0.0031**
- `msg_cpc_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2500 cache-read x $0.2/M = $0.0005 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0015**
- `msg_cpc_a1` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2600 cache-read x $0.2/M = $0.00052 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00152**
- `msg_cpc_b1` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 2600 cache-read x $0.2/M = $0.00052 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00162**
- **total 13c: $0.01874**

13d
- `msg_cpd_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 100 out x $10/M = $0.001 + 2000 cache-write-1h x $4/M = $0.008 = **$0.011**
- `msg_cpd_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 2000 cache-read x $0.2/M = $0.0004 + 500 cache-write-1h x $4/M = $0.002 = **$0.0031**
- `msg_cpd_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2500 cache-read x $0.2/M = $0.0005 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0015**
- `msg_cpd_04` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2700 cache-read x $0.2/M = $0.00054 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00154**
- `msg_cpd_b1` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2800 cache-read x $0.2/M = $0.00056 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00156**
- **total 13d: $0.0187**

13e
- `msg_cpe_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 100 out x $10/M = $0.001 + 2000 cache-write-1h x $4/M = $0.008 = **$0.011**
- `msg_cpe_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 2000 cache-read x $0.2/M = $0.0004 + 500 cache-write-1h x $4/M = $0.002 = **$0.0031**
- `msg_cpe_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2500 cache-read x $0.2/M = $0.0005 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0015**
- `msg_cpe_b1` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2600 cache-read x $0.2/M = $0.00052 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00152**
- **total 13e: $0.01712**

### 14 rewind inside one file
Chain: every record (including attachments and turn_duration) is linked by parentUuid.
- T0 "scaffold the app" (complete). Its turn_duration `X` has **two** child prompts:
  "add a settings page" (answered, **abandoned**) and "add a profile page instead" (active). Branch point 1.
- After the profile turn's turn_duration `Y`: "add dark mode" (no response at all, **abandoned**) and "add light mode" (active). Branch point 2.
- "rename both config files": one assistant record (`msg_rw_05`) with two tool_use blocks; its two tool_result children are siblings; the conversation continues from the second.
  **Not** a branch point.
Totals: 6 prompts, 4 active turns (scaffold, profile, light mode, rename), 2 abandoned (settings, dark mode), 2 branch points. Messages `msg_rw_02` belongs to the abandoned
branch but is still billed. `last-prompt.leafUuid` names the last record.

- `msg_rw_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 60 out x $10/M = $0.0006 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0106**
- `msg_rw_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2000 cache-read x $0.2/M = $0.0004 + 200 cache-write-1h x $4/M = $0.0008 = **$0.0018**
- `msg_rw_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2200 cache-read x $0.2/M = $0.00044 + 200 cache-write-1h x $4/M = $0.0008 = **$0.00184**
- `msg_rw_04` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2500 cache-read x $0.2/M = $0.0005 + 200 cache-write-1h x $4/M = $0.0008 = **$0.0019**
- `msg_rw_05` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 90 out x $10/M = $0.0009 + 2700 cache-read x $0.2/M = $0.00054 + 200 cache-write-1h x $4/M = $0.0008 = **$0.00244**
- `msg_rw_06` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2900 cache-read x $0.2/M = $0.00058 = **$0.00118**
- **total 14: $0.01976**

### 15 sdk one-shot
All records `sdk-cli`, one prompt (promptSource sdk). A `cost-state` record at the end: totalCostUSD = transcript cost + an unrecorded haiku line (1000 in x $1/M + 100 out x $5/M = $0.0015).
Transcript cost $0.0124; cost-state total = $0.0124 + $0.0015. startTime is epoch milliseconds (assumed).

- `msg_sdk_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 60 out x $10/M = $0.0006 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0106**
- `msg_sdk_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2000 cache-read x $0.2/M = $0.0004 + 200 cache-write-1h x $4/M = $0.0008 = **$0.0018**
- **total 15: $0.0124**

### 16 cost-state, many models
Turn 1 on `claude-opus-5-5`, then cost-state #1 (first process exit, covering opus only plus the hidden haiku line); an hour later the session resumes: turn 2 on sonnet-5-5 with a haiku
subagent (`a16e0c0de0000001`), turn 3 on `claude-fable-5-1`; cost-state #2 is cumulative (same startTime). modelUsage keys for opus carry a `[1m]` suffix
(`claude-opus-5-5[1m]`); the assistant messages' `model` has no suffix (assumed). Each cost-state also contains a haiku line that includes a hidden 1000 in / 100 out call
($0.0015) that appears in no transcript. Transcript cost = sum below; cost-state #2 total = transcript cost + $0.0015.

- `msg_cs_01` (claude-opus-5-5): 1000 in x $4/M = $0.004 + 200 out x $20/M = $0.004 + 4000 cache-write-1h x $8/M = $0.032 = **$0.040**
- `msg_cs_02` (claude-opus-5-5): 200 in x $4/M = $0.0008 + 300 out x $20/M = $0.006 + 4000 cache-read x $0.2/M = $0.0008 + 500 cache-write-1h x $8/M = $0.004 = **$0.0116**
- `msg_cs_03` (claude-sonnet-5-5): 500 in x $2/M = $0.001 + 100 out x $10/M = $0.001 + 1000 cache-write-1h x $4/M = $0.004 = **$0.006**
- `msg_cs_a1` (claude-haiku-4-5-20251001): 3000 in x $1/M = $0.003 + 100 out x $5/M = $0.0005 + 1000 cache-write-5m x $1.25/M = $0.00125 = **$0.00475**
- `msg_cs_04` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 80 out x $10/M = $0.0008 + 1500 cache-read x $0.2/M = $0.0003 + 200 cache-write-1h x $4/M = $0.0008 = **$0.0021**
- `msg_cs_05` (claude-fable-5-1): 1000 in x $10/M = $0.010 + 400 out x $50/M = $0.020 + 5000 cache-read x $0.25/M = $0.00125 + 1000 cache-write-1h x $20/M = $0.020 = **$0.05125**
- **total 16: $0.1157**

### 17 hostile input
Line order: prompt, assistant tool_use, **corrupt** line (terminated, not JSON), **unknown type** `hologram-state`, tool_result with a **1.1 MB** content string (valid JSON, > 1 MB line), assistant with an unknown
envelope field and an unknown message field, turn_duration, prompt, assistant `<synthetic>` (`isApiErrorMessage`, no cost), prompt, assistant, turn_duration, and finally a **partial line with no trailing newline**.
Expected: 3 turns, bad lines = 1 (the corrupt one; the unterminated tail is not consumed), unknown types = {hologram-state: 1}, synthetic message not priced, `msg_host_synth` absent from messages.

- `msg_host_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 100 out x $10/M = $0.001 + 2000 cache-write-1h x $4/M = $0.008 = **$0.011**
- `msg_host_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 2000 cache-read x $0.2/M = $0.0004 + 200 cache-write-1h x $4/M = $0.0008 = **$0.0019**
- `msg_host_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2200 cache-read x $0.2/M = $0.00044 = **$0.00104**
- **total 17: $0.01394**

### 18 cwd change
Turn 1 cwd `/home/dev/acme/cwdchange` branch main. Then a `worktree-state` record (shape assumed: {worktreeSession:{originalCwd, worktreePath, worktreeName, worktreeBranch}}); turn 2 records carry
cwd `/home/dev/acme/cwdchange-wt`, gitBranch `worktree-login`. Then a `relocated` record (`relocatedCwd`); turn 3 cwd `/home/dev/acme/cwdchange-moved`, gitBranch main.
Expected: cwds [/home/dev/acme/cwdchange, /home/dev/acme/cwdchange-wt, /home/dev/acme/cwdchange-moved], gitBranches [main, worktree-login, main] (as a set: main, worktree-login). The project key is derived from the first cwd.

- `msg_cwd_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 50 out x $10/M = $0.0005 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0105**
- `msg_cwd_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2000 cache-read x $0.2/M = $0.0004 + 200 cache-write-1h x $4/M = $0.0008 = **$0.0018**
- `msg_cwd_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 2200 cache-read x $0.2/M = $0.00044 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00134**
- **total 18: $0.01364**

### 19 day boundary
**The test must use time zone `America/New_York`** (UTC-4 on this date); local midnight = 2026-09-19T04:00:00Z. In UTC everything is on 2026-09-19; in New York:
| message | UTC | local | local day |
|---|---|---|---|
| msg_day_01 | 03:50:10Z | 23:50:10 | 2026-09-18 |
| msg_day_02 | 03:59:50Z | 23:59:50 | 2026-09-18 |
| msg_day_03 | 04:00:30Z | 00:00:30 | 2026-09-19 |
| msg_day_04 | 04:05:20Z | 00:05:20 | 2026-09-19 |
Turn 2 ("add a header") starts 2026-09-18 23:59:30 local and ends 2026-09-19 00:00:32 local (62 s). Daily cost by local day: see below.

2026-09-18 (msg_day_01 + msg_day_02) = $0.0136; 2026-09-19 (msg_day_03 + msg_day_04) = $0.00308.

- `msg_day_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 100 out x $10/M = $0.001 + 2000 cache-write-1h x $4/M = $0.008 = **$0.011**
- `msg_day_02` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 80 out x $10/M = $0.0008 + 2000 cache-read x $0.2/M = $0.0004 + 300 cache-write-1h x $4/M = $0.0012 = **$0.0026**
- `msg_day_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 40 out x $10/M = $0.0004 + 2400 cache-read x $0.2/M = $0.00048 + 100 cache-write-1h x $4/M = $0.0004 = **$0.00148**
- `msg_day_04` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 50 out x $10/M = $0.0005 + 2500 cache-read x $0.2/M = $0.0005 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0016**
- **total 19: $0.01668**

### 20 pricing edges
`msg_px_01` opus-5-5 with 400 5m + 600 1h cache writes (usage.cache_creation_input_tokens = 1000). `msg_px_02` opus-5-5 with `speed: "fast"` (price doubled: **assumed rule**, transcript-format.md section 8).
`msg_px_03` model `claude-nova-9-9`, not in the table: must be reported **unpriced** (diagnostics.unpricedModels), contributes no cost. `msg_px_04` sonnet with
`server_tool_use.web_search_requests: 2` (not priced). Total below is priced messages only (px_03 excluded).

- `msg_px_01` (claude-opus-5-5): 1000 in x $4/M = $0.004 + 100 out x $20/M = $0.002 + 2000 cache-read x $0.2/M = $0.0004 + 400 cache-write-5m x $5/M = $0.002 + 600 cache-write-1h x $8/M = $0.0048 = **$0.0132**
- `msg_px_02` (claude-opus-5-5): 1000 in x $4/M = $0.004 + 100 out x $20/M = $0.002 + speed fast: x2 (assumed rule) = **$0.012**
- `msg_px_03` (claude-nova-9-9): UNPRICED model, 1000 in / 100 out tokens, cost not computed
- `msg_px_04` (claude-sonnet-5-5): 500 in x $2/M = $0.001 + 50 out x $10/M = $0.0005 = **$0.0015**
- **total 20: $0.0267**

### 21 non-transcript files
Project `-home-dev-acme-misc` holds one real session `21212121-0000-4000-8000-000000000001` plus files a scan must ignore: `notes.jsonl` (basename not a uuid, though its first line looks like a user record), `vercel-plugin/skill-injections.jsonl`,
`sessions-index.json`, `memory/MEMORY.md`.

- `msg_misc_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 50 out x $10/M = $0.0005 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0105**
- **total 21: $0.0105**

### 22 nested project directory
`projects/-home-dev-acme-nest/` has its own session `22222222-0000-4000-8000-000000000001` and a directory `-home-dev-acme-nest/-home-dev-acme-nest-inner/` that holds session `22222222-0000-4000-8000-000000000002` (cwd `/home/dev/acme/nest/inner`) with agent `a22e0c0de0000001` under
`<session>/subagents/`. A recursive walk finds both sessions; the inner one's project key is the nested directory name.

- `msg_nest22_01` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 50 out x $10/M = $0.0005 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0105**
- `msg_nest22_02` (claude-sonnet-5-5): 1000 in x $2/M = $0.002 + 60 out x $10/M = $0.0006 + 2000 cache-write-1h x $4/M = $0.008 = **$0.0106**
- `msg_nest22_a1` (claude-sonnet-5-5): 500 in x $2/M = $0.001 + 20 out x $10/M = $0.0002 + 400 cache-write-5m x $2.5/M = $0.001 = **$0.0022**
- `msg_nest22_03` (claude-sonnet-5-5): 100 in x $2/M = $0.0002 + 30 out x $10/M = $0.0003 + 2000 cache-read x $0.2/M = $0.0004 + 100 cache-write-1h x $4/M = $0.0004 = **$0.0013**
- **total 22: $0.0246**
