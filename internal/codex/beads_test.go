package codex

import (
	"reflect"
	"testing"

	"github.com/terek/merlin/internal/model"
)

func (r *rollout) exec(sec int, id string, argv any, output string, exit int) *rollout {
	return r.event(sec, map[string]any{"type": "item_completed", "item": map[string]any{
		"type": "CommandExecution", "id": id, "command": argv, "cwd": "file:///home/dev/acme",
		"status": "completed", "aggregated_output": output, "exit_code": exit}})
}

func TestBeadEvents(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "cli", map[string]any{"git": map[string]any{"branch": "cards"}}).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).
		user(2, "Track the card work.", 0).
		usage(3, "resp-1", "r1", 100, 0, 10).
		exec(4, "exec-1", []string{"/bin/zsh", "-lc", "bd create --title='Render cards' --type=task --json"},
			"{\n  \"id\": \"cards-b2d\",\n  \"title\": \"Render cards\"\n}\nbeads: auto-export warning\n", 0).
		usage(5, "resp-2", "r1", 100, 0, 10).
		exec(6, "exec-2", []string{"/bin/zsh", "-lc", "bd update cards-b2d --claim && bd close cards-b2d --reason='Rendered'"},
			"✓ Updated issue: cards-b2d — Render cards\n✓ Closed cards-b2d — Render cards: Rendered\n", 0).
		exec(7, "exec-3", "cd sub && bd dep add cards-x cards-y", "Error: issue cards-x not found\n", 1).
		done(8, "r1").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")

	d := build(t, home, "R")
	type row struct {
		tool    string
		msg     string
		op      model.BeadOp
		ids     []string
		cwd     string
		outcome model.BeadOutcome
	}
	var got []row
	for _, e := range d.Beads {
		if e.Turn == nil || *e.Turn != 0 || e.AgentID != "" {
			t.Errorf("event %+v: want main turn 0", e)
		}
		got = append(got, row{e.ToolUseID, e.MessageID, e.Op, e.IDs, e.Cwd, e.Outcome})
	}
	want := []row{
		{"exec-1", "resp-1", model.BeadCreate, []string{"cards-b2d"}, "/home/dev/acme", model.BeadOK},
		{"exec-2", "resp-2", model.BeadClaim, []string{"cards-b2d"}, "/home/dev/acme", model.BeadOK},
		{"exec-2", "resp-2", model.BeadClose, []string{"cards-b2d"}, "/home/dev/acme", model.BeadOK},
		{"exec-3", "resp-2", model.BeadDep, []string{"cards-x", "cards-y"}, "/home/dev/acme/sub", model.BeadFailed},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("beads\n got %+v\nwant %+v", got, want)
	}
	if d.Beads[0].Title != "Render cards" || d.Beads[2].Reason != "Rendered" {
		t.Errorf("title %q, reason %q", d.Beads[0].Title, d.Beads[2].Reason)
	}
	if len(d.Turns) != 1 || d.Turns[0].GitBranch != "cards" {
		t.Errorf("turn branch: %+v", d.Turns)
	}
}
