package daemon_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/beads"
	"github.com/terek/merlin/explorer/internal/daemon"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/repos"
	"github.com/terek/merlin/explorer/internal/store"
)

// A session that worked in a repository with a beads database leads to repos.json and a
// registry snapshot after a rescan.
func TestRescanRefreshesLinks(t *testing.T) {
	home := t.TempDir()
	repo, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		filepath.Join(repo, ".git", "config"):          "[remote \"origin\"]\n\turl = git@example.com:dev/acme.git\n",
		filepath.Join(repo, ".beads", "metadata.json"): `{"project_id":"p-links"}`,
		filepath.Join(repo, ".beads", "issues.jsonl"):  `{"_type":"issue","id":"acme-a1","title":"A","status":"open"}` + "\n",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	st, err := store.New(home)
	if err != nil {
		t.Fatal(err)
	}
	// A digest whose transcript is gone still counts: digests outlive transcripts.
	if err := st.Write(&model.SessionDigest{SchemaVersion: model.SchemaVersion, Harness: "claude", ID: "links-1",
		ProjectKey: "-acme", Project: repo}); err != nil {
		t.Fatal(err)
	}

	r := newRig(t, home, "", func(o *daemon.Options) { o.RescanInterval = 20 * time.Millisecond })
	r.start()
	eventually(t, "repos.json and the bead snapshot", func() bool {
		_, err1 := os.Stat(filepath.Join(home, repos.FileName))
		_, err2 := os.Stat(filepath.Join(home, beads.RegistryDir, "p-links.json"))
		return err1 == nil && err2 == nil
	})
	if rp, ok := repos.Open(home).Lookup(repo); !ok || rp.Remote != "git@example.com:dev/acme.git" || rp.Beads != filepath.Join(repo, ".beads") {
		t.Errorf("repo = %+v, %v", rp, ok)
	}
	if db, ok := beads.OpenRegistry(home).ForDir(filepath.Join(repo, ".beads")); !ok || len(db.Issues) != 1 {
		t.Errorf("snapshot = %+v, %v", db, ok)
	}
}
