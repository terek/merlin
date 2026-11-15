package catalog

import (
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

// instantSession spends 1 at 10:00:30, 2 at 10:59:00, 4 at 11:00:00 and 8 at 11:30:00 (UTC).
func instantSession() *model.SessionDigest {
	d := syn("claude", "inst", "/p", 0, 200, []model.Turn{turn(0, "u0", "go", 0)},
		msgSpec{"i1", 0, 1, 0}, msgSpec{"i2", 0, 2, 0}, msgSpec{"i3", 0, 4, 0}, msgSpec{"i4", 0, 8, 0})
	for i, at := range []time.Time{
		t0.Add(30 * time.Second), t0.Add(59 * time.Minute), t0.Add(60 * time.Minute), t0.Add(90 * time.Minute),
	} {
		d.Messages[i].At = at
	}
	return d
}

func TestFilterInstantsCutFacts(t *testing.T) {
	setZone(t, "UTC")
	d := instantSession()
	c := New()
	c.Upsert(d)
	hm := func(h, m, s int) time.Time { return time.Date(2026, 10, 1, h, m, s, 0, time.UTC) }
	for _, tc := range []struct {
		name     string
		from, to time.Time
		want     float64
	}{
		{"unbounded", time.Time{}, time.Time{}, 15},
		{"from inside the first minute keeps that minute", hm(10, 0, 30), hm(11, 0, 0), 3},
		{"to inside a minute is rounded down", hm(10, 1, 0), hm(11, 0, 30), 2},
		{"to on a message minute excludes it", hm(10, 59, 0), hm(11, 30, 0), 6},
		{"from inside a minute is rounded down", hm(11, 0, 59), hm(11, 31, 0), 12},
		{"only from", hm(11, 0, 0), time.Time{}, 12},
		{"only to", time.Time{}, hm(11, 0, 0), 3},
		{"empty", hm(10, 5, 0), hm(10, 50, 0), 0},
	} {
		wantNear(t, tc.name, c.Total(Filter{From: tc.from, To: tc.to}).TotalUSD, tc.want)
	}

	// The rollups over the whole day do not change.
	wantNear(t, "day", c.Rollup(Filter{DayFrom: "2026-10-01", DayTo: "2026-10-01"}, ByDay)[0].TotalUSD, 15)
	hours := c.Rollup(Filter{}, ByHour)
	if len(hours) != 2 || hours[0].Hour != "2026-10-01T10" || !near(hours[0].TotalUSD, 3) || hours[1].Hour != "2026-10-01T11" || !near(hours[1].TotalUSD, 12) {
		t.Errorf("hours = %+v", hours)
	}
	// By hour inside an instant range: still local hours, the bounds exact.
	h := c.Rollup(Filter{From: hm(10, 59, 0), To: hm(11, 30, 0)}, ByHour)
	if len(h) != 2 || !near(h[0].TotalUSD, 2) || !near(h[1].TotalUSD, 4) {
		t.Errorf("hours in range = %+v", h)
	}

	// A message with no time passes only an unbounded range.
	d2 := syn("claude", "untimed", "/p", 0, 200, []model.Turn{turn(0, "u0", "go", 0)}, msgSpec{"z1", 0, 16, 0})
	d2.Messages[0].At = time.Time{}
	c.Upsert(d2)
	wantNear(t, "untimed unbounded", c.Total(Filter{}).TotalUSD, 31)
	wantNear(t, "untimed bounded", c.Total(Filter{From: hm(10, 0, 0), To: hm(12, 0, 0)}).TotalUSD, 15)
}

// An instant range cuts a reported window's overhead in proportion to the covered spend inside it.
func TestFilterInstantsApportionOverhead(t *testing.T) {
	setZone(t, "UTC")
	d := withWindows(instantSession(), window(0, 150, 30)) // covered 15, overhead 15
	c := New()
	c.Upsert(d)
	from, to := t0.Add(59*time.Minute), t0.Add(90*time.Minute) // the messages worth 2 and 4
	wantNear(t, "total", c.Total(Filter{From: from, To: to}).TotalUSD, 12)
	var overhead float64
	for _, r := range c.Rollup(Filter{From: from, To: to}, ByModel) {
		if r.Model == OverheadModel {
			overhead = r.TotalUSD
		}
	}
	wantNear(t, "overhead", overhead, 6)
	wantNear(t, "whole window", c.Total(Filter{}).TotalUSD, 30)
	wantNear(t, "split in two", c.Total(Filter{To: from}).TotalUSD+c.Total(Filter{From: from}).TotalUSD, 30)
}
