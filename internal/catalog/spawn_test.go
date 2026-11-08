package catalog

import (
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

// A parent Pi session "p" in /w makes a bash call at minute 2 (result at minute 2 + 3 s); the
// child "k" is the Pi it started.
func spawnParent() *model.SessionDigest {
	p := syn("pi", "p", "/w", 0, 10, []model.Turn{turn(0, "up0", "delegate", 0), turn(1, "up1", "next", 5)},
		msgSpec{"pm1", 1, 1, 0}, msgSpec{"pm2", 6, 2, 1})
	turn0 := 0
	p.SpawnedSessions = []model.SessionSpawn{{
		ToolUseID: "b1", Turn: &turn0, At: at(2), EndedAt: at(2).Add(3 * time.Second),
		Dir: "/w", Prompts: []string{"Write hello.py"}, Harness: "pi",
	}}
	return p
}

func spawnChild(id, project string, start time.Duration, prompt string) *model.SessionDigest {
	k := syn("pi", id, project, 0, 3, []model.Turn{turn(0, "u"+id+"0", prompt, 0)}, msgSpec{id + "m1", 2, 4, 0})
	k.StartedAt = at(2).Add(start)
	return k
}

func build3(ds ...*model.SessionDigest) *Catalog {
	c := New()
	for _, d := range ds {
		c.Upsert(d)
	}
	return c
}

func pkey(id string) model.SessionKey { return model.SessionKey{Harness: "pi", ID: id} }

func TestSpawnedChildIsLinked(t *testing.T) {
	c := build3(spawnParent(), spawnChild("k", "/w", 300*time.Millisecond, "  Write hello.py\n"))
	k, _ := c.Session(pkey("k"))
	if k.Parent == nil || k.Parent.Parent != pkey("p") || k.Parent.Kind != LinkSpawned || k.Parent.AtTurn != 0 ||
		k.Parent.SharedMessages != 0 || k.Parent.SharedTurns != 0 || k.Parent.Explicit {
		t.Fatalf("child parent %+v", k.Parent)
	}
	if k.Root != pkey("p") || !k.Leaf || len(k.InheritedTurns) != 0 || k.FirstOwnTurn != 0 {
		t.Errorf("child %+v", k)
	}
	p, _ := c.Session(pkey("p"))
	if len(p.Children) != 1 || p.Children[0].Child != pkey("k") || !p.Leaf {
		t.Errorf("parent children %+v leaf %v", p.Children, p.Leaf)
	}
	fam, _ := c.Family(pkey("k"))
	if len(fam.Members) != 2 || fam.Root != pkey("p") {
		t.Errorf("family %+v", fam)
	}
	// the child's spend (4) and the parent's (3) each count once
	trees := c.Trees(Filter{}, Liveness{})
	if len(trees) != 1 {
		t.Fatalf("trees %d", len(trees))
	}
	wantNear(t, "tree", trees[0].BestUSD, 7)
	wantNear(t, "total", c.Total(Filter{}).TotalUSD, 7)
	wantNear(t, "child", k.Cost.BestUSD, 4)
	wantNear(t, "parent", p.Cost.BestUSD, 3)
}

func TestSpawnedChildNotLinked(t *testing.T) {
	cases := map[string]*model.SessionDigest{
		"other cwd":    spawnChild("k", "/elsewhere", 300*time.Millisecond, "Write hello.py"),
		"too early":    spawnChild("k", "/w", -2500*time.Millisecond, "Write hello.py"),
		"too late":     spawnChild("k", "/w", 5500*time.Millisecond, "Write hello.py"),
		"other prompt": spawnChild("k", "/w", 300*time.Millisecond, "Write hello.py now"),
		"other harness": func() *model.SessionDigest {
			d := spawnChild("k", "/w", 0, "Write hello.py")
			d.Harness = "claude"
			return d
		}(),
	}
	for name, k := range cases {
		c := build3(spawnParent(), k)
		got, _ := c.Session(k.Key())
		if got.Parent != nil {
			t.Errorf("%s: linked %+v", name, got.Parent)
		}
		wantNear(t, name+" total", c.Total(Filter{}).TotalUSD, 7)
	}
	// edges of the window are in: 2 s before the call, 2 s after the result
	for name, d := range map[string]time.Duration{"2s before": -2 * time.Second, "2s after result": 5 * time.Second} {
		c := build3(spawnParent(), spawnChild("k", "/w", d, "Write hello.py"))
		if got, _ := c.Session(pkey("k")); got.Parent == nil || got.Parent.Kind != LinkSpawned {
			t.Errorf("%s: not linked", name)
		}
	}
}

func TestSpawnWithoutResultUsesLastActivity(t *testing.T) {
	p := spawnParent()
	p.SpawnedSessions[0].EndedAt = time.Time{} // parent's last activity is minute 10
	c := build3(p, spawnChild("k", "/w", 4*time.Minute, "Write hello.py"))
	if got, _ := c.Session(pkey("k")); got.Parent == nil {
		t.Error("child inside the parent's activity span not linked")
	}
	c = build3(p, spawnChild("k", "/w", 9*time.Minute, "Write hello.py"))
	if got, _ := c.Session(pkey("k")); got.Parent != nil {
		t.Error("child after the parent's last activity linked")
	}
}

func TestSpawnAmbiguousLinksNone(t *testing.T) {
	c := build3(spawnParent(), spawnChild("k1", "/w", 300*time.Millisecond, "Write hello.py"),
		spawnChild("k2", "/w", 900*time.Millisecond, "Write hello.py"))
	for _, id := range []string{"k1", "k2"} {
		if got, _ := c.Session(pkey(id)); got.Parent != nil {
			t.Errorf("%s linked despite ambiguity: %+v", id, got.Parent)
		}
	}
}

func TestSpawnedChildWithOtherParentKeepsIt(t *testing.T) {
	// the candidate child is a fork of "f" (shares a message and a turn with it)
	f := syn("pi", "f", "/w", -30, -20, []model.Turn{turn(0, "ushared", "Write hello.py", -30)}, msgSpec{"fm1", -29, 1, 0})
	k := spawnChild("k", "/w", 300*time.Millisecond, "Write hello.py")
	k.Turns[0].UUID = "ushared"
	k.Messages = append(k.Messages, model.Message{ID: "fm1", At: at(-29), Model: "sonnet", USD: 1, Turn: new(int)})
	k.Cost.USD++
	c := build3(spawnParent(), f, k)
	got, _ := c.Session(pkey("k"))
	if got.Parent == nil || got.Parent.Parent != pkey("f") || got.Parent.Kind == LinkSpawned {
		t.Errorf("shared-history parent lost: %+v", got.Parent)
	}
	wantNear(t, "total", c.Total(Filter{}).TotalUSD, 3+1+4)

	// a fork marker with nothing shared
	k2 := spawnChild("k2", "/w", 300*time.Millisecond, "Write hello.py")
	k2.Lineage.ForkedFrom = &model.ForkRef{SessionID: "f2"}
	c = build3(spawnParent(), syn("pi", "f2", "/w", -30, -20, nil), k2)
	got, _ = c.Session(pkey("k2"))
	if got.Parent == nil || got.Parent.Parent != pkey("f2") || got.Parent.Kind == LinkSpawned {
		t.Errorf("marker parent lost: %+v", got.Parent)
	}
}

func TestSpawnCycleIsBroken(t *testing.T) {
	// two sessions that each started the other: the cycle is cut, never looped
	a := spawnParent()
	b := spawnChild("k", "/w", 300*time.Millisecond, "Write hello.py")
	b.SpawnedSessions = []model.SessionSpawn{{At: at(0).Add(-time.Second), EndedAt: at(0).Add(time.Second), Dir: "/w", Prompts: []string{"delegate"}, Harness: "pi"}}
	c := build3(a, b)
	pa, _ := c.Session(pkey("p"))
	pb, _ := c.Session(pkey("k"))
	if (pa.Parent == nil) == (pb.Parent == nil) {
		t.Errorf("want exactly one link, got %+v / %+v", pa.Parent, pb.Parent)
	}
}
