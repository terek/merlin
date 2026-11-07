package repos

import (
	"maps"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)

func tmpRoot(t *testing.T) (string, func(...string) string) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root, func(p ...string) string { return filepath.Join(append([]string{root}, p...)...) }
}

func mkClone(t *testing.T, dir, url string) {
	write(t, filepath.Join(dir, ".git", "HEAD"), head)
	write(t, filepath.Join(dir, ".git", "config"), origin(url))
}

// record puts real entries in the cache as an earlier run would have left them.
func record(c *Cache, e map[string]Repo) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, r := range e {
		c.paths[k] = r
	}
}

func goneWT(checkout, common, remote string) Repo {
	return Repo{Checkout: checkout, GitCommonDir: common, Worktree: true, Remote: remote, Gone: true}
}

func get(t *testing.T, c *Cache, d string) Repo {
	t.Helper()
	r, _ := c.Lookup(d)
	return r
}

func TestInferLiveClone(t *testing.T) {
	_, j := tmpRoot(t)
	mkClone(t, j("clone"), "https://h.example/a/app.git")
	write(t, j("clone/.beads/metadata.json"), `{}`)
	c := Open(t.TempDir())
	d := j("clone/old/sub")
	if n := c.Refresh([]string{d}, 0, t0); n != 2 {
		t.Errorf("changed = %d, want 2 (the directory and the clone)", n)
	}
	want := Repo{Checkout: j("clone"), GitCommonDir: j("clone/.git"), Remote: "h.example/a/app", Gone: true, Inferred: true}
	if got := get(t, c, d); got != want {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
	if got := get(t, c, j("clone")); got.Gone || got.Inferred || got.Checkout != j("clone") || got.Beads != j("clone/.beads") {
		t.Errorf("the clone's own entry = %+v", got)
	}
}

func TestInferRecordedWorktreePrefix(t *testing.T) {
	_, j := tmpRoot(t)
	mkdir(t, j("wts"))
	c := Open(t.TempDir())
	feat := goneWT(j("wts/feat"), j("m/.git"), "h.example/a/app")
	record(c, map[string]Repo{
		j("wts/feat"): feat,
		// a plain repository under the same folder turns the sibling rule off
		j("wts/plain"): {Checkout: j("wts/plain"), GitCommonDir: j("wts/plain/.git"), Gone: true},
	})
	d := j("wts/feat/src/deep")
	c.Refresh([]string{d}, 0, t0)
	want := Repo{Checkout: feat.Checkout, GitCommonDir: feat.GitCommonDir, Worktree: true, Remote: feat.Remote, Gone: true, Inferred: true}
	if got := get(t, c, d); got != want {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

func TestInferSiblings(t *testing.T) {
	_, j := tmpRoot(t)
	mkdir(t, j("p"))
	c := Open(t.TempDir())
	record(c, map[string]Repo{
		j("p/b"): goneWT(j("p/b"), j("m/.git"), "h.example/z"),
		j("p/a"): goneWT(j("p/a"), j("m/.git"), ""),
		// an entry with no checkout is neither for nor against
		j("p"): {GitCommonDir: j("m/.git")},
	})
	d := j("p/gone/deep")
	c.Refresh([]string{d}, 0, t0)
	want := Repo{Checkout: j("p/gone"), GitCommonDir: j("m/.git"), Worktree: true, Remote: "h.example/z", Gone: true, Inferred: true}
	if got := get(t, c, d); got != want {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

func TestSiblingRuleOff(t *testing.T) {
	_, j := tmpRoot(t)
	cases := map[string]map[string]Repo{
		"plain repository beside": {
			j("p/a"):     goneWT(j("p/a"), j("m/.git"), "r"),
			j("p/plain"): {Checkout: j("p/plain"), GitCommonDir: j("p/plain/.git"), Gone: true},
		},
		"two repositories": {
			j("p/a"): goneWT(j("p/a"), j("m/.git"), "r"),
			j("p/b"): goneWT(j("p/b"), j("n/.git"), "r"),
		},
		"not directly under": {
			j("p/q/a"): goneWT(j("p/q/a"), j("m/.git"), "r"),
		},
		"segment prefix": {
			j("app"): {Checkout: j("app"), GitCommonDir: j("app/.git"), Gone: true},
		},
	}
	for name, e := range cases {
		mkdir(t, j("p"))
		c := Open(t.TempDir())
		record(c, e)
		before := len(c.All())
		d := j("p/gone/deep")
		if name == "segment prefix" {
			d = j("app-wt/x")
		}
		if n := c.Refresh([]string{d}, 0, t0); n != 0 || len(c.All()) != before {
			t.Errorf("%s: changed %d, entries %d -> %d; %+v", name, n, before, len(c.All()), get(t, c, d))
		}
	}
}

func TestInferBareRoot(t *testing.T) {
	_, j := tmpRoot(t)
	write(t, j("bw/.bare/HEAD"), head)
	mkdir(t, j("bw/.bare/objects"))
	mkdir(t, j("bw/.bare/refs"))
	write(t, j("bw/.bare/config"), "[core]\n\tbare = true\n"+"[remote \"origin\"]\n\turl = https://h.example/a/app\n")
	write(t, j("bw/.git"), "gitdir: ./.bare\n")

	c := Open(t.TempDir())
	d := j("bw/new/x")
	if n := c.Refresh([]string{d}, 0, t0); n != 1 {
		t.Errorf("changed = %d, want 1: no checkout to record", n)
	}
	want := Repo{GitCommonDir: j("bw/.bare"), Remote: "h.example/a/app", Gone: true, Inferred: true}
	if got := get(t, c, d); got != want || len(c.All()) != 1 {
		t.Errorf("no sibling: %+v, %d entries", got, len(c.All()))
	}

	// With a worktree recorded, the sibling checkout is inferred.
	record(c, map[string]Repo{j("bw/main"): goneWT(j("bw/main"), j("bw/.bare"), "h.example/a/app")})
	c.Refresh([]string{d}, 0, t0.Add(time.Hour))
	want = Repo{Checkout: j("bw/new"), GitCommonDir: j("bw/.bare"), Worktree: true, Remote: "h.example/a/app", Gone: true, Inferred: true}
	if got := get(t, c, d); got != want {
		t.Errorf("with sibling: %+v", got)
	}

	// A plain repository beside the worktree turns it off; a recorded checkout above wins
	// over the bare root's repository-only answer.
	record(c, map[string]Repo{j("bw/vend"): {Checkout: j("bw/vend"), GitCommonDir: j("bw/vend/.git"), Gone: true}})
	d2 := j("bw/main/src/z")
	c.Refresh([]string{d, d2}, 0, t0.Add(2*time.Hour))
	if got := get(t, c, d2); got.Checkout != j("bw/main") || !got.Worktree || !got.Inferred {
		t.Errorf("prefix checkout: %+v", got)
	}
	if got := get(t, c, d); got.Checkout != "" || got.GitCommonDir != j("bw/.bare") {
		t.Errorf("repository only: %+v", got)
	}
}

func TestInferNothing(t *testing.T) {
	_, j := tmpRoot(t)
	mkdir(t, j("nogit"))
	c := Open(t.TempDir())
	if n := c.Refresh([]string{j("nogit/x/y")}, 0, t0); n != 0 || len(c.All()) != 0 {
		t.Errorf("changed %d, entries %v", n, c.All())
	}
}

func TestRealAnswersAreKept(t *testing.T) {
	_, j := tmpRoot(t)
	mkdir(t, j("sc/x"))
	c := Open(t.TempDir())
	// seen alive outside any repository
	c.Refresh([]string{j("sc/x")}, 0, t0)
	if _, ok := c.Lookup(j("sc/x")); !ok {
		t.Fatal("alive directory not recorded")
	}
	// previously resolved, gone
	feat := goneWT(j("sc/old"), j("m/.git"), "r")
	record(c, map[string]Repo{j("sc/old"): feat, j("sc/old2"): goneWT(j("sc/old2"), j("m/.git"), "r")})
	record(c, map[string]Repo{j("sc/old/sub"): {Checkout: j("sc/other"), GitCommonDir: j("o/.git"), Gone: true}})
	if err := os.RemoveAll(j("sc/x")); err != nil {
		t.Fatal(err)
	}
	c.Refresh([]string{j("sc/x"), j("sc/old/sub")}, 0, t0.Add(time.Hour))
	if got := get(t, c, j("sc/x")); got != (Repo{Gone: true}) {
		t.Errorf("empty answer: %+v", got)
	}
	if got := get(t, c, j("sc/old/sub")); got.Inferred || got.Checkout != j("sc/other") {
		t.Errorf("resolved gone entry: %+v", got)
	}
}

// siblingFixture: two live worktrees of one clone under p/, a gone directory p/c/deep.
func siblingFixture(t *testing.T) (dirs []string, j func(...string) string) {
	_, j = tmpRoot(t)
	mkClone(t, j("main"), "https://h.example/a/app.git")
	for _, n := range []string{"a", "b"} {
		write(t, j("main/.git/worktrees", n, "commondir"), "../..\n")
		write(t, j("p", n, ".git"), "gitdir: "+j("main/.git/worktrees", n)+"\n")
	}
	return []string{j("p/c/deep"), j("p/a"), j("p/b"), j("p/c/other")}, j
}

func TestOrderIndependentAndIdempotent(t *testing.T) {
	dirs, j := siblingFixture(t)
	var results []map[string]Repo
	for _, order := range [][]int{{0, 1, 2, 3}, {3, 2, 1, 0}, {1, 3, 0, 2}} {
		home := t.TempDir()
		c := Open(home)
		var ds []string
		for _, i := range order {
			ds = append(ds, dirs[i])
		}
		c.Refresh(ds, 0, t0)
		results = append(results, c.All())
		if err := c.Save(); err != nil {
			t.Fatal(err)
		}
		first, _ := os.ReadFile(filepath.Join(home, FileName))
		if n := c.Refresh(ds, 0, t0.Add(time.Hour)); n != 0 {
			t.Errorf("order %v: second refresh changed %d", order, n)
		}
		if err := c.Save(); err != nil {
			t.Fatal(err)
		}
		if second, _ := os.ReadFile(filepath.Join(home, FileName)); string(second) != string(first) {
			t.Errorf("order %v: file changed", order)
		}
		// and a new process reading the file agrees
		if n := Open(home).Refresh(ds, 0, t0.Add(2*time.Hour)); n != 0 {
			t.Errorf("order %v: reopened refresh changed %d", order, n)
		}
	}
	for _, r := range results[1:] {
		if !maps.Equal(r, results[0]) {
			t.Errorf("results depend on order:\n%+v\n%+v", results[0], r)
		}
	}
	got := results[0][dirs[0]]
	if got.Checkout != j("p/c") || !got.Worktree || !got.Gone || !got.Inferred || got.Beads != "" || got.GitCommonDir != j("main/.git") {
		t.Errorf("inferred = %+v", got)
	}
}

func TestInferredIsNotEvidenceAndIsReworked(t *testing.T) {
	_, j := tmpRoot(t)
	mkdir(t, j("p"))
	c := Open(t.TempDir())
	a := goneWT(j("p/a"), j("m/.git"), "r")
	record(c, map[string]Repo{j("p/a"): a})
	d1, d2 := j("p/c/deep"), j("p/d/deep")
	c.Refresh([]string{d1, d2}, 0, t0)
	if !get(t, c, d1).Inferred || !get(t, c, d2).Inferred {
		t.Fatalf("not inferred: %+v %+v", get(t, c, d1), get(t, c, d2))
	}
	// The evidence goes: both inferred entries go with it, even though each one's neighbour
	// is an inferred p/<n> that must not count.
	c.mu.Lock()
	delete(c.paths, j("p/a"))
	c.mu.Unlock()
	if n := c.Refresh([]string{d1, d2}, 0, t0.Add(time.Hour)); n != 2 {
		t.Errorf("changed %d, want 2", n)
	}
	if _, ok := c.Lookup(d1); ok {
		t.Errorf("stale inferred entry: %+v", get(t, c, d1))
	}
	if _, ok := c.Lookup(d2); ok {
		t.Errorf("stale inferred entry: %+v", get(t, c, d2))
	}
}

func TestInferredBetterAnswerAndRevival(t *testing.T) {
	_, j := tmpRoot(t)
	mkClone(t, j("p"), "https://h.example/a/p")
	c := Open(t.TempDir())
	d := j("p/q/deep")
	c.Refresh([]string{d}, 0, t0)
	if got := get(t, c, d); got.Checkout != j("p") || !got.Inferred {
		t.Fatalf("first answer %+v", got)
	}
	// A deeper recorded checkout is a better answer.
	record(c, map[string]Repo{j("p/q"): {Checkout: j("p/q"), GitCommonDir: j("p/q/.git"), Gone: true}})
	if n := c.Refresh([]string{d}, 0, t0.Add(time.Hour)); n != 1 {
		t.Errorf("changed %d", n)
	}
	if got := get(t, c, d); got.Checkout != j("p/q") || !got.Inferred {
		t.Errorf("better answer %+v", got)
	}
	// The directory comes back as a repository of its own: the real answer, no marks.
	mkClone(t, j("p/q/deep"), "https://h.example/a/deep")
	c.Refresh([]string{d}, 0, t0.Add(2*time.Hour))
	if got := get(t, c, d); got.Gone || got.Inferred || got.Checkout != d {
		t.Errorf("revived %+v", got)
	}
}

func TestInferThroughSymlinkedRoute(t *testing.T) {
	_, j := tmpRoot(t)
	mkdir(t, j("real"))
	if err := os.Symlink(j("real"), j("link")); err != nil {
		t.Fatal(err)
	}
	c := Open(t.TempDir())
	record(c, map[string]Repo{j("real/a"): goneWT(j("real/a"), j("m/.git"), "r")})
	d := j("link/c/x")
	c.Refresh([]string{d}, 0, t0)
	got, ok := c.Lookup(d)
	if !ok || got.Checkout != j("real/c") || got.GitCommonDir != j("m/.git") {
		t.Errorf("through a symlink: %+v, %v", got, ok)
	}
}

// A checkout recorded only because a gone directory was inferred from it is rechecked.
func TestRecordedLiveCheckoutGoesGone(t *testing.T) {
	_, j := tmpRoot(t)
	mkClone(t, j("clone"), "https://h.example/a/app.git")
	c := Open(t.TempDir())
	d := j("clone/old/sub")
	c.Refresh([]string{d}, 0, t0)
	if got := get(t, c, j("clone")); got.Gone || got.Checkout != j("clone") {
		t.Fatalf("clone entry = %+v", got)
	}
	if err := os.RemoveAll(j("clone")); err != nil {
		t.Fatal(err)
	}
	if n := c.Refresh([]string{d}, 0, t0.Add(time.Hour)); n != 1 {
		t.Errorf("changed %d, want 1 (the clone goes gone)", n)
	}
	if got := get(t, c, j("clone")); !got.Gone || got.Inferred || got.Checkout != j("clone") {
		t.Errorf("clone entry = %+v", got)
	}
	if got := get(t, c, d); got.Checkout != j("clone") || !got.Inferred || got.GitCommonDir != j("clone/.git") {
		t.Errorf("subdirectory = %+v", got)
	}
	if n := c.Refresh([]string{d}, 0, t0.Add(2*time.Hour)); n != 0 {
		t.Errorf("further refresh changed %d", n)
	}
}
