# Claude Code hooks: what Explorer relies on

Source: https://code.claude.com/docs/en/hooks, fetched 2026-10-01. The page was read through
a summarising fetch tool, not byte for byte, so treat field lists as confirmed-by-summary;
fields marked (unverified) were not on the page. Explorer only needs `session_id`,
`hook_event_name`, `transcript_path`, `cwd` and `agent_transcript_path`; everything else is
forwarded untouched and ignored.

## Payload on stdin (JSON, one object)

Common to all events: `session_id`, `transcript_path`, `cwd`, `permission_mode`,
`hook_event_name` (also `scratchpad_dir`).

| Event | Extra fields |
|---|---|
| SessionStart | `source` (`startup`, `resume`, `clear`, `compact`, `fork`); optional `model`, `agent_type`, `session_title`; on resume/fork also `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` |
| UserPromptSubmit | `prompt_id`, `prompt` |
| Stop | `last_assistant_message`, `stop_reason`; `agent_id` / `agent_type` when running inside a subagent or `--agent` |
| SubagentStop | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`. The page's example omits `transcript_path` and `cwd` (unverified whether they are present). |
| SessionEnd | `reason` (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`) |

Differences from PLAN.md / transcript-format.md §10: `hook_event_name` and
`agent_transcript_path` are now confirmed (they were "assumed"). `SubagentStop` identifies its
subagent by `agent_id` plus `agent_transcript_path`. The daemon must therefore not require
`transcript_path` or `cwd` on `SubagentStop`.

## settings.json shape

```json
{ "hooks": { "<Event>": [ { "matcher": "optional", "hooks": [
  { "type": "command", "command": "...", "timeout": 600 } ] } ] } }
```

- Event maps to an array of matcher groups; each group has an optional `matcher` (omitted
  means all) and a `hooks` array. Hook fields: `type` and `command` required; `timeout` in
  seconds (default 600; 30 on UserPromptSubmit); optional `args`, `async`, `statusMessage`,
  `if`, `shell`.
- All matching hooks run in parallel.
- Hooks in the user's `~/.claude/settings.json` run without a workspace trust prompt.

## Output and exit codes

- Exit 0: success. Plain stdout of SessionStart, UserPromptSubmit and Stop hooks is added
  to the model's context. Hence `explorer hook` prints nothing.
- Exit 2: blocking error (blocks the prompt / prevents stopping). Other non-zero: error shown
  to the user. Hence `explorer hook` always exits 0.
- SessionEnd hooks share a ~1.5 s budget, so the client's 150 ms cap matters there.
- Timed-out hooks have their output discarded.

## What Explorer installs

One matcher group, no `matcher`, per event (`SessionStart`, `UserPromptSubmit`, `Stop`,
`SubagentStop`, `SessionEnd`):

```json
{"hooks": [{"type": "command", "command": "<EXPLORER_HOME>/claude/hooks/notify.sh", "timeout": 2}]}
```

Ownership: a hook is Explorer's if its `command` ends in `/claude/hooks/notify.sh`.
Uninstall removes such hooks only (the whole group if it holds nothing else), then removes
event arrays and `hooks` if they became empty. An empty array that existed before install is
indistinguishable from one Explorer created and is removed too.
