package moments

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

var t0 = time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)

func at(min int) time.Time { return t0.Add(time.Duration(min) * time.Minute) }

func ip(i int) *int { return &i }

func turn(i int, start int, text string) model.Turn {
	return model.Turn{Index: i, Origin: model.OriginHuman, UserText: text, StartedAt: at(start), EndedAt: at(start + 3)}
}

func session(id string, kind model.SessionKind, turns ...model.Turn) *model.SessionDigest {
	d := &model.SessionDigest{Harness: "claude", ID: id, Kind: kind, Turns: turns}
	if len(turns) > 0 {
		d.StartedAt, d.LastActivityAt = turns[0].StartedAt, end(&turns[len(turns)-1])
	}
	return d
}

func view(r Report, id string) MomentView {
	for _, m := range r.Moments {
		if m.ID == id {
			return m
		}
	}
	return MomentView{}
}

func TestDetectors(t *testing.T) {
	steer := turn(0, 0, "fix the parser")
	steer.Queued = []model.QueuedPrompt{{At: at(1), Origin: model.OriginHuman, Text: "also the tests"}}
	steer.ToolsByName = map[string]int64{"EnterPlanMode": 1, "Edit": 1}

	stopped := turn(1, 10, "rename everything")
	stopped.Interrupted = true
	redirect := turn(2, 14, "only rename the exported names")

	grounded := turn(3, 30, "look at internal/store/store.go please")
	grounded.FilesTouched = []string{"/repo/internal/store/store.go"}

	vibe := turn(4, 40, "add dark mode")
	vibe.ToolsByName = map[string]int64{"Edit": 5}

	approve := turn(5, 50, "yes do it")
	approve.ToolsByName = map[string]int64{"Edit": 5}

	cmd := turn(6, 60, "")
	cmd.Origin, cmd.Command = model.OriginCommand, "/wake merlin"
	clear := turn(7, 70, "")
	clear.Origin, clear.Command = model.OriginCommand, "/clear"
	wake := turn(8, 80, "")
	wake.Origin, wake.Command = model.OriginCommand, "/wake ada"
	sleep := turn(9, 90, "")
	sleep.Origin, sleep.Command = model.OriginCommand, "/sleep"

	d := session("a", model.KindInteractive, steer, stopped, redirect, grounded, vibe, approve, cmd, clear, wake, sleep)
	d.Compactions = []model.Compaction{{At: at(65), Turn: 6, Trigger: model.TriggerManual, PreTokens: 120_000}}
	d.Agents = []model.Agent{
		{ID: "x", Kind: model.AgentSubagent, AgentType: "Explore", StartedAt: at(31), EndedAt: at(35), SpawnTurn: ip(3), Model: "claude-haiku-5-5"},
		{ID: "c", Kind: model.AgentCompact, StartedAt: at(65), EndedAt: at(66)},
	}
	d.Messages = []model.Message{{ID: "m1", Model: "claude-opus-5-5", At: at(1)}}

	r := BuildWith(Registry(), []Input{{Digest: d}}, at(24*60), time.UTC)
	for id, hits := range map[string]int{
		"steer-mid-turn": 1, "interrupt-redirect": 1, "grounded-prompt": 1, "vibe-one-shot": 1,
		"plans-first": 1, "custom-command": 3, "clean-slate": 1, "deliberate-compact": 1,
		"context-isolation": 1, "model-routing": 1, "agent-team": 0, "swarm": 0, "personas": 1,
	} {
		if got := view(r, id).Hits; got != hits {
			t.Errorf("%s: %d hits, want %d", id, got, hits)
		}
	}
	if m := view(r, "personas"); m.Examples[0].Note != "a persona's whole workday: woke, worked, slept" {
		t.Errorf("personas note %q", m.Examples[0].Note)
	}
	if m := view(r, "steer-mid-turn"); m.Status != StatusExplored || !m.New || m.Examples[0].Turn == nil || *m.Examples[0].Turn != 0 {
		t.Errorf("steer-mid-turn = %+v", m)
	}
	// Notes carry no session text.
	for _, m := range r.Moments {
		for _, h := range m.Examples {
			for _, s := range []string{"parser", "rename", "dark mode", "merlin"} {
				if contains([]string{h.Note}, s) || len(h.Note) > 0 && containsWord(h.Note, s) {
					t.Errorf("%s: note %q quotes the session", m.ID, h.Note)
				}
			}
		}
	}
}

func containsWord(s, w string) bool {
	for i := 0; i+len(w) <= len(s); i++ {
		if s[i:i+len(w)] == w {
			return true
		}
	}
	return false
}

func TestInheritedTurnsAreSkipped(t *testing.T) {
	steer := turn(0, 0, "go")
	steer.Queued = []model.QueuedPrompt{{At: at(1), Origin: model.OriginHuman, Text: "and this"}}
	parent := session("p", model.KindInteractive, steer)
	child := session("c", model.KindInteractive, steer, turn(1, 100, "next"))
	r := BuildWith(Registry(), []Input{{Digest: parent}, {Digest: child, Inherited: []int{0}}}, at(1000), time.UTC)
	if got := view(r, "steer-mid-turn").Hits; got != 1 {
		t.Errorf("steer-mid-turn: %d hits, want 1 (the child's copy is skipped)", got)
	}
}

func TestHabitNeedsWeeks(t *testing.T) {
	var in []Input
	for w := range 3 {
		tt := turn(0, w*7*24*60, "x")
		tt.Queued = []model.QueuedPrompt{{At: at(w*7*24*60 + 1), Origin: model.OriginHuman}}
		in = append(in, Input{Digest: session(string(rune('a'+w)), model.KindInteractive, tt)})
	}
	now := at(30 * 24 * 60)
	if m := view(BuildWith(Registry(), in[:2], now, time.UTC), "steer-mid-turn"); m.Status != StatusExplored {
		t.Errorf("two weeks: %s, want explored", m.Status)
	}
	if m := view(BuildWith(Registry(), in, now, time.UTC), "steer-mid-turn"); m.Status != StatusHabit || m.Weeks != 3 {
		t.Errorf("three weeks: %s in %d weeks, want habit", m.Status, m.Weeks)
	}
}

func TestDepth(t *testing.T) {
	var in []Input
	for w := range 3 {
		tt := turn(0, w*7*24*60, "x")
		tt.Queued = []model.QueuedPrompt{{At: at(w*7*24*60 + 1), Origin: model.OriginHuman}}
		in = append(in, Input{Digest: session(string(rune('a'+w)), model.KindInteractive, tt)})
	}
	depth := func(in []Input, days int) (Depth, Status) {
		m := view(BuildWith(Registry(), in, at(days*24*60), time.UTC), "steer-mid-turn")
		return m.Depth, m.Status
	}
	// hits on days 0, 7 and 14; the window is the last 28 days
	for _, c := range []struct {
		name string
		in   []Input
		days int
		want Depth
	}{
		{"three weeks and a hit in the window", in, 20, DepthRoutine},
		{"three weeks, the last hit exactly at the window's start", in, 42, DepthRoutine},
		{"three weeks, nothing in the window", in, 43, DepthPaused},
		{"two weeks, first hit in the window", in[:2], 10, DepthNew},
		{"two weeks, first hit older than the window", in[:2], 40, DepthTried},
		{"one hit long ago", in[:1], 90, DepthTried},
	} {
		if got, _ := depth(c.in, c.days); got != c.want {
			t.Errorf("%s: depth %q, want %q", c.name, got, c.want)
		}
	}
	// status does not fall back
	if d, s := depth(in, 90); d != DepthPaused || s != StatusHabit {
		t.Errorf("a dropped habit: depth %q status %q, want paused and habit", d, s)
	}
	if d, _ := depth(nil, 10); d != "" {
		t.Errorf("unseen: depth %q, want none", d)
	}
}

func TestParallelSessionsAndScripted(t *testing.T) {
	a := session("a", model.KindInteractive, turn(0, 0, "a"))
	b := session("b", model.KindInteractive, turn(0, 1, "b"))
	c := session("c", model.KindInteractive, turn(0, 60, "c")) // later, alone
	a.Project, b.Project, c.Project = "/r/app", "/r/app/.worktrees/x", "/r/lib"
	// b ran in a worktree of the repository a started in: one project, not two.
	in := []Input{{Digest: a}, {Digest: b, Project: "/r/app"}, {Digest: c}}
	for i := range 50 { // a script that ran 50 times on one day: one moment
		d := session(string(rune('A'+i)), model.KindSDK, turn(0, 120+i, "scripted"))
		d.Project = "/tmp/run" // scripted runs don't count as projects
		in = append(in, Input{Digest: d})
	}
	r := BuildWith(Registry(), in, at(5000), time.UTC)
	if m := view(r, "parallel-sessions"); m.Hits != 1 || m.Examples[0].Note != "2 sessions working at once" {
		t.Errorf("parallel-sessions = %+v", m)
	}
	if m := view(r, "automation"); m.Hits != 1 {
		t.Errorf("automation: %d hits, want 1 per day", m.Hits)
	}
	if r.Sessions != 53 || r.Scripted != 50 || r.Projects != 2 {
		t.Errorf("sessions %d scripted %d projects %d", r.Sessions, r.Scripted, r.Projects)
	}
}

func TestSwarmAndOverYegge(t *testing.T) {
	d := session("s", model.KindInteractive, turn(0, 0, "fan out"))
	for i := range 6 {
		d.Agents = append(d.Agents, model.Agent{ID: string(rune('a' + i)), Kind: model.AgentSubagent, Addressable: true,
			StartedAt: at(1 + i), EndedAt: at(30), Status: model.StatusKilled, SpawnTurn: ip(0), ParentAgentID: nil})
	}
	r := BuildWith(Registry(), []Input{{Digest: d}}, at(60), time.UTC)
	if m := view(r, "swarm"); m.Hits != 1 || m.Examples[0].Note != "6 agents at once" {
		t.Errorf("swarm = %+v", m)
	}
	// One swarm and one team: 2 frontier hits, not yet too much.
	if r.OverYegge {
		t.Error("over-Yegge after two frontier hits")
	}
	var in []Input
	for i := range 5 {
		dd := *d
		dd.ID = string(rune('k' + i))
		in = append(in, Input{Digest: &dd})
	}
	r = BuildWith(Registry(), in, at(60), time.UTC)
	if !r.OverYegge {
		t.Fatal("ten frontier hits with no steering: want over-Yegge")
	}
	got := map[Persona]string{}
	for _, p := range r.Personas {
		got[p.ID] = p.Reaction
	}
	if got[Karpathy] != "😬" || got[Boris] != "🫠" || got[Yegge] != "🤯" {
		t.Errorf("reactions %v", got)
	}
}

func TestReactionsAndSuggestions(t *testing.T) {
	r := BuildWith(Registry(), nil, t0, time.UTC)
	if len(r.Personas) != 3 {
		t.Fatalf("%d personas", len(r.Personas))
	}
	for _, p := range r.Personas {
		if p.Reaction != "👀" {
			t.Errorf("%s with no sessions: %s", p.ID, p.Reaction)
		}
	}
	if len(r.Suggestions) != 3 {
		t.Fatalf("suggestions %+v", r.Suggestions)
	}
	order := []Persona{}
	reg := map[string]Persona{}
	for _, m := range Registry() {
		reg[m.ID] = m.Persona
	}
	for _, s := range r.Suggestions {
		order = append(order, reg[s.Moment])
	}
	if order[0] != Karpathy || order[1] != Boris || order[2] != Yegge {
		t.Errorf("suggestion personas %v", order)
	}
}

func TestRegistry(t *testing.T) {
	seen := map[string]bool{}
	for _, m := range Registry() {
		if m.ID == "" || m.Title == "" || m.What == "" || m.Try == "" || m.Detect == nil {
			t.Errorf("incomplete moment %+v", m.ID)
		}
		if seen[m.ID] {
			t.Errorf("duplicate id %s", m.ID)
		}
		seen[m.ID] = true
		switch m.Persona {
		case Karpathy, Boris, Yegge:
		default:
			t.Errorf("%s: persona %q", m.ID, m.Persona)
		}
	}
}

func TestDeterministic(t *testing.T) {
	var in []Input
	for i := range 4 {
		tt := turn(0, i, "x")
		tt.Queued = []model.QueuedPrompt{{At: at(i + 1), Origin: model.OriginHuman}}
		in = append(in, Input{Digest: session(string(rune('a'+i)), model.KindInteractive, tt)})
	}
	first, _ := json.Marshal(BuildWith(Registry(), in, at(100), time.UTC))
	for k := range 5 {
		rev := append([]Input(nil), in...)
		for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
			rev[i], rev[j] = rev[j], rev[i]
		}
		if k%2 == 0 {
			rev = in
		}
		got, _ := json.Marshal(BuildWith(Registry(), rev, at(100), time.UTC))
		if string(got) != string(first) {
			t.Fatal("report depends on input order")
		}
	}
}

func TestFirstHitDaysAndActivity(t *testing.T) {
	day := 24 * 60
	mk := func(id string, start int, text string) *model.SessionDigest {
		tt := turn(0, start, text)
		tt.Queued = []model.QueuedPrompt{{At: at(start + 1), Origin: model.OriginHuman}}
		return session(id, model.KindInteractive, tt)
	}
	a := mk("a", 0, "one")
	b := mk("b", 30, "two") // same day as a
	c := mk("c", 2*day, "three")
	child := session("d", model.KindInteractive, turn(0, 5*day, "copied"), turn(1, 5*day+10, "own"))
	child.Turns[0].Queued = []model.QueuedPrompt{{At: at(5*day + 1), Origin: model.OriginHuman}}
	scripted := session("s", model.KindSDK, turn(0, 3*day, "script"))
	in := []Input{{Digest: c}, {Digest: b}, {Digest: a}, {Digest: child, Inherited: []int{0}}, {Digest: scripted}}
	r := BuildWith(Registry(), in, at(10*day), time.UTC)

	m := view(r, "steer-mid-turn")
	if m.FirstHit == nil || m.FirstHit.Session.ID != "a" || !m.FirstHit.At.Equal(m.First) || m.FirstHit.Turn == nil || *m.FirstHit.Turn != 0 {
		t.Errorf("firstHit = %+v, first %v", m.FirstHit, m.First)
	}
	// each day's example is its session with the most hits; a and b tie on the first day, the later one wins
	wantDays := []struct {
		day     string
		hits    int
		session string
	}{{"2026-10-01", 2, "b"}, {"2026-10-03", 1, "c"}}
	if len(m.Days) != len(wantDays) {
		t.Fatalf("days = %+v, want %d", m.Days, len(wantDays))
	}
	for i, w := range wantDays {
		d := m.Days[i]
		if d.Day != w.day || d.Hits != w.hits || d.Example == nil || d.Example.Session.ID != w.session {
			t.Errorf("day %d = %+v (example %+v), want %v", i, d, d.Example, w)
		}
	}
	if m := view(r, "swarm"); m.FirstHit != nil || m.Days != nil {
		t.Errorf("unseen moment has firstHit/days: %+v", m)
	}
	// prompts per day: the copied turn of d and the scripted session are not counted
	wantAct := []ActivityDay{{"2026-10-01", 2}, {"2026-10-03", 1}, {"2026-10-06", 1}}
	if !slices.Equal(r.Activity, wantAct) {
		t.Errorf("activity = %v, want %v", r.Activity, wantAct)
	}
	if got := BuildWith(Registry(), nil, t0, time.UTC); got.Activity != nil {
		t.Errorf("activity without sessions: %v", got.Activity)
	}
}

func TestSuggestionExample(t *testing.T) {
	compacted := func(id string, start, n int) *model.SessionDigest {
		d := session(id, model.KindInteractive, turn(0, start, "x"), turn(1, start+10, "y"))
		for i := range n {
			d.Compactions = append(d.Compactions, model.Compaction{At: at(start + 20 + i), Turn: 1, Trigger: model.TriggerAuto})
		}
		return d
	}
	in := []Input{{Digest: compacted("few", 0, 1)}, {Digest: compacted("most", 100, 3)}, {Digest: compacted("tie", 200, 3)}}
	r := BuildWith(Registry(), in, at(1000), time.UTC)
	var got *Suggestion
	for i, s := range r.Suggestions {
		if s.Moment == "deliberate-compact" {
			got = &r.Suggestions[i]
		}
	}
	if got == nil || got.Example == nil {
		t.Fatalf("no example on %+v", r.Suggestions)
	}
	// the session with the most auto compactions; the later of two equal ones, at its turn
	if got.Example.Session.ID != "tie" || got.Example.Turn == nil || *got.Example.Turn != 1 || !got.Example.At.Equal(at(220)) {
		t.Errorf("example = %+v", got.Example)
	}
	for _, s := range r.Suggestions {
		if s.Reason == "" && s.Example != nil {
			t.Errorf("example without reason: %+v", s)
		}
	}
}

func TestEveryMomentSaysHowItIsSpotted(t *testing.T) {
	for _, m := range Registry() {
		if strings.TrimSpace(m.Detects) == "" {
			t.Errorf("%s has no Detects", m.ID)
		}
	}
}
