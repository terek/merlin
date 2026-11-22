# Moments

Experimental. Merlin looks through a person's sessions for **moments**: things they did that say
something about how they work with coding agents. It tells them what they do well, what they have
explored, and what to try next. Three personas react to what they see, and the result can be
shown as a card meant for sharing.

Two goals are served by one mechanism:

- **Learning.** Every moment comes with a "try" text. The page suggests moments that are not yet
  a habit, preferring those for which the person's own history shows a reason ("auto-compaction
  kicked in 11 times, 4 of them on a cold cache").
- **Bragging.** The card lists what someone already does well, and the personas react with an
  emoji. There is no score and no rank, so it is worth sharing at any level.

## 1. Concepts

**Moment.** One entry of the catalog (`internal/moments/registry.go`): an `id`, a persona, a
category (`prompt`, `context`, `harness` or `parallelism`: what part of the work it changes), a
title, a `what` sentence (what was seen), a `try` text (for someone who has not done it yet) and a
detector. The detector is a heuristic over digests, with no AI. Moments have no order and no
prerequisites: any of them can be found first.

**Hit.** One occurrence of a moment: when, in which session, at which turn, and a note. The note
is Merlin's own wording with numbers only ("named 2 files the agent then opened"), never text
from the session.

**Status.** Worked out from the hits on every request:

| Status | Rule |
|---|---|
| `habit` | hits in at least 3 distinct ISO weeks (a moment can set its own `HabitWeeks`) |
| `explored` | at least one hit, in fewer weeks |
| `unseen` | no hit |

**Depth.** Status never falls back, so a second field says how a moment sits in the work right
now. It is read from the hits and the report's time, and leaves `status` alone:

| Depth | Rule |
|---|---|
| `routine` | at least the weeks a `habit` needs, and a hit in the last 28 days |
| `paused` | that many weeks, but no hit in the last 28 days |
| `new` | fewer weeks, the first hit in the last 28 days: too early to tell |
| `tried` | fewer weeks, the first hit older than 28 days |

The words are neutral; they describe and do not judge. An unseen moment has no depth.

A moment is **new** when its first hit falls in the recent window (the last 28 days). Statuses
only grow as history grows; a habit never falls back because of a quiet month. The reactions,
which look at the recent window, are what moves.

**Personas.** These are caricatures, named for marketing:

| Persona | Cares about | You want |
|---|---|---|
| Andrej Karpathy | control and context: you know what you want, you steer, you give the agent the right context | a lot |
| Boris Cherny | the harness and automation: plan mode, compaction, skills, subagents, model routing, sensible parallelism | a lot |
| Steve Yegge | the frontier: teams, swarms, workflows, beads, agents working overnight | a bit, carefully |

**Reactions.** Each persona reacts with one emoji, and Merlin gives one sentence of explanation.
Merlin never writes quotes attributed to the real people.

| Persona | Rule (first that applies) | Emoji |
|---|---|---|
| Karpathy, Boris | over-Yegge (below) | 😬 Karpathy, 🫠 Boris |
| | a moment of theirs is new | 🚀 |
| | a habit of theirs had hits in the window | 👏 |
| | any moment of theirs had hits in the window | 👍 |
| | otherwise | 👀 |
| Yegge | over-Yegge | 🤯 |
| | a frontier moment is new | 🤘 |
| | two or more frontier habits had hits in the window | 🫡 (he has moved on) |
| | any frontier hit in the window | 🧪 |
| | otherwise | 👀 |

**Over-Yegge.** In the window there are at least 5 frontier hits, and either no steering
(`steer-mid-turn`, `interrupt-redirect`, `rewind`) or at least 30% of at least 5 recent agents
killed. Yegge never warns; the other two do.

**Suggestions.** Up to three. Unseen moments come before explored ones. Within each group, moments
whose `Symptom` fired come first (with its reason), then at most one per persona, Karpathy before
Boris before Yegge. A technique (below) on an unseen moment comes before all of them.

**Techniques.** A technique is a gap the history shows on one practice, with an estimate of the saving,
a fix to copy and, once copied, a follow-up. It belongs to the moment it is attached to: when that
moment is unseen the technique is a suggestion (a row at the end of the table); when it is seen the
technique is the SAVES cell and the open row's section on the moment's own row
(`MomentView.technique`). Estimates use the last 28 days at the API prices of the pricing tables, are
scaled by 30/28 and rounded to two figures. Each has `days` (when the gap showed) and an `example`.

| Technique | Attached to | Fires when | Estimate (28 days, then x 30/28) |
|---|---|---|---|
| Heavy context | `clean-slate` | 3+ interactive main-thread turns and at least 20% of them (or of their cost) ran above 250k tokens of context; or any turn at 500k+ (the reason then leads with that count) | each turn above 250k: `cost x (context - 150k) / context`, the part of its price paid for context beyond a lean 150k. Fix: an AGENTS.md paragraph (hand-off note, fresh session, exploration to sub-agents), the same for every harness |
| Orchestrator | `model-routing` | 3+ turns on a model whose output price is above the latest Sonnet's, each with 10+ edit and shell calls and at most one sub-agent started | those turns' cost per model, minus the same tokens priced at the latest Sonnet in the table. Fix: an AGENTS.md paragraph ("Act as the orchestrator ..."), nothing else; its universal wording says "a mid-tier model", and `fix.variants` has the Claude Code wording (Sonnet) with its own how-line |
| Shell compressor | `compressed-shell` | no rtk hook in Claude Code's user `settings.json` and no shell call rewritten to rtk in the window (see the practice below), and the estimate is at least $1 a month | per turn with shell output that no hook rewrote: tokens = bytes / 4 (Claude digests, `Turn.shellOutputBytes`), capped at 20k tokens a turn; times the later calls that read it again (the rest of the turn, then later turns of the same compaction epoch), capped at 100; times the main model's cache-read price; times 0.7 (rtk claims 60 to 90%). Fix: `brew install rtk` and `rtk init -g`, with a link to its README |

`unroutedAgents` stays the symptom of `model-routing`: it counts sub-agents that ran on the main
model, which the orchestrator technique does not look at. The old `context-isolation` symptom (150k
context, 3 turns) is retired; Heavy context replaces it.

**The loop.** Opening a suggestion's or technique's row is `open`, pressing Copy is `copy`
(`POST /api/moments/engage`). The daemon keeps the first open and the latest copy of each moment in
`$MERLIN_HOME/moments.json`; they come back as `engaged`. For 28 days after a copy the row is
*watching*: its mark is a clock, and the open row shows `engaged.followUp` or "Copied 12 Nov ·
watching your next sessions". `followUp` is set once 3+ interactive sessions started after the copy,
and compares the metric after the copy with the 28 days before it: the share of turns above 250k
(Heavy context), the premium tool-heavy turns' cost per session (Orchestrator), whether rtk is
configured now plus the practice's hits since (shell compressor), the hits since (any other
suggestion). It is worded as an association ("Since you copied it on 12 Nov: ..."), never as proof.

## 2. What is counted

- **Sessions.** Sessions a person worked in (not `sdk`) feed every detector. Scripted sessions only
  feed `automation`, as one hit per day.
- **Copied history** is skipped. A resumed or forked session repeats its parent's turns
  (`catalog.SessionInfo.InheritedTurns`). Those turns, and the agents, compactions, bead events and
  PRs that belong to them, do not count again.
- **Hits** later than the report's `now` are dropped.

## 3. Changing the catalog

Nothing is stored. A report is a pure function of the digests, the clock and the time zone, and
it is recomputed on every request: about 20 ms for 3,400 sessions. So:

- **Add** a moment: append an entry to `Registry()` with a new `id`, write its detector in the
  persona's file (`karpathy.go`, `boris.go`, `yegge.go`), add a test and a row below.
- **Change** a moment: edit its detector or texts and keep its `id`. Past sessions are re-read
  with the new rule on the next request.
- **Remove** a moment: delete its entry and its row below. Never reuse its `id`.

The `id` is the only durable name. Everything that keeps or passes ids (a shared card, a URL,
the web UI) ignores ids it does not know, so a removed moment just disappears. There is no
version number to bump. A test checks that every id in the registry has a row in §4.

The names of harness tools and commands that detectors look for (`EnterPlanMode`, `Skill`,
`apply_patch`, `/compact`, …) are kept in one file, `internal/moments/vocab.go`.

## 4. The catalog

Source column: **digest** means the detector reads fields the digest already has; **heur** means
a text heuristic over the prompt.

### Karpathy

| id | Title | Category | Detected when | Source |
|---|---|---|---|---|
| `steer-mid-turn` | Steering mid-turn | prompt | a human prompt is queued while a turn runs (`Turn.queued`, origin human) | digest |
| `interrupt-redirect` | Interrupt and redirect | prompt | an interrupted human turn is followed within 2 min by a different human prompt | digest |
| `rewind` | Takes the other branch | prompt | an abandoned human turn (rewind), or a session forked from another | digest |
| `grounded-prompt` | Grounded prompt | prompt | the prompt names a file (by base name) that the turn then touched | digest + heur |
| `pasted-evidence` | Shows the evidence | prompt | an image is attached, or the prompt holds 2+ lines that look like an error or stack trace | digest + heur |
| `acceptance-criteria` | Spec with criteria | prompt | a prompt of 300+ bytes with 3+ list items and a constraint word (must, never, verify, test, …) | heur |
| `one-shot-spec` | One-shot spec | prompt | a prompt of 120+ words, 10+ tool calls, not interrupted, no correction next | heur |
| `vibe-one-shot` | Vibe one-shot | prompt | a prompt of 2–25 words (not an approval like "yes do it") leading to 3+ edits, no correction next | heur |
| `clean-slate` | Clean slate | context | `/clear` | digest |

A **correction** is the next human prompt arriving within 30 minutes, at most 60 words, and
starting like "no", "wrong", "still", "doesn't work", "revert", ….

### Boris

| id | Title | Category | Detected when | Source |
|---|---|---|---|---|
| `plans-first` | Plans first | prompt | a turn used plan mode (`EnterPlanMode`/`ExitPlanMode`) | digest |
| `deliberate-compact` | Compacts on purpose | context | a manual compaction | digest |
| `model-switch` | Switches model mid-session | context | `/model`, `/effort` or `/fast` mid-session | digest |
| `custom-command` | Own commands and skills | harness | a slash command that is not built in, or the `Skill` tool | digest |
| `builds-harness` | Builds the harness | harness | a turn with edits touched CLAUDE.md, AGENTS.md, `.claude/skills`, commands, agents, hooks or settings | digest |
| `context-isolation` | Context isolation | context | a fresh-context subagent of type Explore, or one with 5+ read-only calls and no edits | digest |
| `model-routing` | Model routing | harness | a subagent on a model with a lower output price than the session's main model | digest |
| `compressed-shell` | Compressed shell output (rtk) | harness | a turn in which a PreToolUse hook rewrote a shell call to run through a compressor such as rtk: the hook's own `hook_success` record in the transcript (`Turn.shellCompressed`, transcript-format §4c). The settings only say whether it is configured, for the row's note: "rtk is on: it rewrote 1,240 shell commands in the last 28 days.", "configured, but no rewrites seen lately" or "not set up" (`MomentView.note`) | digest (+ setup for the note) |
| `parallel-sessions` | Parallel sessions | parallelism | 2+ sessions working at once (turns less than 5 min apart form one stretch); one hit per day | digest |
| `worktrees` | Worktrees | parallelism | `EnterWorktree`, or a working directory under `worktrees/` | digest |
| `background-agents` | Background agents | parallelism | a background subagent | digest |
| `automation` | Automation | harness | scripted sessions (one hit per day), scheduled turns, or `ScheduleWakeup`/`CronCreate` | digest |
| `ships-pr` | Ships | harness | a PR linked from the session | digest |
| `mcp-tools` | Plugged in | harness | an MCP tool call | digest |

### Yegge

| id | Title | Category | Detected when | Source |
|---|---|---|---|---|
| `agent-team` | Agent team | parallelism | addressable subagents (teammates); one hit per session | digest |
| `workflow-run` | Workflow | harness | a workflow run | digest |
| `nested-agents` | Agents spawning agents | parallelism | an agent with a parent agent; one hit per session, at the deepest | digest |
| `swarm` | Swarm | parallelism | 5+ agents running at the same moment; one hit per session | digest |
| `beads-graph` | Beads as the plan | harness | in one session, 3+ beads created, 1+ linked (dep or parent), 1+ closed | digest |
| `personas` | Persistent personas | harness | `/wake`, `/sleep` or `/handoff`, or a file under `personas/` touched; one hit per session ([model welfare](https://yegge.ai/essays/model-welfare/)) | digest |
| `forked-agents` | Forks itself | parallelism | a subagent that inherits its parent's context | digest |
| `two-harnesses` | Two harnesses | harness | sessions in two harnesses in one ISO week | digest |
| `night-shift` | Night shift | parallelism | 2h+ between two human prompts with 3+ machine-started turns in between | digest |

### Symptoms

| Moment | Fires when |
|---|---|
| `steer-mid-turn` | 3+ human turns ran longer than 10 minutes | prompt |
| `clean-slate` | a session went past 40 human prompts | context |
| `deliberate-compact` | any auto-compaction (cold ones are counted separately) | context |
| `custom-command` | the same prompt (20+ characters) was typed 3+ times | harness |
| `model-routing` | 3+ subagents ran on the main session's model | harness |

### Planned (need parser work)

| Moment | Persona | Needs |
|---|---|---|
| Says no | Karpathy | tool results where the user rejected a call, with or without a reason |
| Sends the plan back | Karpathy | a rejected `ExitPlanMode` |
| Hooks at work | Boris | hook attachment records |
| Early adopter | Yegge | first use of a feature within weeks of the harness version that shipped it |
| Plan churn → beads | Yegge (symptom) | edits per file, to spot one plan file rewritten many times |
| Tight context | Boris | nothing new: auto-compaction `preTokens` reveal a low threshold; peak `contextTokens` (merlin-3gf) |
| Harness setup | Boris | a harness-neutral snapshot of each harness's setup: status line, hooks, plugins, autocompact (merlin-ut5) |
| Custom harness | Yegge | a Pi harness beside claude and codex; `two-harnesses` generalises to N (merlin-ut5) |

Also planned, as numbers beside the moments rather than moments (merlin-3gf): what carrying a large
context costs (tokens past a reference size, at the cache-read price) and what cache misses cost
(context written again after an idle gap, at the write-minus-read price), per harness.

## 5. API and UI

`GET /api/moments` returns the report ([api.md](api.md)). The web UI shows it at `/moments`,
with the card on top.

The card is an SVG 1056 wide with a fixed light look of its own (it does not follow the app's
theme). It is about the achievements: under the title, three headline numbers (sessions without
scripted runs, projects, and how long the history runs); then one narrow column per persona: its
drawing with its reaction as an emoji comment bubble, its name and focus (context, harness,
frontier) beside it under the bubble, and up to ten of its moments. The card is as tall as the
longest column needs (about 730 to 1080), so it stays close to square. The Merlin mark and `merlin.dev` sit small in the bottom
right. The drawings (`web/src/features/moments/avatars/*.webp`, about 15 KB each) were cut from an
AI-generated reference card and are inlined as data URLs, so the SVG stands alone. On the page, a
small drawing of the persona's whole head (`avatars/*-head.webp`, about 5 KB each, no neck and no
backdrop) marks a moment's persona in the lists. Download PNG
saves the card at twice its size (drawn on a canvas in the browser). The Sessions page
shows a one-row invite with the three reactions that links to `/moments`.

## 5a. The page

`/moments` is the guide next to the instruments (Overview, Cost, the session view): your own story,
and what to try next. Every claim links to the instrument view that shows it. Top to bottom:

- **The table.** A moment is one occurrence (a square on the timeline); a row is a practice. One row per seen practice, headed Practice: its depth mark, title, category and count, then a track of
  squares, one per stretch of days it came back (linear time from `since` to `now`, never more than the last
  year, under a thin strip of the prompts per day). Every column header sorts; the timeline sorts by start or
  end. Rows open in place, one at a time: what was seen and how Merlin spots it, and for a suggestion the
  reason, the try text and a link to where it shows. The open moment's squares open the session of that day.
  The key (marks, categories, squares) is in the shell's legend panel.
- **Next.** Suggested unseen moments are rows at the end, with a dotted circle; a suggested seen moment keeps
  its row, tagged "try again". At most three suggestions in all.
- **Techniques.** A technique with an estimate of $20 a month or more has a red filled circle instead of
  the dotted one (below that, the dotted circle stays and the SAVES cell still shows). On a seen row the
  depth glyph stays and the estimate is in the SAVES column, after the green amount already saved (`MomentView.saved`: model routing and rtk only, see api.md) ("≈ $120 / mo", sortable, empty for most rows). While the person is watching a copied fix
  (28 days) a clock circle replaces the red or dotted circle, and on a seen row the depth glyph. Watching
  and red rank with the suggestions in the depth sort.
- **More to try.** The unseen moments that are not suggestions, collapsed.

The personas, their reactions and the share card are not shown for now; the code stays.

## 6. Sharing (open)

Undecided. Whatever is chosen, only moment ids, statuses, counts and reactions leave the machine,
never session text, paths or projects. The card's data is about 1 KB.

- **The URL holds it.** `merlin.dev/c#…` with the payload in the fragment: nothing is stored and
  the server never sees it. But link previews (X, LinkedIn) need an image the server can render,
  and a fragment never reaches the server.
- **The URL holds it, in the query.** `merlin.dev/c?m=…` can be rendered server-side into a
  preview image without being stored. Only an anonymous log line would remain (useful for
  aggregate statistics, such as "6% of cards show a swarm").
- **A certificate page.** `merlin.dev/u/<handle>` grows with every update the person pushes: the
  catalog only ever grows, which makes it a reason to come back. It needs storage and some
  identity, though.
