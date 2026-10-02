package catalog

import (
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

func sum(rows []Row) Money {
	var m Money
	for _, r := range rows {
		m.TotalUSD += r.TotalUSD
		m.ReportedUSD += r.ReportedUSD
		m.AttributedUSD += r.AttributedUSD
	}
	return m
}

// bestSum adds up the best costs of the sessions a filter selects, the long way.
func bestSum(c *Catalog, f Filter) (total float64, n int) {
	f.States = nil
	for _, s := range c.view().sessions {
		if f.selects(s, "") {
			total += s.info.Cost.BestUSD
			n++
		}
	}
	return
}

// checkIdentities verifies that every grouping of the selected spend adds up to the sum of
// the sessions' best costs.
func checkIdentities(t *testing.T, c *Catalog, f Filter) {
	t.Helper()
	want, n := bestSum(c, f)
	if n == 0 {
		t.Fatalf("filter %+v selects nothing", f)
	}
	for name, rows := range map[string][]Row{
		"day":         c.Rollup(f, ByDay),
		"model":       c.Rollup(f, ByModel),
		"project":     c.Rollup(f, ByProject),
		"kind":        c.Rollup(f, ByKind),
		"project/day": c.Rollup(f, ByProject, ByDay),
		"model/day":   c.Rollup(f, ByModel, ByDay),
		"all":         c.Rollup(f),
	} {
		got := sum(rows)
		wantNear(t, name+" rollup total", got.TotalUSD, want)
		wantNear(t, name+" reported+attributed", got.ReportedUSD+got.AttributedUSD, want)
	}
	m := c.Total(f)
	wantNear(t, "Total", m.TotalUSD, want)
}

func TestRollupIdentitiesOnFixtures(t *testing.T) {
	for _, zone := range []string{"UTC", "America/New_York", "Asia/Tokyo"} {
		t.Run(zone, func(t *testing.T) {
			setZone(t, zone)
			c := fixtureCatalog(t)
			checkIdentities(t, c, Filter{})
			checkIdentities(t, c, Filter{Kinds: []model.SessionKind{model.KindInteractive}})
			checkIdentities(t, c, Filter{Kinds: []model.SessionKind{model.KindSDK}})
			checkIdentities(t, c, Filter{Project: "/home/dev/acme/coststate"})
			checkIdentities(t, c, Filter{Since: time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC), Until: time.Date(2026, 9, 17, 0, 0, 0, 0, time.UTC)})
			if len(c.Rollup(Filter{}, ByModel)) < 4 {
				t.Errorf("model rollup too short")
			}
		})
	}
}

func TestFixtureTotalCountsSharedHistoryOnce(t *testing.T) {
	c := fixtureCatalog(t)
	// Naive sum of digest costs over-counts the five copied-history pairs.
	naive := 0.0
	for _, d := range goldens(t) {
		naive += d.Cost.USD
	}
	dups := 0.0
	for _, s := range c.view().sessions {
		dups += s.info.Cost.InheritedUSD
	}
	if dups < 0.05 {
		t.Fatalf("expected inherited spend across the pairs, got %v", dups)
	}
	// reported windows replace attributed spend inside them, so compare attributed only
	var own float64
	for _, s := range c.view().sessions {
		own += s.info.Cost.OwnUSD
	}
	wantNear(t, "naive - inherited = owned", naive-dups, own)
}

func TestDayBoundaryAtLocalMidnight(t *testing.T) {
	setZone(t, "America/New_York")
	c := fixtureCatalog(t)
	rows := c.Rollup(Filter{Project: "/home/dev/acme/daybound"}, ByDay)
	if len(rows) != 2 {
		t.Fatalf("rows = %+v", rows)
	}
	if rows[0].Day != "2026-09-18" || rows[1].Day != "2026-09-19" {
		t.Errorf("days = %s %s", rows[0].Day, rows[1].Day)
	}
	wantNear(t, "2026-09-18", rows[0].TotalUSD, 0.0136)
	wantNear(t, "2026-09-19", rows[1].TotalUSD, 0.00308)
	// in UTC all of it falls on one day
	setZone(t, "UTC")
	rows = c.Rollup(Filter{Project: "/home/dev/acme/daybound"}, ByDay)
	if len(rows) != 1 || rows[0].Day != "2026-09-19" {
		t.Errorf("UTC rows = %+v", rows)
	}
	// day range filter
	setZone(t, "America/New_York")
	r := c.Rollup(Filter{Project: "/home/dev/acme/daybound", DayFrom: "2026-09-19"}, ByDay)
	if len(r) != 1 || !near(r[0].TotalUSD, 0.00308) {
		t.Errorf("DayFrom rows = %+v", r)
	}
}

func TestReportedCostFixture(t *testing.T) {
	c := fixtureCatalog(t)
	s, _ := c.Session(sid("16", "01"))
	cost := s.Cost
	if cost.Flag != CostExact {
		t.Errorf("flag = %s", cost.Flag)
	}
	wantNear(t, "best = reported", cost.BestUSD, 0.1172)
	wantNear(t, "own", cost.OwnUSD, 0.1157)
	wantNear(t, "overhead = the hidden haiku line", cost.OverheadUSD, 0.0015)
	wantNear(t, "uncovered", cost.UncoveredUSD, 0)
	// the model rollup carries the overhead as its own line
	var overhead float64
	var models float64
	for _, r := range c.Rollup(Filter{Project: "/home/dev/acme/coststate"}, ByModel) {
		if r.Model == OverheadModel {
			overhead = r.TotalUSD
		} else {
			models += r.TotalUSD
		}
	}
	wantNear(t, "overhead line", overhead, 0.0015)
	wantNear(t, "model lines", models, 0.1157)

	// A session without windows is estimated from tokens.
	p, _ := c.Session(sid("01", "01"))
	if p.Cost.Flag != CostEstimated || !near(p.Cost.BestUSD, 0.02124) {
		t.Errorf("plain: %+v", p.Cost)
	}
}

func TestPartialWindows(t *testing.T) {
	// Two windows with spend before, between and after them.
	tu := []model.Turn{turn(0, "u0", "go", 0)}
	d := syn("claude", "w", "/p", 0, 100, tu,
		msgSpec{"before", 1, 5, 0},     // 0:01 outside
		msgSpec{"in1", 11, 10, 0},      // window 1 (10..20)
		msgSpec{"in1b", 19, 10, 0},     // window 1
		msgSpec{"between", 40, 3, 0},   // outside
		msgSpec{"in2", 62, 20, 0},      // window 2 (60..70)
		msgSpec{"edge", 70, 7, 0},      // at the end of window 2: inside
		msgSpec{"slack", 70 + 0, 0, 0}, // free message, irrelevant
		msgSpec{"after", 90, 2, 0},     // outside
	)
	// the harness reported 1.5x what the transcript shows in each window
	withWindows(d, window(10, 20, 30), window(60, 70, 40.5))
	c := New()
	c.Upsert(d)
	s, _ := c.Session(key("w"))
	cost := s.Cost
	if cost.Flag != CostPartial {
		t.Errorf("flag = %s", cost.Flag)
	}
	wantNear(t, "reported", cost.ReportedUSD, 70.5)
	wantNear(t, "covered", cost.CoveredUSD, 47)
	wantNear(t, "uncovered", cost.UncoveredUSD, 10)
	wantNear(t, "best = reported + uncovered", cost.BestUSD, 80.5)
	wantNear(t, "overhead = reported - covered", cost.OverheadUSD, 23.5)
	wantNear(t, "own", cost.OwnUSD, 57)
	checkIdentities(t, c, Filter{})

	// a message 500 ms past the end of a window still counts as inside it
	d2 := syn("claude", "slack", "/p", 0, 100, tu, msgSpec{"x", 0, 1, 0})
	d2.Messages[0].At = at(20).Add(900 * time.Millisecond)
	withWindows(d2, window(10, 20, 2))
	c.Upsert(d2)
	if s, _ := c.Session(key("slack")); s.Cost.Flag != CostExact {
		t.Errorf("slack: %+v", s.Cost)
	}
	d2.Messages[0].At = at(20).Add(1100 * time.Millisecond)
	c.Upsert(d2)
	if s, _ := c.Session(key("slack")); s.Cost.Flag != CostPartial {
		t.Errorf("past the slack: %+v", s.Cost)
	}
}

func TestOverheadIsSpreadOverDays(t *testing.T) {
	setZone(t, "UTC")
	tu := []model.Turn{turn(0, "u0", "go", 0)}
	d := syn("claude", "span", "/p", 0, 3000, tu,
		msgSpec{"d1", 60, 3, 0},         // 2026-10-01
		msgSpec{"d2", 24*60 + 60, 1, 0}, // 2026-10-02
	)
	// one window over both days; reported 8, transcript 4 -> overhead 4 split 3:1
	withWindows(d, model.ReportedWindow{From: at(0), To: at(24*60 + 120), TotalUSD: 8})
	c := New()
	c.Upsert(d)
	rows := c.Rollup(Filter{}, ByDay)
	if len(rows) != 2 || !near(rows[0].TotalUSD, 6) || !near(rows[1].TotalUSD, 2) {
		t.Fatalf("rows = %+v", rows)
	}
	checkIdentities(t, c, Filter{})
	s, _ := c.Session(key("span"))
	wantNear(t, "overhead", s.Cost.OverheadUSD, 4)

	// a window with no covered message at all: its total lands on the day it ended
	e := syn("claude", "empty", "/p", 0, 3000, tu)
	withWindows(e, model.ReportedWindow{From: at(1), To: at(24*60 + 5), TotalUSD: 1.5})
	c.Upsert(e)
	rows = c.Rollup(Filter{Project: "/p"}, ByDay)
	if len(rows) != 2 || !near(rows[1].TotalUSD, 3.5) {
		t.Errorf("rows = %+v", rows)
	}
	checkIdentities(t, c, Filter{})
}

func TestSharedWindowCountsOnce(t *testing.T) {
	// B resumed A with the counter restored: both digests carry the window that starts at
	// minute 10. It belongs to the earlier session.
	tu := []model.Turn{turn(0, "u0", "go", 0)} // the shared prompt links them
	a := syn("claude", "a", "/p", 0, 30, tu, msgSpec{"a1", 12, 4, 0}, msgSpec{"a2", 40, 1, 0})
	withWindows(a, window(10, 20, 6))
	b := syn("claude", "b", "/p", 5, 60, tu, msgSpec{"b1", 12, 2, 0}, msgSpec{"b2", 50, 8, 0})
	withWindows(b, window(10, 55, 20))
	for _, order := range [][]*model.SessionDigest{{a, b}, {b, a}} {
		c := New()
		for _, d := range order {
			c.Upsert(d)
		}
		sa, _ := c.Session(key("a"))
		sb, _ := c.Session(key("b"))
		wantNear(t, "a reported", sa.Cost.ReportedUSD, 6)
		wantNear(t, "b reported (window not repeated)", sb.Cost.ReportedUSD, 0)
		if sb.Cost.Flag != CostEstimated {
			t.Errorf("b flag = %s", sb.Cost.Flag)
		}
		// a: window total 6 + a2 outside; b: only attributed spend, window not shared
		wantNear(t, "a best", sa.Cost.BestUSD, 6+1)
		wantNear(t, "b best", sb.Cost.BestUSD, 2+8)
		if c.Diagnostics().SharedWindows != 1 {
			t.Errorf("shared windows = %d", c.Diagnostics().SharedWindows)
		}
		checkIdentities(t, c, Filter{})
	}
}

func TestSameProjectTwoHarnesses(t *testing.T) {
	tu := []model.Turn{turn(0, "", "go", 0)}
	a := syn("claude", "s1", "/work/app", 0, 10, tu, msgSpec{"c1", 1, 3, 0})
	b := syn("codex", "s1", "/work/app", 0, 10, tu, msgSpec{"x1", 1, 4, 0})
	b.ProjectKey = "other-storage-key"
	c := New()
	c.Upsert(a)
	c.Upsert(b)
	rows := c.Rollup(Filter{}, ByProject)
	if len(rows) != 1 || rows[0].Sessions != 2 || !near(rows[0].TotalUSD, 7) {
		t.Errorf("rows = %+v", rows)
	}
	if got := c.Total(Filter{Harness: "codex"}).TotalUSD; !near(got, 4) {
		t.Errorf("codex only = %v", got)
	}
	// same session id in two harnesses are two sessions
	if _, ok := c.Session(model.SessionKey{Harness: "codex", ID: "s1"}); !ok {
		t.Errorf("codex/s1 missing")
	}
	if l := c.List(Filter{}, Liveness{}); len(l.Sessions) != 2 {
		t.Errorf("listed %d", len(l.Sessions))
	}
	files := c.ProjectFiles()
	if len(files) != 2 || files[0].Harness != "claude" || files[1].ProjectKey != "other-storage-key" {
		t.Errorf("project files = %+v", files)
	}
}

func TestScriptedSessionsAreAggregated(t *testing.T) {
	setZone(t, "UTC")
	c := fixtureCatalog(t)
	l := c.List(Filter{}, Liveness{})
	for _, s := range l.Sessions {
		if s.Kind == model.KindSDK {
			t.Errorf("scripted session listed: %v", s.Key)
		}
	}
	if len(l.Sessions) != 34 {
		t.Errorf("listed %d sessions, want 34 (35 minus the scripted one)", len(l.Sessions))
	}
	if len(l.Scripted) != 1 {
		t.Fatalf("scripted lines = %+v", l.Scripted)
	}
	line := l.Scripted[0]
	if line.Project != "/home/dev/acme/sdk" || line.Day != "2026-09-15" || line.Count != 1 {
		t.Errorf("line = %+v", line)
	}
	wantNear(t, "line cost (reported window)", line.TotalUSD, 0.0139)
	// ... and the rollups count it
	rows := c.Rollup(Filter{}, ByKind)
	var sdk float64
	for _, r := range rows {
		if r.Kind == "sdk" {
			sdk = r.TotalUSD
		}
	}
	wantNear(t, "sdk in kind rollup", sdk, 0.0139)
	if all, _ := bestSum(c, Filter{}); !near(c.Total(Filter{}).TotalUSD, all) {
		t.Errorf("totals disagree")
	}
	// kind filter: interactive only has no scripted lines; sdk only lists nothing
	if got := c.List(Filter{Kinds: []model.SessionKind{model.KindInteractive}}, Liveness{}); len(got.Scripted) != 0 {
		t.Errorf("scripted lines under an interactive filter: %+v", got.Scripted)
	}
	if got := c.List(Filter{Kinds: []model.SessionKind{model.KindSDK}}, Liveness{}); len(got.Sessions) != 0 || len(got.Scripted) != 1 {
		t.Errorf("sdk filter: %d sessions, %d lines", len(got.Sessions), len(got.Scripted))
	}

	// many scripted runs of one project and day make one line
	for i := 0; i < 5; i++ {
		d := syn("claude", "run"+string(rune('a'+i)), "/p/eval", 0, 1, []model.Turn{turn(0, "", "x", 0)}, msgSpec{"r" + string(rune('a'+i)), 0, 0.5, 0})
		d.Kind = model.KindSDK
		c.Upsert(d)
	}
	l = c.List(Filter{Project: "/p/eval"}, Liveness{})
	if len(l.Sessions) != 0 || len(l.Scripted) != 1 || l.Scripted[0].Count != 5 || !near(l.Scripted[0].TotalUSD, 2.5) {
		t.Errorf("eval: %+v", l)
	}
}

func TestListFilters(t *testing.T) {
	c := fixtureCatalog(t)
	l := c.List(Filter{Project: "/home/dev/acme/plain"}, Liveness{})
	if len(l.Sessions) != 1 || l.Sessions[0].Title != "Add login page" {
		t.Errorf("project filter: %+v", l.Sessions)
	}
	all := c.List(Filter{}, Liveness{}).Sessions
	for i := 1; i < len(all); i++ {
		if all[i].LastActivityAt.After(all[i-1].LastActivityAt) {
			t.Fatalf("not sorted by last activity at %d", i)
		}
	}
	since := time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC)
	for _, s := range c.List(Filter{Since: since}, Liveness{}).Sessions {
		if s.LastActivityAt.Before(since) {
			t.Errorf("%v before since", s.Key)
		}
	}
}

func TestUnrelatedSessionsKeepTheirOwnWindows(t *testing.T) {
	// Scripted runs launched in the same millisecond have identical window starts but share
	// no history: both windows count.
	a := syn("claude", "a", "/p", 0, 30, []model.Turn{turn(0, "ua", "one", 0)}, msgSpec{"a1", 12, 4, 0})
	b := syn("claude", "b", "/q", 0, 30, []model.Turn{turn(0, "ub", "two", 0)}, msgSpec{"b1", 12, 2, 0})
	withWindows(a, window(10, 20, 6))
	withWindows(b, window(10, 20, 3))
	c := New()
	c.Upsert(a)
	c.Upsert(b)
	sa, _ := c.Session(key("a"))
	sb, _ := c.Session(key("b"))
	wantNear(t, "a reported", sa.Cost.ReportedUSD, 6)
	wantNear(t, "b reported", sb.Cost.ReportedUSD, 3)
	wantNear(t, "total", c.Total(Filter{}).TotalUSD, 9)
	if c.Diagnostics().SharedWindows != 0 {
		t.Errorf("shared windows = %d", c.Diagnostics().SharedWindows)
	}
	checkIdentities(t, c, Filter{})
}

func TestParentWithSubagentMessagesInsideSharedRangeStaysParent(t *testing.T) {
	// A copy keeps the original timestamps, so startedAt ties. The parent has subagent
	// messages before the last shared message, which the copy does not carry, and it
	// outlives the child; plain last-activity order would pick the child as parent.
	ts := []model.Turn{turn(0, "u0", "first", 0), turn(1, "u1", "second", 1)}
	P := syn("claude", "p", "/p", 0, 60, append(slicesClone(ts), turn(2, "up2", "parent goes on", 40)),
		msgSpec{"m1", 0, 1, 0}, msgSpec{"m2", 3, 2, 1}, msgSpec{"mp3", 40, 4, 2})
	P.Messages = append(P.Messages, model.Message{ID: "sub1", At: at(2), Model: "sonnet", USD: 16, AgentID: "agent1"})
	C := syn("claude", "c", "/p", 0, 20, append(slicesClone(ts), turn(2, "uc2", "child own", 5)),
		msgSpec{"m1", 0, 1, 0}, msgSpec{"m2", 3, 2, 1}, msgSpec{"mc3", 5, 8, 2})
	for _, order := range [][]*model.SessionDigest{{P, C}, {C, P}} {
		c := New()
		for _, d := range order {
			c.Upsert(d)
		}
		pi, _ := c.Session(key("p"))
		ci, _ := c.Session(key("c"))
		if ci.Parent == nil || ci.Parent.Parent != key("p") || pi.Parent != nil {
			t.Fatalf("parent=%+v child=%+v", pi.Parent, ci.Parent)
		}
		if ci.Parent.Kind != LinkFork {
			t.Errorf("kind = %s (the parent went on)", ci.Parent.Kind)
		}
		wantNear(t, "child inherits", ci.Cost.InheritedUSD, 3)
		wantNear(t, "parent owns the shared messages", pi.Cost.OwnUSD, 23)
		wantNear(t, "total", c.Total(Filter{}).TotalUSD, 31)
	}
}

func TestOwnershipAmongThreeSharersFollowsLineage(t *testing.T) {
	// m1 is held by A, B (copy of A) and C (copy of B). The owner is the one that is a
	// child of no other holder, whatever the load order.
	ts := []model.Turn{turn(0, "u0", "first", 0)}
	A := syn("claude", "a", "/p", 0, 50, ts, msgSpec{"m1", 0, 1, 0})
	B := syn("claude", "b", "/p", 0, 20, ts, msgSpec{"m1", 0, 1, 0}, msgSpec{"mb", 5, 2, 0})
	C := syn("claude", "c", "/p", 0, 10, ts, msgSpec{"m1", 0, 1, 0}, msgSpec{"mb", 5, 2, 0}, msgSpec{"mc", 8, 4, 0})
	sub := model.Message{ID: "sub", At: at(3), Model: "sonnet", USD: 8, AgentID: "x"}
	// only the parent has the subagent message "subA", which predates the shared range
	A.Messages = append(A.Messages, sub, model.Message{ID: "subA", At: at(1), Model: "sonnet", USD: 16, AgentID: "y"})
	C.Messages = append(C.Messages, sub)
	B.Messages = append(B.Messages, model.Message{ID: "sub", At: at(3), Model: "sonnet", USD: 8, AgentID: "x"})
	for _, order := range [][]*model.SessionDigest{{A, B, C}, {C, B, A}, {B, C, A}} {
		c := New()
		for _, d := range order {
			c.Upsert(d)
		}
		a, _ := c.Session(key("a"))
		if a.Cost.OwnMessages != 3 || a.Parent != nil {
			t.Errorf("A = %+v", a.Cost)
		}
		wantNear(t, "total", c.Total(Filter{}).TotalUSD, 1+2+4+8+16)
	}
}

func TestParentContinuedInsideTheSameTurn(t *testing.T) {
	mk := func(withExtra bool) *Catalog {
		ts := []model.Turn{turn(0, "u0", "first", 0), turn(1, "u1", "second", 1)}
		specs := []msgSpec{{"m1", 0, 1, 0}, {"m2", 1, 2, 1}}
		if withExtra {
			specs = append(specs, msgSpec{"m3", 8, 4, 1}, msgSpec{"m4", 9, 4, 1}) // same turn, after the copy
		}
		last := 3
		if withExtra {
			last = 9
		}
		A := syn("claude", "a", "/p", 0, last, ts, specs...)
		B := syn("claude", "b", "/p", 0, 30, append(slicesClone(ts), turn(2, "ub2", "child own", 20)),
			msgSpec{"m1", 0, 1, 0}, msgSpec{"m2", 1, 2, 1}, msgSpec{"mb", 20, 8, 2})
		c := New()
		c.Upsert(A)
		c.Upsert(B)
		return c
	}
	b, _ := mk(true).Session(key("b"))
	if b.Parent == nil || b.Parent.Parent != key("a") || b.Parent.AtTurn != 1 || b.Parent.Kind != LinkFork {
		t.Errorf("parent kept going in turn 1: %+v", b.Parent)
	}
	b, _ = mk(false).Session(key("b"))
	if b.Parent == nil || b.Parent.Kind != LinkContinuation {
		t.Errorf("parent stopped: %+v", b.Parent)
	}
}
