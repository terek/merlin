# Validation against the real corpus

Bead `merlin-t8s.16`. Run on 2026-10-02 against the author's real `~/.claude` (read-only),
digests in a scratch `MERLIN_HOME`. Everything below is ids (8-character prefixes),
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
- `merlin doctor`: the format-drift table lists only versions with bad lines or unknown
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

## Bead events, registry and repositories (2026-10-28)

Bead `merlin-t8s.48.7`. `merlin scan` (parser: Claude 16, Codex 6) over the real `~/.claude` and
`~/.codex`, read-only, into a scratch `MERLIN_HOME`: 3,405 sessions in 1.6 s. Design:
[beads-and-repos.md](beads-and-repos.md).

**Bead events.** 3,744 events in 107 sessions (Claude 3,666, Codex 78); 2,918 by the main agent,
826 by sub-agents. Outcomes: ok 2,666, failed 116, unknown 962. The unknowns were sampled by hand:
almost all are calls whose output was sent to `/dev/null`, cut by `| tail -1`, or empty, which is
what `unknown` is for. Every event has a `messageId`, a `turn` and a `cwd`.

**Against the registry.** 4 beads databases found (merlin, chatfw, yimple, geocards), 724 issues,
no bad lines. Of the 606 closed issues, 602 have a close event (ok or unknown) in some session.
The 4 others were closed in calls the recogniser cannot see through (ids built at run time).
Closes: 488 by the main agent, 98 by sub-agents.

**Repositories.** 279 directories resolved: 236 in a git repository (11 repositories, 9 remotes),
3 linked worktrees (resolved to the main repository and its beads database), 183 with a beads
database. Worktrees removed before Merlin ever saw them (the `yimple-wt/*` projects) do not
resolve: there is no answer to keep. Their sessions are still tied to yimple through the prefix
of their bead events.

**Fixed while validating** (each with a table test in `internal/beads`):

- `bd show <memory key>` was a bead: `Issue X not found` now counts as an error line. Such
  events remain (op `show`, outcome failed or unknown) with ids that match no registry prefix;
  the catalog filters ids by the registry.
- A bare word printed by the script (`echo epic-ok`, an indented `bd memories` entry) was taken
  as a created id. A bare id line now counts only unindented, and only when its prefix is one
  the script's other ids use (when they use any).
- `Comment added to X` without the check mark (older bd) is a confirmation.
- A script whose only bd call failed with an error naming no id (`Error: unknown flag`) marks it
  failed.
- `--dry-run` calls are ignored.
- `for b in 470.1 470.2; do bd close acme-$b …; done` is unrolled over literal words (this took
  close coverage from 588 to 602).
- `cd ~/work/acme` expands `~` to the home directory the session's working directory is under
  (the digest may not read `$HOME`); 141 events had no `cwd` before.

## Location keys (2026-11-07)

Bead `merlin-t8s.53.7`. Design: [location.md](location.md). `merlin scan` (parser: Claude 18, Codex 7)
over the real `~/.claude` and `~/.codex`, read-only, into a scratch `MERLIN_HOME` that held copies of
`claude/`, `codex/`, `beads/` and the version 1 `repos.json`. Nothing was served. The scan took 2.0 s
for 3,425 sessions (3,133 of them scripted runs). The real `repos.json` has the same SHA-1 before and
after (`7d562930…`); nothing else in the real home was touched. The numbers come from a temporary Go
program in the module (calling `catalog`, `links` and `repos`, deleted afterwards) and `os.Stat` on the
real paths. The history has grown since 2026-11-06 (3,422 to 3,425 digests, $6,431 to $6,612 on the
comparable set), and `workDirs` now names more directories (see "Directories").

**Migration.** The version 1 file has 299 entries, 62 gone, 60 of those with a repository. All 60
become `gitCommonDir` = old `repo` + `/.git` (250 of 250 entries with a `repo` took that shape; none
needed the `.bare` or `HEAD` rules), keep a checkout, and share their common dir with a live entry, so
they still group under their repositories. The one session that starts in a gone version 1 directory
keeps its repository. The file saved as version 2. No credential reaches it: no remote value holds
`@`, `token` or `://`; those strings occur only in directory names (10 keys with `@`, 7 with `token`).
After the scan it holds 810 entries: 391 live, 62 gone, 357 inferred; 280 linked worktrees; 719 with a
common dir. A second scan changed nothing (`repos.json` byte-identical, 1 session reprocessed, the
one whose source is missing).

**Directories** (against §9 of the design, which counted the directories the digests named before
`workDirs`; the same set now has 472 directories):

| | §9 (11-06) | measured |
|---|---|---|
| directories | 461 | 472 |
| gone | 224 | 224 |
| never recorded | 162 | 162 |
| recovered | 91 (32 under a recorded checkout, 59 sibling worktrees) | 91 (28 and 63, see below) |
| unknown | 71 (all but 3 temporary) | 73 (all but 2 temporary) |

The split between ancestor and sibling is read back from the entries (a checkout still on disk means
the ancestor rule), so it is approximate; the total is exact. With the directories `workDirs` adds
(edits by agents, `cd` in commands) the set is 989: 598 gone, 536 of them never recorded; 357
recovered (259 sibling, 98 ancestor); 181 unknown, 176 of them temporary directories. Of the 391
live ones, 89 are in no repository.

**Sessions with no repository.** 76 of 3,425 (9 empty, 41 scripted runs in scratch directories), against
82 (9 empty). Five are the sessions that started in a deleted subdirectory of a live repository and
regain their repository, as §9 expected; one more is not traced. Each of the 76 also has no entry for
its start directory, so no session's activity placed it in a repository its start directory is not in.
Among the 292 sessions the list shows (not scripted) 35 have none, 9 empty.

**Checkout and repository flips.** On the 268 non-scripted Claude sessions ($6,612): 19 ($240) count
under a checkout other than their start directory's, and 1 of them ($3) under another repository.
§9 simulated 19 ($227 of $6,431) and 1 ($3) on 264 sessions: the same counts, with the history's
growth in dollars. All 19 had a checkout for their start directory (none went from none to one).

**Totals.** $6,710.42 in all. `cost` by project (33 rows), repo (11), checkout (30), remote (9), branch
(23), bead (578), family (268), day and model each add up to it within 2e-11, and so do `groups` by
dir (42), checkout (30), repo (11) and remote (9); each counts 292 sessions.

**Gone flags against the disk** (the check from the review of `.53.4`). Every repository (10 with
sessions, 14 in the cache) and every checkout (29 with sessions, 76 in the cache) agrees with
`os.Stat` of its path: 0 repositories shown gone that exist, 0 shown live that are missing, and the
same for checkouts. The known risk (a repository whose entries are all gone while it still exists)
does not occur here. The check covered 14 repositories, so it says little about a machine with many
removed worktrees; that is for `.53.8`.

**Remotes.** 12 distinct in the cache, 8 among sessions that count. 11 are `host/owner/repo`, 1 is a
local path (the vendored clone). None keeps a user, a scheme, a `.git` suffix or a port; no two remotes
differ only by case. No two repositories share a remote on this machine, so splitting by normalising
cannot show here, and 2 repositories have no origin. 14 repositories in all.

**Display names.** 0 of 14 come out as `.git`, `.bare` or empty; 0 collide.

**Beads.** The `beads` value of every version 1 directory equals the new one: 237 live and 62 gone, 0
differences (104 directories are new, since `workDirs` named more). The bead rollups (578 beads, 268
families) are identical, row by row, to the same data under the migrated version 1 cache alone, and both
add up to $6,710.42. This compares old data under the new code, not the old binary, which no longer
builds.

**`workDirs`.** 241 of the 261 non-scripted sessions with turns have it (92%); the 20 without use the §6
fallback. None of the 3,133 scripted runs has any. Versions: 3,400 Claude digests on 18 and all 25 Codex
on 7. One older digest (version 9, source gone) shares its id with a current one and so is shadowed in
the catalog.

**Determinism.** Groups by the four keys and the rollups by project, repo, checkout, remote and branch
are identical across three runs (a rebuild, a second `SetPlaces`, a fresh load). The bead and family
rollups and a session's bead shares are not: they differ in the last digit (about 1e-15 dollars) from run
to run, because `share` in `internal/catalog/places.go` summed its weights in map order. That code is
older than the location keys and had no visible effect. It now sums in key order
(`TestShareIsDeterministic`); this run was not repeated after that fix.

## Beads without an export (2026-11-07)

Bead `merlin-n1u.8`. Design: [beads-and-repos.md](beads-and-repos.md) §6 (fold, calls that count,
families, uses). The history is this machine's, rescanned with the current parser (Claude 19, Codex
9, Pi 2) into a scratch `MERLIN_HOME`: 3,428 digests, no unreadable one, `repos.json` and the four
registry snapshots (merlin, chatfw, yimple, geocards, with the statuses read from
`interactions.jsonl`; only chatfw and yimple have that file). Nothing was served and nothing was
rescanned: the numbers come from a temporary Go program in the module (loading the digests with
`store`, `repos.Open` and `beads.OpenRegistry` into `catalog.Places` as the daemon does, then
`Families`, `Prefixes`, `Rollup`, `Groups` and each session's `Places`), deleted afterwards, and from
the same program built from `git archive HEAD` for the "before" column. The real home was not read
at all. `shasum` of the real `repos.json` and the 4 `beads/*.json` files is identical before and
after (5 of 5 lines; `repos.json` starts `2027baee`).

### (a) As is, with the exports

127 sessions have bead events; 123 of the 3,428 are on a bead, 3,305 on none. The total is $6,753.13;
$3,787.98 of it is spent on beads (sum of `BeadShare` usd) and $2,965.15 on none (the two add up).
Cost per bead by `Rollup` sums to $3,788.88 over beads: the $0.90 over the share sum is the same
before the change (it is the message-attributed part of the rollup against the sessions' best cost
the shares use), not a fold effect.

Beads worked on, by database and source: yimple 544 export, merlin 105 export and 1 sessions, chatfw
93 export, geocards 27 export, 2 in other prefixes (sessions, database `prefix:<p>`); no `implied`
bead is worked on (stubs are roots of unworked families). 589 of the 772 have a nonzero share. The
fold knows 797 beads under the prefixes some session worked on. 349 families, 271 with spend; every
root has a title (no hint needed).

Totals against `by=project`: `groups` by `beadDatabase` (6 rows), `prefix` (6), `family` (91) and
`bead` (113) each add up to $6,753.13 and count 295 sessions (scripted runs add cost, not sessions);
the largest absolute difference from the project total is 1.8e-11. `cost` by bead and by family
(including the no-bead row) add up to $6,753.13 as well.

**Before and after** (same digests and registry; before is HEAD):

| | before | after |
|---|---|---|
| beads worked on | 769 | 772 |
| bead-attributed USD | 3,785.28 | 3,787.98 |
| no-bead USD | 2,967.86 | 2,965.15 |
| families | 349 (270 with spend) | 349 (271) |
| prefixes | 4 | 5 (4 databases and `prefix:zz`) |
| beads in the fold, under those prefixes | 793 | 797 |
| merlin: issues, USD, families | 116, 300.80, 12 | 117, 299.79, 12 |
| yimple: issues, USD, families | 555, 2,918.55, 288 | 555, 2,918.55, 287 |
| chatfw: issues, USD, families | 95, 547.84, 22 | 96, 547.84, 21 |
| geocards: issues, USD, families | 27, 18.09, 27 | 27, 18.09, 27 |
| other prefix: issues, USD, families | not shown | 2, 3.71, 2 |

Only 2 of 3,428 sessions change which beads they count, and the total did not move. The moves:

- **Ids the registry did not know are kept** (+3 beads, +$2.70 net). One session names 2 ids of a
  prefix no database has (`zz`); the old rule dropped them, now they count (+$3.71, 2 families, a
  `prefix:zz` group) and take their share from the session's other beads (-$1.26 on 2 merlin beads
  of the same session). One other session names a merlin bead the export lacks: now a bead of source
  `sessions` (+$0.25, a share the old rule did not attribute).
- **Dotted ids give a parent** (-1 family each in yimple and chatfw). One yimple and one chatfw
  family of a single zero-spend bead each had no parent in the export; the dotted id now places them
  under their parent's family. No spend moves.
- **Stub** (+1 chatfw issue): the fold has 1 more chatfw bead than the export; consistent with an
  implied parent (source `implied`) of an unworked family, not traced further. merlin +1 issue is
  the sessions-only bead above, other prefix +2 the `zz` ids.
- **Output-only guard**: no id that counted before is dropped (0 beads removed, 0 sessions lose a
  bead), so the guard changed nothing on this history; **dep target rule**: no bead gains or loses
  spend through it that the table shows.

### (b) No export

A copy of the registry with every database's `issues` and `prefixes` emptied and the `issues.jsonl`
source entries dropped (keys, directories and the `statuses` of chatfw and yimple kept), the same
digests and `repos.json`. Totals are unchanged: 123 sessions on a bead, $3,787.98 on beads.

| kept from (a) | |
|---|---|
| beads worked on | 772 of 772, all of them with `source: sessions` |
| cost per bead, sum of min(usd) / sum of usd (a) | 100.00% |
| family USD on the same root, sum of min / sum (a) | 99.83% |
| (a)'s families with spend whose root is a root in (b) | 271 of 271 |
| bead-attributed USD in the same database | 100.00% (all 4 databases and `prefix:zz`; prefixes are learned from events) |
| beads with spend that have a title | 513 of 589 (87.1%); 669 of 772 beads in all |
| families | 353 (349 in (a)); 44 with an untitled root (41 sessions, 3 implied), 10 of them get a hint (38 have spend, 10 of those hinted) |

**Acceptance (>= 95% of cost per bead and of families): met** (100.00% and 99.83%). Cost per bead is
complete because every id the sessions name is kept whatever the export says.

Where the 0.17% of family USD ($6.62 on 8 beads, all yimple) goes: the export holds parents that no
call shows. 4 non-dotted beads (about $1.66) become roots of their own families, and 4 dotted
beads (about $4.95) keep only their dotted parent, which in the export has a parent of its own that
no session set. That is the 4 extra families (353 against 349), and it is the case §6.2 predicted
(parents set through a variable). The fold's counts under each prefix fall with the export: 111,
551, 94 and 27 beads (merlin, yimple, chatfw, geocards) against 117, 555, 96 and 27, and yimple
closed 480 against 486 (beads no session touched are absent; `interactions.jsonl` covers
chatfw and yimple only for those it records).

### Not checked here

The other machine's database with only `interactions.jsonl` (no export, no events for most of its
beads): to be run by Zsolt.
