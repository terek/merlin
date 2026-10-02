package catalog

import (
	"math/rand"
	"reflect"
	"testing"

	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/store"
)

func TestCopiedHistoryPairs(t *testing.T) {
	c := fixtureCatalog(t)
	cases := []struct {
		name         string
		a, b         string
		kind         LinkKind
		explicit     bool
		atTurn       int
		shared       int
		inheritedUSD float64 // billed to the parent, shown in the child
		ownB         float64
		unique       float64 // README: cost of the pair counted once
		project      string
		inhTurns     []int
		firstOwn     int
	}{
		{"13a continuation", "01", "02", LinkContinuation, false, 1, 3, 0.0156, 0.00152, 0.01712, "/home/dev/acme/s13a-continuation", []int{0, 1}, 2},
		{"13b unmarked fork", "03", "04", LinkFork, false, 1, 3, 0.0156, 0.00162, 0.01874, "/home/dev/acme/s13b-fork-unmarked", []int{0, 1}, 2},
		{"13c marked fork", "05", "06", LinkFork, true, 1, 3, 0.0156, 0.00162, 0.01874, "/home/dev/acme/s13c-fork-marked", []int{0, 1}, 2},
		{"13d partial copy", "07", "08", LinkContinuation, true, 2, 1, 0.00154, 0.00156, 0.0187, "/home/dev/acme/s13d-partial-copy", []int{0}, 1},
		{"13e sdk pickup", "09", "10", LinkContinuation, false, 1, 3, 0.0156, 0.00152, 0.01712, "/home/dev/acme/s13e-sdk-pickup", []int{0, 1}, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a, ok := c.Session(sid("13", tc.a))
			if !ok {
				t.Fatal("parent missing")
			}
			b, _ := c.Session(sid("13", tc.b))
			if b.Parent == nil {
				t.Fatalf("child has no parent link")
			}
			l := *b.Parent
			if l.Parent != a.Key || l.Child != b.Key {
				t.Errorf("link %v -> %v", l.Parent, l.Child)
			}
			if l.Kind != tc.kind || l.Explicit != tc.explicit || l.AtTurn != tc.atTurn || l.SharedMessages != tc.shared {
				t.Errorf("link = %+v, want kind=%s explicit=%v atTurn=%d shared=%d", l, tc.kind, tc.explicit, tc.atTurn, tc.shared)
			}
			if len(a.Children) != 1 || a.Children[0] != l {
				t.Errorf("parent's children = %+v", a.Children)
			}
			if a.Parent != nil || a.Root != a.Key || b.Root != a.Key {
				t.Errorf("roots: a=%v b=%v", a.Root, b.Root)
			}
			wantNear(t, "child inheritedUSD", b.Cost.InheritedUSD, tc.inheritedUSD)
			if len(b.Cost.InheritedFrom) != 1 || b.Cost.InheritedFrom[0].From != a.Key {
				t.Errorf("inheritedFrom = %+v", b.Cost.InheritedFrom)
			}
			wantNear(t, "child ownUSD", b.Cost.OwnUSD, tc.ownB)
			wantNear(t, "parent inheritedUSD", a.Cost.InheritedUSD, 0)
			wantNear(t, "pair counted once", a.Cost.BestUSD+b.Cost.BestUSD, tc.unique)
			wantNear(t, "project total", c.Total(Filter{Project: tc.project}).TotalUSD, tc.unique)
			if !reflect.DeepEqual(b.InheritedTurns, tc.inhTurns) || b.FirstOwnTurn != tc.firstOwn {
				t.Errorf("inherited turns = %v first own %d, want %v %d", b.InheritedTurns, b.FirstOwnTurn, tc.inhTurns, tc.firstOwn)
			}
			if len(a.InheritedTurns) != 0 || a.FirstOwnTurn != 0 {
				t.Errorf("parent inherits %v, first own %d", a.InheritedTurns, a.FirstOwnTurn)
			}
			// Both sessions are interactive (13e: a mixed cli/sdk file is not scripted).
			if a.Kind != model.KindInteractive || b.Kind != model.KindInteractive {
				t.Errorf("kinds %s %s", a.Kind, b.Kind)
			}
		})
	}
}

func TestLeaves(t *testing.T) {
	c := fixtureCatalog(t)
	// continuation: only the child is a candidate to resume
	f, _ := c.Family(sid("13", "01"))
	if want := []model.SessionKey{sid("13", "02")}; !reflect.DeepEqual(f.Leaves, want) {
		t.Errorf("13a leaves = %v", f.Leaves)
	}
	// fork: both branches go on, newest first
	f, _ = c.Family(sid("13", "03"))
	if want := []model.SessionKey{sid("13", "04"), sid("13", "03")}; !reflect.DeepEqual(f.Leaves, want) {
		t.Errorf("13b leaves = %v, want %v", f.Leaves, want)
	}
	if want := []model.SessionKey{sid("13", "03"), sid("13", "04")}; !reflect.DeepEqual(f.Members, want) {
		t.Errorf("13b members = %v", f.Members)
	}
}

func TestThreeSessionFamily(t *testing.T) {
	// A <- B (continuation) <- C (continuation of B, which carries A's history);
	// D forks off A. E is unrelated.
	ta := []model.Turn{turn(0, "ua0", "first", 0), turn(1, "ua1", "second", 1)}
	A := syn("claude", "a", "/p", 0, 8, append(slicesClone(ta), turn(2, "ua2", "A goes on", 8)),
		msgSpec{"m1", 0, 1, 0}, msgSpec{"m2", 1, 2, 1}, msgSpec{"ma3", 8, 4, 2})
	B := syn("claude", "b", "/p", 0, 10, []model.Turn{ta[0], ta[1], turn(2, "ub2", "B own", 5)},
		msgSpec{"m1", 0, 1, 0}, msgSpec{"m2", 1, 2, 1}, msgSpec{"mb3", 5, 8, 2})
	C := syn("claude", "c", "/p", 0, 30, []model.Turn{ta[0], ta[1], turn(2, "ub2", "B own", 5), turn(3, "uc3", "C own", 25)},
		msgSpec{"m1", 0, 1, 0}, msgSpec{"m2", 1, 2, 1}, msgSpec{"mb3", 5, 8, 2}, msgSpec{"mc4", 25, 16, 3})
	D := syn("claude", "d", "/p", 0, 15, []model.Turn{ta[0], ta[1], turn(2, "ud2", "D own", 12)},
		msgSpec{"m1", 0, 1, 0}, msgSpec{"m2", 1, 2, 1}, msgSpec{"md3", 12, 32, 2})
	E := syn("claude", "e", "/p", 0, 5, []model.Turn{turn(0, "ue0", "unrelated", 1)}, msgSpec{"me1", 1, 64, 0})
	// copies keep the original timestamps, so A, B, C and D start together and only the last
	// activity (A 8, B 10, D 15, C 30) orders them
	for _, order := range [][]*model.SessionDigest{{A, B, C, D, E}, {E, D, C, B, A}, {C, A, E, B, D}} {
		c := New()
		for _, d := range order {
			c.Upsert(d)
		}
		fam, _ := c.Family(key("c"))
		if fam.Root != key("a") {
			t.Fatalf("root = %v", fam.Root)
		}
		a, _ := c.Session(key("a"))
		b, _ := c.Session(key("b"))
		cc, _ := c.Session(key("c"))
		d, _ := c.Session(key("d"))
		if cc.Parent == nil || cc.Parent.Parent != key("b") {
			t.Errorf("C's parent = %+v, want b (shares the most)", cc.Parent)
		}
		if b.Parent == nil || b.Parent.Parent != key("a") || d.Parent == nil || d.Parent.Parent != key("a") {
			t.Errorf("B/D parents wrong: %+v %+v", b.Parent, d.Parent)
		}
		var kids []model.SessionKey
		for _, l := range a.Children {
			kids = append(kids, l.Child)
		}
		if !reflect.DeepEqual(kids, []model.SessionKey{key("b"), key("d")}) {
			t.Errorf("A's children = %v", kids)
		}
		if b.Parent.AtTurn != 1 || cc.Parent.AtTurn != 2 {
			t.Errorf("atTurn b=%d c=%d", b.Parent.AtTurn, cc.Parent.AtTurn)
		}
		// A has a turn of its own after the copy point: forks. B stops where C copies.
		if d.Parent.Kind != LinkFork || b.Parent.Kind != LinkFork || cc.Parent.Kind != LinkContinuation {
			t.Errorf("kinds: d=%s b=%s c=%s", d.Parent.Kind, b.Parent.Kind, cc.Parent.Kind)
		}
		// Leaves: B is continued by C, so it is out; A only has fork children, so it is
		// still a branch tip. Newest first.
		if want := []model.SessionKey{key("c"), key("d"), key("a")}; !reflect.DeepEqual(fam.Leaves, want) {
			t.Errorf("leaves = %v, want %v", fam.Leaves, want)
		}
		if want := []model.SessionKey{key("a"), key("b"), key("c"), key("d")}; !reflect.DeepEqual(fam.Members, want) {
			t.Errorf("members = %v", fam.Members)
		}
		// Money: every message once.
		if got := c.Total(Filter{}).TotalUSD; !near(got, 1+2+4+8+16+32+64) {
			t.Errorf("total = %v", got)
		}
		// C inherits m1,m2 from A and mb3 from B.
		if cc.Cost.InheritedFrom[0].From != key("a") || cc.Cost.InheritedFrom[1].From != key("b") || !near(cc.Cost.InheritedUSD, 11) {
			t.Errorf("C inherited = %+v", cc.Cost)
		}
		if !reflect.DeepEqual(cc.InheritedTurns, []int{0, 1, 2}) || cc.FirstOwnTurn != 3 {
			t.Errorf("C inherited turns %v first own %d", cc.InheritedTurns, cc.FirstOwnTurn)
		}
		e, _ := c.Family(key("e"))
		if e.Root != key("e") || len(e.Members) != 1 {
			t.Errorf("unrelated family = %+v", e)
		}
	}
}

func slicesClone(ts []model.Turn) []model.Turn { return append([]model.Turn(nil), ts...) }

func TestOwnershipRules(t *testing.T) {
	msg := func(id string) msgSpec { return msgSpec{id, 0, 1, 0} }
	tu := []model.Turn{turn(0, "", "x", 0)}
	t.Run("earliest start wins", func(t *testing.T) {
		c := New()
		c.Upsert(syn("claude", "late", "/p", 5, 9, tu, msg("m")))
		c.Upsert(syn("claude", "early", "/p", 1, 9, tu, msg("m")))
		early, _ := c.Session(key("early"))
		late, _ := c.Session(key("late"))
		if early.Cost.OwnMessages != 1 || late.Cost.OwnMessages != 0 || late.Cost.InheritedFrom[0].From != key("early") {
			t.Errorf("early=%+v late=%+v", early.Cost, late.Cost)
		}
	})
	t.Run("then last activity, then id", func(t *testing.T) {
		c := New()
		c.Upsert(syn("claude", "x", "/p", 1, 9, tu, msg("m")))
		c.Upsert(syn("claude", "y", "/p", 1, 7, tu, msg("m")))
		if y, _ := c.Session(key("y")); y.Cost.OwnMessages != 1 {
			t.Errorf("y should own (earlier last activity): %+v", y.Cost)
		}
		c = New()
		c.Upsert(syn("claude", "b", "/p", 1, 9, tu, msg("m")))
		c.Upsert(syn("claude", "a", "/p", 1, 9, tu, msg("m")))
		if a, _ := c.Session(key("a")); a.Cost.OwnMessages != 1 {
			t.Errorf("a should own (smallest id): %+v", a.Cost)
		}
	})
	t.Run("explicit markers beat time", func(t *testing.T) {
		parent := syn("claude", "parent", "/p", 5, 9, tu, msg("m"))
		child := syn("claude", "child", "/p", 1, 9, tu, msg("m")) // looks older
		child.Lineage.InheritedFrom = []string{"parent"}
		c := New()
		c.Upsert(child)
		c.Upsert(parent)
		p, _ := c.Session(key("parent"))
		ch, _ := c.Session(key("child"))
		if p.Cost.OwnMessages != 1 || ch.Cost.OwnMessages != 0 {
			t.Errorf("parent=%+v child=%+v", p.Cost, ch.Cost)
		}
		if ch.Parent == nil || ch.Parent.Parent != key("parent") || !ch.Parent.Explicit {
			t.Errorf("link = %+v", ch.Parent)
		}
	})
	t.Run("marker naming an unknown session changes nothing", func(t *testing.T) {
		child := syn("claude", "child", "/p", 1, 9, tu, msg("m"))
		child.Lineage.ForkedFrom = &model.ForkRef{SessionID: "ghost"}
		c := New()
		c.Upsert(child)
		if ch, _ := c.Session(key("child")); ch.Cost.OwnMessages != 1 || ch.Parent != nil {
			t.Errorf("%+v", ch)
		}
	})
	t.Run("cyclic markers fall back to the order and still form a tree", func(t *testing.T) {
		x := syn("claude", "x", "/p", 1, 9, tu, msg("m"))
		y := syn("claude", "y", "/p", 2, 9, tu, msg("m"))
		x.Lineage.InheritedFrom = []string{"y"}
		y.Lineage.InheritedFrom = []string{"x"}
		c := New()
		c.Upsert(x)
		c.Upsert(y)
		xi, _ := c.Session(key("x"))
		yi, _ := c.Session(key("y"))
		if xi.Cost.OwnMessages+yi.Cost.OwnMessages != 1 {
			t.Errorf("message billed %d times", xi.Cost.OwnMessages+yi.Cost.OwnMessages)
		}
		if (xi.Parent == nil) == (yi.Parent == nil) {
			t.Errorf("exactly one of them must have a parent: %+v %+v", xi.Parent, yi.Parent)
		}
	})
	t.Run("duplicate id inside one session counts once", func(t *testing.T) {
		d := syn("claude", "dup", "/p", 1, 9, tu, msg("m"), msg("m"))
		c := New()
		c.Upsert(d)
		if s, _ := c.Session(key("dup")); s.Cost.OwnMessages != 1 || !near(s.Cost.OwnUSD, 1) {
			t.Errorf("%+v", s.Cost)
		}
	})
}

// snapshot captures everything a reader can see, for comparisons between catalogs.
func snapshot(c *Catalog) any {
	f := Filter{}
	var infos []SessionInfo
	for _, p := range c.ProjectFiles() {
		infos = append(infos, p.Sessions...)
	}
	return []any{
		c.List(f, Liveness{}),
		c.Rollup(f, ByProject, ByDay),
		c.Rollup(f, ByModel, ByDay),
		c.Rollup(f, ByKind),
		c.Total(f),
		c.ProjectFiles(),
		c.Search("a", SearchOptions{}),
		c.Search("context", SearchOptions{}),
		c.Diagnostics(),
		infos,
	}
}

func TestLoadOrderDoesNotMatter(t *testing.T) {
	setZone(t, "America/New_York")
	ds := goldens(t)
	ref := New()
	for _, d := range ds {
		ref.Upsert(d)
	}
	want := snapshot(ref)
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 12; i++ {
		perm := rng.Perm(len(ds))
		c := New()
		for j, p := range perm {
			c.Upsert(ds[p])
			if j%7 == 0 {
				c.List(Filter{}, Liveness{}) // force intermediate rebuilds
			}
		}
		if got := snapshot(c); !reflect.DeepEqual(got, want) {
			t.Fatalf("permutation %d differs from the reference load", i)
		}
	}
}

func TestUpsertEqualsFreshLoad(t *testing.T) {
	setZone(t, "UTC")
	// Index the child first, then the parent: the parent takes the shared messages back.
	ds := goldens(t)
	byID := map[string]*model.SessionDigest{}
	for _, d := range ds {
		byID[d.ID] = d
	}
	c := New()
	child := byID[sid("13", "06").ID]
	parent := byID[sid("13", "05").ID]
	c.Upsert(child)
	if s, _ := c.Session(sid("13", "06")); s.Cost.InheritedUSD != 0 || s.Parent != nil || !near(s.Cost.OwnUSD, 0.01722) {
		t.Fatalf("alone, the child owns everything: %+v", s.Cost)
	}
	c.Upsert(parent)
	s, _ := c.Session(sid("13", "06"))
	if s.Parent == nil || !near(s.Cost.OwnUSD, 0.00162) || !near(s.Cost.InheritedUSD, 0.0156) {
		t.Fatalf("after the parent arrives: %+v / %+v", s.Parent, s.Cost)
	}
	// Replace, mark missing, remove: always equal to a fresh load of the final set.
	rng := rand.New(rand.NewSource(3))
	live := map[model.SessionKey]*model.SessionDigest{}
	c = New()
	for step := 0; step < 120; step++ {
		d := ds[rng.Intn(len(ds))]
		switch rng.Intn(5) {
		case 0:
			c.Remove(d.Key())
			delete(live, d.Key())
		case 1:
			if _, ok := live[d.Key()]; ok {
				c.MarkMissing(d.Key())
				cp := *live[d.Key()]
				cp.SourceMissing = true
				live[d.Key()] = &cp
			}
		default:
			c.Upsert(d)
			live[d.Key()] = d
		}
		if step%10 == 0 {
			fresh := New()
			for _, x := range live {
				fresh.Upsert(x)
			}
			if !reflect.DeepEqual(snapshot(c), snapshot(fresh)) {
				t.Fatalf("step %d: incremental state differs from a fresh load", step)
			}
		}
	}
}

func TestErrorStubsAreIgnored(t *testing.T) {
	c := fixtureCatalog(t)
	before := c.Total(Filter{})
	c.Upsert(&model.SessionDigest{Harness: "claude", ID: "broken", ProjectKey: "k", Error: "boom"})
	if got := c.Total(Filter{}); got != before {
		t.Errorf("a stub changed the totals")
	}
	if _, ok := c.Session(key("broken")); ok {
		t.Errorf("stub is indexed")
	}
	if c.Diagnostics().Stubs != 1 {
		t.Errorf("stubs = %d", c.Diagnostics().Stubs)
	}
}

func TestLoadFromStoreAndProjectFiles(t *testing.T) {
	st, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range goldens(t) {
		if err := st.Write(d); err != nil {
			t.Fatal(err)
		}
	}
	c, err := Load(st, "")
	if err != nil {
		t.Fatal(err)
	}
	if c.Len() != 35 {
		t.Fatalf("loaded %d digests", c.Len())
	}
	if err := c.WriteProjects(st); err != nil {
		t.Fatal(err)
	}
	var pf ProjectFile
	found, err := st.ReadProject("claude", "-home-dev-acme-s13b-fork-unmarked", &pf)
	if err != nil || !found {
		t.Fatalf("project.json: %v %v", found, err)
	}
	if pf.Project != "/home/dev/acme/s13b-fork-unmarked" || len(pf.Sessions) != 2 {
		t.Errorf("%+v", pf)
	}
	// newest first; the child links back to its parent
	if pf.Sessions[0].Key != sid("13", "04") || pf.Sessions[0].Parent == nil || pf.Sessions[0].Parent.Parent != sid("13", "03") {
		t.Errorf("sessions = %+v", pf.Sessions)
	}
	// the scripted session is not listed, only counted
	var sdk ProjectFile
	if found, _ := st.ReadProject("claude", "-home-dev-acme-sdk", &sdk); !found || len(sdk.Sessions) != 0 || len(sdk.Scripted) != 1 || sdk.Scripted[0].Count != 1 {
		t.Errorf("sdk project file = %+v", sdk)
	}
}
