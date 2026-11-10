package pi

import (
	"testing"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
)

// useFP is use with usage.cost.totalFromProvider set; a nil fp leaves the field out.
func useFP(cost float64, fp *bool) map[string]any {
	u := use(10, 10, 0, 0, cost)
	if fp != nil {
		u["cost"].(map[string]any)["totalFromProvider"] = *fp
	}
	return u
}

func TestBilledFromProvider(t *testing.T) {
	yes, no := true, false
	dir := t.TempDir()
	f := newFile(t, "b", "/home/dev/b", nil)
	f.user("u1", "", 1, "go")
	f.asst("a1", "u1", 2, "m", "ok", "stop", useFP(0.1, &yes))
	f.asst("a2", "a1", 3, "m", "ok", "stop", useFP(0.2, &no))
	f.asst("a3", "a2", 4, "m", "ok", "stop", useFP(0.3, nil))
	f.asst("a4", "a3", 5, "m", "ok", "stop", useFP(0, &yes)) // no cost: priced from the table, never billed
	f.write(dir, "b.jsonl")
	d := build(t, dir, "b")
	got := map[string][2]bool{}
	for _, m := range d.Messages {
		got[m.ID[:2]] = [2]bool{m.Recorded, m.Billed}
	}
	want := map[string][2]bool{"a1": {true, true}, "a2": {true, false}, "a3": {true, false}, "a4": {false, false}}
	for id, w := range want {
		if got[id] != w {
			t.Errorf("%s recorded/billed = %v, want %v", id, got[id], w)
		}
	}
}

// All calls billed: the billed flag and BilledUSD = RecordedUSD; some billed: recorded flag and a
// split; the money total never changes, only where it is filed.
func TestCatalogBilledFlag(t *testing.T) {
	yes := true
	dir := t.TempDir()
	b := newFile(t, "bill", "/home/dev/b", nil)
	b.user("u1", "", 1, "go")
	b.asst("a1", "u1", 2, "m", "ok", "stop", useFP(0.1, &yes))
	b.asst("a2", "a1", 3, "m", "ok", "stop", useFP(0.2, &yes))
	b.write(dir, "b.jsonl")
	mix := newFile(t, "mix", "/home/dev/mx", nil)
	mix.user("mu1", "", 11, "go mix")
	mix.asst("ma1", "mu1", 12, "m", "ok", "stop", useFP(0.1, &yes))
	mix.asst("ma2", "ma1", 13, "m", "ok", "stop", useFP(0.4, nil))
	mix.write(dir, "m.jsonl")
	c := catalogOf(t, dir)
	check := func(id string, flag catalog.CostFlag, rec, billed float64) {
		t.Helper()
		in, _ := c.Session(model.SessionKey{Harness: "pi", ID: id})
		if in.Cost.Flag != flag || !near(in.Cost.RecordedUSD, rec) || !near(in.Cost.BilledUSD, billed) {
			t.Errorf("%s: flag %q recorded %v billed %v; want %q %v %v", id, in.Cost.Flag, in.Cost.RecordedUSD, in.Cost.BilledUSD, flag, rec, billed)
		}
		m := in.Cost.Money()
		if m.AttributedUSD > 1e-9 || !near(m.TotalUSD, rec) || !near(m.RecordedUSD, rec) || !near(m.BilledUSD, billed) {
			t.Errorf("%s: money %+v", id, m)
		}
	}
	check("bill", catalog.CostBilled, 0.3, 0.3)
	check("mix", catalog.CostRecorded, 0.5, 0.1)
	tot := c.Total(catalog.Filter{})
	if !near(tot.TotalUSD, 0.8) || !near(tot.RecordedUSD, 0.8) || !near(tot.BilledUSD, 0.4) || tot.AttributedUSD > 1e-9 {
		t.Errorf("total %+v", tot)
	}
}
