package codex

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/terek/merlin/internal/model"
)

func TestWorkDirs(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "cli", nil).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).
		user(2, "Work.", 0).
		usage(3, "resp-1", "r1", 100, 0, 10).
		event(4, map[string]any{"type": "item_completed", "item": map[string]any{"type": "FileChange", "status": "completed", "changes": map[string]any{
			"/home/dev/acme/src/a.go": map[string]any{"type": "add", "content": "package a\n"},
			"/home/dev/acme/src/b.go": map[string]any{"type": "update", "unified_diff": "@@ -1 +1 @@\n-x\n+y\n",
				"move_path": "/home/dev/acme/pkg/b.go"},
			"relative/c.go": map[string]any{"type": "add", "content": "x\n"},
		}}}).
		event(5, map[string]any{"type": "item_completed", "item": map[string]any{"type": "FileChange", "status": "failed", "changes": map[string]any{
			"/home/dev/acme/src/d.go": map[string]any{"type": "add", "content": "x\n"},
		}}}).
		exec(6, "e1", []string{"/bin/zsh", "-lc", "go test ./..."}, "ok\n", 0).
		exec(7, "e2", []string{"/bin/zsh", "-lc", "cd /home/dev/acme-w/ && make"}, "", 1).
		exec(8, "e3", []string{"/bin/zsh", "-lc", "cd $DIR && ls"}, "", 0).
		exec(9, "e4", []string{"/bin/zsh", "-lc", "cd sub && ls"}, "", 0).
		done(10, "r1").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")

	d := build(t, home, "R")
	want := []model.WorkDir{
		{Dir: "/home/dev/acme", Commands: 1}, // go test (the file:// cwd is a plain path)
		{Dir: "/home/dev/acme-w", Commands: 1},
		{Dir: "/home/dev/acme/pkg", Edits: 1},
		{Dir: "/home/dev/acme/src", Edits: 3},
		{Dir: "/home/dev/acme/sub", Commands: 1},
	}
	if len(d.Turns) != 1 || !reflect.DeepEqual(d.Turns[0].WorkDirs, want) {
		t.Errorf("workDirs\n got %+v\nwant %+v", d.Turns[0].WorkDirs, want)
	}

	enc := func() string {
		b, err := json.Marshal(build(t, home, "R"))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	first := enc()
	for range 4 {
		if enc() != first {
			t.Fatal("rebuilding gave different bytes")
		}
	}
}
