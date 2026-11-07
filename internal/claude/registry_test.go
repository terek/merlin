package claude_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/terek/merlin/internal/claude"
	"github.com/terek/merlin/internal/fixtures"
	"github.com/terek/merlin/internal/model"
)

func TestReadRegistry(t *testing.T) {
	reg, err := claude.ReadRegistry(fixtures.ClaudeDir(), func(pid int) bool { return pid == 4242 })
	if err != nil {
		t.Fatal(err)
	}
	key := model.SessionKey{Harness: "claude", ID: "01010101-0000-4000-8000-000000000001"}
	if len(reg) != 1 || reg[key].Status != "busy" || reg[key].PID != 4242 {
		t.Fatalf("registry = %+v", reg)
	}
	if reg, _ = claude.ReadRegistry(fixtures.ClaudeDir(), func(int) bool { return true }); len(reg) != 2 {
		t.Errorf("both alive: %+v", reg)
	}
	if r, err := claude.ReadRegistry(filepath.Join(t.TempDir(), "none"), nil); err != nil || len(r) != 0 {
		t.Errorf("missing dir: %v %v", r, err)
	}
	// a dead pid, a malformed file and an unrelated file are skipped
	cfg := t.TempDir()
	dir := filepath.Join(cfg, "sessions")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "1.json"), []byte(`{"pid":1,"sessionId":"x","status":"idle"}`), 0o644)
	os.WriteFile(filepath.Join(dir, "2.json"), []byte(`not json`), 0o644)
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte(`{}`), 0o644)
	if r, _ := claude.ReadRegistry(cfg, func(int) bool { return false }); len(r) != 0 {
		t.Errorf("dead pid kept: %v", r)
	}
}
