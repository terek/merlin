package server

import (
	"testing"
	"time"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
)

func TestLimits(t *testing.T) {
	r := newRig(t)
	var l catalog.Limits
	if code := r.get("/api/limits", &l); code != 200 {
		t.Fatal(code)
	}
	if l.Windows == nil || l.Refusals == nil || len(l.Windows) != 0 {
		t.Fatalf("the fixtures carry no limits: %+v", l)
	}

	resets := time.Date(2026, 10, 1, 15, 0, 0, 0, time.UTC)
	p := 40.0
	d := r.digest(r.cat.List(catalog.Filter{}, catalog.Liveness{}).Sessions[0].Key.ID)
	d.Limits = []model.LimitReading{
		{At: resets.Add(-time.Hour), Limit: "five_hour", WindowMinutes: 300, ResetsAt: resets, Rejected: true},
		{At: resets.Add(-2 * time.Hour), Limit: "five_hour", WindowMinutes: 300, UsedPercent: &p, ResetsAt: resets},
	}
	r.cat.Upsert(d)
	r.get("/api/limits", &l)
	if len(l.Windows) != 1 || len(l.Refusals) != 1 || l.Windows[0].Refusals != 1 {
		t.Fatalf("limits = %+v", l)
	}
	w := l.Windows[0]
	if w.Harness != d.Harness || w.Limit != "five_hour" || !w.ResetsAt.Equal(resets) || *w.MaxPercent != 40 || len(w.Points) != 1 {
		t.Errorf("window = %+v", w)
	}
	if rf := l.Refusals[0]; rf.Session == nil || *rf.Session != d.Key() || rf.Limit != "five_hour" || !rf.ResetsAt.Equal(resets) {
		t.Errorf("refusal = %+v", rf)
	}
}
