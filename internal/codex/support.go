package codex

import "github.com/terek/merlin/internal/harness"

// Support is what Merlin understands of Codex sessions: one claim per capability of
// harness.Capabilities. It is data only. Absent claims rest on docs/codex-format.md; how
// often a capability is seen is measured by merlin doctor, and seen is not the same as
// correct.
func Support() harness.Support {
	return harness.Support{
		"session.project":   harness.P("session_meta cwd"),
		"session.title":     harness.P("session_index.jsonl thread names, else the first prompt"),
		"session.gitBranch": harness.P("session_meta git.branch"),
		"session.recaps":    harness.U("no record of this kind is known; not looked for"),

		"turns.userText":  harness.P("item_completed UserMessage; event_msg user_message in Codex 0.116 and 0.137 (public corpus: 6 of 6 sessions)"),
		"turns.finalText": harness.P("task_complete last_agent_message, final_answer messages; event_msg agent_message final_answer in 0.116 and 0.137"),
		"turns.inbox":     harness.P("messages between threads (send_message, followup_task)"),
		"turns.queued":    harness.P("messages that arrive while a turn runs"),
		"turns.abandoned": harness.U("rewinds inside a rollout are not examined; turn_aborted is read as interrupted"),

		"tools.calls":        harness.P("function_call and custom_tool_call"),
		"files.touched":      harness.P("FileChange items; patch_apply_end before 0.164"),
		"files.linesChanged": harness.P("FileChange diffs; patch_apply_end before 0.164"),

		"cost.perMessage": harness.P("token_usage_record; without one (0.116, 0.137) each token_count with info is a call, repeats skipped; the redacted public dataset has token_count without info, so it has no cost"),
		"cost.reported":   harness.A("docs/codex-format.md, Not recorded: no dollar figure; cost is recomputed from tokens"),
		"cost.truncated":  harness.U("whether a usage record can be written before its call finished is not known"),
		"cost.fast":       harness.P("service_tier priority in thread_settings_applied"),

		"compactions.record":  harness.P("compacted records; 0.137 also writes event_msg context_compacted (24 in the public corpus, 0 compacted records: redacted) which is not read"),
		"compactions.summary": harness.A("docs/codex-format.md, Compactions: the summary is stored encrypted"),
		"compactions.trigger": harness.P("manual when no one typed into the turn; auto is inferred; the public corpus has 24 compaction events (context_compacted) and none carries a trigger"),
		"compactions.call":    harness.P("recorded: the call has its own token_usage_record"),

		"agents.tree":    harness.P("threads sharing a session_id"),
		"agents.nesting": harness.P("parent_thread_id and agent paths"),
		"agents.prompts": harness.P("spawn_agent message; encrypted in 0.164, then marked promptEncrypted and empty"),
		"agents.inbox":   harness.P("agent_message records and plain final answers; messages between threads are encrypted in 0.164"),

		"lineage.fork": harness.P("forked_from_id, history_base and copied subagent history"),
		"links.prs":    harness.U("no record of this kind is known; not looked for"),
		"links.beads":  harness.P("bd calls in command executions"),

		"live.registry": harness.U("LiveSessions returns none; whether Codex keeps a registry is not known"),
		"live.hooks":    harness.P("ParseHook, with hooks installed by internal/codex/hooks"),
	}
}
