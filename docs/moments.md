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
Boris before Yegge.

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

| id | Title | Detected when | Source |
|---|---|---|---|
| `steer-mid-turn` | Steering mid-turn | a human prompt is queued while a turn runs (`Turn.queued`, origin human) | digest |
| `interrupt-redirect` | Interrupt and redirect | an interrupted human turn is followed within 2 min by a different human prompt | digest |
| `rewind` | Takes the other branch | an abandoned human turn (rewind), or a session forked from another | digest |
| `grounded-prompt` | Grounded prompt | the prompt names a file (by base name) that the turn then touched | digest + heur |
| `pasted-evidence` | Shows the evidence | an image is attached, or the prompt holds 2+ lines that look like an error or stack trace | digest + heur |
| `acceptance-criteria` | Spec with criteria | a prompt of 300+ bytes with 3+ list items and a constraint word (must, never, verify, test, …) | heur |
| `one-shot-spec` | One-shot spec | a prompt of 120+ words, 10+ tool calls, not interrupted, no correction next | heur |
| `vibe-one-shot` | Vibe one-shot | a prompt of 2–25 words (not an approval like "yes do it") leading to 3+ edits, no correction next | heur |
| `clean-slate` | Clean slate | `/clear` | digest |

A **correction** is the next human prompt arriving within 30 minutes, at most 60 words, and
starting like "no", "wrong", "still", "doesn't work", "revert", ….

### Boris

| id | Title | Detected when | Source |
|---|---|---|---|
| `plans-first` | Plans first | a turn used plan mode (`EnterPlanMode`/`ExitPlanMode`) | digest |
| `deliberate-compact` | Compacts on purpose | a manual compaction | digest |
| `model-switch` | Right model for the job | `/model`, `/effort` or `/fast` mid-session | digest |
| `custom-command` | Own commands and skills | a slash command that is not built in, or the `Skill` tool | digest |
| `builds-harness` | Builds the harness | a turn with edits touched CLAUDE.md, AGENTS.md, `.claude/skills`, commands, agents, hooks or settings | digest |
| `context-isolation` | Context isolation | a fresh-context subagent of type Explore, or one with 5+ read-only calls and no edits | digest |
| `model-routing` | Model routing | a subagent on a model with a lower output price than the session's main model | digest |
| `parallel-sessions` | Parallel sessions | 2+ sessions working at once (turns less than 5 min apart form one stretch); one hit per day | digest |
| `worktrees` | Worktrees | `EnterWorktree`, or a working directory under `worktrees/` | digest |
| `background-agents` | Background agents | a background subagent | digest |
| `automation` | Automation | scripted sessions (one hit per day), scheduled turns, or `ScheduleWakeup`/`CronCreate` | digest |
| `ships-pr` | Ships | a PR linked from the session | digest |
| `mcp-tools` | Plugged in | an MCP tool call | digest |

### Yegge

| id | Title | Detected when | Source |
|---|---|---|---|
| `agent-team` | Agent team | addressable subagents (teammates); one hit per session | digest |
| `workflow-run` | Workflow | a workflow run | digest |
| `nested-agents` | Agents spawning agents | an agent with a parent agent; one hit per session, at the deepest | digest |
| `swarm` | Swarm | 5+ agents running at the same moment; one hit per session | digest |
| `beads-graph` | Beads as the plan | in one session, 3+ beads created, 1+ linked (dep or parent), 1+ closed | digest |
| `personas` | Persistent personas | `/wake`, `/sleep` or `/handoff`, or a file under `personas/` touched; one hit per session ([model welfare](https://yegge.ai/essays/model-welfare/)) | digest |
| `forked-agents` | Forks itself | a subagent that inherits its parent's context | digest |
| `two-harnesses` | Two harnesses | sessions in two harnesses in one ISO week | digest |
| `night-shift` | Night shift | 2h+ between two human prompts with 3+ machine-started turns in between | digest |

### Symptoms

| Moment | Fires when |
|---|---|
| `steer-mid-turn` | 3+ human turns ran longer than 10 minutes |
| `clean-slate` | a session went past 40 human prompts |
| `deliberate-compact` | any auto-compaction (cold ones are counted separately) |
| `custom-command` | the same prompt (20+ characters) was typed 3+ times |
| `context-isolation` | 3+ turns ran with 150k+ tokens of context |
| `model-routing` | 3+ subagents ran on the main session's model |

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
