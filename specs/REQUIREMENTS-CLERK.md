# Merlin Clerk — Requirements

## What it is

The Clerk is an orchestration and planning assistant for the architect. It has total recall of all past sessions in a project and can quickly pull context, prepare plans, draft prompts, and dispatch them to CC sessions. It eliminates the architect's main bottleneck: reassembling context scattered across sessions and days.

The Clerk is not a pair programmer, not a supervisor, not opinionated. It's the staff engineer who knows where everything is and can prepare anything you need, fast.

## Core capabilities

### 1. Recall

Find and synthesize information across all sessions in a project.

- "What did we decide about encryption?"
- "Where did we implement the relay refactor?"
- "What was the rationale for PID-keyed lockfiles?"

The architect shouldn't have to remember which session something happened in. The Clerk knows. It retrieves the relevant pieces, presents user prompts verbatim, and compresses agent responses to the essentials.

### 2. Prepare

Draft prompts and plans with the right context baked in.

- The architect describes intent ("I want to redo the relay")
- The Clerk pulls relevant past decisions, current code state, and constraints
- Assembles a prompt ready for review
- The architect edits, asks for restructuring ("split into two phases", "add the backwards compat constraint")
- Iterates until the architect is satisfied

The Clerk can also be asked to prepare information that isn't readily available — e.g., "give me a description of all tests around feature X." If this requires running an errand (dispatching a CC session to explore the codebase and report back), the Clerk does so and reports back when the results are ready.

### 3. Dispatch

Send a prepared prompt to an existing idle session or start a new one. The architect says "send it" and the Clerk handles the mechanics. The dispatched prompt and its context become part of the Clerk's memory for future recall.

### 4. Track errands

When the Clerk dispatches a session (either from a prepared prompt or an information-gathering errand), it knows the session's state — running, idle, finished, stuck. It can report on what was done and knows when sessions complete. This is not the primary focus but is necessary for the prepare-and-dispatch loop to work end to end.

## Key properties

### Speed

Recall and preparation must feel instant. The architect is thinking fast — the Clerk can't be the bottleneck. Session data must be pre-processed so searches don't require scanning raw JSONL files on every question.

### Interruptibility

The Clerk streams its responses. The architect can cut it off at any point and redirect. If the architect realizes mid-summary they want to ask about something else, the Clerk drops what it's doing and follows the new thread immediately. No "let me finish."

### No opinions

The Clerk retrieves, organizes, and assembles. It does not suggest architectural changes, critique decisions, or offer alternatives unless explicitly asked. The architect is the decision-maker. The Clerk is the one who remembers everything and prepares things quickly.

### Asymmetric detail

When recalling past sessions:

| Content | Treatment |
|---------|-----------|
| User prompts | Verbatim — these are the requirements |
| Subagent launch prompts | Verbatim — equivalent to user prompts |
| Agent reasoning/explanation | 1-2 sentence summary |
| Agent tool calls | File-change stats only ("edited 5 files in src/auth/") |
| Agent tool results | Dropped |

## Pre-processing

Sessions must be processed ahead of time so recall is fast. This runs automatically when sessions close or on daemon startup for historical sessions. Uses a cheap/fast model (Haiku or Gemini Flash).

### Segmentation

Sessions often cover multiple unrelated topics (the architect reuses sessions). The Clerk breaks them into coherent topic chunks — each segment represents one coherent piece of work or discussion.

### Compression

Agent responses summarized, tool calls reduced to stats, user prompts kept verbatim. The compressed form is what the Clerk searches and retrieves from. Raw JSONL is never modified — always available for drill-down.

### Indexing

Segments tagged by topic so cross-session search is fast. The Clerk can answer "what did we discuss about X" without scanning every turn of every session.

## Project scope

A project is a group of associated sessions, typically all sessions started in the same directory (at the .git level). The Clerk operates per-project. Sub-folder sessions may be included.

## Prompt lifecycle

1. Architect describes intent
2. Clerk pulls relevant context, drafts a prompt
3. Architect reviews, edits, asks for changes
4. Architect says "send it"
5. Clerk dispatches to a session (existing or new)
6. The prompt and its outcome become part of the Clerk's recall for next time

## Errands

When the Clerk needs information it doesn't have (e.g., current test coverage for a module, or a detailed inventory of how a feature is implemented), it can:

1. Spin up a CC session with a targeted exploration prompt
2. Track the session until completion
3. Ingest the results
4. Report back to the architect

The architect can also explicitly ask the Clerk to go gather information: "go find out how the auth middleware handles token refresh and come back to me."

## Chat interface

The Clerk is accessed through a conversational interface — mobile app, desktop app, or both. Built with claude-agent-sdk. Streaming responses. LLM calls go directly to the Anthropic or Gemini API (not through CC).

## Non-goals (for now)

- Proactive suggestions or architectural opinions
- Autonomous multi-agent orchestration without architect involvement
- Real-time progress dashboards for running sessions
- Interrupting or steering running CC sessions
- Code generation (the Clerk prepares prompts, CC writes code)
