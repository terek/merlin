package main

import (
	"testing"

	"github.com/terek/merlin/internal/harness"
	"github.com/terek/merlin/internal/model"
)

// Every harness in the list declares a complete, sound support table.
func TestEveryListedHarnessDeclaresSupport(t *testing.T) {
	for _, e := range harnessList {
		if e.support == nil {
			t.Errorf("%s: no support table in harnessList", e.Name)
			continue
		}
		for _, p := range harness.CheckSupport(e.support()) {
			t.Errorf("%s: %s", e.Name, p)
		}
	}
}

func TestCoverageFlagsContradictions(t *testing.T) {
	d := &model.SessionDigest{Harness: "codex", ID: "a", Project: "/p",
		Reported: &model.Reported{}} // codex declares cost.reported absent
	cov := buildCoverage([]*model.SessionDigest{d})
	rows := map[string]coverageRow{}
	var hc harnessCoverage
	for _, h := range cov {
		if h.Harness == "codex" {
			hc = h
		}
	}
	for _, r := range hc.Rows {
		rows[r.Capability] = r
	}
	if r := rows["cost.reported"]; r.Flag != "absent but populated" || r.Seen == nil || *r.Seen != 1 {
		t.Errorf("cost.reported = %+v", r)
	}
	if r := rows["session.project"]; r.State != harness.Parsed || r.Flag != "" {
		t.Errorf("session.project = %+v", r)
	}
	if r := rows["turns.userText"]; r.Flag != "parsed but not seen" {
		t.Errorf("turns.userText = %+v", r)
	}
	if r := rows["live.hooks"]; r.Seen != nil || r.Flag != "" {
		t.Errorf("live.hooks = %+v", r)
	}
	// No sessions: nothing can contradict.
	for _, h := range buildCoverage(nil) {
		for _, r := range h.Rows {
			if r.Flag != "" {
				t.Errorf("%s %s flagged with no sessions", h.Harness, r.Capability)
			}
		}
	}
}

func TestCoverageUnlistedHarnessHasNoTable(t *testing.T) {
	cov := buildCoverage([]*model.SessionDigest{{Harness: "other", ID: "x"}})
	last := cov[len(cov)-1]
	if last.Harness != "other" || !last.NoTable || last.States[harness.Unknown] != len(last.Rows) {
		t.Errorf("unlisted = %+v", last)
	}
}
