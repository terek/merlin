package catalog

import (
	"reflect"
	"slices"
	"testing"

	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/repos"
)

const (
	rMain  = "/main/.git"
	rOther = "/other/.git"
	rBare  = "/bare/.bare"
)

// locFixture: /main is a clone with two linked worktrees, /other a second repository, /bare a
// bare repository whose root has no checkout and whose worktree is /bare/w1, /clone1 and /clone2
// two clones of one remote. /scratch is in no repository.
func locFixture() Places {
	main := repos.Repo{Checkout: "/main", GitCommonDir: rMain, Remote: "example.com/main"}
	wt := func(c string) repos.Repo {
		return repos.Repo{Checkout: c, GitCommonDir: rMain, Worktree: true, Remote: "example.com/main"}
	}
	other := repos.Repo{Checkout: "/other", GitCommonDir: rOther, Remote: "example.com/other"}
	bare := repos.Repo{GitCommonDir: rBare, Remote: "example.com/bare"}
	w1 := repos.Repo{Checkout: "/bare/w1", GitCommonDir: rBare, Worktree: true, Remote: "example.com/bare"}
	return Places{Repos: map[string]repos.Repo{
		"/main": main, "/main/sub": main, "/main/.wt/a": wt("/main/.wt/a"), "/main/.wt/b": wt("/main/.wt/b"),
		"/other": other, "/bare": bare, "/bare/plain": bare, "/bare/w1": w1,
		"/clone1": {Checkout: "/clone1", GitCommonDir: "/clone1/.git", Remote: "example.com/two"},
		"/clone2": {Checkout: "/clone2", GitCommonDir: "/clone2/.git", Remote: "example.com/two"},
	}}
}

type loc struct{ repo, checkout, remote string }

func wd(dir string, edits, commands int64) model.WorkDir {
	return model.WorkDir{Dir: dir, Edits: edits, Commands: commands}
}

// locSession is a one-turn session started in start, with the given work on its turn.
func locSession(id, start string, work ...model.WorkDir) *model.SessionDigest {
	d := syn("claude", id, start, 0, 5, []model.Turn{turn(0, "u-"+id, "go", 0)}, msgSpec{id: id + "-m", min: 1, usd: 1})
	d.Turns[0].WorkDirs = work
	return d
}

func primary(t *testing.T, places Places, ds ...*model.SessionDigest) (SessionPlaces, *Catalog) {
	t.Helper()
	c := New()
	for _, d := range ds {
		c.Upsert(d)
	}
	c.SetPlaces(places)
	p, ok := c.Places(ds[0].Key())
	if !ok {
		t.Fatal("no places")
	}
	return p, c
}

func repoOf(p SessionPlaces) string {
	if p.Repo == nil {
		return ""
	}
	return p.Repo.Repo
}

func TestPrimaryLocation(t *testing.T) {
	scratch := wd("/scratch", 100, 100)
	for _, tc := range []struct {
		name string
		d    *model.SessionDigest
		want loc
	}{
		{"starts in main, edits mostly in a worktree",
			locSession("s", "/main", wd("/main", 1, 9), wd("/main/.wt/a", 5, 0)),
			loc{rMain, "/main/.wt/a", "example.com/main"}},
		{"a lead with many commands in main and one edit in a worktree: edits outrank commands",
			locSession("s", "/main", wd("/main", 0, 100), wd("/main/.wt/a", 1, 0)),
			loc{rMain, "/main/.wt/a", "example.com/main"}},
		{"no edits: commands decide",
			locSession("s", "/main", wd("/main", 0, 1), wd("/main/.wt/a", 0, 5)),
			loc{rMain, "/main/.wt/a", "example.com/main"}},
		{"neither: the start directory's values",
			locSession("s", "/main/sub", scratch),
			loc{rMain, "/main", "example.com/main"}},
		{"neither, and the start is in no repository",
			locSession("s", "/scratch", scratch),
			loc{}},
		{"starts at a bare root, then works in a worktree",
			locSession("s", "/bare", wd("/bare", 0, 3), wd("/bare/w1", 2, 0)),
			loc{rBare, "/bare/w1", "example.com/bare"}},
		{"starts at a bare root and does nothing there: checkout none, repo set",
			locSession("s", "/bare", scratch),
			loc{rBare, "", "example.com/bare"}},
		{"edits only in a bare directory with no checkout: that is no candidate",
			locSession("s", "/bare", wd("/bare/plain", 4, 0)),
			loc{rBare, "", "example.com/bare"}},
		{"a bare root with commands in a worktree and edits in none",
			locSession("s", "/bare", wd("/bare/plain", 4, 0), wd("/bare/w1", 0, 1)),
			loc{rBare, "/bare/w1", "example.com/bare"}},
		{"edits in two repositories: the sums of the primary repository win although another repo's one checkout has more edits",
			locSession("s", "/other", wd("/main", 2, 0), wd("/main/.wt/a", 2, 0), wd("/main/.wt/b", 2, 0), wd("/other", 5, 0)),
			loc{rMain, "/main", "example.com/main"}},
		{"the same, and the start is a checkout of the winning repo that ties",
			locSession("s", "/main/.wt/b", wd("/main", 2, 0), wd("/main/.wt/a", 2, 0), wd("/main/.wt/b", 2, 0), wd("/other", 5, 0)),
			loc{rMain, "/main/.wt/b", "example.com/main"}},
		{"directories of one checkout add up",
			locSession("s", "/other", wd("/main", 3, 0), wd("/main/sub", 3, 0), wd("/other", 5, 0)),
			loc{rMain, "/main", "example.com/main"}},
		{"activity in a scratch directory never beats a repository",
			locSession("s", "/main", scratch, wd("/main", 0, 1)),
			loc{rMain, "/main", "example.com/main"}},
		{"activity in a directory Places does not know contributes nothing",
			locSession("s", "/main", wd("/unknown", 50, 50), wd("/main/.wt/b", 1, 0)),
			loc{rMain, "/main/.wt/b", "example.com/main"}},
		{"edits in another repository beat the start's commands",
			locSession("s", "/main", wd("/main", 0, 50), wd("/other", 1, 0)),
			loc{rOther, "/other", "example.com/other"}},
		{"edits only in the other repository, start repo elsewhere with no checkout candidate: no contradiction",
			locSession("s", "/bare", wd("/other", 1, 0)),
			loc{rOther, "/other", "example.com/other"}},
		{"a tie goes to the start directory's checkout",
			locSession("s", "/main/.wt/b", wd("/main", 3, 0), wd("/main/.wt/a", 3, 0), wd("/main/.wt/b", 3, 0)),
			loc{rMain, "/main/.wt/b", "example.com/main"}},
		{"a tie not involving the start goes to the first in sort order",
			locSession("s", "/scratch", wd("/main/.wt/b", 3, 0), wd("/main/.wt/a", 3, 0)),
			loc{rMain, "/main/.wt/a", "example.com/main"}},
		{"a tie between repositories goes to the start's repository",
			locSession("s", "/other", wd("/main", 3, 0), wd("/other", 3, 0)),
			loc{rOther, "/other", "example.com/other"}},
		{"a tie between repositories otherwise goes to the first in sort order",
			locSession("s", "/scratch", wd("/other", 3, 0), wd("/main", 3, 0)),
			loc{rMain, "/main", "example.com/main"}},
		{"a tie in commands goes to the start too",
			locSession("s", "/main/.wt/b", wd("/main/.wt/a", 0, 2), wd("/main/.wt/b", 0, 2)),
			loc{rMain, "/main/.wt/b", "example.com/main"}},
		{"the start is outside the winning repo: its checkout is no answer",
			locSession("s", "/other", wd("/main/.wt/a", 1, 0)),
			loc{rMain, "/main/.wt/a", "example.com/main"}},
		{"old digest: filesTouched count as edits, cwds as commands",
			func() *model.SessionDigest {
				d := locSession("s", "/scratch")
				d.Turns[0].FilesTouched = []string{"/main/.wt/a/x.go", "/main/.wt/a/y.go", "/other/z.go", "relative.go"}
				d.Cwds = []string{"/scratch", "/other", "/other", "/other"}
				return d
			}(), loc{rMain, "/main/.wt/a", "example.com/main"}},
		{"old digest with only cwds",
			func() *model.SessionDigest {
				d := locSession("s", "/scratch")
				d.Cwds = []string{"/other", "/main/.wt/b", "/main/.wt/b"}
				return d
			}(), loc{rMain, "/main/.wt/b", "example.com/main"}},
		{"old digest: bd calls ran in a directory",
			func() *model.SessionDigest {
				d := locSession("s", "/scratch")
				d.Beads = []model.BeadEvent{{Cwd: "/other", Op: model.BeadClaim, Outcome: model.BeadOK}}
				return d
			}(), loc{rOther, "/other", "example.com/other"}},
		{"a digest with workDirs never uses the fallback",
			func() *model.SessionDigest {
				d := locSession("s", "/scratch", scratch)
				d.Turns[0].FilesTouched = []string{"/other/z.go"}
				d.Cwds = []string{"/other"}
				return d
			}(), loc{}},
		{"workDirs on an agent turn alone also switch the fallback off",
			func() *model.SessionDigest {
				d := locSession("s", "/scratch")
				d.Turns[0].FilesTouched = []string{"/other/z.go"}
				d.Agents = []model.Agent{{ID: "ag", Turns: []model.AgentTurn{{WorkDirs: []model.WorkDir{wd("/main/.wt/b", 1, 0)}}}}}
				return d
			}(), loc{rMain, "/main/.wt/b", "example.com/main"}},
		{"agent edits count",
			func() *model.SessionDigest {
				d := locSession("s", "/main", wd("/main", 1, 0))
				d.Agents = []model.Agent{{ID: "ag", Turns: []model.AgentTurn{{WorkDirs: []model.WorkDir{wd("/main/.wt/a", 3, 0)}}}}}
				return d
			}(), loc{rMain, "/main/.wt/a", "example.com/main"}},
		{"two clones of one remote are two repos",
			locSession("s", "/clone1", wd("/clone2", 1, 0)),
			loc{"/clone2/.git", "/clone2", "example.com/two"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var first SessionPlaces
			for i := range 25 { // map order must not matter
				p, _ := primary(t, locFixture(), tc.d)
				if i == 0 {
					first = p
				} else if !reflect.DeepEqual(first, p) {
					t.Fatalf("build %d differs:\n%+v\n%+v", i, first, p)
				}
				got := loc{repoOf(p), p.Checkout, p.Remote}
				if got != tc.want {
					t.Fatalf("primary = %+v, want %+v", got, tc.want)
				}
				if p.Checkout != "" && !slices.Contains(p.Checkouts, p.Checkout) || p.Repo != nil && !slices.ContainsFunc(p.Repos, func(r RepoRef) bool { return r.Repo == p.Repo.Repo }) {
					t.Errorf("primary values missing from the lists: %+v", p)
				}
			}
		})
	}
}

func TestPrimaryLocationCopiedHistoryAddsNothing(t *testing.T) {
	parent := locSession("parent", "/main", wd("/main", 1, 0))
	parent.Turns[0].UUID = "shared"
	// The child copies the parent's turn 0 (and the work of an agent spawned in it) and adds a turn.
	child := locSession("child", "/main", wd("/other", 50, 50))
	child.Turns[0].UUID = "shared"
	child.Turns = append(child.Turns, turn(1, "own", "more", 3))
	child.Turns[1].WorkDirs = []model.WorkDir{wd("/main/.wt/a", 1, 0)}
	zero, one := 0, 1
	child.Agents = []model.Agent{
		{ID: "copied", SpawnTurn: &zero, Turns: []model.AgentTurn{{WorkDirs: []model.WorkDir{wd("/other", 99, 0)}}}},
		{ID: "own", SpawnTurn: &one, Turns: []model.AgentTurn{{WorkDirs: []model.WorkDir{wd("/main/.wt/b", 2, 0)}}}},
		{ID: "nospawn", Turns: []model.AgentTurn{{WorkDirs: []model.WorkDir{wd("/main/.wt/b", 1, 0)}}}},
	}
	child.Lineage.ForkedFrom = &model.ForkRef{SessionID: "parent"}
	p, c := primary(t, locFixture(), child, parent)
	if info, _ := c.Session(child.Key()); !slices.Equal(info.InheritedTurns, []int{0}) {
		t.Fatalf("inherited turns = %v", info.InheritedTurns)
	}
	// own: a 1, b 2 + 1 (an agent with no spawn turn is own).
	if got := (loc{repoOf(p), p.Checkout, p.Remote}); got != (loc{rMain, "/main/.wt/b", "example.com/main"}) {
		t.Errorf("primary = %+v, copied work must not count", got)
	}
	if slices.Contains(p.Checkouts, "/other") || slices.Contains(p.Remotes, "example.com/other") {
		t.Errorf("lists = %v %v: copied work must not be listed", p.Checkouts, p.Remotes)
	}

	// A session that is nothing but a copy counts none of its activity: its start decides.
	whole := locSession("whole", "/main", wd("/other", 9, 9))
	whole.Turns[0].UUID = "shared"
	whole.Agents = []model.Agent{{ID: "nospawn", Turns: []model.AgentTurn{{WorkDirs: []model.WorkDir{wd("/other", 9, 0)}}}}}
	whole.Lineage.ForkedFrom = &model.ForkRef{SessionID: "parent"}
	p, c = primary(t, locFixture(), whole, parent)
	if info, _ := c.Session(whole.Key()); info.FirstOwnTurn != -1 {
		t.Fatalf("whole copy: first own turn %d", info.FirstOwnTurn)
	}
	if got := (loc{repoOf(p), p.Checkout, p.Remote}); got != (loc{rMain, "/main", "example.com/main"}) {
		t.Errorf("primary of a whole copy = %+v", got)
	}

	// The fallback leaves copied turns out, too.
	old := locSession("old", "/scratch")
	old.Turns[0].UUID = "shared"
	old.Turns[0].FilesTouched = []string{"/other/a.go"}
	old.Turns = append(old.Turns, turn(1, "own2", "more", 3))
	old.Turns[1].FilesTouched = []string{"/main/.wt/a/b.go"}
	old.Lineage.ForkedFrom = &model.ForkRef{SessionID: "parent"}
	p, _ = primary(t, locFixture(), old, parent)
	if got := (loc{repoOf(p), p.Checkout, p.Remote}); got != (loc{rMain, "/main/.wt/a", "example.com/main"}) {
		t.Errorf("fallback primary = %+v", got)
	}
}

func TestLocationLists(t *testing.T) {
	d := locSession("s", "/other", wd("/main/.wt/b", 1, 0), wd("/main/.wt/a", 0, 1), wd("/main/sub", 0, 1),
		wd("/bare/plain", 0, 1), wd("/scratch", 4, 4))
	p, _ := primary(t, locFixture(), d)
	if got := (loc{repoOf(p), p.Checkout, p.Remote}); got != (loc{rMain, "/main/.wt/b", "example.com/main"}) {
		t.Fatalf("primary = %+v", got)
	}
	// Activity, the primary values and the start directory's: sorted, no duplicates.
	if want := []string{"/main", "/main/.wt/a", "/main/.wt/b", "/other"}; !slices.Equal(p.Checkouts, want) {
		t.Errorf("checkouts = %v, want %v", p.Checkouts, want)
	}
	if want := []string{"example.com/bare", "example.com/main", "example.com/other"}; !slices.Equal(p.Remotes, want) {
		t.Errorf("remotes = %v, want %v", p.Remotes, want)
	}
	var rs []string
	for _, r := range p.Repos {
		rs = append(rs, r.Repo)
	}
	if want := []string{rBare, rMain, rOther}; !slices.Equal(rs, want) {
		t.Errorf("repos = %v, want %v sorted", rs, want)
	}
}

func TestLocationFilters(t *testing.T) {
	c := New()
	c.Upsert(locSession("a", "/main", wd("/main/.wt/a", 3, 0)))                    // main, wt a
	c.Upsert(locSession("b", "/main", wd("/main", 1, 0), wd("/main/.wt/a", 0, 2))) // main, main (touched a)
	c.Upsert(locSession("c", "/other", wd("/other", 1, 0)))                        // other
	c.Upsert(locSession("d", "/bare", wd("/scratch", 1, 0)))                       // bare, no checkout
	c.Upsert(locSession("e", "/scratch", wd("/scratch", 1, 0)))                    // nothing
	c.SetPlaces(locFixture())
	count := func(f Filter) int { return len(c.List(f, Liveness{}).Sessions) }
	for _, tc := range []struct {
		f    Filter
		want int
	}{
		{Filter{Checkout: "/main/.wt/a"}, 1},
		{Filter{Checkout: "/main/.wt/a", Touched: true}, 2},
		{Filter{Checkout: "/main"}, 1},
		{Filter{Checkout: NoneFilter}, 2},
		{Filter{Checkout: NoneFilter, Touched: true}, 2}, // a none filter stays primary
		{Filter{Repo: rMain}, 2},
		{Filter{Repo: rMain, Touched: true}, 2},
		{Filter{Repo: rBare}, 1},
		{Filter{Repo: NoneFilter}, 1},
		{Filter{Remote: "example.com/main"}, 2},
		{Filter{Remote: "example.com/bare"}, 1},
		{Filter{Remote: NoneFilter}, 1},
		{Filter{Remote: "example.com/main", Checkout: "/main/.wt/a", Touched: true}, 2},
		{Filter{Remote: "example.com/main", Checkout: "/main/.wt/a"}, 1},
	} {
		if n := count(tc.f); n != tc.want {
			t.Errorf("List(%+v) = %d, want %d", tc.f, n, tc.want)
		}
	}
	// The detail's lists make a touched filter reach back: session b touched wt a.
	if p, _ := c.Places(key("b")); !slices.Contains(p.Checkouts, "/main/.wt/a") {
		t.Errorf("b touched = %v", p.Checkouts)
	}
}

func TestLocationTotalsAddUp(t *testing.T) {
	c := New()
	mk := func(id, start string, day int, branch string, work ...model.WorkDir) {
		d := locSession(id, start, work...)
		d.Turns[0].GitBranch = branch
		d.Messages[0].At = at(day * 24 * 60)
		d.Messages = append(d.Messages, model.Message{ID: id + "-2", At: at(day*24*60 + 5), Model: "sonnet", USD: 2, Turn: new(int)})
		d.StartedAt, d.LastActivityAt = at(day*24*60), at(day*24*60+5)
		c.Upsert(d)
	}
	mk("a", "/main", 0, "main", wd("/main/.wt/a", 3, 0))
	mk("b", "/main", 1, "fix/#123", wd("/main", 1, 0))
	mk("c", "/other", 1, "", wd("/other", 1, 0))
	mk("d", "/bare", 2, "x", wd("/scratch", 1, 0))
	mk("e", "/scratch", 3, "y", wd("/scratch", 1, 0))
	mk("f", "/clone1", 3, "", wd("/clone2", 1, 0))
	c.SetPlaces(locFixture())

	total := c.Total(Filter{}).TotalUSD
	if total == 0 {
		t.Fatal("no spend")
	}
	for _, f := range []Filter{{}, {Repo: rMain}, {Remote: "example.com/main", Touched: true}, {DayFrom: at(24 * 60).Format("2006-01-02")}} {
		want := c.Total(f).TotalUSD
		for _, dims := range [][]Dim{{ByProject}, {ByRepo}, {ByCheckout}, {ByRemote}, {ByBranch}, {ByDay, ByCheckout}, {ByDay, ByRemote},
			{ByDay, ByRepo, ByBranch}, {ByCheckout, ByBranch}, {ByRemote, ByProject}} {
			var sum float64
			for _, r := range c.Rollup(f, dims...) {
				sum += r.TotalUSD
			}
			wantNear(t, "rollup total", sum, want)
		}
	}
	by := map[string]float64{}
	for _, r := range c.Rollup(Filter{}, ByCheckout) {
		by[r.Checkout] += r.TotalUSD
	}
	if _, ok := by[NoCheckout]; !ok || by["/main/.wt/a"] == 0 || by["/other"] == 0 {
		t.Errorf("by checkout = %v: sessions with no value belong to the none row", by)
	}
	for _, r := range c.Rollup(Filter{}, ByRemote) {
		if r.Remote == "example.com/two" {
			wantNear(t, "remote two", r.TotalUSD, 3)
		}
	}
	// The branch key survives a # in the branch name.
	for _, r := range c.Rollup(Filter{}, ByBranch) {
		repo, branch := SplitBranchKey(r.Branch)
		if branch == "fix/#123" && repo != rMain {
			t.Errorf("branch key %q splits into %q, %q", r.Branch, repo, branch)
		}
	}
}

func TestSplitBranchKey(t *testing.T) {
	for _, tc := range []struct{ repo, branch string }{
		{rMain, "fix/#123"}, {rMain, "main"}, {rMain, ""}, {"", "fix/#1#2"}, {"", "main"},
	} {
		k := branchKey(tc.repo, tc.branch)
		if r, b := SplitBranchKey(k); r != tc.repo || b != tc.branch {
			t.Errorf("SplitBranchKey(%q) = %q, %q; want %q, %q", k, r, b, tc.repo, tc.branch)
		}
	}
	if r, b := SplitBranchKey(""); r != "" || b != "" {
		t.Errorf("empty key = %q, %q", r, b)
	}
}

func TestGone(t *testing.T) {
	live := repos.Repo{Checkout: "/live", GitCommonDir: "/live/.git", Remote: "example.com/live"}
	gone := func(r repos.Repo) repos.Repo { r.Gone = true; return r }
	places := Places{Repos: map[string]repos.Repo{
		"/live": live,
		// gone subdirectories and an inferred entry of the same repository, in every order
		"/live/a": gone(live), "/live/b": gone(live), "/live/z": {Checkout: "/live", GitCommonDir: "/live/.git", Inferred: true, Gone: true, Remote: "example.com/live"},
		// a repository with only gone and inferred entries
		"/dead/wt": gone(repos.Repo{Checkout: "/dead/wt", GitCommonDir: "/dead/.git", Worktree: true, Remote: "example.com/dead"}),
		"/dead/in": {Checkout: "/dead/in", GitCommonDir: "/dead/.git", Inferred: true, Remote: "example.com/dead"},
		// a live worktree of a repository whose main checkout is gone: the repository lives
		"/mix":    gone(repos.Repo{Checkout: "/mix", GitCommonDir: "/mix/.git", Remote: "example.com/mix"}),
		"/mix/wt": {Checkout: "/mix/wt", GitCommonDir: "/mix/.git", Worktree: true, Remote: "example.com/mix"},
	}}
	for i := range 40 {
		c := New()
		c.Upsert(locSession("s", "/live", wd("/live/a", 1, 0)))
		c.SetPlaces(places)
		p, _ := c.Places(key("s"))
		if p.Repo == nil || p.Repo.Gone {
			t.Fatalf("build %d: a live repository with gone entries is gone: %+v", i, p.Repo)
		}
		_, fv := c.views()
		for repo, want := range map[string]bool{"/live/.git": false, "/dead/.git": true, "/mix/.git": false} {
			if got := fv.repoRef(repo).Gone; got != want {
				t.Fatalf("build %d: repo %s gone = %v, want %v", i, repo, got, want)
			}
		}
		for co, want := range map[string]bool{"/live": false, "/dead/wt": true, "/dead/in": true, "/mix": true, "/mix/wt": false} {
			if got := fv.goneCheckout(co); got != want {
				t.Fatalf("build %d: checkout %s gone = %v, want %v", i, co, got, want)
			}
		}
		if fv.liveRemote["example.com/dead"] || !fv.liveRemote["example.com/mix"] {
			t.Fatalf("build %d: live remotes %v", i, fv.liveRemote)
		}
	}
}

func TestRepoRemoteIsDeterministic(t *testing.T) {
	places := Places{Repos: map[string]repos.Repo{
		"/r/z": {Checkout: "/r", GitCommonDir: "/r/.git", Remote: "example.com/z"},
		"/r/a": {Checkout: "/r", GitCommonDir: "/r/.git", Remote: "example.com/a"},
		"/r/g": {Checkout: "/r", GitCommonDir: "/r/.git", Remote: "example.com/0-gone", Gone: true},
		"/r/n": {Checkout: "/r", GitCommonDir: "/r/.git"},
	}}
	for i := range 40 {
		c := New()
		c.Upsert(locSession("s", "/r/a", wd("/r/a", 1, 0)))
		c.SetPlaces(places)
		p, _ := c.Places(key("s"))
		if p.Remote != "example.com/a" || p.Repo.Remote != "example.com/a" {
			t.Fatalf("build %d: remote = %q / %q, want the first live one in directory order", i, p.Remote, p.Repo.Remote)
		}
	}
}

func TestGroups(t *testing.T) {
	c := New()
	mk := func(id, start string, min int, kind model.SessionKind, work ...model.WorkDir) {
		d := locSession(id, start, work...)
		d.Kind = kind
		d.LastActivityAt = at(min)
		c.Upsert(d)
	}
	mk("a", "/main", 10, model.KindInteractive, wd("/main/.wt/a", 1, 0))
	mk("b", "/main", 20, model.KindInteractive, wd("/main", 1, 0))
	mk("run", "/main", 30, model.KindSDK, wd("/main", 1, 0))
	mk("c", "/clone1", 5, model.KindInteractive, wd("/clone1", 1, 0))
	mk("d", "/clone2", 6, model.KindInteractive, wd("/clone2", 1, 0))
	mk("e", "/scratch", 40, model.KindInteractive, wd("/scratch", 1, 0))
	c.SetPlaces(locFixture())

	keys := func(by GroupBy) (ks []string, gs []Group) {
		gs, err := c.Groups(by, Filter{})
		if err != nil {
			t.Fatal(err)
		}
		for _, g := range gs {
			ks = append(ks, g.Key)
		}
		return ks, gs
	}
	ks, gs := keys(GroupRepo)
	if want := []string{rMain, "/clone2/.git", "/clone1/.git", ""}; !slices.Equal(ks, want) {
		t.Errorf("by repo = %v, want %v (newest first, none last)", ks, want)
	}
	if g := gs[0]; g.Name != "main" || g.Remote != "example.com/main" || g.Sessions != 2 || g.Gone ||
		!g.LastActivityAt.Equal(at(20)) {
		t.Errorf("main = %+v: the scripted run counts in cost only", g)
	}
	wantNear(t, "main cost", gs[0].Money.TotalUSD, 3)
	if g := gs[len(gs)-1]; g.Key != "" || g.Name == "" || g.Sessions != 1 {
		t.Errorf("none group = %+v", g)
	}
	// Two repositories with one remote: two rows by repo, one by remote.
	ks, gs = keys(GroupRemote)
	if want := []string{"example.com/main", "example.com/two", ""}; !slices.Equal(ks, want) {
		t.Errorf("by remote = %v, want %v", ks, want)
	}
	if gs[1].Sessions != 2 || gs[1].Name != "example.com/two" {
		t.Errorf("remote two = %+v", gs[1])
	}
	ks, _ = keys(GroupCheckout)
	if want := []string{"/main", "/main/.wt/a", "/clone2", "/clone1", ""}; !slices.Equal(ks, want) {
		t.Errorf("by checkout = %v", ks)
	}
	ks, gs = keys(GroupDir)
	if want := []string{"/scratch", "/main", "/clone2", "/clone1"}; !slices.Equal(ks, want) {
		t.Errorf("by dir = %v, want %v", ks, want)
	}
	if gs[1].Name != "main" || gs[1].Remote != "example.com/main" {
		t.Errorf("dir main = %+v", gs[1])
	}
	for _, by := range []GroupBy{GroupDir, GroupCheckout, GroupRepo, GroupRemote} {
		_, gs := keys(by)
		var sum float64
		for _, g := range gs {
			sum += g.Money.TotalUSD
		}
		wantNear(t, string(by), sum, c.Total(Filter{}).TotalUSD)
	}
	if _, err := c.Groups("branch", Filter{}); err == nil {
		t.Error("grouping by an unknown key must fail")
	}
	if gs, _ := c.Groups(GroupRepo, Filter{Remote: "example.com/two"}); len(gs) != 2 {
		t.Errorf("groups under a filter = %+v", gs)
	}
}

func TestPlacesUpdateKeepsSessionsAndCosts(t *testing.T) {
	c := New()
	c.Upsert(locSession("s", "/main", wd("/main/.wt/a", 1, 0)))
	c.SetPlaces(Places{})
	v1, _ := c.views()
	before := c.Total(Filter{})
	if p, _ := c.Places(key("s")); p.Repo != nil {
		t.Fatalf("repo with no places: %+v", p.Repo)
	}
	c.SetPlaces(locFixture())
	v2, _ := c.views()
	if v1 != v2 {
		t.Error("a Places update rebuilt the view: sessions and costs must stay")
	}
	if c.Total(Filter{}) != before {
		t.Error("cost changed with Places")
	}
	if p, _ := c.Places(key("s")); p.Checkout != "/main/.wt/a" {
		t.Errorf("checkout = %q", p.Checkout)
	}
}

func TestTouchedWidensTheMostSpecificFilter(t *testing.T) {
	c := New()
	// in: primary in /main, touched the worktree. out: primary in /other, touched both.
	c.Upsert(locSession("in", "/main", wd("/main", 2, 0), wd("/main/.wt/a", 0, 1)))
	c.Upsert(locSession("out", "/other", wd("/other", 3, 0), wd("/main", 0, 1), wd("/main/.wt/a", 0, 1)))
	c.SetPlaces(locFixture())
	ids := func(f Filter) []string {
		var out []string
		for _, in := range c.List(f, Liveness{}).Sessions {
			out = append(out, in.Key.ID)
		}
		slices.Sort(out)
		return out
	}
	const wt = "/main/.wt/a"
	if got := ids(Filter{Repo: rMain, Checkout: wt, Touched: true}); !slices.Equal(got, []string{"in"}) {
		t.Errorf("repo+checkout touched = %v, want [in]", got)
	}
	if got := ids(Filter{Checkout: wt, Touched: true}); !slices.Equal(got, []string{"in", "out"}) {
		t.Errorf("checkout touched = %v, want both", got)
	}
	if got := ids(Filter{Repo: rMain, Touched: true}); !slices.Equal(got, []string{"in", "out"}) {
		t.Errorf("repo touched = %v, want both", got)
	}
	if got := ids(Filter{Remote: "example.com/main", Checkout: wt, Touched: true}); !slices.Equal(got, []string{"in"}) {
		t.Errorf("remote+checkout touched = %v, want [in]", got)
	}
	found := false
	for _, g := range c.Repos(Filter{}) {
		if g.Repo != rMain {
			continue
		}
		for _, co := range g.Checkouts {
			if co.Checkout == wt {
				found = true
				if co.Sessions != len(ids(Filter{Repo: rMain, Checkout: wt, Touched: true})) {
					t.Errorf("checkouts[].sessions = %d, the filter selects %v", co.Sessions, ids(Filter{Repo: rMain, Checkout: wt, Touched: true}))
				}
			}
		}
	}
	if !found {
		t.Errorf("Repos() has no row for checkout %s under %s", wt, rMain)
	}
}
