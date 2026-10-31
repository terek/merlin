package beads

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

const exportV1 = `{"_type":"issue","id":"acme-e1","title":"Epic","status":"open","priority":1,"issue_type":"epic","created_at":"2026-10-01T10:00:00Z"}
{"_type":"issue","id":"acme-e1.1","title":"Widget","status":"closed","priority":2,"issue_type":"task","assignee":"Dev","labels":["ui"],"created_at":"2026-10-01T10:01:00Z","started_at":"2026-10-01T10:02:00Z","closed_at":"2026-10-01T11:00:00Z","close_reason":"Built","description":"long text that is not kept","dependencies":[{"issue_id":"acme-e1.1","depends_on_id":"acme-e1","type":"parent-child"},{"issue_id":"acme-e1.1","depends_on_id":"acme-z9","type":"blocks"}]}
not json
{"_type":"memory","id":"acme-m1"}
{"_type":"issue","id":"acme-z9","title":"Other","status":"open"}
`

func TestRegistry(t *testing.T) {
	home := t.TempDir()
	repo := t.TempDir()
	bd := filepath.Join(repo, ".beads")
	writeFile(t, filepath.Join(bd, "metadata.json"), `{"project_id":"p-acme","dolt_database":"acme"}`)
	writeFile(t, filepath.Join(bd, "issues.jsonl"), exportV1)

	r := OpenRegistry(home)
	if changed, err := r.Refresh(bd); err != nil || !changed {
		t.Fatalf("first refresh: %v %v", changed, err)
	}
	db, ok := r.ForDir(bd)
	if !ok || db.Key != "p-acme" || db.Database != "acme" || db.BadLines != 2 || len(db.Issues) != 3 ||
		strings.Join(db.Prefixes, ",") != "acme" {
		t.Fatalf("snapshot = %+v", db)
	}
	w := db.Issues[1]
	if w.ID != "acme-e1.1" || w.Parent != "acme-e1" || len(w.Deps) != 1 || w.Deps[0] != (Dep{ID: "acme-z9", Type: "blocks"}) ||
		w.Status != "closed" || w.CloseReason != "Built" || *w.Priority != 2 || w.Labels[0] != "ui" ||
		!w.ClosedAt.Equal(time.Date(2026, 10, 1, 11, 0, 0, 0, time.UTC)) {
		t.Errorf("issue = %+v", w)
	}

	// Unchanged export: not read again, even by a new process.
	if changed, err := OpenRegistry(home).Refresh(bd); err != nil || changed {
		t.Errorf("unchanged refresh: %v %v", changed, err)
	}

	// A newer export without acme-z9: it is kept, marked gone.
	writeFile(t, filepath.Join(bd, "issues.jsonl"), strings.Replace(exportV1, `{"_type":"issue","id":"acme-z9","title":"Other","status":"open"}`+"\n", "", 1)+"\n")
	r2 := OpenRegistry(home)
	if changed, err := r2.Refresh(bd); err != nil || !changed {
		t.Fatalf("refresh after change: %v %v", changed, err)
	}
	db, _ = r2.ForDir(bd)
	if len(db.Issues) != 3 || db.Issues[2].ID != "acme-z9" || !db.Issues[2].Gone || db.Issues[0].Gone {
		t.Errorf("after removal = %+v", db.Issues)
	}
	if all := OpenRegistry(home).All(); len(all) != 1 || all[0].Key != "p-acme" {
		t.Errorf("All = %+v", all)
	}
}

func TestRegistryWithoutProjectIDOrExport(t *testing.T) {
	home := t.TempDir()
	bd := filepath.Join(t.TempDir(), ".beads")
	writeFile(t, filepath.Join(bd, "metadata.json"), `{}`)
	r := OpenRegistry(home)
	if changed, err := r.Refresh(bd); err != nil || !changed {
		t.Fatalf("refresh: %v %v", changed, err)
	}
	db, ok := r.ForDir(bd)
	if !ok || !strings.HasPrefix(db.Key, "path-") || len(db.Issues) != 0 || len(db.Sources) != 0 {
		t.Errorf("snapshot = %+v", db)
	}
	if _, err := r.Refresh(filepath.Join(t.TempDir(), ".beads")); err == nil {
		t.Error("a directory without metadata.json refreshed")
	}
}

func TestPrefixAndRoot(t *testing.T) {
	for id, want := range map[string][2]string{
		"merlin-t8s.48.1": {"merlin", "merlin-t8s"}, "my-app-k2": {"my-app", "my-app-k2"}, "x": {"", "x"},
	} {
		if Prefix(id) != want[0] || Root(id) != want[1] {
			t.Errorf("%s: prefix %q root %q", id, Prefix(id), Root(id))
		}
	}
}
