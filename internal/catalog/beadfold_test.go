package catalog

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/terek/merlin/internal/beads"
	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/repos"
)

// bev builds a bd call at a minute in a directory.
func bev(min int, agent string, op model.BeadOp, cwd string, ids ...string) model.BeadEvent {
	return model.BeadEvent{At: at(min), AgentID: agent, Op: op, IDs: ids, Cwd: cwd, Outcome: model.BeadOK}
}

// oneMsgSession: a session in cwd with a message of usd at each given minute.
func oneMsgSession(id, cwd string, usd float64, mins ...int) *model.SessionDigest {
	var msgs []msgSpec
	for i, m := range mins {
		msgs = append(msgs, msgSpec{id: id + "-m" + string(rune('a'+i)), min: m, usd: usd})
	}
	return syn("claude", id, cwd, mins[0], mins[len(mins)-1], []model.Turn{turn(0, id+"-u0", "go", mins[0])}, msgs...)
}

// TestFoldWithoutExport is the original bug: a database with an interactions log and no export
// still gives every bead grouping, from the sessions' bd calls alone.
func TestFoldWithoutExport(t *testing.T) {
	bd := filepath.Join(t.TempDir(), ".beads")
	if err := os.MkdirAll(bd, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, s string) {
		if err := os.WriteFile(filepath.Join(bd, name), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("metadata.json", `{"project_id":"p-noexp"}`)
	write("interactions.jsonl",
		`{"id":"i1","kind":"field_change","created_at":"2026-10-01T10:02:00Z","issue_id":"acme-a1","extra":{"field":"status","new_value":"in_progress","old_value":"open"}}`+"\n"+
			`{"id":"i2","kind":"field_change","created_at":"2026-10-01T10:04:00Z","issue_id":"acme-a1","extra":{"field":"status","new_value":"closed","old_value":"in_progress"}}`+"\n")
	reg := beads.OpenRegistry(t.TempDir())
	if _, err := reg.Refresh(bd); err != nil {
		t.Fatal(err)
	}
	db, ok := reg.ForDir(bd)
	if !ok || len(db.Issues) != 0 {
		t.Fatalf("registry database = %+v, %v", db, ok)
	}
	r := repos.Repo{Checkout: "/w", GitCommonDir: "/w/.git", Beads: db.Dirs[0]}
	places := Places{Repos: map[string]repos.Repo{"/w": r}, Beads: reg.All()}

	c := New()
	s1 := oneMsgSession("s1", "/w", 1, 0, 1, 2, 3, 4, 5, 6)
	create := bev(0, "", model.BeadCreate, "/w", "acme-a1")
	create.Title = "Alpha work"
	child := bev(1, "", model.BeadCreate, "/w", "acme-c1")
	child.Title, child.Parent = "Child task", "acme-r0"
	s1.Beads = []model.BeadEvent{create, child, bev(2, "", model.BeadClaim, "/w", "acme-a1"),
		bev(4, "", model.BeadClose, "/w", "acme-a1"), bev(5, "", model.BeadClaim, "/w", "acme-c1")}
	s2 := oneMsgSession("s2", "/w", 2, 10, 11, 12)
	s2.Beads = []model.BeadEvent{bev(10, "", model.BeadClaim, "/w", "acme-c1"), bev(12, "", model.BeadClose, "/w", "acme-c1")}
	s3 := oneMsgSession("s3", "/w", 5, 20, 21) // no bead
	for _, d := range []*model.SessionDigest{s1, s2, s3} {
		c.Upsert(d)
	}
	c.SetPlaces(places)
	total := c.Total(Filter{}).TotalUSD

	// Cost per bead.
	byBead := map[string]float64{}
	var sum float64
	for _, row := range c.Rollup(Filter{}, ByBead) {
		byBead[row.Bead] += row.TotalUSD
		sum += row.TotalUSD
	}
	wantNear(t, "bead rollup total", sum, total)
	if byBead["acme-a1"] <= 0 || byBead["acme-c1"] <= 0 {
		t.Errorf("cost per bead = %v", byBead)
	}
	wantNear(t, "no bead", byBead[NoBead], 5*2+2)

	// Families: the root nobody titled is a stub, named by its earliest titled member.
	fams := c.Families(Filter{})
	if len(fams) != 2 {
		t.Fatalf("families = %+v", fams)
	}
	var fam *FamilyGroup
	for i := range fams {
		if fams[i].Root.ID == "acme-r0" {
			fam = &fams[i]
		}
	}
	if fam == nil || fam.Root.Title != "" || fam.Root.Source != beads.SourceImplied || fam.Hint != "Child task" ||
		fam.Sessions != 2 || fam.Issues != 2 {
		t.Errorf("family acme-r0 = %+v", fam)
	}
	wantNear(t, "family acme-r0 usd", fam.USD, byBead["acme-c1"])

	// Prefixes: the database learned its prefix.
	pres := c.Prefixes(Filter{})
	if len(pres) != 1 || pres[0].Prefix != "acme" || pres[0].Database != db.Key || pres[0].Sessions != 2 {
		t.Errorf("prefixes = %+v", pres)
	}

	// Session places.
	p, _ := c.Places(key("s1"))
	got := map[string]BeadShare{}
	for _, b := range p.Beads {
		got[b.ID] = b
	}
	if len(p.Beads) != 2 {
		t.Fatalf("s1 places.beads = %+v", p.Beads)
	}
	for _, b := range p.Beads {
		if b.USD <= 0 || b.Database != db.Key || len(b.Ops) == 0 {
			t.Errorf("share = %+v", b)
		}
	}

	// Every grouping adds up to the project total.
	for _, by := range []GroupBy{GroupBeadDatabase, GroupPrefix, GroupFamily, GroupBead, GroupDir} {
		groups, err := c.Groups(by, Filter{})
		if err != nil {
			t.Fatal(err)
		}
		var gsum float64
		names := map[string]string{}
		for _, g := range groups {
			gsum += g.Money.TotalUSD
			names[g.Key] = g.Name
		}
		wantNear(t, string(by)+" groups total", gsum, total)
		if by == GroupFamily && names["acme-r0"] != "Child task" {
			t.Errorf("family group name = %q, want the hint", names["acme-r0"])
		}
		if by == GroupBead && names["acme-a1"] != "Alpha work" {
			t.Errorf("bead group name = %q", names["acme-a1"])
		}
		if by == GroupPrefix && len(groups) != 2 { // acme and no bead
			t.Errorf("prefix groups = %+v", groups)
		}
	}
}

// TestOutputOnlyGuard: a bead named only by a script's output counts under a directory whose
// database owns it, or under none; not under a directory with another database.
func TestOutputOnlyGuard(t *testing.T) {
	places := Places{
		Repos: map[string]repos.Repo{
			"/a": {Checkout: "/a", GitCommonDir: "/a/.git", Beads: "/a/.beads"},
			"/b": {Checkout: "/b", GitCommonDir: "/b/.git", Beads: "/b/.beads"},
		},
		Beads: []beads.Database{
			{Key: "db-a", Dirs: []string{"/a/.beads"}, Prefixes: []string{"a"}, Issues: []beads.Issue{{ID: "a-1"}}},
			{Key: "db-b", Dirs: []string{"/b/.beads"}, Prefixes: []string{"zed"}, Issues: []beads.Issue{{ID: "zed-q1"}}},
		},
	}
	c := New()
	for _, cwd := range []string{"/a", "/b", "/n"} {
		d := oneMsgSession("s"+cwd[1:], cwd, 1, 1, 2, 3)
		e := bev(2, "", model.BeadClose, cwd, "zed-q1")
		e.OutputOnly = true
		d.Beads = []model.BeadEvent{e}
		c.Upsert(d)
	}
	c.SetPlaces(places)
	for id, want := range map[string]int{"sa": 0, "sb": 1, "sn": 1} {
		p, _ := c.Places(key(id))
		if len(p.Beads) != want {
			t.Errorf("%s: beads = %+v, want %d", id, p.Beads, want)
		}
	}
	// A call that names it itself counts anywhere.
	d := oneMsgSession("sx", "/a", 1, 1, 2, 3)
	d.Beads = []model.BeadEvent{bev(2, "", model.BeadClose, "/a", "zed-q1")}
	c.Upsert(d)
	if p, _ := c.Places(key("sx")); len(p.Beads) != 1 {
		t.Errorf("sx: beads = %+v", p.Beads)
	}
	// The dropped line is not on the timeline either; the others are.
	det, ok := c.Bead("zed-q1")
	if !ok || len(det.Timeline) != 3 {
		t.Errorf("timeline = %+v", det.Timeline)
	}
}

func TestBeadDetail(t *testing.T) {
	places := Places{
		Repos: map[string]repos.Repo{"/r": {Checkout: "/r", GitCommonDir: "/r/.git", Beads: "/r/.beads"}},
		Beads: []beads.Database{{Key: "db-r", Dirs: []string{"/r/.beads"}, Prefixes: []string{"x"}, Issues: []beads.Issue{
			{ID: "x-e", Title: "Epic"}, {ID: "x-a", Title: "A", Parent: "x-e"}, {ID: "x-a1", Title: "A one", Parent: "x-a"},
			{ID: "x-a2", Parent: "x-a"},
		}}},
	}
	c := New()
	s1 := oneMsgSession("s1", "/r", 1, 0, 1, 2, 3, 4, 5)
	s1.Agents = []model.Agent{{ID: "ag"}}
	failed := bev(4, "", model.BeadClose, "/r", "x-a")
	failed.Outcome = model.BeadFailed
	agent := bev(3, "ag", model.BeadUpdate, "/r", "x-a")
	agent.Status = "in_progress"
	zero := 0
	agent.AgentTurn = &zero
	seen := bev(6, "", model.BeadShow, "/r")
	seen.Seen = []model.BeadSeen{{ID: "x-a", Title: "A listed"}}
	s1.Beads = []model.BeadEvent{bev(1, "", model.BeadShow, "/r", "x-a"), bev(2, "", model.BeadClaim, "/r", "x-a"), agent, failed, seen}
	s2 := oneMsgSession("s2", "/r", 1, 2, 5)
	closed := bev(5, "", model.BeadClose, "/r", "x-a")
	closed.Reason = "done"
	s2.Beads = []model.BeadEvent{bev(2, "", model.BeadClaim, "/r", "x-a"), closed}
	c.Upsert(s1)
	c.Upsert(s2)
	c.SetPlaces(places)

	d, ok := c.Bead("x-a")
	if !ok {
		t.Fatal("x-a unknown")
	}
	if d.Title != "A" || d.Root != "x-e" || d.Database != "db-r" || d.Source != beads.SourceExport {
		t.Errorf("bead = %+v", d.BeadRef)
	}
	if len(d.Ancestors) != 1 || d.Ancestors[0].ID != "x-e" {
		t.Errorf("ancestors = %+v", d.Ancestors)
	}
	if len(d.Children) != 2 || d.Children[0].ID != "x-a1" || d.Children[1].ID != "x-a2" {
		t.Errorf("children = %+v", d.Children)
	}
	if c1, _ := c.Bead("x-a1"); len(c1.Ancestors) != 2 || c1.Ancestors[0].ID != "x-a" || c1.Ancestors[1].ID != "x-e" {
		t.Errorf("x-a1 ancestors = %+v", c1.Ancestors)
	}
	type step struct {
		min       int
		session   string
		agent     string
		op        model.BeadOp
		outcome   model.BeadOutcome
		reasonOrT string
	}
	want := []step{
		{1, "s1", "", model.BeadShow, model.BeadOK, ""},
		{2, "s1", "", model.BeadClaim, model.BeadOK, ""}, // same minute: s1 before s2
		{2, "s2", "", model.BeadClaim, model.BeadOK, ""},
		{3, "s1", "ag", model.BeadUpdate, model.BeadOK, ""},
		{4, "s1", "", model.BeadClose, model.BeadFailed, ""},
		{5, "s2", "", model.BeadClose, model.BeadOK, "done"},
		{6, "s1", "", model.BeadShow, model.BeadOK, "A listed"},
	}
	if len(d.Timeline) != len(want) {
		t.Fatalf("timeline = %+v", d.Timeline)
	}
	for i, w := range want {
		g := d.Timeline[i]
		rt := g.Reason
		if rt == "" {
			rt = g.Title
		}
		if !g.At.Equal(at(w.min)) || g.SessionID != w.session || g.AgentID != w.agent || g.Op != w.op ||
			g.Outcome != w.outcome || rt != w.reasonOrT {
			t.Errorf("timeline[%d] = %+v, want %+v", i, g, w)
		}
	}
	if d.Timeline[3].AgentTurn == nil {
		t.Errorf("agent turn lost: %+v", d.Timeline[3])
	}
	if len(d.Sessions) != 2 {
		t.Errorf("sessions = %+v", d.Sessions)
	}
	for _, s := range d.Sessions {
		if s.USD <= 0 || len(s.Ops) == 0 {
			t.Errorf("session share = %+v", s)
		}
	}
	if _, ok := c.Bead("x-nope"); ok {
		t.Error("an unknown id has a detail")
	}
}

// dep add names its target without working on it: the session's cost goes to the issue alone,
// and the target still shows the call on its timeline.
func TestDepTargetNotWorkedOn(t *testing.T) {
	c := New()
	d := oneMsgSession("sd", "/n", 1, 1, 2, 3)
	e := bev(2, "", model.BeadDep, "/n", "acme-c1", "acme-e1")
	e.DepType = "blocks"
	d.Beads = []model.BeadEvent{e}
	c.Upsert(d)
	c.SetPlaces(Places{})
	p, _ := c.Places(key("sd"))
	if len(p.Beads) != 1 || p.Beads[0].ID != "acme-c1" {
		t.Fatalf("beads = %+v, want acme-c1 alone", p.Beads)
	}
	if det, ok := c.Bead("acme-e1"); !ok || len(det.Timeline) != 1 || len(det.Sessions) != 0 {
		t.Errorf("acme-e1 = %+v", det)
	}
}
