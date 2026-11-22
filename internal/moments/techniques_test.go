package moments

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

var tnow = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

// techSession is a session of the given turns, started daysAgo days before tnow, with one message
// on the given model so that it is the main one.
func techSession(id string, daysAgo int, mdl string, turns ...model.Turn) Input {
	start := tnow.AddDate(0, 0, -daysAgo).Truncate(24 * time.Hour).Add(9 * time.Hour)
	for i := range turns {
		turns[i].Index = i
		turns[i].Origin = model.OriginHuman
		turns[i].UserText = "work"
		turns[i].StartedAt = start.Add(time.Duration(i) * 10 * time.Minute)
		turns[i].EndedAt = turns[i].StartedAt.Add(5 * time.Minute)
		if turns[i].AssistantMessages == 0 {
			turns[i].AssistantMessages = 4
		}
	}
	d := &model.SessionDigest{Harness: "claude", ID: id, Kind: model.KindInteractive, StartedAt: start,
		LastActivityAt: start.Add(time.Hour), Turns: turns, Messages: []model.Message{{ID: "m", Model: mdl, At: start}}}
	return Input{Digest: d}
}

func costed(ctx int64, usd float64) model.Turn {
	return model.Turn{ContextTokens: ctx, Cost: model.Cost{USD: usd}}
}

func TestHeavyContext(t *testing.T) {
	var in []Input
	// 5 turns, 3 of them above 250k (one above 500k)
	in = append(in, techSession("a", 3, "claude-opus-5-5",
		costed(100_000, 1), costed(300_000, 3), costed(400_000, 4), costed(600_000, 6), costed(50_000, 0.5)))
	r := BuildConfig(Registry(), in, tnow, time.UTC, Config{})
	var s *Suggestion
	for i := range r.Suggestions {
		if r.Suggestions[i].Moment == "clean-slate" {
			s = &r.Suggestions[i]
		}
	}
	// clean-slate is unseen here, so the technique is a suggestion
	if s == nil || s.Technique == nil || s.Technique.Estimate == nil {
		t.Fatalf("want a heavy-context technique on clean-slate: %+v", r.Suggestions)
	}
	tech := s.Technique
	if !strings.HasPrefix(tech.Reason, "1 turn ran on more than 500k") {
		t.Errorf("the reason should lead with the 500k count: %q", tech.Reason)
	}
	want := (3*150.0/300 + 4*250.0/400 + 6*450.0/600) * 30 / WindowDays
	if got := tech.Estimate.MonthlyUSD; math.Abs(got-want)/want > 0.03 {
		t.Errorf("estimate %v, want about %v", got, want)
	}
	if tech.Fix.Kind != "claudemd" || tech.Example == nil || len(tech.Days) != 1 {
		t.Errorf("fix, example and days: %+v", tech)
	}
	// below the share and with no 500k turn: nothing
	in = []Input{techSession("b", 3, "claude-opus-5-5", costed(300_000, 3), costed(1, 1), costed(1, 1), costed(1, 1),
		costed(1, 1), costed(1, 1), costed(1, 1), costed(1, 1))}
	if r := BuildConfig(Registry(), in, tnow, time.UTC, Config{}); len(r.Suggestions) > 0 && r.Suggestions[0].Technique != nil {
		t.Errorf("one heavy turn in eight is not a gap: %+v", r.Suggestions[0].Technique)
	}
}

func TestOrchestrator(t *testing.T) {
	heavy := func(usd float64) model.Turn {
		return model.Turn{ToolsByName: map[string]int64{"Edit": 8, "Bash": 4},
			Cost: model.Cost{USD: usd, ByModel: map[string]model.ModelCost{
				"claude-opus-5-5": {Tokens: model.Tokens{Input: 1_000_000, Output: 100_000}, USD: usd}}}}
	}
	in := []Input{techSession("a", 2, "claude-opus-5-5", heavy(10), heavy(10), heavy(10), heavy(10))}
	r := BuildConfig(Registry(), in, tnow, time.UTC, Config{})
	m := view(r, "orchestrator")
	if m.Status != StatusUnseen {
		t.Fatalf("the orchestrator has no seen state: %v", m.Status)
	}
	var tech *Technique
	for _, s := range r.Suggestions {
		if s.Moment == "orchestrator" {
			tech = s.Technique
		}
	}
	if tech == nil || tech.Estimate == nil {
		t.Fatalf("want the orchestrator technique: %+v", r.Suggestions)
	}
	// opus-5-5: 1M x $4 + 100k x $20 = $6 at list; at Sonnet 5.5: 1M x $2 + 100k x $10 = $3
	sonnet, _ := prices().Cost(sonnetModel(), model.Tokens{Input: 1_000_000, Output: 100_000}, false)
	opus, _ := prices().Cost("claude-opus-5-5", model.Tokens{Input: 1_000_000, Output: 100_000}, false)
	_ = opus
	want := 4 * (10 - sonnet.USD) * 30 / WindowDays
	if got := tech.Estimate.MonthlyUSD; math.Abs(got-want)/want > 0.03 {
		t.Errorf("estimate %v, want about %v", got, want)
	}
	if tech.Fix.Kind != "claudemd" || strings.Contains(tech.Fix.Text, "---") {
		t.Errorf("the fix is one paragraph for CLAUDE.md: %+v", tech.Fix)
	}
	// delegating turns are not the gap
	d := heavy(10)
	d.Spawned = []string{"a", "b"}
	in = []Input{techSession("b", 2, "claude-opus-5-5", d, d, d, d)}
	for _, s := range BuildConfig(Registry(), in, tnow, time.UTC, Config{}).Suggestions {
		if s.Moment == "orchestrator" && s.Technique != nil {
			t.Errorf("delegating turns are not a gap: %+v", s.Technique)
		}
	}
}

func TestShellCompressorTechnique(t *testing.T) {
	sh := func(bytes int64) model.Turn {
		return model.Turn{ToolsByName: map[string]int64{"Bash": 3}, ShellOutputBytes: bytes, AssistantMessages: 10}
	}
	var in []Input
	for i := 0; i < 40; i++ {
		in = append(in, techSession(fmt.Sprintf("a%d", i), 2+i%10, "claude-opus-5-5", sh(400_000), sh(4_000), sh(4_000)))
	}
	r := BuildConfig(Registry(), in, tnow, time.UTC, Config{})
	var tech *Technique
	for _, s := range r.Suggestions {
		if s.Moment == "compressed-shell" {
			tech = s.Technique
		}
	}
	if tech == nil || tech.Estimate == nil {
		t.Fatalf("want the shell compressor technique: %+v", r.Suggestions)
	}
	if tech.Fix.Kind != "shell" || !strings.Contains(tech.Fix.Text, "rtk init -g") || tech.Fix.Link == "" {
		t.Errorf("fix: %+v", tech.Fix)
	}
	// the first turn's 100k tokens are capped at rtkTurnCap, and its later calls at rtkLaterCap
	_, p, _ := prices().Lookup("claude-opus-5-5")
	cr := p.CacheRead / 1e6
	later := func(rest int) int { return min(9/2+rest, rtkLaterCap) }
	want := (float64(rtkTurnCap)*float64(later(20))*cr + 1000*float64(later(10))*cr + 1000*float64(4)*cr) * rtkTrimmed * 30 / WindowDays * 40
	if got := tech.Estimate.MonthlyUSD; math.Abs(got-want)/want > 0.05 {
		t.Errorf("estimate %v, want about %v", got, want)
	}

	if m := view(r, "compressed-shell"); m.Status != StatusUnseen || m.Note != "rtk is not set up." {
		t.Errorf("no rewrites: unseen, not set up: %v %q", m.Status, m.Note)
	}

	// configured but no hook record in the sessions: no technique, the practice stays unseen, and the note says so
	r = BuildConfig(Registry(), in, tnow, time.UTC, Config{Setup: Setup{ShellCompressor: true}})
	if m := view(r, "compressed-shell"); m.Status != StatusUnseen || m.Technique != nil || !strings.Contains(m.Note, "no rewrites") {
		t.Errorf("configured without rewrites: %+v", m)
	}

	// the hook's records in the sessions: the practice is seen from them, with the count in its note
	var on []Input
	for i := 0; i < 40; i++ {
		on = append(on, techSession(fmt.Sprintf("c%d", i), 2+i%10, "claude-opus-5-5", withRewrites(sh(400_000), 5), sh(4_000), sh(4_000)))
	}
	r = BuildConfig(Registry(), on, tnow, time.UTC, Config{})
	m := view(r, "compressed-shell")
	if m.Status == StatusUnseen || m.Hits != 40 || m.Technique != nil || !strings.HasPrefix(m.Note, "rtk is on: it rewrote 200 shell commands") {
		t.Errorf("rewritten: status %v hits %d technique %v note %q", m.Status, m.Hits, m.Technique, m.Note)
	}
}

func withRewrites(t model.Turn, n int64) model.Turn {
	t.ShellCompressed = n
	return t
}

func TestFollowUp(t *testing.T) {
	var in []Input
	// before the copy (21 Oct to 4 Nov): half of the turns heavy; after: none heavy
	for i := 0; i < 4; i++ {
		in = append(in, techSession(fmt.Sprintf("b%d", i), 25-i, "claude-opus-5-5", costed(300_000, 3), costed(100_000, 1)))
	}
	for i := 0; i < 4; i++ {
		in = append(in, techSession(fmt.Sprintf("a%d", i), 8-i, "claude-opus-5-5", costed(100_000, 1), costed(90_000, 1), costed(80_000, 1)))
	}
	// a 500k turn lately keeps the technique firing
	in = append(in, techSession("big", 1, "claude-opus-5-5", costed(550_000, 6)))
	copied := tnow.AddDate(0, 0, -10)
	cfg := Config{Engaged: []Engagement{{Moment: "clean-slate", OpenedAt: copied.Add(-time.Hour), CopiedAt: copied}}}
	r := BuildConfig(Registry(), in, tnow, time.UTC, cfg)
	var s Suggestion
	for _, x := range r.Suggestions {
		if x.Moment == "clean-slate" {
			s = x
		}
	}
	if s.Engaged == nil || !s.Engaged.Watching || s.Engaged.CopiedAt != copied {
		t.Fatalf("want a watched suggestion: %+v", s)
	}
	if !strings.HasPrefix(s.Engaged.FollowUp, "Since you copied it on 10 Nov: turns above 250k went from 50% to ") {
		t.Errorf("follow-up: %q", s.Engaged.FollowUp)
	}
	// fewer than three sessions after the copy: no follow-up yet
	cfg.Engaged[0].CopiedAt = tnow.AddDate(0, 0, -2)
	r = BuildConfig(Registry(), in, tnow, time.UTC, cfg)
	for _, x := range r.Suggestions {
		if x.Moment == "clean-slate" && x.Engaged.FollowUp != "" {
			t.Errorf("one session after the copy is too few: %q", x.Engaged.FollowUp)
		}
	}
	// after 28 days the watch ends
	cfg.Engaged[0].CopiedAt = tnow.AddDate(0, 0, -29)
	r = BuildConfig(Registry(), in, tnow, time.UTC, cfg)
	for _, x := range r.Suggestions {
		if x.Moment == "clean-slate" && x.Engaged != nil && x.Engaged.Watching {
			t.Errorf("still watching after 29 days")
		}
	}
}

func TestEngagementStore(t *testing.T) {
	home := t.TempDir()
	if got := LoadEngaged(home); got != nil {
		t.Fatalf("missing file: %v", got)
	}
	t1, t2, t3 := tnow, tnow.Add(time.Hour), tnow.Add(2*time.Hour)
	for _, step := range []struct {
		action string
		at     time.Time
	}{{ActionOpen, t1}, {ActionOpen, t2}, {ActionCopy, t2}, {ActionCopy, t3}} {
		if err := RecordEngagement(home, "clean-slate", step.action, step.at); err != nil {
			t.Fatal(err)
		}
	}
	got := LoadEngaged(home)
	if len(got) != 1 || !got[0].OpenedAt.Equal(t1) || !got[0].CopiedAt.Equal(t3) {
		t.Errorf("first open and latest copy: %+v", got)
	}
	if err := RecordEngagement(home, "x", "bogus", t1); err == nil {
		t.Error("an unknown action is refused")
	}
	if entries, _ := os.ReadDir(home); len(entries) != 1 {
		t.Errorf("no temp file may stay behind: %v", entries)
	}
	if err := os.WriteFile(filepath.Join(home, EngagedFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := LoadEngaged(home); got != nil {
		t.Errorf("a bad file is tolerated: %v", got)
	}
	if err := RecordEngagement(home, "clean-slate", ActionOpen, t1); err != nil {
		t.Errorf("and rewritten: %v", err)
	}
}

func TestOrchestratorDetector(t *testing.T) {
	opus := "claude-opus-5-5"
	sonnet := "claude-sonnet-5-5"
	premium := model.Cost{USD: 1, ByModel: map[string]model.ModelCost{opus: {USD: 1}}}
	worker := func(mdl string, calls map[string]int64) model.Agent {
		return model.Agent{ID: "w", Kind: model.AgentSubagent, Model: mdl, SpawnTurn: new(int), ToolsByName: calls,
			StartedAt: tnow.AddDate(0, 0, -2)}
	}
	hits := func(a model.Agent, turns ...model.Turn) int {
		in := techSession("o", 2, opus, turns...)
		in.Digest.Agents = []model.Agent{a}
		return view(BuildWith(Registry(), []Input{in}, tnow, time.UTC), "orchestrator").Hits
	}
	// one worker spawned once, then many main turns that brief it and verify with the shell
	briefing := func(n int) []model.Turn {
		ts := []model.Turn{{Spawned: []string{"w"}, ToolsByName: map[string]int64{"Agent": 1}, Cost: premium}}
		for i := 0; i < n; i++ {
			ts = append(ts, model.Turn{ToolsByName: map[string]int64{"SendMessage": 2, "Bash": 20}, Cost: premium})
		}
		return ts
	}
	if n := hits(worker(sonnet, map[string]int64{"Edit": 9, "Bash": 4}), briefing(6)...); n != 1 {
		t.Errorf("a Sonnet worker made the edits, briefed over many turns: %d hits", n)
	}
	if n := hits(worker(sonnet, map[string]int64{"Edit": 2}), briefing(6)...); n != 0 {
		t.Errorf("two edits are too few: %d hits", n)
	}
	if n := hits(worker(opus, map[string]int64{"Edit": 9}), briefing(6)...); n != 0 {
		t.Errorf("a worker on the same model is not routing: %d hits", n)
	}
	own := briefing(2)
	own[1].ToolsByName = map[string]int64{"Edit": 9}
	if n := hits(worker(sonnet, map[string]int64{"Edit": 9}), own...); n != 0 {
		t.Errorf("the main thread made as many edits as the worker: %d hits", n)
	}
	// those main turns are not the gap: edits only, and the briefing turns made none
	in := techSession("g", 2, opus, briefing(8)...)
	in.Digest.Agents = []model.Agent{worker(sonnet, map[string]int64{"Edit": 9})}
	for _, s := range BuildConfig(Registry(), []Input{in}, tnow, time.UTC, Config{}).Suggestions {
		if s.Moment == "orchestrator" && s.Technique != nil {
			t.Errorf("shell-heavy briefing turns are not a gap: %+v", s.Technique)
		}
	}
}

func TestOrchestratorGapCountsEdits(t *testing.T) {
	turn := func(tools map[string]int64) model.Turn {
		return model.Turn{ToolsByName: tools, Cost: model.Cost{USD: 10, ByModel: map[string]model.ModelCost{
			"claude-opus-5-5": {Tokens: model.Tokens{Input: 1_000_000, Output: 100_000}, USD: 10}}}}
	}
	gap := func(tools map[string]int64) bool {
		in := []Input{techSession("a", 2, "claude-opus-5-5", turn(tools), turn(tools), turn(tools), turn(tools))}
		for _, s := range BuildConfig(Registry(), in, tnow, time.UTC, Config{}).Suggestions {
			if s.Moment == "orchestrator" && s.Technique != nil {
				return true
			}
		}
		return false
	}
	if !gap(map[string]int64{"Edit": 6}) {
		t.Error("turns with 6 edits are the gap")
	}
	if gap(map[string]int64{"Bash": 20}) {
		t.Error("20 shell calls and no edits are not the gap")
	}
}
