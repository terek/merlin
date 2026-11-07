package codex

import (
	"reflect"
	"testing"

	"github.com/terek/merlin/internal/model"
)

func addUpdate(extra map[string]any) map[string]any {
	m := map[string]any{"type": "patch_apply_end", "call_id": "call_1", "turn_id": "r1", "status": "completed",
		"changes": map[string]any{
			"/w/new.go": map[string]any{"type": "add", "content": "package n\n\nfunc N() {}\n"},
			"/w/old.go": map[string]any{"type": "update", "unified_diff": "@@ -1,2 +1,2 @@\n-a\n+b\n+c\n", "move_path": nil},
		}}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

// The 0.137 to 0.142 form of an applied patch: files and lines are counted, and the event is
// not an unknown type.
func TestPatchApplyEndCounts(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "cli", map[string]any{"cli_version": "0.139.0"}).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).
		user(2, "Edit.", 0).
		event(3, addUpdate(nil)).
		done(4, "r1").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
	d := build(t, home, "R")
	if got, want := d.Turns[0].FilesTouched, []string{"/w/new.go", "/w/old.go"}; !reflect.DeepEqual(got, want) {
		t.Errorf("files = %v, want %v", got, want)
	}
	if d.Stats.LinesAdded != 5 || d.Stats.LinesRemoved != 1 {
		t.Errorf("lines +%d -%d, want +5 -1", d.Stats.LinesAdded, d.Stats.LinesRemoved)
	}
	if want := []model.WorkDir{{Dir: "/w", Edits: 2}}; !reflect.DeepEqual(d.Turns[0].WorkDirs, want) {
		t.Errorf("workDirs = %+v", d.Turns[0].WorkDirs)
	}
	if _, ok := d.Diagnostics.UnknownTypes["event_msg/patch_apply_end"]; ok || len(d.Diagnostics.UnknownTypes) != 0 {
		t.Errorf("unknown = %v", d.Diagnostics.UnknownTypes)
	}
}

// A failed patch is an edit in Work and nothing else. A missing success is not a failure.
func TestPatchApplyEndOutcome(t *testing.T) {
	f := false
	for name, c := range map[string]struct {
		extra map[string]any
		files int
	}{
		"success false":  {map[string]any{"success": f}, 0},
		"status failed":  {map[string]any{"status": "failed", "success": true}, 0},
		"success absent": {nil, 2},
		"success true":   {map[string]any{"success": true}, 2},
		"status empty":   {map[string]any{"status": ""}, 2},
	} {
		home := t.TempDir()
		newRollout(t).meta("R", "R", "cli", nil).
			start(1, "r1", "", "user").ctx(1, "r1", "m", nil).
			user(2, "Edit.", 0).
			event(3, addUpdate(c.extra)).
			done(4, "r1").
			write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
		d := build(t, home, "R")
		if len(d.Turns[0].FilesTouched) != c.files || (c.files == 0) != (d.Stats.LinesAdded == 0 && d.Stats.LinesRemoved == 0) {
			t.Errorf("%s: files %v lines +%d -%d", name, d.Turns[0].FilesTouched, d.Stats.LinesAdded, d.Stats.LinesRemoved)
		}
		if want := []model.WorkDir{{Dir: "/w", Edits: 2}}; !reflect.DeepEqual(d.Turns[0].WorkDirs, want) {
			t.Errorf("%s: workDirs = %+v", name, d.Turns[0].WorkDirs)
		}
	}
}

// The record names its turn: a patch that arrives after the next turn started belongs to the
// turn that ran it.
func TestPatchApplyEndNamesItsTurn(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "cli", nil).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).user(2, "One.", 0).done(3, "r1").
		start(4, "r2", "", "user").ctx(4, "r2", "m", nil).user(5, "Two.", 0).
		event(6, addUpdate(nil)).
		done(7, "r2").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
	d := build(t, home, "R")
	if len(d.Turns) != 2 || len(d.Turns[0].FilesTouched) != 2 || len(d.Turns[1].FilesTouched) != 0 {
		t.Errorf("files per turn: %v / %v", d.Turns[0].FilesTouched, d.Turns[1].FilesTouched)
	}
}

// A repeated record counts once, within each form. The two forms have different ids (a
// FileChange item id is a UUID, a patch_apply_end call_id is the tool call's), so a rollout
// with one of each for the same patch is not told apart: both count.
func TestPatchApplyEndRepeatedAndMixedForms(t *testing.T) {
	fc := map[string]any{"type": "item_completed", "item": map[string]any{"type": "FileChange", "id": "u-1", "status": "completed", "changes": map[string]any{
		"/w/x.go": map[string]any{"type": "add", "content": "x\n"}}}}
	home := t.TempDir()
	newRollout(t).meta("R", "R", "cli", nil).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).
		user(2, "Edit.", 0).
		event(3, addUpdate(nil)).
		event(4, addUpdate(nil)). // the same call again
		event(5, fc).
		event(6, fc). // the same item again
		done(7, "r1").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
	d := build(t, home, "R")
	// 5 + 1 lines from the patch, 1 from the item.
	if d.Stats.LinesAdded != 6 || d.Stats.LinesRemoved != 1 {
		t.Errorf("lines +%d -%d, want +6 -1", d.Stats.LinesAdded, d.Stats.LinesRemoved)
	}
}
