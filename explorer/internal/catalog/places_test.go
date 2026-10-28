package catalog

import (
	"testing"

	"github.com/terek/merlin/explorer/internal/beads"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/repos"
)

// placesFixture: one repository /r with a bead database (x-e is the parent of x-a), another
// repository /o with a database of its own (y-z), a worktree of /r, and a non-repository /h.
func placesFixture() Places {
	r := repos.Repo{Top: "/r", Repo: "/r", Beads: "/r/.beads"}
	wt := repos.Repo{Top: "/r/.wt/one", Repo: "/r", Worktree: true, Beads: "/r/.beads"}
	return Places{
		Repos: map[string]repos.Repo{"/r": r, "/r/src": r, "/r/.wt/one": wt,
			"/o": {Top: "/o", Repo: "/o", Beads: "/o/.beads"}},
		Beads: []beads.Database{
			{Key: "db-o", Dirs: []string{"/o/.beads"}, Prefixes: []string{"y"}, Issues: []beads.Issue{{ID: "y-z"}}},
			{Key: "db-r", Dirs: []string{"/r/.beads"}, Prefixes: []string{"x"}, Issues: []beads.Issue{
				{ID: "x-a", Parent: "x-e", Title: "A"}, {ID: "x-b", Status: "closed"}, {ID: "x-c"}, {ID: "x-e", Title: "E"},
			}},
		},
	}
}

func ev(min int, agent string, op model.BeadOp, ids ...string) model.BeadEvent {
	return model.BeadEvent{At: at(min), AgentID: agent, Op: op, IDs: ids, Cwd: "/r", Outcome: model.BeadOK}
}

// beadSession: main-thread messages of $1 at minutes 0..10, an agent's two of $1 at 3 and 4.
// A is claimed at 2 and closed at 5; B closed unclaimed at 8 (so from 5); the agent works on
// C alone. A call quoting a bead of another database, and a failed one, do not count.
func beadSession() *model.SessionDigest {
	var msgs []msgSpec
	for i := 0; i <= 10; i++ {
		msgs = append(msgs, msgSpec{id: "m" + string(rune('a'+i)), min: i, usd: 1})
	}
	d := syn("claude", "s1", "/h", 0, 10, []model.Turn{turn(0, "u0", "go", 0)}, msgs...)
	d.Turns[0].GitBranch = "main"
	d.Turns[0].FilesTouched = []string{"/r/src/a.go", "/r/src/b.go"}
	d.Cwds = []string{"/h", "/r/.wt/one"}
	for _, m := range []float64{3, 4} {
		d.Messages = append(d.Messages, model.Message{ID: "g" + string(rune('0'+int(m))), At: at(int(m)), Model: "sonnet", USD: 1, AgentID: "ag"})
	}
	failed := ev(9, "", model.BeadClose, "x-e")
	failed.Outcome = model.BeadFailed
	d.Beads = []model.BeadEvent{
		ev(2, "", model.BeadClaim, "x-a"),
		ev(3, "ag", model.BeadClaim, "x-c"),
		ev(4, "ag", model.BeadClose, "x-c"),
		ev(5, "", model.BeadClose, "x-a"),
		ev(6, "", model.BeadClose, "y-z"), // ran in /r: quoted output
		ev(8, "", model.BeadClose, "x-b"),
		failed,
	}
	return d
}

func TestPlacesBeadShares(t *testing.T) {
	c := New()
	c.Upsert(beadSession())
	c.SetPlaces(placesFixture())
	p, ok := c.Places(key("s1"))
	if !ok {
		t.Fatal("no places")
	}
	if p.Repo == nil || p.Repo.Repo != "/r" {
		t.Fatalf("repo = %+v, want /r (most of the work, though it started in /h)", p.Repo)
	}
	if len(p.Worktrees) != 1 || p.Worktrees[0] != "/r/.wt/one" {
		t.Errorf("worktrees = %v", p.Worktrees)
	}
	got := map[string]float64{}
	for _, b := range p.Beads {
		got[b.ID] = b.USD
	}
	// A: minutes 2,3,4 and half of 5; B: half of 5, then 6,7,8; C: the agent's two.
	want := map[string]float64{"x-a": 3.5, "x-b": 3.5, "x-c": 2}
	if len(got) != len(want) {
		t.Errorf("beads = %v, want %v", got, want)
	}
	for id, w := range want {
		wantNear(t, id, got[id], w)
	}
	wantNear(t, "no bead", p.NoBeadUSD, 4)
	if b := p.Beads[0]; b.Root == "" || len(b.Ops) == 0 {
		t.Errorf("first bead = %+v", b)
	}
	for _, b := range p.Beads {
		if b.ID == "x-a" && b.Root != "x-e" {
			t.Errorf("x-a root = %q, want x-e", b.Root)
		}
	}
}

func TestPlacesFiltersAndRollups(t *testing.T) {
	c := New()
	c.Upsert(beadSession())
	other := syn("claude", "s2", "/o", 0, 3, []model.Turn{turn(0, "v0", "hi", 0)}, msgSpec{id: "o1", min: 1, usd: 2})
	c.Upsert(other)
	c.SetPlaces(placesFixture())

	for _, tc := range []struct {
		f    Filter
		want int
	}{
		{Filter{Repo: "/r"}, 1},
		{Filter{Repo: "/o"}, 1},
		{Filter{Repo: NoneFilter}, 0},
		{Filter{Bead: "x-e"}, 1}, // the family: x-a lies below it
		{Filter{Bead: "y-z"}, 0},
		{Filter{Branch: "main"}, 1},
		{Filter{Worktree: "/r/.wt/one"}, 1},
	} {
		if n := len(c.List(tc.f, Liveness{}).Sessions); n != tc.want {
			t.Errorf("List(%+v) = %d sessions, want %d", tc.f, n, tc.want)
		}
	}

	total := c.Total(Filter{}).TotalUSD
	for _, d := range []Dim{ByRepo, ByBranch, ByBead, ByFamily} {
		var sum float64
		for _, r := range c.Rollup(Filter{}, d) {
			sum += r.TotalUSD
		}
		wantNear(t, "rollup total", sum, total)
	}
	byFam := map[string]float64{}
	for _, r := range c.Rollup(Filter{}, ByFamily) {
		byFam[r.Family] = r.TotalUSD
	}
	wantNear(t, "family x-e", byFam["x-e"], 3.5)
	wantNear(t, "no bead", byFam[NoBead], 4+2)

	fams := c.Families(Filter{})
	if len(fams) != 3 || fams[0].Root.ID == "" {
		t.Fatalf("families = %+v", fams)
	}
	for _, f := range fams {
		if f.Root.ID == "x-e" && (len(f.Beads) != 2 || f.Issues != 2 || f.Sessions != 1) {
			t.Errorf("family x-e = %+v", f)
		}
	}
	rs := c.Repos(Filter{})
	if len(rs) != 2 || len(rs[0].Worktrees)+len(rs[1].Worktrees) != 1 {
		t.Errorf("repos = %+v", rs)
	}
}

func TestPlacesCopiedEventsBelongToTheOwner(t *testing.T) {
	parent := beadSession()
	for i := range parent.Beads {
		parent.Beads[i].MessageID = "m" + string(rune('a'+parent.Beads[i].At.Sub(t0).Minutes()))
	}
	child := *parent
	child.ID = "s1-copy"
	child.StartedAt = at(20)
	child.LastActivityAt = at(30)
	child.Messages = append(append([]model.Message(nil), parent.Messages...),
		model.Message{ID: "late", At: at(30), Model: "sonnet", USD: 5})
	c := New()
	c.Upsert(parent)
	c.Upsert(&child)
	c.SetPlaces(placesFixture())
	p, _ := c.Places(key("s1-copy"))
	for _, b := range p.Beads {
		if b.Ops != nil && b.USD != 0 {
			t.Errorf("the copy bills %s: %+v", b.ID, b)
		}
	}
	if n := len(c.List(Filter{Bead: "x-a"}, Liveness{}).Sessions); n != 1 {
		t.Errorf("sessions on x-a = %d, want 1 (the copy only holds the calls)", n)
	}
}

func TestIDLess(t *testing.T) {
	for _, c := range [][2]string{{"x-a.2", "x-a.10"}, {"x-a", "x-a.1"}, {"x-a.1.9", "x-a.2"}} {
		if !idLess(c[0], c[1]) || idLess(c[1], c[0]) {
			t.Errorf("idLess(%s, %s)", c[0], c[1])
		}
	}
}
