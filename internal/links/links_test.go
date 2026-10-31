package links

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

func TestDirs(t *testing.T) {
	d := &model.SessionDigest{
		Project: "/w/acme", Cwd: "/w/acme/sub", Cwds: []string{"/w/acme", "/w/acme/sub", "relative"},
		Beads: []model.BeadEvent{{Cwd: "/w/other"}, {}},
		Turns: []model.Turn{{FilesTouched: []string{"/w/acme/src/a.go", "/w/acme/src/b.go", "c.go"}}},
	}
	want := []string{"/w/acme", "/w/acme/src", "/w/acme/sub", "/w/other"}
	if got := Dirs(d); !slices.Equal(got, want) {
		t.Errorf("Dirs = %q, want %q", got, want)
	}
}

func TestRefresh(t *testing.T) {
	home := t.TempDir()
	repo, _ := filepath.EvalSymlinks(t.TempDir())
	for path, content := range map[string]string{
		filepath.Join(repo, ".git", "HEAD"):            "ref: refs/heads/main\n",
		filepath.Join(repo, ".beads", "metadata.json"): `{"project_id":"p-x"}`,
		filepath.Join(repo, ".beads", "issues.jsonl"):  `{"id":"x-a1","title":"A"}` + "\n",
	} {
		os.MkdirAll(filepath.Dir(path), 0o755)
		os.WriteFile(path, []byte(content), 0o644)
	}
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	x := Open(home)
	res, err := x.Refresh([]string{repo, filepath.Join(repo, "gone")}, now)
	if err != nil || res != (Result{Resolved: 1, Databases: 1}) {
		t.Fatalf("first refresh = %+v, %v", res, err)
	}
	// Nothing changed: nothing resolved or written; a deleted database keeps its snapshot.
	os.RemoveAll(filepath.Join(repo, ".beads"))
	res, err = Open(home).Refresh(nil, now.Add(time.Minute))
	if err != nil || res != (Result{}) {
		t.Errorf("second refresh = %+v, %v", res, err)
	}
	if all := Open(home).Beads.All(); len(all) != 1 || all[0].Issues[0].ID != "x-a1" {
		t.Errorf("snapshots = %+v", all)
	}
}
