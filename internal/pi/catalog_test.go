package pi

import (
	"testing"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
)

func catalogOf(t *testing.T, dir string) *catalog.Catalog {
	t.Helper()
	h, disc := discover(t, dir)
	c := catalog.New()
	for _, s := range disc.Sessions {
		d, err := h.Build(s)
		if err != nil {
			t.Fatal(err)
		}
		c.Upsert(d)
	}
	return c
}

// A fork copies entries with their ids: the catalog bills the copy once, to the older
// session, links the two, and links no session with an unrelated one that happens to share
// an 8-hex entry id.
func TestCatalogForkBillsOnceAndNoFalseLink(t *testing.T) {
	dir := t.TempDir()
	for i, id := range []string{"one", "two", "three"} {
		cwd := "/home/dev/" + id
		f := newFile(t, id, cwd, nil)
		f.user("deadbeef", "", 1+i*1000, "hello")
		f.asst("cafebabe", "deadbeef", 2+i*1000, "m", "hi", "stop", use(10, 10, 0, 0, 0.1))
		f.write(dir, id+".jsonl")
	}
	fk := newFile(t, "fork", "/home/dev/one", map[string]any{
		"parentSession": "/home/dev/.pi/agent/sessions/--home-dev-one--/2026-10-01T09-00-00-000Z_one.jsonl"})
	fk.user("deadbeef", "", 1, "hello")
	fk.asst("cafebabe", "deadbeef", 2, "m", "hi", "stop", use(10, 10, 0, 0, 0.1))
	fk.user("11111111", "cafebabe", 50, "more")
	fk.asst("22222222", "11111111", 51, "m", "ok", "stop", use(10, 10, 0, 0, 0.4))
	fk.write(dir, "fork.jsonl")
	c := catalogOf(t, dir)

	diag := c.Diagnostics()
	if diag.Links != 1 || diag.SharedMessages != 1 {
		t.Errorf("links %d, shared messages %d; want 1 and 1", diag.Links, diag.SharedMessages)
	}
	info, _ := c.Session(model.SessionKey{Harness: "pi", ID: "fork"})
	if info.Parent == nil || info.Parent.Parent.ID != "one" || info.Parent.Kind != catalog.LinkFork {
		t.Fatalf("fork parent %+v", info.Parent)
	}
	if !near(info.Cost.BestUSD, 0.4) || !near(info.Cost.InheritedUSD, 0.1) {
		t.Errorf("fork cost %+v", info.Cost)
	}
	for _, id := range []string{"two", "three"} {
		in, _ := c.Session(model.SessionKey{Harness: "pi", ID: id})
		if in.Parent != nil || len(in.Children) != 0 || in.Cost.InheritedMessages != 0 {
			t.Errorf("%s is linked: %+v", id, in)
		}
	}
	if total := c.Total(catalog.Filter{}); !near(total.TotalUSD, 0.1*3+0.4) {
		t.Errorf("total %v", total.TotalUSD)
	}
}

// Recorded per-call costs give the recorded flag; a mix with recomputed ones stays estimated;
// work with no billed message is unknown.
func TestCatalogRecordedFlag(t *testing.T) {
	dir := t.TempDir()
	r := newFile(t, "rec", "/home/dev/r", nil)
	r.user("u1", "", 1, "go")
	r.asst("a1", "u1", 2, "m", "ok", "stop", use(10, 10, 0, 0, 0.1))
	r.write(dir, "r.jsonl")
	mix := newFile(t, "mix", "/home/dev/m", nil)
	mix.user("u1", "", 1, "go")
	mix.asst("a1", "u1", 2, "m", "ok", "stop", use(10, 10, 0, 0, 0.1))
	mix.asst("a2", "a1", 3, "m", "ok", "stop", use(10, 10, 0, 0, 0)) // table
	mix.write(dir, "m.jsonl")
	none := newFile(t, "none", "/home/dev/n", nil)
	none.user("u1", "", 1, "go")
	none.asst("a1", "u1", 2, "m", "ok", "stop", use(0, 0, 0, 0, 0))
	none.write(dir, "n.jsonl")
	c := catalogOf(t, dir)
	for id, want := range map[string]catalog.CostFlag{"rec": catalog.CostRecorded, "mix": catalog.CostEstimated, "none": catalog.CostUnknown} {
		in, _ := c.Session(model.SessionKey{Harness: "pi", ID: id})
		if in.Cost.Flag != want {
			t.Errorf("%s flag = %q, want %q", id, in.Cost.Flag, want)
		}
	}
}
