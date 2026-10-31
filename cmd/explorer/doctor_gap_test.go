package main

import "testing"

func TestCoveredAboveIgnoresFloatNoise(t *testing.T) {
	gaps := []gapRow{{ID: "a", GapUSD: 0.2}, {ID: "b", GapUSD: 1e-17}, {ID: "c", GapUSD: -3e-17},
		{ID: "d", GapUSD: -0.004}, {ID: "e", GapUSD: -0.006}, {ID: "f", GapUSD: -1.5}}
	got := coveredAbove(gaps, 10)
	if len(got) != 2 || got[0].ID != "f" || got[1].ID != "e" {
		t.Errorf("coveredAbove = %+v, want f then e", got)
	}
	if got := coveredAbove(gaps, 1); len(got) != 1 || got[0].ID != "f" {
		t.Errorf("limit 1: %+v", got)
	}
	if got := coveredAbove(nil, 10); got == nil || len(got) != 0 {
		t.Errorf("empty must be a non-nil empty slice (JSON []): %#v", got)
	}
}
