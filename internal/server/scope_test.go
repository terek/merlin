package server

import (
	"net/url"
	"testing"
)

// laneSum is the Overview's usd of the lanes whose dir sits under in (and which match q).
func laneSum(t *testing.T, r *rig, q, in string) float64 {
	t.Helper()
	o, code := r.overview("")
	if code != 200 {
		t.Fatalf("overview: %d", code)
	}
	keep := map[string]bool{}
	if q != "" {
		keep = r.costKeys(t, q)
	}
	sum := 0.0
	for _, l := range o.Lanes {
		if in != "" && l.Dir != in {
			continue
		}
		if q != "" && !keep[l.ID] {
			continue
		}
		sum += l.USD
	}
	return sum
}

// costKeys are the ids of the sessions /api/cost?by=session keeps for a search.
func (r *rig) costKeys(t *testing.T, q string) map[string]bool {
	t.Helper()
	var ct CostTable
	if code := r.get("/api/cost?by=session&q="+url.QueryEscape(q), &ct); code != 200 {
		t.Fatalf("cost: %d", code)
	}
	out := map[string]bool{}
	for _, row := range ct.Rows {
		out[row.Key] = true
	}
	return out
}

// The Overview's lanes under a selection add up to /api/cost with the same place and in.
func TestCostFollowsTheOverviewScope(t *testing.T) {
	r := ovRig(t)
	const days = "&since=2026-12-26&until=2027-01-01"
	for _, c := range []struct{ name, query, in, q string }{
		{"all", "", "", ""},
		{"dir main", "&place=dir&in=/main", "/main", ""},
		{"dir other", "&place=dir&in=/other", "/other", ""},
		{"search", "&q=thing", "", "thing"},
		{"search by title", "&q=title+c", "", "title c"},
	} {
		var ct CostTable
		if code := r.get("/api/cost?by=day"+days+c.query, &ct); code != 200 {
			t.Fatalf("%s: status %d", c.name, code)
		}
		want := laneSum(t, r, c.q, c.in)
		if c.name == "all" {
			want += 0.5 // the scripted run, beside the lanes
		}
		got := ct.Total.AttributedUSD + ct.Total.RecordedUSD
		if !near(got, want) || !near(ct.Total.TotalUSD, want) {
			t.Errorf("%s: cost %v (total %v), overview %v", c.name, got, ct.Total.TotalUSD, want)
		}
		if c.name != "all" && ct.Backing.ScriptedRuns != 0 {
			t.Errorf("%s: scriptedRuns %d, want 0", c.name, ct.Backing.ScriptedRuns)
		}
	}
	var ct CostTable
	if code := r.get("/api/cost?by=model&place=nope&in=/x", &ct); code != 400 {
		t.Errorf("bad place: %d", code)
	}
	r.get("/api/cost?by=model&place=dir&in=-", &ct)
	if ct.Total.TotalUSD != 0 || ct.Sessions != 0 {
		t.Errorf("in=-: %+v", ct)
	}
}

// The class and agent tables add up to the plain total under every filter, parts included.
func TestClassAndAgentTablesAddUp(t *testing.T) {
	r := ovRig(t)
	const days = "&since=2026-12-26&until=2027-01-01"
	for _, extra := range []string{"", "&place=dir&in=/main", "&q=thing", "&place=dir&in=/other&q=title"} {
		var plain CostTable
		r.get("/api/cost?by=model"+days+extra, &plain)
		for _, by := range []string{"class", "agent"} {
			var ct CostTable
			if code := r.get("/api/cost?by="+by+days+extra, &ct); code != 200 {
				t.Fatalf("%s%s: %d", by, extra, code)
			}
			sum := 0.0
			for _, row := range ct.Rows {
				sum += row.TotalUSD
			}
			if !near(sum, plain.Total.TotalUSD) || !near(ct.Total.TotalUSD, plain.Total.TotalUSD) {
				t.Errorf("by=%s%s: rows %v total %v, plain %v", by, extra, sum, ct.Total.TotalUSD, plain.Total.TotalUSD)
			}
			var sp CostTable
			r.get("/api/cost?by="+by+"&split=model"+days+extra, &sp)
			for _, row := range sp.Rows {
				parts := 0.0
				for _, p := range row.Split {
					parts += p.TotalUSD
				}
				if !near(parts, row.TotalUSD) {
					t.Errorf("by=%s split=model%s: %s parts %v row %v", by, extra, row.Key, parts, row.TotalUSD)
				}
			}
		}
	}
	var ct CostTable
	if code := r.get("/api/cost?by=model&split=class"+days, &ct); code != 200 {
		t.Errorf("by=model&split=class: %d", code)
	}
}
