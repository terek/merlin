package catalog

import (
	"testing"

	"github.com/terek/merlin/internal/model"
)

// splitSession: a main-agent message and a sub-agent one, with tokens, inside a reported window.
func splitSession(id string, windowTokens bool) *model.SessionDigest {
	d := syn("claude", id, "/p/"+id, 0, 30, []model.Turn{turn(0, "u0"+id, "go", 0)},
		msgSpec{"m1" + id, 1, 3, 0}, msgSpec{"m2" + id, 2, 1, 0})
	for i := range d.Messages {
		d.Messages[i].Model = "claude-sonnet-5-5"
	}
	d.Messages[0].Tokens = model.Tokens{Input: 1000, Output: 500, CacheRead: 100000, CacheWrite5m: 20000}
	d.Messages[1].Tokens = model.Tokens{Input: 500, Output: 200, CacheRead: 50000}
	d.Messages[1].AgentID = "ag1"
	w := window(0, 10, 4.5) // 0.5 above what the messages explain: overhead
	if windowTokens {
		w.ByModel = map[string]model.ReportedModel{"claude-sonnet-5-5": {InputTokens: 1500, OutputTokens: 700,
			CacheReadTokens: 150000, CacheCreationTokens: 20000, USD: 4.5}}
	}
	return withWindows(d, w)
}

func rowOf(rows []Row, key string, d Dim) (Row, bool) {
	for _, r := range rows {
		if r.Key(d) == key {
			return r, true
		}
	}
	return Row{}, false
}

func TestClassAndAgentRowsAddUp(t *testing.T) {
	c := New()
	c.Upsert(splitSession("a", true))
	c.Upsert(splitSession("b", false))
	want := c.Rollup(Filter{})[0].TotalUSD
	wantNear(t, "plain total", want, 9)
	for name, dims := range map[string][]Dim{"class": {ByClass}, "agent": {ByAgent}, "class/model": {ByClass, ByModel}, "model/agent": {ByModel, ByAgent}} {
		wantNear(t, name, sum(c.Rollup(Filter{}, dims...)).TotalUSD, want)
	}
	// per model: the classes of a model add up to the model's row
	for _, m := range c.Rollup(Filter{}, ByModel) {
		var got float64
		for _, r := range c.Rollup(Filter{}, ByClass, ByModel) {
			if r.Model == m.Model {
				got += r.TotalUSD
			}
		}
		wantNear(t, "classes of "+m.Model, got, m.TotalUSD)
	}
}

func TestUnsplitWhenAWindowHasNoTokens(t *testing.T) {
	c := New()
	c.Upsert(splitSession("b", false)) // the window's 0.5 overhead has no tokens to apportion by
	rows := c.Rollup(Filter{}, ByClass, ByModel)
	r, ok := rowOf(rows, "(unsplit)", ByClass)
	if !ok || r.Model != OverheadModel {
		t.Fatalf("no (unsplit) overhead row: %+v", rows)
	}
	wantNear(t, "(unsplit)", r.TotalUSD, 0.5)
	for _, x := range rows {
		if x.Class == "(unsplit)" && x.Model != OverheadModel {
			t.Errorf("messages with tokens are split: %+v", x)
		}
	}
	// with tokens in the window the overhead splits like the window
	c2 := New()
	c2.Upsert(splitSession("a", true))
	if _, ok := rowOf(c2.Rollup(Filter{}, ByClass), "(unsplit)", ByClass); ok {
		t.Error("an (unsplit) row although every window has tokens")
	}
}

func TestAgentsSplitByMessages(t *testing.T) {
	c := New()
	c.Upsert(splitSession("a", true))
	rows := c.Rollup(Filter{}, ByAgent)
	m, _ := rowOf(rows, "main", ByAgent)
	a, _ := rowOf(rows, "agents", ByAgent)
	u, _ := rowOf(rows, "(unsplit)", ByAgent)
	wantNear(t, "main", m.TotalUSD, 3)
	wantNear(t, "agents", a.TotalUSD, 1)
	wantNear(t, "(unsplit): the overhead", u.TotalUSD, 0.5)
	if m.Sessions != 1 || a.Sessions != 1 {
		t.Errorf("sessions %d %d", m.Sessions, a.Sessions)
	}
}

func TestClassesFollowTheTokensPrices(t *testing.T) {
	c := New()
	c.Upsert(splitSession("a", true))
	rows := c.Rollup(Filter{}, ByClass)
	out, _ := rowOf(rows, "output", ByClass)
	in, _ := rowOf(rows, "input", ByClass)
	cr, _ := rowOf(rows, "cacheRead", ByClass)
	cw, _ := rowOf(rows, "cacheWrite", ByClass)
	if out.TotalUSD <= in.TotalUSD || cr.TotalUSD <= 0 || cw.TotalUSD <= 0 {
		t.Errorf("implausible split: in %v out %v cr %v cw %v", in.TotalUSD, out.TotalUSD, cr.TotalUSD, cw.TotalUSD)
	}
}
