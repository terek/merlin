package server

import (
	"encoding/json"
	"math"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/repos"
)

// locRig serves a small synthetic catalog (no fixture, no real paths): a and b start in /main
// (a works in the worktree /main/.wt/a, b in /main and only runs commands in the worktree), c
// works in /other and d in a scratch directory that is in no repository.
func locRig(t *testing.T) *rig {
	t.Helper()
	r := newRig(t)
	t0 := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
	c := catalog.New()
	c.SetLocation(testZone)
	add := func(id, start string, usd float64, min int, work ...model.WorkDir) {
		zero := 0
		d := &model.SessionDigest{
			SchemaVersion: model.SchemaVersion, Harness: "claude", ID: id, ProjectKey: "k" + start, Project: start, Cwd: start,
			Kind: model.KindInteractive, Title: id, StartedAt: t0.Add(time.Duration(min) * time.Minute),
			LastActivityAt: t0.Add(time.Duration(min+1) * time.Minute),
			Turns:          []model.Turn{{Index: 0, UUID: "u" + id, Origin: model.OriginHuman, WorkDirs: work}},
			Messages:       []model.Message{{ID: id + "m", At: t0.Add(time.Duration(min) * time.Minute), Model: "sonnet", USD: usd, Turn: &zero}},
		}
		d.Cost.USD = usd
		c.Upsert(d)
	}
	add("a", "/main", 1, 0, model.WorkDir{Dir: "/main/.wt/a", Edits: 3})
	add("b", "/main", 2, 10, model.WorkDir{Dir: "/main", Edits: 1}, model.WorkDir{Dir: "/main/.wt/a", Commands: 2})
	add("c", "/other", 3, 20, model.WorkDir{Dir: "/other", Edits: 1})
	add("d", "/scratch", 4, 30, model.WorkDir{Dir: "/scratch", Edits: 1})
	main := repos.Repo{Checkout: "/main", GitCommonDir: "/main/.git", Remote: "example.com/acme/main"}
	wt := main
	wt.Checkout, wt.Worktree = "/main/.wt/a", true
	c.SetPlaces(catalog.Places{Repos: map[string]repos.Repo{
		"/main": main, "/main/.wt/a": wt,
		"/other": {Checkout: "/other", GitCommonDir: "/other/.git", Remote: "example.com/acme/other"},
	}})
	r.cat = c
	return r
}

func sessionIDs(l SessionList) []string {
	var ids []string
	for _, s := range l.Sessions {
		ids = append(ids, s.Key.ID)
	}
	slices.Sort(ids)
	return ids
}

func TestGroupsRoute(t *testing.T) {
	r := locRig(t)
	for _, tc := range []struct {
		by   string
		keys []string // newest first, none last
		name string   // of the first
	}{
		{"dir", []string{"/scratch", "/other", "/main"}, "scratch"},
		{"checkout", []string{"/other", "/main", "/main/.wt/a", ""}, "other"},
		{"repo", []string{"/other/.git", "/main/.git", ""}, "other"},
		{"remote", []string{"example.com/acme/other", "example.com/acme/main", ""}, "example.com/acme/other"},
	} {
		var gl GroupList
		if code := r.get("/api/groups?by="+tc.by, &gl); code != 200 {
			t.Fatalf("by=%s: %d", tc.by, code)
		}
		var keys []string
		var sum float64
		for _, g := range gl.Groups {
			keys = append(keys, g.Key)
			sum += g.Money.TotalUSD
		}
		if !slices.Equal(keys, tc.keys) {
			t.Errorf("by=%s keys = %v, want %v", tc.by, keys, tc.keys)
		}
		if len(gl.Groups) > 0 && gl.Groups[0].Name != tc.name {
			t.Errorf("by=%s first name = %q, want %q", tc.by, gl.Groups[0].Name, tc.name)
		}
		if math.Abs(sum-10) > 1e-9 {
			t.Errorf("by=%s costs add up to %v, want 10", tc.by, sum)
		}
	}
	// "repo" groups name the repository, not the base of its key (.git).
	var gl GroupList
	r.get("/api/groups?by=repo&repo=/main/.git", &gl)
	if len(gl.Groups) != 1 || gl.Groups[0].Name != "main" || gl.Groups[0].Remote != "example.com/acme/main" || gl.Groups[0].Sessions != 2 {
		t.Errorf("repo groups = %+v", gl.Groups)
	}
	// Filters are the shared ones.
	r.get("/api/groups?by=checkout&checkout=/main/.wt/a&touched=1", &gl)
	if len(gl.Groups) != 2 {
		t.Errorf("touched checkout groups = %+v: sessions a and b touched it, under two checkouts", gl.Groups)
	}
	r.get("/api/groups?by=repo&remote=-", &gl)
	if len(gl.Groups) != 1 || gl.Groups[0].Key != "" {
		t.Errorf("sessions with no remote = %+v", gl.Groups)
	}
	for _, path := range []string{"/api/groups", "/api/groups?by=branch", "/api/groups?by=", "/api/groups?by=repo&touched=2"} {
		e := r.wantError(path, 400, CodeInvalidParameter)
		if !strings.HasPrefix(path, "/api/groups?by=repo") && !strings.Contains(e.Error.Message, "dir, checkout, repo, remote, beadDatabase, prefix, family or bead") {
			t.Errorf("%s: message %q does not name the allowed values", path, e.Error.Message)
		}
	}
}

func TestLocationFiltersOnSessions(t *testing.T) {
	r := locRig(t)
	for _, tc := range []struct {
		query string
		want  []string
	}{
		{"checkout=/main/.wt/a", []string{"a"}},
		{"checkout=/main/.wt/a&touched=1", []string{"a", "b"}},
		{"checkout=/main", []string{"b"}},
		{"checkout=-", []string{"d"}},
		{"checkout=-&touched=1", []string{"d"}},
		{"repo=/main/.git", []string{"a", "b"}},
		{"repo=-", []string{"d"}},
		{"remote=example.com/acme/main", []string{"a", "b"}},
		{"remote=example.com/acme/other", []string{"c"}},
		{"remote=-", []string{"d"}},
		{"remote=example.com/acme/main&checkout=/main", []string{"b"}},
		{"worktree=/main/.wt/a", []string{"a", "b", "c", "d"}}, // gone: ignored like any unknown parameter
	} {
		var l SessionList
		if code := r.get("/api/sessions?"+tc.query, &l); code != 200 {
			t.Fatalf("%s: %d", tc.query, code)
		}
		if got := sessionIDs(l); !slices.Equal(got, tc.want) {
			t.Errorf("%s: sessions %v, want %v", tc.query, got, tc.want)
		}
	}
	r.wantError("/api/sessions?touched=yes", 400, CodeInvalidParameter)

	// The summary and the detail carry the keys.
	var l SessionList
	r.get("/api/sessions?checkout=/main/.wt/a", &l)
	s := l.Sessions[0]
	if s.Checkout != "/main/.wt/a" || s.Remote != "example.com/acme/main" || s.Repo == nil || s.Repo.Repo != "/main/.git" {
		t.Errorf("summary = %+v", s)
	}
	var d SessionDetail
	r.get("/api/sessions/claude/b", &d)
	p := d.Places
	if p.Checkout != "/main" || p.Remote != "example.com/acme/main" ||
		!slices.Equal(p.Checkouts, []string{"/main", "/main/.wt/a"}) || !slices.Equal(p.Remotes, []string{"example.com/acme/main"}) ||
		len(p.Repos) != 1 || p.Repos[0].Name != "main" {
		t.Errorf("detail places = %+v", p)
	}
	var raw map[string]map[string]json.RawMessage
	resp, err := http.Get(r.srv.URL + "/api/sessions/claude/b")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	_ = json.NewDecoder(resp.Body).Decode(&raw)
	if _, ok := raw["places"]["worktrees"]; ok {
		t.Error("places still has worktrees")
	}
}

func TestCostByLocationKeys(t *testing.T) {
	r := locRig(t)
	var base CostTable
	r.get("/api/cost?by=project", &base)
	if math.Abs(base.Total.TotalUSD-10) > 1e-9 {
		t.Fatalf("total = %v", base.Total.TotalUSD)
	}
	labels := map[string]map[string]string{
		"dir":      {"/main": "main", "/scratch": "scratch"},
		"checkout": {"": "no checkout", "/main/.wt/a": "a", "/other": "other"},
		"repo":     {"": "no repository", "/main/.git": "main", "/other/.git": "other"},
		"remote":   {"": "no remote", "example.com/acme/main": "example.com/acme/main"},
	}
	for by, want := range labels {
		for _, query := range []string{"", "&split=model", "&checkout=/main&touched=1"} {
			var ct CostTable
			if code := r.get("/api/cost?by="+by+query, &ct); code != 200 {
				t.Fatalf("by=%s%s: %d", by, query, code)
			}
			var sum float64
			for _, row := range ct.Rows {
				sum += row.TotalUSD
				if query == "" && want[row.Key] != "" && row.Label != want[row.Key] {
					t.Errorf("by=%s key %q: label %q, want %q", by, row.Key, row.Label, want[row.Key])
				}
				if query == "&split=model" {
					var parts float64
					for _, p := range row.Split {
						parts += p.TotalUSD
					}
					if math.Abs(parts-row.TotalUSD) > 1e-9 {
						t.Errorf("by=%s split of %q adds up to %v, row %v", by, row.Key, parts, row.TotalUSD)
					}
				}
			}
			if math.Abs(sum-ct.Total.TotalUSD) > 1e-9 || query == "" && math.Abs(sum-10) > 1e-9 {
				t.Errorf("by=%s%s: rows add up to %v, total %v", by, query, sum, ct.Total.TotalUSD)
			}
		}
	}
	// The cost route honours the same filters as the list.
	var ct CostTable
	r.get("/api/cost?by=checkout&remote=example.com/acme/main", &ct)
	if math.Abs(ct.Total.TotalUSD-3) > 1e-9 || len(ct.Rows) != 2 {
		t.Errorf("cost of the main remote = %+v", ct)
	}
	r.get("/api/cost?by=dir&checkout=/main/.wt/a&touched=1", &ct)
	if math.Abs(ct.Total.TotalUSD-3) > 1e-9 {
		t.Errorf("cost of the touched worktree = %v", ct.Total.TotalUSD)
	}
	r.wantError("/api/cost?by=project&touched=maybe", 400, CodeInvalidParameter)
	r.wantError("/api/cost?by=project&split=project", 400, CodeInvalidParameter)
	e := r.wantError("/api/cost?by=worktree", 400, CodeInvalidParameter)
	if !strings.Contains(e.Error.Message, "checkout, remote") {
		t.Errorf("message = %q", e.Error.Message)
	}
}

func TestReposListCheckouts(t *testing.T) {
	r := locRig(t)
	var rl RepoList
	r.get("/api/repos", &rl)
	var main *catalog.RepoGroup
	for i := range rl.Repos {
		if rl.Repos[i].Repo == "/main/.git" {
			main = &rl.Repos[i]
		}
	}
	if main == nil || len(main.Checkouts) != 2 {
		t.Fatalf("repos = %+v", rl.Repos)
	}
	got := map[string]bool{}
	for _, c := range main.Checkouts {
		got[c.Checkout] = c.Worktree
		if c.Sessions != 2 { // both sessions started in or touched each
			t.Errorf("checkout %+v", c)
		}
	}
	if w, ok := got["/main"]; !ok || w {
		t.Errorf("checkouts = %v: /main is the main checkout", got)
	}
	if !got["/main/.wt/a"] {
		t.Errorf("checkouts = %v: the linked worktree must say so", got)
	}
	resp, err := http.Get(r.srv.URL + "/api/repos")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var raw struct{ Repos []map[string]json.RawMessage }
	_ = json.NewDecoder(resp.Body).Decode(&raw)
	for _, m := range raw.Repos {
		if _, ok := m["worktrees"]; ok {
			t.Error("/api/repos still has worktrees[]")
		}
	}
}

func TestNoDirectoryLabel(t *testing.T) {
	r := newRig(t)
	c := catalog.New()
	c.SetLocation(testZone)
	zero := 0
	c.Upsert(&model.SessionDigest{SchemaVersion: model.SchemaVersion, Harness: "claude", ID: "x", Kind: model.KindInteractive,
		StartedAt: testNow.Add(-time.Hour), LastActivityAt: testNow.Add(-time.Hour),
		Turns:    []model.Turn{{Index: 0, UUID: "ux", Origin: model.OriginHuman}},
		Messages: []model.Message{{ID: "xm", At: testNow.Add(-time.Hour), Model: "sonnet", USD: 1, Turn: &zero}}})
	r.cat = c
	var ct CostTable
	r.get("/api/cost?by=dir", &ct)
	if len(ct.Rows) != 1 || ct.Rows[0].Key != "" || ct.Rows[0].Label != "no directory" {
		t.Errorf("by=dir rows = %+v", ct.Rows)
	}
	var gl GroupList
	r.get("/api/groups?by=dir", &gl)
	if len(gl.Groups) != 1 || gl.Groups[0].Key != "" || gl.Groups[0].Name != "(no directory)" {
		t.Errorf("dir groups = %+v", gl.Groups)
	}
}
