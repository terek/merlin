package catalog

import (
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

// The hours of every day add up to the day, for every grouping, on the fixtures.
func TestHourRowsAddUpToDays(t *testing.T) {
	setZone(t, "America/New_York")
	c := fixtureCatalog(t)
	for _, extra := range [][]Dim{nil, {ByModel}, {ByKind}, {ByProject}, {ByClass}, {ByAgent}} {
		days := map[string]float64{}
		for _, r := range c.Rollup(Filter{}, append([]Dim{ByDay}, extra...)...) {
			days[r.Day] += r.TotalUSD
		}
		hours := map[string]float64{}
		for _, r := range c.Rollup(Filter{}, append([]Dim{ByHour}, extra...)...) {
			if len(r.Hour) != len("2006-01-02T15") && r.Hour != "" {
				t.Fatalf("hour key %q", r.Hour)
			}
			hours[r.Hour] += r.TotalUSD
		}
		sum := map[string]float64{}
		for h, v := range hours {
			d := h
			if i := strings.IndexByte(h, 'T'); i >= 0 {
				d = h[:i]
			}
			sum[d] += v
		}
		if len(sum) != len(days) {
			t.Errorf("%v: %d days from hours, %d days", extra, len(sum), len(days))
		}
		for d, v := range days {
			wantNear(t, "day "+d, sum[d], v)
		}
	}
}

// A window's overhead is spread over the hours of its covered spend.
func TestOverheadIsSpreadOverHours(t *testing.T) {
	setZone(t, "UTC")
	tu := []model.Turn{turn(0, "u0", "go", 0)}
	d := syn("claude", "span", "/p", 0, 3000, tu,
		msgSpec{"d1", 60, 3, 0},  // 11:00
		msgSpec{"d2", 180, 1, 0}, // 13:00
	)
	withWindows(d, model.ReportedWindow{From: at(0), To: at(240), TotalUSD: 8})
	c := New()
	c.Upsert(d)
	rows := c.Rollup(Filter{}, ByHour)
	if len(rows) != 2 || rows[0].Hour != "2026-10-01T11" || !near(rows[0].TotalUSD, 6) || rows[1].Hour != "2026-10-01T13" || !near(rows[1].TotalUSD, 2) {
		t.Fatalf("rows = %+v", rows)
	}
}

// On a 23-hour and a 25-hour day the keys are the local clock hours.
func TestHourKeysAcrossDST(t *testing.T) {
	setZone(t, "America/New_York")
	v := &view{loc: time.Local}
	for _, c := range []struct {
		utc  time.Time
		want string
	}{
		{time.Date(2026, 3, 8, 6, 30, 0, 0, time.UTC), "2026-03-08T01"},  // 01:30 EST
		{time.Date(2026, 3, 8, 7, 30, 0, 0, time.UTC), "2026-03-08T03"},  // 02:xx does not exist
		{time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC), "2026-11-01T01"}, // 01:30 EDT
		{time.Date(2026, 11, 1, 6, 30, 0, 0, time.UTC), "2026-11-01T01"}, // 01:30 EST, the repeat
		{time.Date(2026, 11, 1, 7, 30, 0, 0, time.UTC), "2026-11-01T02"},
	} {
		f := fact{day: v.day(c.utc), hour: v.hour(c.utc)}
		if got := f.hourKey(); got != c.want {
			t.Errorf("%v: %s, want %s", c.utc, got, c.want)
		}
	}
	if (fact{hour: -1}).hourKey() != "" {
		t.Error("a fact without a day has no hour")
	}
}
