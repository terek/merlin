package beads

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func chg(id, at, status, reason string) string {
	r := ""
	if reason != "" {
		r = `,"reason":"` + reason + `"`
	}
	return `{"id":"int-1","kind":"field_change","created_at":"` + at + `","actor":"A B","issue_id":"` + id +
		`","extra":{"field":"status","new_value":"` + status + `","old_value":"open"` + r + `}}` + "\n"
}

func appendFile(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

func TestInteractionsWithoutExport(t *testing.T) {
	home, bd := t.TempDir(), filepath.Join(t.TempDir(), ".beads")
	writeFile(t, filepath.Join(bd, "metadata.json"), `{"project_id":"p-int"}`)
	ip := filepath.Join(bd, "interactions.jsonl")
	writeFile(t, ip, chg("acme-b", "2026-07-27T10:00:00Z", "in_progress", "")+
		chg("acme-a", "2026-07-27T11:00:00Z", "closed", "done well")+
		chg("acme-a", "2026-07-27T09:00:00Z", "open", "early")+
		chg("acme-b", "2026-07-27T12:00:00Z", "closed", "")+
		`{"id":"int-2","kind":"comment","created_at":"2026-07-27T12:00:00Z","issue_id":"acme-a","extra":{}}`+"\n"+
		"garbage\n")

	r := OpenRegistry(home)
	if changed, err := r.Refresh(bd); err != nil || !changed {
		t.Fatalf("refresh: %v %v", changed, err)
	}
	db, _ := r.ForDir(bd)
	want := []Status{
		{ID: "acme-a", Status: "closed", At: time.Date(2026, 7, 27, 11, 0, 0, 0, time.UTC), Reason: "done well"},
		{ID: "acme-b", Status: "closed", At: time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)},
	}
	if len(db.Statuses) != 2 || db.Statuses[0] != want[0] || db.Statuses[1] != want[1] {
		t.Fatalf("statuses = %+v", db.Statuses)
	}
	if db.BadLines != 1 || db.InteractionsBadLines != 1 || len(db.Issues) != 0 {
		t.Errorf("bad/issues = %d %d %d", db.BadLines, db.InteractionsBadLines, len(db.Issues))
	}
	if _, err := os.Stat(filepath.Join(home, "beads", "p-int.json")); err != nil {
		t.Fatal(err)
	}
	r2 := OpenRegistry(home)
	db2, ok := r2.ForDir(bd)
	if !ok || len(db2.Statuses) != 2 || db2.Statuses[0] != want[0] || db2.BadLines != 1 {
		t.Fatalf("reloaded = %+v", db2)
	}
	if changed, err := r2.Refresh(bd); err != nil || changed {
		t.Errorf("unchanged refresh: %v %v", changed, err)
	}

	appendFile(t, ip, chg("acme-b", "2026-07-28T10:00:00Z", "open", "reopened"))
	if changed, err := r2.Refresh(bd); err != nil || !changed {
		t.Fatalf("refresh after append: %v %v", changed, err)
	}
	db, _ = r2.ForDir(bd)
	if db.Statuses[1].Status != "open" || db.Statuses[1].Reason != "reopened" || db.Statuses[0] != want[0] || db.BadLines != 1 {
		t.Errorf("after append = %+v bad %d", db.Statuses, db.BadLines)
	}
}

func TestInteractionsWithExportAndLongLine(t *testing.T) {
	home, bd := t.TempDir(), filepath.Join(t.TempDir(), ".beads")
	writeFile(t, filepath.Join(bd, "metadata.json"), `{"project_id":"p-both"}`)
	writeFile(t, filepath.Join(bd, "issues.jsonl"), exportV1)
	long := strings.Repeat("x", 1<<20+100)
	writeFile(t, filepath.Join(bd, "interactions.jsonl"), chg("acme-z9", "2026-07-27T10:00:00Z", "closed", long)+"bad\nbad2\n")

	r := OpenRegistry(home)
	if _, err := r.Refresh(bd); err != nil {
		t.Fatal(err)
	}
	db, _ := r.ForDir(bd)
	if len(db.Issues) != 3 || len(db.Statuses) != 1 || db.Statuses[0].Reason != long {
		t.Fatalf("issues %d statuses %d", len(db.Issues), len(db.Statuses))
	}
	if db.BadLines != 4 || db.InteractionsBadLines != 2 || len(db.Sources) != 2 {
		t.Errorf("bad %d/%d sources %d", db.BadLines, db.InteractionsBadLines, len(db.Sources))
	}
	// Only the interactions change: the sum stays right.
	appendFile(t, filepath.Join(bd, "interactions.jsonl"), "bad3\n")
	if _, err := r.Refresh(bd); err != nil {
		t.Fatal(err)
	}
	db, _ = r.ForDir(bd)
	if db.BadLines != 5 || len(db.Issues) != 3 {
		t.Errorf("bad = %d", db.BadLines)
	}
	// Only the export changes: the interactions' share stays in the sum.
	appendFile(t, filepath.Join(bd, "issues.jsonl"), "bad4\n")
	if _, err := r.Refresh(bd); err != nil {
		t.Fatal(err)
	}
	db, _ = r.ForDir(bd)
	if db.BadLines != 6 || db.InteractionsBadLines != 3 {
		t.Errorf("after export change: bad %d/%d, want 6/3", db.BadLines, db.InteractionsBadLines)
	}
}

func TestMergeStatusesKeepsLater(t *testing.T) {
	t0 := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	old := []Status{{ID: "acme-a", Status: "closed", At: t0.Add(time.Hour)}, {ID: "acme-b", Status: "open", At: t0}}
	cur := []Status{{ID: "acme-a", Status: "open", At: t0}, {ID: "acme-b", Status: "in_progress", At: t0.Add(time.Minute)}}
	got := mergeStatuses(old, cur)
	if len(got) != 2 || got[0].Status != "closed" || got[1].Status != "in_progress" {
		t.Errorf("merge = %+v", got)
	}
}
