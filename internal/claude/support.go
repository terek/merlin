package claude

import "github.com/terek/merlin/internal/harness"

// Support is what Merlin understands of Claude Code sessions: one claim per capability of
// harness.Capabilities. It is data only. A claim of parsed points at code that fills the
// field (docs/transcript-format.md describes the records); how often it is seen is
// measured by merlin doctor, and seen is not the same as correct.
func Support() harness.Support {
	return harness.Support{
		"session.project":   harness.P("cwd of the records"),
		"session.title":     harness.P("ai-title and custom-title records"),
		"session.gitBranch": harness.P("gitBranch on records"),
		"session.recaps":    harness.P("away-summary system records"),

		"turns.userText":  harness.P(""),
		"turns.finalText": harness.P(""),
		"turns.inbox":     harness.P("machine-delivered prompts taken apart (transcript-format.md 4a)"),
		"turns.queued":    harness.P("queued_command attachments (transcript-format.md 4b)"),
		"turns.abandoned": harness.P("rewinds, edits and retries inside one file (transcript-format.md 9)"),

		"tools.calls":        harness.P(""),
		"files.touched":      harness.P(""),
		"files.linesChanged": harness.P("totalLinesAdded and totalLinesRemoved of cost-state records"),

		"cost.perMessage": harness.P("usage of assistant records"),
		"cost.reported":   harness.P("cost-state records, as windows (transcript-format.md 8)"),
		"cost.truncated":  harness.P("assistant records written before they finished"),
		"cost.fast":       harness.P("usage speed of assistant records"),

		"compactions.record":  harness.P("compact_boundary system records"),
		"compactions.summary": harness.P("the isCompactSummary record after the boundary"),
		"compactions.trigger": harness.P("compactMetadata.trigger"),
		"compactions.call":    harness.P("an estimate: Claude Code does not record the call (transcript-format.md 6a)"),

		"agents.tree":    harness.P("subagent files and workflow runs"),
		"agents.nesting": harness.P("spawnDepth and the parent chain"),
		"agents.prompts": harness.P(""),
		"agents.inbox":   harness.P("teammate messages, idle notices, task notifications"),

		"lineage.fork": harness.P("forkedFrom and records copied from another session (transcript-format.md 9)"),
		"links.prs":    harness.P("pr-link records"),
		"links.beads":  harness.P("bd calls in Bash tool uses"),

		"live.registry": harness.P("sessions/<pid>.json files (registry.go)"),
		"live.hooks":    harness.P("ParseHook"),
	}
}
