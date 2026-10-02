# Validation against the real corpus

Bead `merlin-t8s.16`. Run on 2026-10-02 against the author's real `~/.claude` (read-only),
digests in a scratch `EXPLORER_HOME`. Everything below is ids (8-character prefixes),
counts, model names, token totals and dollars; nothing is quoted from a transcript.

The corpus is live: the session that ran this validation is itself indexed, so counts that
involve open agents move by a few between runs.

## Conclusions

1. **Index health is clean.** 3,355 sessions, 0 failures, 0 bad lines, 0 unknown record
   types, 0 unpriced models, across 96 Claude Code versions. First scan 1.27 s, no-op rescan
   73 ms.
2. **The reported-vs-attributed overhead is $203.92 (7.6% of $2,682.89) and is mostly
   explained, by three separable causes** (details in "The overhead"):

   | cause | $ | share | confidence |
   |---|---|---|---|
   | output tokens of subagent/teammate messages are truncated in the transcript (`stop_reason: null` on the last line) | ~49 | 24% | high |
   | main-model calls that scale with recaps (`away_summary` records), 0.28M cache-read and ~770 output tokens each | ~99 | 49% | moderate (correlation, mechanism not observed) |
   | calls of background Task subagents that leave no transcript line, about one per 38 s of agent run time | ~49 | 24% | moderate |
   | haiku calls with no cache (titles) | 1.1 | 0.5% | moderate |
   | not assigned (cache and input remainder in the teammate sessions) | ~5 | 3% | |

   Compaction calls, window-edge effects and a mispriced model were tested and ruled out.
3. **No session exceeds 1.0 inside its windows** (max 0.991 over the 74 interactive
   sessions). Every whole-session ratio above 1.0 is spend outside the windows, as the lead
   found. There is no evidence of an overpriced entry.
4. **Prices.** `claude-fable-5` cache read ($1.00) is now **verified** (five of six windows
   reproduce the reported cost to the cent). `fable-5-1`, `opus-5-5`, `opus-5`, `sonnet-5`
   re-confirmed by regression. **Not verifiable on this corpus:** `opus-4-8/4-7/4-6`
   ($1,031 attributed, 17% of the best-cost total), `sonnet-5-5`, `sonnet-4-6`, haiku cache read, and fast mode (no
   message anywhere has `speed: fast`).
5. **Copied sessions and cost-state: unanswerable here.** None of the 18 sessions in the
   nine pairs has a reported window.
6. **Unresolved agents: 83 = 56 subagents + 26 compact agents (all Claude Code 2.1.31 to
   2.1.74) + 1 teammate that is the live validation session itself.**
7. **Abandoned turns are tiny:** 80 in 40 sessions, at most 2 assistant messages each, $1.20
   in total.

## Method and numbers

### Scan and doctor

| | |
|---|---|
| source | 3,853 `.jsonl` files, 3,355 sessions: 208 interactive, 15 background, 3,132 scripted |
| first scan | 1.271 s wall (12.5 s CPU, 12 cores), 0 failed |
| rescan, nothing changed | 73 ms |
| bad lines / unknown record types | 0 / 0 in all 96 versions (95 + "unknown") |
| unpriced models | none |
| distinct messages | 54,114, 651 shared between sessions |
| reported | $2,715.30 = $2,682.89 interactive + $32.41 scripted |
| covered (inside windows) | $2,511.38 = $2,478.98 interactive + $32.40 scripted |
| outside every window | $145.27 in 5 sessions; 1,751 sessions have no window at all ($3,085.26, all attributed) |

The interactive covered figure here is $2,478.98 (0.924), the lead's earlier measurement was
$2,484.99 (0.926); the $6 difference is the catalog giving each shared message id to one
owner. Scripted sessions match exactly (ratio 1.000, overhead $0.01 in total).

### Attributed vs reported, inside windows, per model (74 interactive sessions)

Tokens are summed over windows; "att" counts messages inside a window (1 s slack).

| model | reported $ | att $ | gap $ | in gap | out gap | cache-read gap | cache-write gap |
|---|---|---|---|---|---|---|---|
| sonnet-5 | 1271.30 | 1169.37 | 101.93 | 1.72M | 4.95M | 234.7M | 0.84M |
| fable-5-1 | 879.16 | 828.08 | 51.09 | 0.36M | 0.13M | 83.9M | 1.57M |
| fable-5 | 241.22 | 214.10 | 27.12 | 0.05M | 0.07M | 17.0M | 0.45M |
| opus-5 | 190.81 | 175.26 | 15.55 | 0.41M | 0.07M | 22.4M | 0.07M |
| opus-5-5 | 99.19 | 92.03 | 7.16 | 0.08M | 0.01M | 23.4M | 0.25M |
| haiku-4-5 | 1.21 | 0.14 | 1.07 | 0.72M | 0.03M | 0 | 0 |
| total | 2682.89 | 2478.98 | 203.92 | | | | |

Per class the gap is about $61 output, $101 cache read, $28 cache write, $11 input.
Per-session covered/reported over the 74 sessions: min 0.448 (ea8b5581, a $2.66 window),
p10 0.861, p25 0.891, median 0.937, p75 0.956, p90 0.982, max 0.991.

Structure that makes the gap tractable: **sonnet-5 occurs only in agent files and fable /
opus only in main files**, so the model identifies the role. Haiku cache read and write
match exactly (337,064 / 75,312 tokens); the haiku gap is input and output only.

## The overhead

### A. Truncated output tokens in agent files: ~$49, high confidence

7,171 messages inside the windows have `stop_reason: null` on their last line (7,080
sonnet-5, 83 opus-5, 8 others), and 7,169 of them are in agent files; main files have 2.
Their `output_tokens` is the count at the time the line was written (median 2 to 4 tokens).
Cache and input counts of those messages are complete: their context size never shrinks
relative to the previous message (0 of 7,080).

Per session, the output gap of sonnet-5 regresses on the number of such messages with slope
667 tokens per message and R² 0.975 (all models: 688, R² 0.970); typical complete
messages of the same shape average 300 to 1,400 output tokens. 7,080 × 667 = 4.72M of
the 4.95M sonnet-5 output gap, i.e. $47.2 of $49.5; the 83 opus-5 messages account for
about $1.5. The rest of the output gap (fable-5-1 0.13M tokens = $6.4) does not come from
this cause.

These sessions are the ones that use named teammates: sonnet-5 cache read there matches to
0.0% (21 sessions with teammates only: 0.8M of 2,147M).

Consequence: attributed output cost is a floor for agent messages. The true count is not in
the transcript. The digest could count the affected messages; it does not today.

### B. Main-model calls scaling with recaps: ~$101, moderate confidence

The main-model gap (fable-5-1, fable-5, opus-5, opus-5-5; $100.92) is 7 to 16% of their
cache reads, in every session, and 146.7M cache-read tokens in total. Dividing each
session's cache-read gap by its mean main-message context gives the number of hidden calls
it implies: 960 in total over 71 sessions.

- Implied calls correlate with the session's `away_summary` count at r = 0.91 (513 recaps in
  these sessions), with human turns at 0.78, with main message count at 0.76. Cache-read gap
  tokens ~ recaps: slope 0.275M per recap, R² 0.81. Output gap ~ recaps: 770 tokens per
  recap, R² 0.49. Dollar gap ~ recaps: $0.25 per recap, R² 0.60 (this slope would predict
  $128, more than the gap, so recaps cannot be the whole story and may share a cause with
  turns).
- Roughly 1.9 hidden calls per recap with a context of about 160k tokens, or one call per
  recap with a larger-than-average context. Not separable with this data.
- Alternatives. Compaction: ruled out (below). Titles: haiku, not these models. Window edges:
  ruled out. Recaps vs. other per-turn calls (e.g. next-prompt suggestions) cannot be
  separated because recaps and turns are correlated; I only say that the gap is
  main-model, per-turn-ish, and tracks recaps best.

### C. Background Task subagents: ~$49, moderate confidence

Sessions are cleanly split by how sonnet-5 was used:

| sonnet-5 used by | sessions | cache-read gap |
|---|---|---|
| teammates only | 21 | 0.0% |
| foreground Task subagents (+ teammates) | 4 | 0.0% |
| teammates + background subagents | 9 | 2.0% |
| background Task subagents only | 19 | **29.3%** (217.8M of 744M); uncached input gap 1.49M |
| background + foreground + forks + teammates | 1 | 0.3% |

Every agent file of the 74 interactive sessions (630 files, 90 of them in the large-gap
sessions) has an unbroken `parentUuid` chain (0 orphans), so nothing is missing mid-chain; every `Agent` call has an agent
file, all completed.

Dividing each such session's cache-read gap by its agents' mean context gives the implied
number of hidden calls; dividing the agents' wall time (start to end) by that gives
seconds per hidden call: 29 to 52 s in 17 of 19 sessions (median 38 s), 96 s and 171 s in
the other two. Each hidden call carries about 1,000 to 1,700 uncached input tokens and a
context like the agent's own. This looks like a periodic call per running background agent
(the "agent progress summary" hypothesis), but I did not observe the calls, only the
regularity. Foreground agents show none, which fits a feature that exists to report progress
of background work.

The sonnet-5 gap in this class is $49.41; in the other sonnet-5 sessions $52.53, of which
~$47 is cause A.

### D. Haiku: $1.07, moderate confidence

Reported haiku input 715k and output 28.5k tokens against 122 / 2,367 in the transcripts
and no cache use. 2,881 `ai-title` records exist in these sessions: about 250 input tokens
per record, consistent with title generation. The share is negligible.

### Ruled out

- **Compaction calls (hypothesis b).** 19 compactions inside the windows (22
  `compact_boundary` records in these files), 4.85M `preTokens` in total. Even if every
  compaction call read its whole context from cache and wrote a 3k summary, that is under
  $5 (at most 2.5% of the overhead) against 381M cache-read tokens missing in total. Per
  session the gap correlates with compaction count at 0.72, only because both grow with
  session size; the compaction term is negative in multivariate fits.
- **Partial output on main-file lines (a), for main agents.** 2 messages.
- **Window edges.** Widening every window by 60 s moves covered by $0.50 (ratio 0.9240 to
  0.9242); by one hour by $4.6 (0.9257).
- **A wrong price.** Regression of reported cost on reported tokens (below) recovers the
  table. No window is above 1.0.
- **Abandoned branches** carry $1.20 in total.
- **Iterations.** `usage.iterations[]` has more than one entry in 1 of 55,822 messages
  (a `fallback_message`); top-level usage and the iteration sum differ in 771 messages, 768
  of them with an empty array, so iterations explain nothing.
- **Fast mode.** No `speed: fast` anywhere.

### What remains unknown

- The mechanism behind B and C was inferred from counts, not observed: no transcript line
  records these calls and `cost-state` has no per-call breakdown. A controlled experiment
  (idle a session, check the cost-state delta; run a background agent for five minutes) would
  settle both.
- Whether B is recaps or per-turn calls.
- About $5 (3%) is not assigned to any cause (cache and input in the teammate sessions).

## Price verification

Method: every reported (window, model) record satisfies reported$ = in·p_in + out·p_out +
cr·p_cr + cw·p_cw exactly, hidden calls included, because the tokens are included. A
least-squares fit across windows therefore recovers the rates. With input and output fixed,
fitted cache-read / cache-write per million tokens (mixed 5m and 1h writes, so the write
rate lies between the two multiples):

| model | windows | fitted cache read | table | fitted cache write | status |
|---|---|---|---|---|---|
| sonnet-5 | 54 | 0.200 | 0.20 | 2.50 | verified (all four rates exact) |
| fable-5-1 | 46 | 0.260 (0.244 free fit) | 0.25 | 18.7 | verified |
| opus-5-5 | 15 | 0.213 (0.207 free) | 0.20 | 7.3 | verified |
| opus-5 | 16 | 0.522 (0.514 free) | 0.50 | 8.6 | verified |
| fable-5 | 6 | 0.93 (1.10 free) | 1.00 | 21.0 | **verified now**, see below |
| haiku-4-5 | 994 | not determined (tokens too few) | 0.10 | | input/output verified; cache read stays assumed |

`claude-fable-5`: with input 10, output 50, 1h write 20, five of six windows reproduce the
reported cost with cache read at exactly 1.000 (to four decimals: 7.5999, 34.3737, 56.6950,
5.6130, 12.4157 dollars); the sixth is $2.86 over, which is the agent 5m writes in that
window priced at the 1h rate in my check. The status in `prices.json` and §8 of
`transcript-format.md` is now `verified`, with two of those windows as worked examples in
`pricing_test.go`.

Not verifiable (no window contains the model): `opus-4-8`, `opus-4-7`, `opus-4-6` ($1,031 attributed, 17% of the
best-cost total), `sonnet-5-5` ($19.80),
`sonnet-4-6` ($4.76). They stay `assumed`. The fast multiplier is untested: no message
anywhere has `speed: fast`. Cost-state keys seen: fable-5-1 (+[1m]), fable-5, haiku, opus-5
[1m], opus-5-5 [1m], sonnet-5, nothing else.

## Agent linkage

Over all 3,355 sessions, 505 agents by linkage: teammate/name 291, subagent/meta 110,
fork/meta 12, subagent/tool-result 9, **unresolved 83** (subagent 56, compact 26, teammate
1). Status: 490 completed, 10 open, 5 killed (open ones include this session's own live
agents).

Unresolved by the first Claude Code version of their session:

| kind | versions |
|---|---|
| subagent | 2.1.31 (2), 2.1.50 (15), 2.1.63 (24), 2.1.68 (3), 2.1.69 (1), 2.1.71 (8), 2.1.72 (2), 2.1.74 (1) |
| compact | 2.1.31 (1), 2.1.50 (5), 2.1.59 (1), 2.1.63 (15), 2.1.69 (1), 2.1.71 (3) |
| teammate | 2.1.287 (1): session 20a19a7e, the live session running this validation; its agent has no finished transcript yet |

So the old-format population (no agent meta) is the only real source; none after 2.1.74.
They are in 18 sessions and are attached to the session root.

## Branching, forking, copied sessions

Nine parent to child links, as `transcript-format.md` §9 expects:

| parent | child | kind | explicit | shared msgs / turns | atTurn (parent turns) | parent file created before child's |
|---|---|---|---|---|---|---|
| 0518132a | 1e49acbd | fork | no | 56 / 5 | 4 (7) | yes |
| 7c72abad | 3dc2366f | continuation | no | 66 / 6 | 5 (6) | tie (bulk copy) |
| c6df564b | 6d1684a3 | fork | yes | 21 / 4 | 3 (12) | yes |
| b2f92f55 | 7c41d025 | fork | yes | 176 / 17 | 16 (18) | tie (bulk copy) |
| d558f9f0 | 8fcd4e90 | fork | no | 110 / 7 | 6 (7) | yes |
| b2f92f55 | 9abad296 | fork | yes | 162 / 16 | 15 (18) | tie (bulk copy) |
| a8e282b4 | aef40bb4 | continuation | no | 25 / 3 | 2 (3) | yes |
| 19559025 | b9f36040 | fork | no | 140 / 18 | 17 (18) | yes |
| 2660d391 | d88aeab8 | continuation | yes | 56 / 7 | 20 (21) | yes |

Ownership direction: for the six pairs whose two files have distinct creation times, the
parent chosen by the catalog is the earlier file in all six (differences of 18 min to 6
days). In three pairs both files were created in the same minute (2026-05-31 14:34, a bulk
restore), so file creation says nothing; two of those are explicit forks and the third is a
continuation whose parent's last activity (05-21) precedes the child's (05-31), consistent
with the catalog. No direction looked wrong. 2660d391 to d88aeab8 is a tail copy after a
compaction (7 of the parent's 21 turns), as §9 describes.

**Cost-state in copies: not answerable.** All 18 sessions in the nine pairs predate
`cost-state` (no reported window), so there is no case of a copy carrying its parent's
totals. The question stays open until such a pair exists.

Abandoned turns: 80 in 40 sessions (78 interactive, 2 background) of 2,980 interactive
turns. Worst sessions: 0e2c1d14 (9), 365b2e99 (8), 6c1e63c3 (5). Each abandoned turn has at
most 2 assistant messages (5 in total) and at most 3 tool calls; total attributed cost
$1.20. None is large.

## Changes made

- `internal/claude/digest`: `ParserVersion` 1 to 2, so stores written by earlier builds are
  rebuilt.
- `explorer doctor`: the format-drift table lists only versions with bad lines or unknown
  types, followed by "and N other versions with no bad lines and no unknown record types",
  or, when all are clean, one line ("96 versions, no bad lines, no unknown record types").
  `--all-versions` prints every version. JSON output is unchanged. Snapshots updated,
  `doctor-all-versions.txt` added.
- `internal/pricing`: `claude-fable-5` status `verified`, worked examples and a status test.
- `docs/transcript-format.md` §8: fable-5 status, pointer to this report.

## Things for the lead

- **Attributed output cost is a floor for agent messages** (cause A). Candidates: add a
  digest diagnostic counting messages whose last line has `stop_reason: null`, and say so in
  `show`. Not done; it changes digest output and the schema.
- `doctor`: the "transcripts above reported" table lists rows with a gap of -$0.0000 (float
  noise from scripted sessions). Showing rows only when the gap is below -$0.005 would make
  an empty table mean "none", as the heading promises.
- The overhead is per session and mostly a property of how the session was used (recaps,
  background agents). It cannot be spread over agents or turns, which is what the design
  already does.
