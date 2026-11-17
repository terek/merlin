package catalog

import (
	"encoding/json"
	"strings"
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
	// Bounds are applied to the minute: the window ends at 14:59, so a2 (14:59:00) is out.
	if w.SeenUSD == nil || *w.SeenUSD != 17 || w.SeenSessions != 2 {
		t.Errorf("seen = %v over %d sessions, want 17 over 2", w.SeenUSD, w.SeenSessions)
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
	if string(b) != `{"windows":[],"refusals":[],"lockouts":[]}` {
		t.Errorf("empty = %s", b)
	}
}

func TestLockoutRecoveryAcrossSessions(t *testing.T) {
	c := New()
	account := model.AccountKey("invented-account")
	other := model.AccountKey("another-account")
	reset := at(30 * 24 * 60)
	refusal := func(min int) model.LimitReading {
		return model.LimitReading{At: at(min), Limit: "overage", Kind: "spend_cap", Rejected: true, ResetsAt: reset}
	}
	rejected := limitSession("claude", "refused", 0, []model.LimitReading{refusal(5), refusal(6), refusal(150)})
	rejected.Account = account
	c.Upsert(rejected)
	call := func(id, acct, modelName string, min int, usage bool) {
		d := limitSession("claude", id, min, nil, msgSpec{id, min, 1, 0})
		d.Account, d.Messages[0].Model = acct, modelName
		d.Messages[0].Tokens = model.Tokens{}
		if usage {
			d.Messages[0].Input = 1
		}
		d.Kind = model.KindSDK
		c.Upsert(d)
	}
	call("synthetic", account, "<synthetic>", 10, true)
	call("no-usage", account, "claude-opus-4-6", 15, false)
	call("other", other, "claude-opus-4-6", 20, true)
	call("unknown", "", "claude-opus-4-6", 25, true)
	call("resumed", account, "claude-opus-4-6", 125, true)
	l := c.LimitsAt(at(180))
	if len(l.Windows) != 1 || l.Windows[0].Kind != "spend_cap" || !l.Windows[0].StartsAt.IsZero() || l.Windows[0].SeenUSD != nil {
		t.Fatalf("windows = %+v", l.Windows)
	}
	if len(l.Lockouts) != 2 {
		t.Fatalf("lockouts = %+v", l.Lockouts)
	}
	first, next := l.Lockouts[0], l.Lockouts[1]
	if first.Account != account || first.AccountLabel != "Account 1" || first.End != "resumed" ||
		!first.EndedAt.Equal(at(125)) || !first.WorkResumedAt.Equal(at(20)) || !first.ResetsAt.Equal(reset) {
		t.Errorf("first lockout = %+v", first)
	}
	if next.End != "open" || !next.StartedAt.Equal(at(150)) || !next.EndedAt.IsZero() {
		t.Errorf("next lockout = %+v", next)
	}
	next = c.LimitsAt(reset).Lockouts[1]
	if next.End != "reset" || !next.EndedAt.Equal(reset) {
		t.Errorf("past reset = %+v", next)
	}
}

func TestLockoutRecoveryMatchesModelAndAccount(t *testing.T) {
	c := New()
	known := model.AccountKey("known")
	d := limitSession("claude", "refused", 0, []model.LimitReading{
		{At: at(5), Limit: "seven_day_opus", WindowMinutes: 10080, ResetsAt: at(300), Rejected: true},
	})
	c.Upsert(d)
	for _, tc := range []struct {
		id, account, model string
		at                 int
	}{
		{"known-opus", known, "claude-opus-4-6", 8},
		{"unknown-sonnet", "", "claude-sonnet-4-6", 10},
		{"unknown-opus", "", "claude-opus-4-6[1m]", 15},
	} {
		s := limitSession("claude", tc.id, tc.at, nil, msgSpec{tc.id, tc.at, 0, 0})
		s.Account, s.Messages[0].Model, s.Messages[0].CacheRead = tc.account, tc.model, 1
		c.Upsert(s)
	}
	l := c.LimitsAt(at(30))
	if len(l.Lockouts) != 1 || !l.Lockouts[0].EndedAt.Equal(at(15)) || !l.Lockouts[0].WorkResumedAt.Equal(at(8)) ||
		l.Lockouts[0].AccountLabel != "" {
		t.Errorf("lockouts = %+v", l.Lockouts)
	}
}

func TestLimitWindowSpendMatchesAccountAndPlan(t *testing.T) {
	setZone(t, "UTC")
	c := New()
	account := model.AccountKey("first")
	reset := at(300)
	old, newPlan := codexRead(20, 95, reset), codexRead(40, 90, reset)
	newPlan.Plan = "pro"
	newPlan2 := codexRead(350, 98, at(620))
	newPlan2.Plan = "pro"
	a := limitSession("codex", "A", 0, []model.LimitReading{old, newPlan, newPlan2},
		msgSpec{"a1", 50, 3, 0}, msgSpec{"a2", 400, 5, 0}, msgSpec{"a3", 430, 33, 0})
	a.Account = account
	a.Messages[2].AccountKnown = true // a child with an unknown account
	c.Upsert(a)
	b := limitSession("codex", "B", 50, []model.LimitReading{codexRead(60, 95, reset)},
		msgSpec{"b1", 110, 16, 0})
	b.Account = model.AccountKey("second")
	c.Upsert(b)
	l := c.LimitsAt(at(700))
	if len(l.Windows) != 4 {
		t.Fatalf("windows = %+v", l.Windows)
	}
	for _, w := range l.Windows {
		switch {
		case w.Account == a.Account && w.ResetsAt.Equal(reset):
			if w.PlanPeriod == "" || w.SeenUSD != nil {
				t.Errorf("crosses plan observation boundary: %+v", w)
			}
		case w.Account == a.Account:
			if w.Plan != "pro" || w.SeenUSD == nil || *w.SeenUSD != 5 || w.SeenSessions != 1 || w.TopSessions[0].ID != "A" {
				t.Errorf("first account: %+v", w)
			}
		case w.Account == b.Account:
			if w.SeenUSD == nil || *w.SeenUSD != 16 || w.AccountLabel != "Account 2" {
				t.Errorf("second account: %+v", w)
			}
		default:
			t.Errorf("unexpected account: %+v", w)
		}
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

// A window's figures come from the Cost code path: seenUSD is Total over (harness, window), the
// scripted run counts in it but is never listed, and another harness's spend stays out.
func TestLimitsSeenFromCost(t *testing.T) {
	setZone(t, "UTC")
	r := at(300) // the window runs [at(0), at(300))
	c := New()
	c.Upsert(limitSession("codex", "A", 0, []model.LimitReading{codexRead(5, 0, r), codexRead(250, 40, r)}, msgSpec{"a1", 10, 10, 0}))
	c.Upsert(limitSession("codex", "B", 0, nil, msgSpec{"b1", 20, 5, 0}))
	c.Upsert(limitSession("codex", "C", 0, nil, msgSpec{"c1", 100, 3, 0}))
	c.Upsert(limitSession("codex", "E", 0, nil, msgSpec{"e1", 110, 3, 0}))
	c.Upsert(limitSession("codex", "D", 0, nil, msgSpec{"d1", 260, 2, 0}))
	s := limitSession("codex", "S", 0, nil, msgSpec{"s1", 30, 100, 0})
	s.Kind = model.KindSDK
	c.Upsert(s)
	c.Upsert(limitSession("claude", "X", 0, nil, msgSpec{"x1", 20, 64, 0}))
	// A second window, 0 to 5 percent.
	r2 := at(600)
	c.Upsert(limitSession("codex", "F", 310, []model.LimitReading{codexRead(310, 0, r2), codexRead(400, 5, r2)}, msgSpec{"f1", 350, 7, 0}))

	l := c.Limits()
	if len(l.Windows) != 2 {
		t.Fatalf("windows = %+v", l.Windows)
	}
	w := l.Windows[0]
	f := Filter{Harness: "codex", From: w.StartsAt, To: w.ResetsAt}
	want := c.Total(f).TotalUSD
	wantNear(t, "total", want, 123) // 10+5+3+3+2+100, no Claude spend
	if w.SeenUSD == nil || !near(*w.SeenUSD, want) || w.SeenSessions != 6 {
		t.Errorf("seen = %v over %d sessions, want %v over 6", w.SeenUSD, w.SeenSessions, want)
	}
	wantNear(t, "scripted", w.ScriptedUSD, 100)
	if len(w.TopSessions) != 3 || w.TopSessions[0].ID != "A" || w.TopSessions[1].ID != "B" || w.TopSessions[2].ID != "C" ||
		w.TopSessions[0].USD != 10 || w.TopSessions[0].Harness != "codex" || w.TopSessions[0].Title != "session A" {
		t.Errorf("top = %+v", w.TopSessions)
	}
	for _, ts := range w.TopSessions {
		if ts.ID == "S" {
			t.Errorf("a scripted run is listed: %+v", w.TopSessions)
		}
	}
	// 0 -> 40 percent: the cost from the first to the last reading per point.
	if w.UsdPerPercent == nil {
		t.Fatal("no usdPerPercent for a 0 -> 40 window")
	}
	between := c.Total(Filter{Harness: "codex", From: at(5), To: at(250)}).TotalUSD
	wantNear(t, "usdPerPercent", *w.UsdPerPercent, between/40)
	if n := l.Windows[1]; n.UsdPerPercent != nil || n.ScriptedUSD != 0 || len(n.TopSessions) != 1 {
		t.Errorf("0 -> 5 window = %+v", n)
	}
	b, _ := json.Marshal(l.Windows[1])
	if !json.Valid(b) || !containsNot(string(b), "usdPerPercent", "scriptedUSD") {
		t.Errorf("window json = %s", b)
	}
	b, _ = json.Marshal(w)
	t.Logf("window: %s", b)

	// A window with no spend lists no sessions: [] not null.
	e := New()
	e.Upsert(limitSession("codex", "Z", 0, []model.LimitReading{codexRead(5, 0, r)}))
	b, _ = json.Marshal(e.Limits().Windows[0].TopSessions)
	if string(b) != "[]" {
		t.Errorf("topSessions = %s", b)
	}
}

func containsNot(s string, words ...string) bool {
	for _, w := range words {
		if strings.Contains(s, w) {
			return false
		}
	}
	return true
}

// A session with no spend inside the window is neither counted nor listed.
func TestLimitsTopSkipsZeroSpend(t *testing.T) {
	setZone(t, "UTC")
	r := at(300)
	c := New()
	c.Upsert(limitSession("codex", "A", 0, []model.LimitReading{codexRead(10, 0, r)}, msgSpec{"a1", 20, 5, 0}))
	c.Upsert(limitSession("codex", "Z", 30, []model.LimitReading{codexRead(40, 1, r)}, msgSpec{"z1", 50, 0, 0}))
	w := c.Limits().Windows
	if len(w) != 1 || w[0].SeenSessions != 1 || len(w[0].TopSessions) != 1 || w[0].TopSessions[0].ID != "A" {
		t.Errorf("windows = %+v", w)
	}
}
