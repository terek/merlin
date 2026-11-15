package catalog

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

func pct(p float64) *float64 { return &p }

func codexRead(min int, p float64, resets time.Time) model.LimitReading {
	return model.LimitReading{At: at(min), Limit: "codex", WindowMinutes: 300, UsedPercent: pct(p), ResetsAt: resets, Plan: "plus"}
}

func limitSession(harness, id string, startMin int, lims []model.LimitReading, msgs ...msgSpec) *model.SessionDigest {
	d := syn(harness, id, "/p/"+id, startMin, startMin+400, []model.Turn{turn(0, "u-"+id, "go", startMin)}, msgs...)
	d.Limits = lims
	return d
}

func TestLimitsMergeCodexWindows(t *testing.T) {
	setZone(t, "UTC")
	r1 := at(300) // the window runs [at(0), at(300))
	c := New()
	c.Upsert(limitSession("codex", "A", 0, []model.LimitReading{
		codexRead(10, 20, r1), codexRead(200, 40, r1.Add(15*time.Second)),
		{At: at(205), Rejected: true}, // no limit named: a refusal, in no window
	}, msgSpec{"a0", -5, 4, 0}, msgSpec{"a1", 10, 1, 0}, msgSpec{"a2", 299, 2, 0}, msgSpec{"a3", 300, 8, 0}))
	c.Upsert(limitSession("codex", "B", 50, []model.LimitReading{
		codexRead(60, 25, r1.Add(-12*time.Second)), codexRead(100, 40, r1.Add(5*time.Second)),
		codexRead(100, 40, r1.Add(5*time.Second)), // the same point twice
	}, msgSpec{"b1", 100, 16, 0}))
	r2 := r1.Add(5 * time.Hour)
	c.Upsert(limitSession("codex", "C", 310, []model.LimitReading{codexRead(320, 3, r2)}, msgSpec{"c1", 330, 32, 0}))
	// A Claude session spending in the same hours must not count for a Codex window.
	c.Upsert(limitSession("claude", "X", 0, nil, msgSpec{"x1", 20, 64, 0}))

	l := c.Limits()
	if len(l.Windows) != 2 {
		t.Fatalf("windows = %+v", l.Windows)
	}
	w := l.Windows[0]
	if w.Harness != "codex" || w.Limit != "codex" || w.WindowMinutes != 300 || w.Plan != "plus" ||
		!w.ResetsAt.Equal(r1.Add(-12*time.Second)) || !w.StartsAt.Equal(w.ResetsAt.Add(-5*time.Hour)) {
		t.Errorf("window = %+v", w)
	}
	if !w.FirstSeenAt.Equal(at(10)) || !w.LastSeenAt.Equal(at(200)) || *w.FirstPercent != 20 || *w.MaxPercent != 40 || w.Refusals != 0 {
		t.Errorf("window = %+v", w)
	}
	if len(w.Points) != 4 || !w.Points[0].At.Equal(at(10)) || w.Points[1].UsedPercent != 25 || w.Points[3].UsedPercent != 40 {
		t.Errorf("points = %+v", w.Points)
	}
	// resetsAt is 12 s early, so the window starts 12 s early too: a0 (5 min before) is out.
	if w.SeenUSD == nil || *w.SeenUSD != 19 || w.SeenSessions != 2 {
		t.Errorf("seen = %v over %d sessions, want 19 over 2", w.SeenUSD, w.SeenSessions)
	}
	if n := l.Windows[1]; !n.ResetsAt.Equal(r2) || *n.SeenUSD != 40 || n.SeenSessions != 2 { // a3 (at the reset of the first window) opens the second
		t.Errorf("later window = %+v", n)
	}
	if len(l.Refusals) != 1 || l.Refusals[0].Session == nil || l.Refusals[0].Session.ID != "A" || l.Refusals[0].Limit != "" {
		t.Errorf("refusals = %+v", l.Refusals)
	}
	b, _ := json.Marshal(w)
	t.Logf("window: %s", b)
}

func TestLimitsClaudeRefusalsMakeOneWindow(t *testing.T) {
	setZone(t, "UTC")
	resets := at(300)
	rej := func(min int) []model.LimitReading {
		return []model.LimitReading{{At: at(min), Limit: "five_hour", WindowMinutes: 300, ResetsAt: resets, Rejected: true}}
	}
	c := New()
	c.Upsert(limitSession("claude", "B", 100, rej(250), msgSpec{"b1", 150, 2, 0}))
	c.Upsert(limitSession("claude", "A", 0, rej(240), msgSpec{"a1", 10, 1, 0}))
	l := c.Limits()
	if len(l.Windows) != 1 {
		t.Fatalf("windows = %+v", l.Windows)
	}
	w := l.Windows[0]
	if w.Refusals != 2 || !w.FirstRefusalAt.Equal(at(240)) || w.FirstPercent != nil || w.MaxPercent != nil || len(w.Points) != 0 ||
		*w.SeenUSD != 3 || w.SeenSessions != 2 {
		t.Errorf("window = %+v", w)
	}
	if len(l.Refusals) != 2 || l.Refusals[0].Session == nil || l.Refusals[0].Session.ID != "A" || l.Refusals[1].Session.ID != "B" {
		t.Errorf("refusals = %+v", l.Refusals)
	}
	b, _ := json.Marshal(New().Limits())
	if string(b) != `{"windows":[],"refusals":[]}` {
		t.Errorf("empty = %s", b)
	}
}

// A window that does not say how long it is has no start: no spend either.
func TestLimitsUnknownWindowLength(t *testing.T) {
	c := New()
	d := limitSession("claude", "A", 0, []model.LimitReading{{At: at(5), Limit: "overage", ResetsAt: at(300), Rejected: true}}, msgSpec{"a1", 10, 1, 0})
	c.Upsert(d)
	w := c.Limits().Windows
	if len(w) != 1 || !w[0].StartsAt.IsZero() || w[0].SeenUSD != nil {
		t.Errorf("windows = %+v", w)
	}
}

// A scripted run's refusal counts in its window but names no session: scripted runs are never
// listed one by one.
func TestLimitsScriptedRefusalNamesNoSession(t *testing.T) {
	setZone(t, "UTC")
	d := limitSession("claude", "S", 0, []model.LimitReading{{At: at(10), Limit: "five_hour", WindowMinutes: 300, ResetsAt: at(300), Rejected: true}})
	d.Kind = model.KindSDK
	c := New()
	c.Upsert(d)
	l := c.Limits()
	if len(l.Windows) != 1 || l.Windows[0].Refusals != 1 {
		t.Fatalf("windows = %+v", l.Windows)
	}
	b, _ := json.Marshal(l.Refusals)
	if want := `[{"at":"` + at(10).Format(time.RFC3339) + `","harness":"claude","scripted":true,"limit":"five_hour","windowMinutes":300,"resetsAt":"` + at(300).Format(time.RFC3339) + `"}]`; string(b) != want {
		t.Errorf("refusals = %s\nwant       %s", b, want)
	}
}
