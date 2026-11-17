package server

import (
	"net/url"
	"testing"
	"time"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
)

// spender is a synthetic session whose messages are (time, USD) pairs.
func spender(harness, id string, spend map[time.Time]float64, lims ...model.LimitReading) *model.SessionDigest {
	t0 := time.Date(2026, 11, 14, 9, 0, 0, 0, time.UTC)
	d := &model.SessionDigest{SchemaVersion: model.SchemaVersion, Harness: harness, ID: id, ProjectKey: "k-" + id, Project: "/p/" + id,
		Cwd: "/p/" + id, Kind: model.KindInteractive, Title: "session " + id, StartedAt: t0, LastActivityAt: t0.Add(5 * time.Hour),
		Turns: []model.Turn{{Index: 0, UUID: "u-" + id, StartedAt: t0, UserText: "go", Origin: model.OriginHuman}}, Limits: lims}
	n := 0
	for at, usd := range spend {
		zero := 0
		d.Messages = append(d.Messages, model.Message{ID: id + string(rune('a'+n)), At: at, Model: "sonnet", USD: usd, Turn: &zero})
		d.Cost.USD += usd
		n++
	}
	return d
}

func TestCostInstantsAndHarness(t *testing.T) {
	r := newRig(t)
	utc := func(h, m, s int) time.Time { return time.Date(2026, 11, 14, h, m, s, 0, time.UTC) }
	r.cat.Upsert(spender("codex", "cx", map[time.Time]float64{utc(10, 0, 30): 1, utc(10, 59, 0): 2, utc(11, 0, 0): 4, utc(11, 30, 0): 8}))
	r.cat.Upsert(spender("claude", "cl", map[time.Time]float64{utc(10, 30, 0): 64}))

	var c CostTable
	q := "since=" + url.QueryEscape("2026-11-14T10:00:00Z") + "&until=" + url.QueryEscape("2026-11-14T11:00:00Z")
	r.get("/api/cost?by=day&harness=codex&"+q, &c)
	if len(c.Rows) != 1 || c.Rows[0].Key != "2026-11-14" || !near(c.Total.TotalUSD, 3) {
		t.Errorf("codex, instants: total %v rows %+v", c.Total.TotalUSD, c.Rows)
	}
	r.get("/api/cost?by=day&"+q, &c)
	if !near(c.Total.TotalUSD, 67) {
		t.Errorf("every harness: %v, want 67", c.Total.TotalUSD)
	}
	r.get("/api/cost?by=hour&harness=codex&"+q, &c) // the local hours of UTC+2
	if len(c.Rows) != 1 || c.Rows[0].Key != "2026-11-14T12" || !near(c.Rows[0].TotalUSD, 3) || !near(c.Total.TotalUSD, 3) {
		t.Errorf("by hour: %+v total %v", c.Rows, c.Total.TotalUSD)
	}
	for _, by := range []string{"model", "project", "kind"} {
		r.get("/api/cost?by="+by+"&harness=codex&"+q, &c)
		if !near(c.Total.TotalUSD, 3) {
			t.Errorf("by=%s total %v, want 3", by, c.Total.TotalUSD)
		}
	}
	// A date-only range keeps its meaning: the whole local day (UTC+2).
	r.get("/api/cost?by=day&harness=codex&since=2026-11-14&until=2026-11-14", &c)
	if !near(c.Total.TotalUSD, 15) {
		t.Errorf("date-only: %v, want 15", c.Total.TotalUSD)
	}
	// An instant only on one side.
	r.get("/api/cost?by=day&harness=codex&since=2026-11-14&until="+url.QueryEscape("2026-11-14T11:00:00Z"), &c)
	if !near(c.Total.TotalUSD, 3) {
		t.Errorf("date since, instant until: %v, want 3", c.Total.TotalUSD)
	}
	// harness filters by=session too.
	r.get("/api/cost?by=session&harness=claude&since=2026-11-14", &c)
	for _, row := range c.Rows {
		if row.Harness != "claude" {
			t.Errorf("by=session harness=claude: %+v", row)
		}
	}
	r.wantError("/api/cost?harness=bogus", 400, CodeInvalidParameter)
}

// /api/limits serves the same total as /api/cost over the window.
func TestLimitsMatchCost(t *testing.T) {
	r := newRig(t)
	resets := time.Date(2026, 11, 14, 14, 0, 0, 0, time.UTC) // the window runs 09:00-14:00
	utc := func(h, m, s int) time.Time { return time.Date(2026, 11, 14, h, m, s, 0, time.UTC) }
	p0, p1 := 0.0, 40.0
	r.cat.Upsert(spender("codex", "cx", map[time.Time]float64{utc(10, 0, 30): 1, utc(11, 0, 0): 4, utc(14, 0, 0): 8},
		model.LimitReading{At: utc(9, 30, 0), Limit: "codex", WindowMinutes: 300, UsedPercent: &p0, ResetsAt: resets},
		model.LimitReading{At: utc(12, 0, 0), Limit: "codex", WindowMinutes: 300, UsedPercent: &p1, ResetsAt: resets}))
	r.cat.Upsert(spender("claude", "cl", map[time.Time]float64{utc(10, 30, 0): 64}))

	var l catalog.Limits
	r.get("/api/limits", &l)
	if len(l.Windows) != 1 || l.Windows[0].SeenUSD == nil {
		t.Fatalf("limits = %+v", l)
	}
	w := l.Windows[0]
	var c CostTable
	r.get("/api/cost?by=model&harness="+w.Harness+"&since="+url.QueryEscape(w.StartsAt.Format(time.RFC3339))+"&until="+url.QueryEscape(w.ResetsAt.Format(time.RFC3339)), &c)
	if !near(c.Total.TotalUSD, *w.SeenUSD) || !near(*w.SeenUSD, 5) {
		t.Errorf("cost %v, seenUSD %v, want 5", c.Total.TotalUSD, *w.SeenUSD)
	}
	if w.UsdPerPercent == nil || !near(*w.UsdPerPercent, 5.0/40) || len(w.TopSessions) != 1 || w.TopSessions[0].ID != "cx" {
		t.Errorf("window = %+v", w)
	}
}

func TestAccountScopeMatchesLimitsCostAndOverview(t *testing.T) {
	r := newRig(t)
	at := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	account := model.AccountKey("invented-account")
	a := spender("claude", "a", map[time.Time]float64{at: 2},
		model.LimitReading{At: at.Add(time.Minute), Limit: "five_hour", WindowMinutes: 300, ResetsAt: at.Add(time.Hour), Rejected: true})
	a.Account = account
	r.cat.Upsert(a)
	r.cat.Upsert(spender("claude", "b", map[time.Time]float64{at: 4}))
	var limits catalog.Limits
	r.get("/api/limits", &limits)
	if len(limits.Windows) != 1 || limits.Windows[0].Account != account ||
		limits.Windows[0].SeenUSD == nil || *limits.Windows[0].SeenUSD != 2 {
		t.Fatalf("windows = %+v", limits.Windows)
	}
	var cost CostTable
	r.get("/api/cost?harness=claude&account="+account, &cost)
	if cost.Total.TotalUSD != 2 {
		t.Errorf("scoped cost = %+v", cost.Total)
	}
	var overview Overview
	q := "/api/overview?harness=claude&from=" + url.QueryEscape(at.Format(time.RFC3339)) +
		"&to=" + url.QueryEscape(at.Add(time.Hour).Format(time.RFC3339))
	r.get(q+"&account="+account, &overview)
	if len(overview.Lanes) != 1 || overview.Lanes[0].ID != "a" {
		t.Errorf("known-account lanes = %+v", overview.Lanes)
	}
	r.get(q+"&account=unknown", &overview)
	if len(overview.Lanes) != 1 || overview.Lanes[0].ID != "b" {
		t.Errorf("unknown-account lanes = %+v", overview.Lanes)
	}
}
