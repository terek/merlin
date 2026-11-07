package harness

import (
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/terek/merlin/internal/model"
)

// State is what a harness package claims about one capability.
type State string

const (
	// Unknown is the default and an honest answer: nobody has decided yet.
	Unknown State = "unknown"
	// Absent: the harness does not record it. The note names the evidence (a format doc or
	// a parser comment); redacted data alone is not evidence.
	Absent State = "absent"
	// Dropped: the harness records it and Merlin does not read it.
	Dropped State = "dropped"
	// Parsed: code fills the field.
	Parsed State = "parsed"
)

// Capability is one thing a harness might let Merlin know about a session. The list is
// fixed and harness-neutral; adding an entry forces every harness to decide about it.
type Capability struct {
	ID      string
	Meaning string
	// Seen says whether the digest populated the capability. Nil: a digest cannot show it
	// (live state, hooks), so coverage reports it as not measured.
	Seen func(*model.SessionDigest) bool
}

// Claim is one harness's declaration for one capability.
type Claim struct {
	State State
	Note  string
}

// Support is a harness's declarations by capability id. The harness package declares it as
// data; it holds no versions and no corpus figures, those belong to the coverage report.
type Support map[string]Claim

// Declaration constructors, for readable tables.
func P(note string) Claim { return Claim{Parsed, note} }
func A(note string) Claim { return Claim{Absent, note} }
func D(note string) Claim { return Claim{Dropped, note} }
func U(note string) Claim { return Claim{Unknown, note} }

func any1[T any](xs []T, f func(T) bool) bool { return slices.ContainsFunc(xs, f) }

func anyTurn(f func(model.Turn) bool) func(*model.SessionDigest) bool {
	return func(d *model.SessionDigest) bool { return any1(d.Turns, f) }
}

func anyCompaction(f func(model.Compaction) bool) func(*model.SessionDigest) bool {
	return func(d *model.SessionDigest) bool { return any1(d.Compactions, f) }
}

func anyAgent(f func(model.Agent) bool) func(*model.SessionDigest) bool {
	return func(d *model.SessionDigest) bool { return any1(d.Agents, f) }
}

var capabilities = []Capability{
	{"session.project", "the directory the session started in", func(d *model.SessionDigest) bool { return d.Project != "" }},
	{"session.title", "a title or name for the session", func(d *model.SessionDigest) bool { return d.Title != "" }},
	{"session.gitBranch", "the git branch the session was on", func(d *model.SessionDigest) bool { return len(d.GitBranches) > 0 }},
	{"session.recaps", "harness-written recaps of where things stand", func(d *model.SessionDigest) bool { return len(d.Recaps) > 0 }},

	{"turns.userText", "the prompt of a turn, as its author wrote it", anyTurn(func(t model.Turn) bool { return t.UserText != "" })},
	{"turns.finalText", "the answer a turn ended with", anyTurn(func(t model.Turn) bool { return t.FinalText != "" })},
	{"turns.inbox", "messages a machine delivered as a prompt", anyTurn(func(t model.Turn) bool { return len(t.Inbox) > 0 })},
	{"turns.queued", "prompts that arrived while a turn was running", anyTurn(func(t model.Turn) bool { return len(t.Queued) > 0 })},
	{"turns.abandoned", "turns left behind by a rewind, edit or retry", anyTurn(func(t model.Turn) bool { return t.Abandoned })},

	{"tools.calls", "tool calls, counted by name", func(d *model.SessionDigest) bool { return d.Stats.ToolCalls > 0 }},
	{"files.touched", "the files a turn touched", anyTurn(func(t model.Turn) bool { return len(t.FilesTouched) > 0 })},
	{"files.linesChanged", "lines added and removed", func(d *model.SessionDigest) bool { return d.Stats.LinesAdded+d.Stats.LinesRemoved > 0 }},

	{"cost.perMessage", "token counts per billed API message", func(d *model.SessionDigest) bool { return len(d.Messages) > 0 }},
	{"cost.reported", "a dollar figure the harness itself wrote down", func(d *model.SessionDigest) bool { return d.Reported != nil }},
	{"cost.truncated", "messages written down before they finished (partial output tokens)", func(d *model.SessionDigest) bool { return d.Cost.TruncatedMessages > 0 }},
	{"cost.fast", "calls made in fast or priority mode", func(d *model.SessionDigest) bool {
		return any1(d.Messages, func(m model.Message) bool { return m.Fast })
	}},

	{"compactions.record", "that a compaction happened, and when", func(d *model.SessionDigest) bool { return len(d.Compactions) > 0 }},
	{"compactions.summary", "the summary a compaction wrote", anyCompaction(func(c model.Compaction) bool { return c.Summary != "" })},
	{"compactions.trigger", "whether a compaction was automatic or manual", anyCompaction(func(c model.Compaction) bool { return c.Trigger != "" })},
	{"compactions.call", "what the call that wrote the summary cost (recorded or estimated)", anyCompaction(func(c model.Compaction) bool { return c.Call != nil })},

	{"agents.tree", "sub-agents of the session", func(d *model.SessionDigest) bool { return len(d.Agents) > 0 }},
	{"agents.nesting", "agents spawned by other agents", anyAgent(func(a model.Agent) bool { return a.ParentAgentID != nil })},
	{"agents.prompts", "the prompt an agent was started with, readable", anyAgent(func(a model.Agent) bool { return a.Prompt != "" })},
	{"agents.inbox", "messages an agent received after it started", anyAgent(func(a model.Agent) bool { return len(a.Inbox) > 0 })},

	{"lineage.fork", "that the session was forked from, or copied records of, another", func(d *model.SessionDigest) bool {
		return d.Lineage.ForkedFrom != nil || len(d.Lineage.InheritedFrom) > 0
	}},
	{"links.prs", "pull requests the session created or linked", func(d *model.SessionDigest) bool { return len(d.PRs) > 0 }},
	{"links.beads", "bd (beads) calls that name a bead", func(d *model.SessionDigest) bool { return len(d.Beads) > 0 }},

	{"live.registry", "the harness says which sessions are running now", nil},
	{"live.hooks", "hook notifications from the running harness", nil},
}

// Capabilities is the fixed list, in the order reports print it.
func Capabilities() []Capability { return slices.Clone(capabilities) }

// CapabilityIDs is the ids of the list, in order.
func CapabilityIDs() []string {
	out := make([]string, len(capabilities))
	for i, c := range capabilities {
		out[i] = c.ID
	}
	return out
}

// CheckSupport returns the problems with a harness's table: a capability left undeclared,
// one declared that is not in the list, a state that is not one of the four, and a note
// missing where the state is not parsed (absent needs its evidence, dropped and unknown
// their reason). Nil when the table is sound.
func CheckSupport(s Support) []string {
	var out []string
	known := map[string]bool{}
	for _, c := range capabilities {
		known[c.ID] = true
		cl, ok := s[c.ID]
		if !ok {
			out = append(out, c.ID+": not declared")
			continue
		}
		switch cl.State {
		case Parsed:
		case Unknown, Absent, Dropped:
			if strings.TrimSpace(cl.Note) == "" {
				out = append(out, fmt.Sprintf("%s: %s needs a note", c.ID, cl.State))
			}
		default:
			out = append(out, fmt.Sprintf("%s: state %q is not one of unknown, absent, dropped, parsed", c.ID, cl.State))
		}
	}
	var extra []string
	for id := range s {
		if !known[id] {
			extra = append(extra, id)
		}
	}
	sort.Strings(extra)
	for _, id := range extra {
		out = append(out, id+": not in the capability list")
	}
	return out
}
