package pi

import "github.com/terek/merlin/internal/harness"

// Support is what Merlin understands of Pi sessions: one claim per capability of
// harness.Capabilities. It is data only. Absent claims rest on Pi's source (docs/pi-format.md,
// labelled "from source"), never on the public corpus alone: that is redacted and small. How
// often a capability is seen is measured by merlin doctor, and seen is not the same as correct.
func Support() harness.Support {
	return harness.Support{
		"session.project": harness.P("header cwd. Kind is always interactive: nothing in the file says otherwise"),
		"session.title":   harness.P("the last session_info name (an empty one clears it), else the first line of the first prompt"),
		"session.gitBranch": harness.A("docs/pi-format.md, Not recorded (from source): the session header holds only " +
			"type, version, id, timestamp, cwd and parentSession"),
		"session.recaps": harness.A("docs/pi-format.md, Records (from source): no entry type of that kind; " +
			"compaction and branch_summary summaries are read as compactions and are not recaps"),

		"turns.userText":  harness.P("message role user; text blocks joined by a newline, images counted"),
		"turns.finalText": harness.P("the last assistant text of the turn that did not end in a tool call, on the current path"),
		"turns.inbox": harness.D("custom_message entries (extension text sent to the model) are recorded; " +
			"their text is not read and they start no turn"),
		"turns.queued":    harness.U("whether prompts typed while a turn runs leave a trace in the file is not known"),
		"turns.abandoned": harness.P("a turn whose user message is off the path from the last entry to the root"),

		"tools.calls":        harness.P("toolCall blocks of assistant messages, counted by name, on every branch"),
		"files.touched":      harness.P("path argument of the edit and write tools, resolved against the header cwd"),
		"files.linesChanged": harness.P("edit results' details.diff: lines starting with + and -; write is not counted"),

		"cost.perMessage": harness.P("every assistant message with tokens or cost, plus the usage of compaction, " +
			"branch_summary, usage entries and tool results; usage.cost.total is kept as Recorded, else the price table, " +
			"else Unpriced. A tool result's or compaction's model is a guess: the nearest assistant message above"),
		"cost.reported": harness.A("docs/pi-format.md, Tokens and cost (from source): Pi stores a cost on every call and " +
			"no session or run total; totals are summed on demand, so there is no reported window"),
		"cost.truncated": harness.U("aborted and error responses can carry tokens; whether the counts are partial is not known"),
		"cost.fast":      harness.U("a service tier scales Pi's cost for some providers; no field says which calls"),

		"compactions.record":  harness.P("compaction entries on the current path"),
		"compactions.summary": harness.P("compaction.summary, whole"),
		"compactions.trigger": harness.A("docs/pi-format.md, Compaction (from source): a compaction entry has no trigger " +
			"field; manual (/compact) and automatic are not told apart"),
		"compactions.call": harness.P("compaction.usage, when Pi recorded it, as a message and as the compaction's call"),

		"agents.tree": harness.P("docs/pi-format.md, Subagents: the example extension's results[] (from source, Pi 1.5.0); " +
			"a bash pi --no-session and pi-dial's Task and oracle are unrecorded runs (spend unknown, not zero). " +
			"A bash-spawned pi without --no-session is a session of its own, not linked to its parent (merlin-1es.15)"),
		"agents.nesting": harness.P("a child's own results[] or bash pi --no-session, by shape; not seen in a session"),
		"agents.prompts": harness.P("results[].task whole; the bash command for a bash-spawned pi; details.description for Task and oracle"),
		"agents.inbox":   harness.U("no message to a child after its launch is known in any convention here; none is read"),

		"lineage.fork": harness.P("header parentSession: the id after the last _ of the parent file's name; " +
			"entries are copied with their ids, so a fork's spend is billed once by the catalog"),
		"links.prs":   harness.U("no record of this kind is known; not looked for"),
		"links.beads": harness.P("bd calls in the bash tool and in bashExecution (!) messages"),

		"live.registry": harness.U("LiveSessions returns none; whether Pi keeps a registry is not known"),
		"live.hooks": harness.U("ParseHook always declines: Pi has no hook list to install into; " +
			"an extension could send one, none is designed"),
	}
}
