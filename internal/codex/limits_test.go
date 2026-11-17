package codex

import (
	"encoding/json"
	"testing"

	"github.com/terek/merlin/internal/model"
)

func win(pct float64, minutes int, resets int64) map[string]any {
	return map[string]any{"used_percent": pct, "window_minutes": minutes, "resets_at": resets}
}

func (r *rollout) rate(sec int, limits any) *rollout {
	return r.event(sec, map[string]any{"type": "token_count", "info": nil, "rate_limits": limits})
}

func lim(id string, primary, secondary any, plan any) map[string]any {
	return map[string]any{"limit_id": id, "limit_name": nil, "primary": primary, "secondary": secondary,
		"credits": map[string]any{"has_credits": false}, "plan_type": plan}
}

const (
	reset5h = 1792927995
	reset7d = 1793514795
)

func TestLimitReadings(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "vscode", nil).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).user(1, "Go.", 0).
		rate(10, lim("codex", win(38, 300, reset5h), win(6, 10080, reset7d), "plus")).
		rate(20, lim("codex", win(38, 300, reset5h), win(6, 10080, reset7d), "plus")).       // a repeat: dropped
		rate(30, lim("codex", win(38, 300, reset5h+15), win(6, 10080, reset7d-20), "plus")). // jitter: dropped
		rate(40, lim("codex", win(39, 300, reset5h+15), nil, "plus")).                       // null secondary
		rate(50, lim("premium", nil, nil, "plus")).                                          // no windows: no reading
		rate(55, nil).                                                                       // null rate_limits
		rate(60, lim("codex", win(7, 10080, reset7d), nil, nil)).                            // 0.104 style
		rate(65, lim("codex", map[string]any{"window_minutes": 300}, nil, "plus")).          // neither percent nor reset
		event(70, map[string]any{"type": "task_complete", "turn_id": "r1", "duration_ms": 1000,
			"error": map[string]any{"message": "limit", "codex_error_info": "usage_limit_exceeded"}}).
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")

	d := build(t, home, "R")
	type row struct {
		at       int
		limit    string
		minutes  int
		pct      float64
		plan     string
		rejected bool
	}
	var got []row
	for _, l := range d.Limits {
		r := row{at: int(l.At.Sub(t0).Seconds()), limit: l.Limit, minutes: l.WindowMinutes, plan: l.Plan, rejected: l.Rejected}
		if l.UsedPercent != nil {
			r.pct = *l.UsedPercent
		}
		got = append(got, r)
	}
	want := []row{
		{10, "codex", 300, 38, "plus", false},
		{10, "codex", 10080, 6, "plus", false},
		{40, "codex", 300, 39, "plus", false},
		{60, "codex", 10080, 7, "", false},
		{70, "", 0, 0, "", true},
	}
	if len(got) != len(want) {
		t.Fatalf("limits = %+v", d.Limits)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("limit %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	if r := d.Limits[0].ResetsAt; r.Unix() != reset5h || r.Location().String() != "UTC" {
		t.Errorf("resetsAt = %v", r)
	}
	if !d.Limits[4].ResetsAt.IsZero() || d.Limits[4].UsedPercent != nil {
		t.Errorf("a refusal carries no window: %+v", d.Limits[4])
	}
	b, _ := json.Marshal(d.Limits[0])
	t.Logf("reading: %s", b)
}

func TestLimitReadingsOfSubagents(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "vscode", nil).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).user(1, "Go.", 0).
		rate(10, lim("codex", win(10, 300, reset5h), nil, "plus")).
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
	newRollout(t).meta("A", "R", spawnSource("R", "/root/w", "Ada", 1), map[string]any{"agent_path": "/root/w", "parent_thread_id": "R"}).
		start(11, "a1", "r1", "user").ctx(11, "a1", "m", nil).
		rate(12, lim("codex", win(10, 300, reset5h), nil, "plus")). // same numbers, other agent: kept
		rate(13, lim("codex", win(11, 300, reset5h), nil, "plus")).
		write(home, "rollout-2026-10-01T09-00-11-A.jsonl")
	d := build(t, home, "R")
	var ids []string
	for _, l := range d.Limits {
		ids = append(ids, l.AgentID)
	}
	if len(ids) != 3 || ids[0] != "" || ids[1] != "A" || ids[2] != "A" {
		t.Fatalf("agent ids = %q, limits %+v", ids, d.Limits)
	}
}

func TestRefusedEndState(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "vscode", nil).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).user(1, "Go.", 0).
		event(70, map[string]any{"type": "task_complete", "turn_id": "r1", "duration_ms": 1000,
			"error": map[string]any{"message": "limit", "codex_error_info": "usage_limit_exceeded"}}).
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
	if d := build(t, home, "R"); d.EndState != model.EndRefused {
		t.Errorf("end state = %q, want refused", d.EndState)
	}
}

func TestThreadAccountAttribution(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "vscode", map[string]any{"creator_account_id": "root-account"}).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).usage(2, "root-msg", "r1", 10, 0, 2).
		rate(3, lim("codex", win(10, 300, reset5h), nil, "plus")).write(home, "rollout-R.jsonl")
	for i, tc := range []struct{ id, account string }{{"A", "child-account"}, {"B", ""}} {
		extra := map[string]any{"parent_thread_id": "R"}
		if tc.account != "" {
			extra["creator_account_id"] = tc.account
		}
		newRollout(t).meta(tc.id, "R", spawnSource("R", "/root/"+tc.id, tc.id, 1), extra).
			start(10+i*10, "a1", "r1", "user").ctx(10+i*10, "a1", "m", nil).
			usage(11+i*10, tc.id+"-msg", "a1", 10, 0, 2).
			rate(12+i*10, lim("codex", win(10, 300, reset5h), nil, "plus")).write(home, "rollout-"+tc.id+".jsonl")
	}
	d := build(t, home, "R")
	accounts := map[string]string{"": model.AccountKey("root-account"), "A": model.AccountKey("child-account"), "B": ""}
	if d.Account != accounts[""] {
		t.Fatalf("session account = %q", d.Account)
	}
	if len(d.Messages) != 3 || len(d.Limits) != 3 {
		t.Fatalf("messages %d, limits %d", len(d.Messages), len(d.Limits))
	}
	for _, m := range d.Messages {
		if m.Account != accounts[m.AgentID] || !m.AccountKnown {
			t.Errorf("message = %+v", m)
		}
	}
	for _, l := range d.Limits {
		if l.Account != accounts[l.AgentID] || !l.AccountKnown || l.Plan != "plus" {
			t.Errorf("limit = %+v", l)
		}
	}
}
