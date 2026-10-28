package repos

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

// layout builds, under a temp dir:
//
//	acme/            a repository with origin, a beads database, a subdirectory
//	acme-wt/feat/    a linked worktree of acme, with a checked-out copy of .beads
//	acme/vendor/lib/ a submodule
//	plain/sub/       no repository, a beads database in plain/
//	other/           a repository whose .beads redirects to acme's
func layout(t *testing.T) string {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	acme := filepath.Join(root, "acme")
	write(t, filepath.Join(acme, ".git", "config"), "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@example.com:dev/acme.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n")
	write(t, filepath.Join(acme, ".beads", "metadata.json"), `{"project_id":"p-acme"}`)
	mkdir(t, filepath.Join(acme, "src", "deep"))

	wt := filepath.Join(root, "acme-wt", "feat")
	gd := filepath.Join(acme, ".git", "worktrees", "feat")
	write(t, filepath.Join(gd, "commondir"), "../..\n")
	write(t, filepath.Join(wt, ".git"), "gitdir: "+gd+"\n")
	write(t, filepath.Join(wt, ".beads", "metadata.json"), `{"project_id":"p-acme"}`)

	sub := filepath.Join(acme, "vendor", "lib")
	write(t, filepath.Join(acme, ".git", "modules", "lib", "config"), "[remote \"origin\"]\n\turl = https://example.com/lib.git\n")
	write(t, filepath.Join(sub, ".git"), "gitdir: ../../.git/modules/lib\n")

	write(t, filepath.Join(root, "plain", ".beads", "metadata.json"), `{}`)
	mkdir(t, filepath.Join(root, "plain", "sub"))

	write(t, filepath.Join(root, "other", ".git", "config"), "")
	write(t, filepath.Join(root, "other", ".beads", "redirect"), "../acme/.beads\n")
	return root
}

func TestResolve(t *testing.T) {
	root := layout(t)
	j := func(p ...string) string { return filepath.Join(append([]string{root}, p...)...) }
	acme := Repo{Top: j("acme"), Repo: j("acme"), Remote: "git@example.com:dev/acme.git", Beads: j("acme", ".beads")}
	tests := map[string]Repo{
		j("acme"):                  acme,
		j("acme", "src", "deep"):   acme,
		j("acme-wt", "feat"):       {Top: j("acme-wt", "feat"), Repo: j("acme"), Worktree: true, Remote: "git@example.com:dev/acme.git", Beads: j("acme", ".beads")},
		j("acme", "vendor", "lib"): {Top: j("acme", "vendor", "lib"), Repo: j("acme", "vendor", "lib"), Remote: "https://example.com/lib.git", Beads: j("acme", ".beads")},
		j("plain", "sub"):          {Beads: j("plain", ".beads")},
		j("other"):                 {Top: j("other"), Repo: j("other"), Beads: j("acme", ".beads")},
	}
	for dir, want := range tests {
		got, ok := Resolve(dir)
		if !ok || got != want {
			t.Errorf("Resolve(%s) = %+v, %v\nwant %+v", dir, got, ok, want)
		}
	}
	if _, ok := Resolve(j("missing")); ok {
		t.Error("a missing directory resolved")
	}
}

func TestCache(t *testing.T) {
	root := layout(t)
	home := t.TempDir()
	wt := filepath.Join(root, "acme-wt", "feat")
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

	c := Open(home)
	if n := c.Refresh([]string{wt, wt, filepath.Join(root, "missing"), "relative/dir", ""}, time.Hour, now); n != 1 {
		t.Fatalf("first refresh changed %d entries, want 1", n)
	}
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	// Within maxAge nothing is looked at again, even after the worktree is removed.
	if err := os.RemoveAll(wt); err != nil {
		t.Fatal(err)
	}
	if n := c.Refresh([]string{wt}, time.Hour, now.Add(time.Minute)); n != 0 {
		t.Errorf("refresh within maxAge changed %d", n)
	}
	// A new process (fresh cache from disk) sees it gone and keeps the last answer.
	c2 := Open(home)
	if n := c2.Refresh([]string{wt}, time.Hour, now.Add(2*time.Hour)); n != 1 {
		t.Errorf("refresh after removal changed %d, want 1", n)
	}
	r, ok := c2.Lookup(wt)
	if !ok || !r.Gone || r.Repo != filepath.Join(root, "acme") || !r.Worktree {
		t.Errorf("removed worktree = %+v, %v", r, ok)
	}
	if err := c2.Save(); err != nil {
		t.Fatal(err)
	}
	if r, _ := Open(home).Lookup(wt); !r.Gone {
		t.Errorf("gone mark not saved: %+v", r)
	}
	if len(Open(home).All()) != 1 {
		t.Errorf("entries = %v", Open(home).All())
	}
}
