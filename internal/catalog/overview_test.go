package catalog

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

// The overview tests build their digests by hand. Times are t0 (2026-10-01T10:00Z) plus
// minutes; the catalog sits in UTC+5:30, so that no UTC boundary is a local one.

var ovZone = time.FixedZone("UTC+5:30", 5*3600+1800)

func ovCatalog(ds ...*model.SessionDigest) *Catalog {
	c := New()
	c.SetLocation(ovZone)
	for _, d := range ds {
		c.Upsert(d)
	}
	return c
}

// ovFrom is 15:00 local, 09:30Z: an hour boundary of ovZone, 30 minutes before t0.
var ovFrom = at(-30)

func ovQuery(slot time.Duration, hours int) OverviewQuery {
	return OverviewQuery{From: ovFrom, To: ovFrom.Add(time.Duration(hours) * time.Hour), Slot: slot}
}

// msg adds an owned message of the main agent (agent "") or of an agent, with a prompt of
// tokens in total (input, cache read and writes).
func msg(d *model.SessionDigest, id string, min int, usd float64, agent string, tok model.Tokens) {
	zero := 0
	d.Messages = append(d.Messages, model.Message{ID: id, At: at(min), Model: "sonnet", USD: usd, AgentID: agent, Turn: &zero, Tokens: tok})
}

func laneOf(t *testing.T, o Overview, id string) OverviewLane {
	t.Helper()
	for _, l := range o.Lanes {
		if l.ID == id {
			return l
		}
	}
	t.Fatalf("no lane %q in %+v", id, o.Lanes)
	return OverviewLane{}
}

// dense puts a lane's trimmed array back at its slot in n slots.
func dense[T any](l OverviewLane, a []T, n int) []T {
	out := make([]T, n)
	copy(out[l.Slot0:], a)
	return out
}

func TestOverviewCopiedMessageCountedOnce(t *testing.T) {
	p := syn("claude", "p", "/w", 0, 20, []model.Turn{turn(0, "u0", "go", 0)}, msgSpec{"m1", 0, 1, 0}, msgSpec{"m2", 5, 2, 0})
	c := syn("claude", "c", "/w", 8, 20, []model.Turn{turn(0, "u0", "go", 0)}, msgSpec{"m1", 0, 1, 0}, msgSpec{"m2", 5, 2, 0}, msgSpec{"m3", 10, 4, 0})
	c.Lineage.ForkedFrom = &model.ForkRef{SessionID: "p", MessageUUID: "u0"}
	o, err := ovCatalog(p, c).Overview(ovQuery(time.Hour, 3))
	if err != nil {
		t.Fatal(err)
	}
	// c owns only m3 (4), p owns m1 and m2 (3): by usd, c first.
	if len(o.Lanes) != 2 || o.Lanes[0].ID != "c" || o.Lanes[1].ID != "p" {
		t.Fatalf("lanes %+v", o.Lanes)
	}
	wantNear(t, "c usd", o.Lanes[0].USD, 4)
	wantNear(t, "p usd", o.Lanes[1].USD, 3)
	// m1, m2 at 10:00 and 10:05Z, m3 at 10:10Z: all in slot 0 (09:30 to 10:30Z).
	for _, l := range o.Lanes {
		if l.Slot0 != 0 || l.Active[0] != 1 {
			t.Errorf("lane %s: slot0 %d active %v", l.ID, l.Slot0, l.Active)
		}
	}
}

func TestOverviewSlotAlignmentInLocalTime(t *testing.T) {
	d := syn("claude", "a", "/w", 0, 5, nil, msgSpec{"m1", 0, 1, 0})
	c := ovCatalog(d)
	// 10:00Z is 15:30 local on Oct 1; the range ends 10:00Z the next day.
	q := OverviewQuery{From: at(0), To: at(24 * 60)}
	for _, tc := range []struct {
		slot  time.Duration
		from  string
		slots int
	}{
		{24 * time.Hour, "2026-09-30T18:30:00Z", 2},    // local midnight Oct 1
		{6 * time.Hour, "2026-10-01T06:30:00Z", 5},     // 12:00 local
		{12 * time.Hour, "2026-10-01T06:30:00Z", 3},    // 12:00 local
		{time.Hour, "2026-10-01T09:30:00Z", 25},        // 15:00 local
		{15 * time.Minute, "2026-10-01T10:00:00Z", 96}, // 15:30 local is a boundary
	} {
		q.Slot = tc.slot
		o, err := c.Overview(q)
		if err != nil {
			t.Fatal(err)
		}
		if got := o.From.Format(time.RFC3339); got != tc.from || o.Slots != tc.slots {
			t.Errorf("slot %s: from %s, %d slots; want %s, %d", o.Slot, got, o.Slots, tc.from, tc.slots)
		}
		if o.From.Location() != time.UTC || o.To.Sub(o.From) != time.Duration(o.Slots)*tc.slot || o.SlotMs != tc.slot.Milliseconds() {
			t.Errorf("slot %s: to %s, slotMs %d", o.Slot, o.To, o.SlotMs)
		}
		if tc.slot >= 6*time.Hour {
			if l := o.From.In(ovZone); l.Hour()%int(tc.slot/time.Hour) != 0 || l.Minute() != 0 {
				t.Errorf("slot %s starts at %s local", o.Slot, l)
			}
		}
	}
	// A message lands in the slot of its local boundary: 10:00Z is slot 0 of the 6h range
	// (06:30 to 12:30Z) and slot 0 of the 1d range.
	q.Slot = 6 * time.Hour
	o, _ := c.Overview(q)
	if l := laneOf(t, o, "a"); l.Slot0 != 0 || l.Active[0] != 1 {
		t.Errorf("6h: slot0 %d active %v", l.Slot0, l.Active)
	}
	if o.Slot != "6h" {
		t.Errorf("slot name %q", o.Slot)
	}
}

func TestOverviewDefaultSlot(t *testing.T) {
	c := ovCatalog(syn("claude", "a", "/w", 0, 5, nil, msgSpec{"m1", 0, 1, 0}))
	for _, tc := range []struct {
		days int
		slot string
	}{{1, "10m"}, {2, "15m"}, {3, "30m"}, {7, "1h"}, {30, "6h"}, {90, "12h"}, {300, "1d"}} {
		o, err := c.Overview(OverviewQuery{From: at(0).AddDate(0, 0, -tc.days), To: at(0)})
		if err != nil {
			t.Fatalf("%d days: %v", tc.days, err)
		}
		if o.Slot != tc.slot {
			t.Errorf("%d days: slot %s, want %s (%d slots)", tc.days, o.Slot, tc.slot, o.Slots)
		}
	}
}

func TestOverviewErrors(t *testing.T) {
	c := ovCatalog(syn("claude", "a", "/w", 0, 5, nil, msgSpec{"m1", 0, 1, 0}))
	for name, q := range map[string]OverviewQuery{
		"bad slot":   {From: at(0), To: at(60), Slot: 7 * time.Minute},
		"too many":   {From: at(0).AddDate(-10, 0, 0), To: at(0), Slot: 15 * time.Minute},
		"too many d": {From: at(0).AddDate(-7, 0, 0), To: at(0)},
		"empty":      {From: at(0), To: at(0)},
	} {
		_, err := c.Overview(q)
		var oe *OverviewError
		if !errors.As(err, &oe) {
			t.Errorf("%s: err = %v, want an OverviewError", name, err)
		}
	}
}

func TestOverviewContext(t *testing.T) {
	a := syn("claude", "a", "/w", 0, 20, nil)
	msg(a, "a1", 0, 1, "", model.Tokens{Input: 1000, CacheRead: 9000})
	msg(a, "a2", 10, 1, "", model.Tokens{Input: 10000, CacheWrite5m: 5000, CacheWrite1h: 5000, Output: 99999})
	msg(a, "a3", 11, 2, "ag1", model.Tokens{Input: 50000}) // an agent: its context is not the session's
	msg(a, "a4", 70, 1, "", model.Tokens{Input: 3})        // slot 1
	b := syn("claude", "b", "/w", 5, 20, nil)
	msg(b, "b1", 5, 0.5, "", model.Tokens{CacheRead: 7000})
	o, err := ovCatalog(a, b).Overview(ovQuery(time.Hour, 3))
	if err != nil {
		t.Fatal(err)
	}
	// a: the largest prompt of slot 0 is a2's 20000 (input and cache, not output); the agent's
	// 50000 is not the session's context. a4 (10:40Z) is slot 1.
	la, lb := laneOf(t, o, "a"), laneOf(t, o, "b")
	if want := []int64{20000, 3}; la.Slot0 != 0 || !reflect.DeepEqual(la.Context, want) {
		t.Errorf("a context = %v from %d, want %v", la.Context, la.Slot0, want)
	}
	if want := []int{1, 1}; !reflect.DeepEqual(la.Active, want) {
		t.Errorf("a active = %v, want %v", la.Active, want)
	}
	if want := []int64{7000}; !reflect.DeepEqual(lb.Context, want) {
		t.Errorf("b context = %v, want %v", lb.Context, want)
	}
	wantNear(t, "a usd (agent message included)", la.USD, 5)
}

func TestOverviewSpansTurnsAgents(t *testing.T) {
	zero, one := 0, 1
	p := syn("claude", "p", "/w", 0, 90, []model.Turn{turn(0, "u0", "go", 0), turn(1, "u1", "more", 20)}, msgSpec{"m1", 0, 1, 0})
	p.Agents = []model.Agent{
		{ID: "a1", Kind: model.AgentSubagent, StartedAt: at(1), EndedAt: at(4), SpawnTurn: &zero},
		{ID: "a2", Kind: model.AgentSubagent, StartedAt: at(2), EndedAt: at(3), SpawnTurn: &zero},
		{ID: "a3", Kind: model.AgentSubagent, Addressable: true, StartedAt: at(3), SpawnTurn: &zero},
		{ID: "a4", Kind: model.AgentSubagent, InheritsContext: true, StartedAt: at(70), SpawnTurn: &zero},
		{ID: "a5", Kind: model.AgentWorkflow, StartedAt: at(71)},
		{ID: "a6", Kind: model.AgentCompact, StartedAt: at(4)},
	}
	p.Compactions = []model.Compaction{
		{At: at(5), Summary: "s1", Call: &model.CompactionCall{Cache: model.CacheCold}},
		{At: at(6), Summary: "s2", Call: &model.CompactionCall{Cache: model.CacheWarm}},
		{At: at(7), Summary: "s3"},
		{At: at(8), Summary: "s4", Call: &model.CompactionCall{Cache: model.CacheCold}},
	}
	p.Agents[1].Compactions = []model.Compaction{{At: at(9), Summary: "s5", Call: &model.CompactionCall{Cache: model.CacheWarm}}}
	// The child copies the parent's first turn (and its agents and compactions) and adds
	// its own: a fork, since the parent goes on.
	c := syn("claude", "c", "/w", 65, 90, []model.Turn{turn(0, "u0", "go", 0), turn(1, "u2", "mine", 65)}, msgSpec{"m1", 0, 1, 0})
	c.Lineage.ForkedFrom = &model.ForkRef{SessionID: "p", MessageUUID: "u0"}
	msg(c, "c2", 66, 3, "", model.Tokens{Input: 5})
	c.Agents = []model.Agent{
		{ID: "a1", Kind: model.AgentSubagent, StartedAt: at(1), SpawnTurn: &zero}, // inherited turn: not counted
		{ID: "c1", Kind: model.AgentSubagent, StartedAt: at(67), SpawnTurn: &one},
	}
	c.Compactions = []model.Compaction{p.Compactions[3]} // a copy of s4, owned by p
	msg(p, "p2", 75, 1, "", model.Tokens{})
	p.Turns[1].UUID = "u1"

	cat := ovCatalog(p, c)
	info, _ := cat.Session(c.Key())
	if !reflect.DeepEqual(info.InheritedTurns, []int{0}) || info.Parent == nil || info.Parent.Kind != LinkFork {
		t.Fatalf("lineage not as the test assumes: inherited %v, parent %+v", info.InheritedTurns, info.Parent)
	}
	o, err := cat.Overview(ovQuery(time.Hour, 3))
	if err != nil {
		t.Fatal(err)
	}
	// Spans: a1 and a2 are one span each; a3 is a teammate; a4 a fork; a5 a workflow;
	// c1 a subagent of turn 1; c's copy of a1 is an inherited turn's; c is a fork of p.
	type sp struct {
		kind string
		sess string
		at   int
	}
	spans := func(l OverviewLane) []sp {
		var got []sp
		for _, s := range l.Spans {
			got = append(got, sp{s.Kind, s.Session.ID, int(s.Start.Sub(t0) / time.Minute)})
		}
		return got
	}
	lp, lc := laneOf(t, o, "p"), laneOf(t, o, "c")
	if want := []sp{{"subagent", "p", 1}, {"subagent", "p", 2}, {"teammate", "p", 3}, {"fork", "p", 70}, {"workflow", "p", 71}}; !reflect.DeepEqual(spans(lp), want) {
		t.Errorf("p spans:\n got %+v\nwant %+v", spans(lp), want)
	}
	if want := []sp{{"session-fork", "c", 65}, {"subagent", "c", 67}}; !reflect.DeepEqual(spans(lc), want) {
		t.Errorf("c spans:\n got %+v\nwant %+v", spans(lc), want)
	}
	// p: turns 0 and 1 started in the range, 5 agents (a6 is a compact agent). c: its inherited
	// turn 0 and a1 are not its own; turn 1 and c1 are. The branch itself is not an agent.
	if lp.Turns != 2 || lp.Agents != 5 {
		t.Errorf("lane p: turns %d agents %d", lp.Turns, lp.Agents)
	}
	if lc.Turns != 1 || lc.Agents != 1 {
		t.Errorf("lane c: turns %d agents %d", lc.Turns, lc.Agents)
	}
	// A range after the first turn and the first agents: only what started in it counts.
	o, _ = cat.Overview(OverviewQuery{From: at(60), To: at(180), Slot: time.Hour})
	if l := laneOf(t, o, "p"); l.Turns != 0 || l.Agents != 2 {
		t.Errorf("late range, lane p: turns %d agents %d, want 0 and 2 (a4, a5)", l.Turns, l.Agents)
	}
}

func ovAgent(id string, kind model.AgentKind, start, end int, turn *int) model.Agent {
	a := model.Agent{ID: id, Kind: kind, StartedAt: at(start), SpawnTurn: turn, Description: "d-" + id}
	if end >= 0 {
		a.EndedAt = at(end)
	}
	return a
}

func TestOverviewSpanPerAgent(t *testing.T) {
	zero, one := 0, 1
	p := syn("claude", "p", "/w", 0, 60, []model.Turn{turn(0, "u0", "go", 0), turn(1, "u1", "more", 30)}, msgSpec{"m1", 0, 1, 0})
	p.Agents = []model.Agent{
		ovAgent("s1", model.AgentSubagent, 1, 5, &zero),
		ovAgent("s2", model.AgentSubagent, 2, 6, &zero),
		ovAgent("s3", model.AgentSubagent, 3, 9, &zero),
		ovAgent("s4", model.AgentSubagent, 8, 10, &zero),  // overlaps s3
		ovAgent("s5", model.AgentSubagent, 20, 21, &zero), // far later: its own span
		ovAgent("s6", model.AgentSubagent, 2, 6, &one),    // another turn: its own span
		ovAgent("t1", model.AgentSubagent, 2, 6, &zero),
		ovAgent("f1", model.AgentSubagent, 2, 6, &zero),
		ovAgent("k1", model.AgentCompact, 2, 6, &zero),
		ovAgent("r1", model.AgentReview, 2, 6, &zero),
		ovAgent("o1", model.AgentSubagent, 40, -1, &one), // open: ends at its last message
	}
	p.Agents[6].Addressable = true
	p.Agents[7].InheritsContext = true
	msg(p, "o-1", 44, 0.1, "o1", model.Tokens{})
	msg(p, "o-2", 42, 0.1, "o1", model.Tokens{})
	o, err := ovCatalog(p).Overview(ovQuery(time.Hour, 3))
	if err != nil {
		t.Fatal(err)
	}
	type sp struct {
		kind       string
		start, end int
		title      string
	}
	min := func(t time.Time) int { return int(t.Sub(t0) / time.Minute) }
	var got []sp
	for _, s := range laneOf(t, o, "p").Spans {
		got = append(got, sp{s.Kind, min(s.Start), min(s.End), s.Title})
	}
	want := []sp{
		{"subagent", 1, 5, "d-s1"}, // one span per agent, however close
		{"fork", 2, 6, "d-f1"},
		{"subagent", 2, 6, "d-s2"},
		{"subagent", 2, 6, "d-s6"},
		{"teammate", 2, 6, "d-t1"},
		{"subagent", 3, 9, "d-s3"},
		{"subagent", 8, 10, "d-s4"},
		{"subagent", 20, 21, "d-s5"},
		{"subagent", 40, 44, "d-o1"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("spans:\n got %+v\nwant %+v", got, want)
	}
	// A span is not clipped, and is listed when its life overlaps the range; an agent that
	// started before the range is not counted in the lane's agents.
	q := OverviewQuery{From: at(25), To: at(50), Slot: 5 * time.Minute}
	o, err = ovCatalog(p).Overview(q)
	if err != nil {
		t.Fatal(err)
	}
	if l := laneOf(t, o, "p"); len(l.Spans) != 1 || l.Spans[0].Title != "d-o1" || l.Agents != 1 {
		t.Errorf("range spans: %+v, agents %d", l.Spans, l.Agents)
	}
	o, _ = ovCatalog(p).Overview(OverviewQuery{From: at(7), To: at(50), Slot: 5 * time.Minute})
	// The range starts at 10:05Z: s3 (3 to 9) overlaps it and is listed, but started before it.
	if l := laneOf(t, o, "p"); len(l.Spans) != 8 || l.Agents != 3 {
		t.Errorf("early start: %d spans, %d agents; want 8 and 3", len(l.Spans), l.Agents)
	}
}

func TestOverviewContinuationSpanAndLanes(t *testing.T) {
	p := syn("claude", "p", "/w", 0, 30, []model.Turn{turn(0, "u0", "go", 0)}, msgSpec{"m1", 0, 1, 0})
	zero := 0
	p.Agents = []model.Agent{ovAgent("s1", model.AgentSubagent, 1, 3, &zero)}
	// c copies p's only turn and message, and p does not go on: a continuation.
	c := syn("claude", "c", "/w", 40, 90, []model.Turn{turn(0, "u0", "go", 0), turn(1, "u9", "go on", 40)}, msgSpec{"m1", 0, 1, 0})
	msg(c, "c1", 41, 1, "", model.Tokens{Input: 200})
	cat := ovCatalog(p, c)
	if info, _ := cat.Session(c.Key()); info.Parent == nil || info.Parent.Kind != LinkContinuation {
		t.Fatalf("fixture does not make a continuation: %+v", info.Parent)
	}
	o, err := cat.Overview(ovQuery(time.Hour, 3))
	if err != nil {
		t.Fatal(err)
	}
	if len(o.Lanes) != 2 {
		t.Fatalf("lanes %+v", o.Lanes)
	}
	lc, lp := o.Lanes[0], o.Lanes[1] // equal usd: by id
	if len(lp.Spans) != 1 || lp.Spans[0].Kind != "subagent" || len(lc.Spans) != 1 {
		t.Errorf("lane spans: %+v / %+v", lp.Spans, lc.Spans)
	}
	if s := lc.Spans[0]; s.Kind != "continuation" || s.Session.ID != "c" || s.Title != "session c" || !s.Start.Equal(at(40)) || !s.End.Equal(at(90)) {
		t.Errorf("continuation span: %+v", s)
	}
	// p: one call at 10:00Z (slot 0); c: one call of its own at 10:41Z (slot 1).
	if want := []int{1, 0, 0}; !reflect.DeepEqual(dense(lp, lp.Active, 3), want) {
		t.Errorf("p active %v, want %v", lp.Active, want)
	}
	if want := []int{0, 1, 0}; !reflect.DeepEqual(dense(lc, lc.Active, 3), want) {
		t.Errorf("c active %v, want %v", lc.Active, want)
	}
}

func TestOverviewHeldContext(t *testing.T) {
	hold := func(next int) Overview {
		a := syn("claude", "a", "/w", 0, 60, nil)
		msg(a, "a1", 0, 1, "", model.Tokens{Input: 5000})
		msg(a, "a2", next, 1, "", model.Tokens{Input: 100})
		o, err := ovCatalog(a).Overview(OverviewQuery{From: at(0), To: at(15), Slot: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		return o
	}
	// 10:00Z is 15:30 local, a 1m boundary. The next call at 10:04 holds 5000 through slot 4,
	// where the next call's own 100 is smaller.
	o := hold(4)
	if want := []int64{5000, 5000, 5000, 5000, 5000}; !reflect.DeepEqual(o.Lanes[0].Context, want) || o.Lanes[0].Slot0 != 0 {
		t.Errorf("next at 10:04: %v from %d", o.Lanes[0].Context, o.Lanes[0].Slot0)
	}
	if want := []int{1, 1, 1, 1, 1}; !reflect.DeepEqual(o.Lanes[0].Active, want) {
		t.Errorf("active %v", o.Lanes[0].Active)
	}
	// Exactly 5 minutes still holds; 20 minutes ends at the call.
	if c := hold(5).Lanes[0].Context; len(c) != 6 || c[5] != 5000 || c[3] != 5000 {
		t.Errorf("next at 10:05: %v", c)
	}
	o = hold(20)
	if got := dense(o.Lanes[0], o.Lanes[0].Context, 15); got[0] != 5000 || got[1] != 0 || got[4] != 0 {
		t.Errorf("next at 10:20: %v", got)
	}
	// A call before the range holds into it.
	a := syn("claude", "a", "/w", 0, 60, nil)
	msg(a, "a1", 0, 1, "", model.Tokens{Input: 7000})
	msg(a, "a2", 3, 1, "", model.Tokens{Input: 10})
	o, _ = ovCatalog(a).Overview(OverviewQuery{From: at(2), To: at(6), Slot: time.Minute})
	if l := laneOf(t, o, "a"); !reflect.DeepEqual(dense(l, l.Context, 4), []int64{7000, 7000, 0, 0}) || l.Active[0] != 1 {
		t.Errorf("held into range: context %v from %d, active %v", l.Context, l.Slot0, l.Active)
	}
}

func TestOverviewFineSlots(t *testing.T) {
	c := ovCatalog(syn("claude", "a", "/w", 0, 5, nil, msgSpec{"m1", 0, 1, 0}))
	for _, tc := range []struct {
		slot time.Duration
		name string
	}{{time.Minute, "1m"}, {2 * time.Minute, "2m"}, {5 * time.Minute, "5m"}, {10 * time.Minute, "10m"}} {
		// 10:00Z is 15:30 local: a boundary of each; the range 10:01 to 10:31Z moves down.
		o, err := c.Overview(OverviewQuery{From: at(1), To: at(31), Slot: tc.slot})
		if err != nil {
			t.Fatal(err)
		}
		l := o.From.In(ovZone)
		if o.Slot != tc.name || o.SlotMs != tc.slot.Milliseconds() || (l.Hour()*60+l.Minute())%int(tc.slot/time.Minute) != 0 ||
			o.From.After(at(1)) || o.From.Before(at(1).Add(-tc.slot)) || o.To.Before(at(31)) {
			t.Errorf("%s: from %s to %s, %d slots", tc.name, o.From, o.To, o.Slots)
		}
	}
	if _, err := c.Overview(OverviewQuery{From: at(0), To: at(60 * 40), Slot: time.Minute}); err == nil {
		t.Error("1m over 40 hours (2,400 slots) accepted")
	}
}

func TestOverviewScriptedApart(t *testing.T) {
	a := syn("claude", "a", "/w", 0, 5, nil, msgSpec{"m1", 0, 1, 0})
	s := syn("claude", "s", "/w", 0, 5, nil, msgSpec{"s1", 0, 0.25, 0}, msgSpec{"s2", 70, 0.5, 0})
	s.Kind = model.KindSDK
	o, err := ovCatalog(a, s).Overview(ovQuery(time.Hour, 3))
	if err != nil {
		t.Fatal(err)
	}
	if len(o.Lanes) != 1 || o.Lanes[0].ID != "a" {
		t.Errorf("lanes %+v: the scripted run has none", o.Lanes)
	}
	if o.Scripted.Sessions != 1 || !near(o.Scripted.USD, 0.75) {
		t.Errorf("scripted = %+v", o.Scripted)
	}
}

func TestOverviewLanesOrder(t *testing.T) {
	a := syn("claude", "a", "/w", 20, 30, nil, msgSpec{"a1", 20, 1, 0})
	b := syn("claude", "b", "/w", 0, 30, nil, msgSpec{"b1", 0, 2, 0})
	d := syn("claude", "d", "/x", 0, 30, nil, msgSpec{"d1", 0, 5, 0})
	e := syn("claude", "e", "/y", 0, 30, nil, msgSpec{"e1", 0, 5, 0})
	old := syn("claude", "old", "/w", -600, -590, nil, msgSpec{"o1", -600, 9, 0}) // outside the range
	s := syn("claude", "s", "/w", 0, 5, nil, msgSpec{"s1", 0, 7, 0})
	s.Kind = model.KindSDK
	o, err := ovCatalog(a, b, d, e, old, s).Overview(ovQuery(time.Hour, 2))
	if err != nil {
		t.Fatal(err)
	}
	// By usd, then id; the old session and the scripted run have no lane.
	var ids []string
	for _, l := range o.Lanes {
		ids = append(ids, l.ID)
	}
	if want := []string{"d", "e", "b", "a"}; !reflect.DeepEqual(ids, want) {
		t.Errorf("lanes = %v, want %v", ids, want)
	}
	l := o.Lanes[2]
	wantNear(t, "lane usd", l.USD, 2)
	if l.Dir != "/w" || len(l.Context) != 1 || len(l.Active) != 1 || len(l.Idle) != 1 || l.Spans == nil || l.Title == "" || l.StartedAt.IsZero() {
		t.Errorf("lane = %+v", l)
	}
	// No lanes is an empty list, not null.
	o, _ = ovCatalog(a).Overview(OverviewQuery{From: at(5000), To: at(5060), Slot: time.Hour})
	if o.Lanes == nil || len(o.Lanes) != 0 {
		t.Errorf("empty lanes: %#v", o.Lanes)
	}
}

func TestOverviewLanePlaces(t *testing.T) {
	// s starts in /main and edits mostly in a worktree; x works in no repository.
	sd := locSession("s", "/main", wd("/main", 1, 9), wd("/main/.wt/a", 5, 0))
	x := locSession("x", "/scratch", wd("/scratch", 3, 0))
	c := ovCatalog(sd, x)
	c.SetPlaces(locFixture())
	o, err := c.Overview(ovQuery(time.Hour, 2))
	if err != nil {
		t.Fatal(err)
	}
	if l := laneOf(t, o, "s"); l.Dir != "/main" || l.Checkout != "/main/.wt/a" || l.Repo != rMain || l.Remote != "example.com/main" {
		t.Errorf("s: dir %q checkout %q repo %q remote %q", l.Dir, l.Checkout, l.Repo, l.Remote)
	}
	if l := laneOf(t, o, "x"); l.Dir != "/scratch" || l.Checkout != "" || l.Repo != "" || l.Remote != "" {
		t.Errorf("x: dir %q checkout %q repo %q remote %q", l.Dir, l.Checkout, l.Repo, l.Remote)
	}
}

func TestOverviewIdleContext(t *testing.T) {
	// Calls at minutes 0 (5000), 10 (200), 130 (300), 140 (400), 145 (50): the gap of 10 minutes
	// is idle, that of 2 hours holds nothing, 10 minutes is idle again, 5 minutes is context.
	a := syn("claude", "a", "/w", 0, 150, nil)
	msg(a, "a1", 0, 1, "", model.Tokens{Input: 5000})
	msg(a, "a2", 10, 1, "", model.Tokens{Input: 200})
	msg(a, "a3", 130, 1, "", model.Tokens{Input: 300})
	msg(a, "a4", 140, 1, "", model.Tokens{Input: 400})
	msg(a, "a5", 145, 1, "", model.Tokens{Input: 50})
	b := syn("claude", "b", "/w", 0, 150, nil)
	msg(b, "b1", 0, 1, "", model.Tokens{Input: 70})
	msg(b, "b2", 30, 1, "", model.Tokens{Input: 1})
	o, err := ovCatalog(a, b).Overview(OverviewQuery{From: at(0), To: at(150), Slot: 5 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if o.Slots != 30 {
		t.Fatalf("%d slots", o.Slots)
	}
	var la, lb OverviewLane
	for _, l := range o.Lanes {
		if l.ID == "a" {
			la = l
		} else {
			lb = l
		}
	}
	idle, ctx := dense(la, la.Idle, 30), dense(la, la.Context, 30)
	// 5000 is held as idle from 10:00 to 10:10 (slots 0 to 2). Slot 0 has it as context (the
	// call itself) and slot 2 has the next call's 200: only slot 1 shows idle.
	for i, want := range []int64{0, 5000, 0} {
		if idle[i] != want {
			t.Errorf("idle[%d] = %d, want %d (idle %v)", i, idle[i], want, idle)
		}
	}
	if ctx[0] != 5000 || ctx[1] != 0 {
		t.Errorf("context %v", ctx[:4])
	}
	// Slot 2 holds the next call's 200 as context at 10:10 (at the call itself): no idle there.
	if ctx[2] != 200 || idle[2] != 0 {
		t.Errorf("slot 2: context %d idle %d", ctx[2], idle[2])
	}
	// The 200 held from 10:10 and the call at 12:10 are two hours apart: nothing in between.
	for i := 3; i < 26; i++ {
		if idle[i] != 0 {
			t.Errorf("idle[%d] = %d after a 2 h gap", i, idle[i])
		}
	}
	// 12:10 to 12:20: 300 idle in slots 26..28 except where context is held: slot 26 (the call),
	// and slot 28 (12:20, the next call's own context 400).
	if idle[27] != 300 || ctx[26] != 300 || idle[26] != 0 || ctx[28] != 400 || idle[28] != 0 {
		t.Errorf("12:10-12:20: idle %v context %v", idle[26:30], ctx[26:30])
	}
	// The last call holds no idle; 400 then 50 five minutes apart is context (slots 28, 29).
	if idle[29] != 0 || ctx[29] != 400 {
		t.Errorf("end: idle %d ctx %d", idle[29], ctx[29])
	}
	// b: 70 at 10:00, next call 30 minutes later: idle through slots 1..5 (70) and slot 6
	// is the call's own context.
	if bi := dense(lb, lb.Idle, 30); bi[1] != 70 || bi[5] != 70 || bi[0] != 0 || bi[6] != 0 {
		t.Errorf("b idle %v", bi[:8])
	}
}

func TestOverviewLaneTrimming(t *testing.T) {
	a := syn("claude", "a", "/w", 0, 200, nil)
	msg(a, "a1", 62, 1, "", model.Tokens{Input: 900}) // slot 2 of 1h slots from 09:30Z... see below
	msg(a, "a2", 70, 1, "", model.Tokens{Input: 100})
	o, err := ovCatalog(a).Overview(OverviewQuery{From: ovFrom, To: ovFrom.Add(8 * time.Hour), Slot: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	l := o.Lanes[0]
	// 09:30Z + 2 h = 11:30Z: the call at 11:02Z is slot 1, the other at 11:10Z too; the
	// 5-minute-plus gap is 8 minutes: idle from 11:02 to 11:10, all inside slot 1.
	if l.Slot0 != 1 || len(l.Context) != 1 || len(l.Idle) != 1 || len(l.Active) != 1 {
		t.Fatalf("lane: slot0 %d, lens %d %d %d", l.Slot0, len(l.Context), len(l.Idle), len(l.Active))
	}
	if l.Context[0] != 900 || l.Idle[0] != 0 || !near(l.USD, 2) {
		t.Errorf("lane: %+v", l)
	}
	// Idle that runs into later slots extends the lane's arrays.
	b := syn("claude", "b", "/w", 0, 200, nil)
	msg(b, "b1", 5, 1, "", model.Tokens{Input: 900})
	msg(b, "b2", 125, 1, "", model.Tokens{Input: 100}) // 2 h later: nothing held
	msg(b, "b3", 160, 1, "", model.Tokens{Input: 100}) // 35 min after b2: idle
	o, _ = ovCatalog(b).Overview(OverviewQuery{From: ovFrom, To: ovFrom.Add(8 * time.Hour), Slot: time.Hour})
	l = o.Lanes[0]
	// b1 10:05Z slot 0; b2 12:05Z slot 2; b3 12:40Z slot 3. Idle 100 from b2 to b3: slot 2 has
	// context 100 (the call), slot 3 context 100 (the call): idle never shows.
	if l.Slot0 != 0 || len(l.Context) != 4 {
		t.Errorf("b: slot0 %d, %d slots", l.Slot0, len(l.Context))
	}
}

// A lane carries the bead holding the largest share of its bead-attributed cost, and the answer the
// chains (the bead and its parents up to the last one the databases know) of those beads.
func TestOverviewLaneBeadAndChains(t *testing.T) {
	create := func(min int, id, title, parent string) model.BeadEvent {
		e := bev(min, "", model.BeadCreate, "/w", id)
		e.Title, e.Parent = title, parent
		return e
	}
	// s1 works on a grandchild (parent acme-c1, whose parent acme-r0 is a title-less implied root)
	s1 := oneMsgSession("s1", "/w", 1, 0, 1, 2)
	s1.Beads = []model.BeadEvent{
		create(0, "acme-c1", "Child task", "acme-r0"),
		create(0, "acme-c1.1", "Grandchild", "acme-c1"),
		bev(1, "", model.BeadClaim, "/w", "acme-c1.1"),
	}
	// s2 claims a parent-less bead and a child bead: the larger share decides
	s2 := oneMsgSession("s2", "/w", 1, 5, 6, 7)
	s2.Beads = []model.BeadEvent{create(5, "other-a1", "Alone", ""), bev(6, "", model.BeadClaim, "/w", "other-a1")}
	s3 := oneMsgSession("s3", "/w", 1, 10, 11) // no bead
	c := ovCatalog(s1, s2, s3)
	c.SetPlaces(Places{})
	o, err := c.Overview(ovQuery(time.Hour, 3))
	if err != nil {
		t.Fatal(err)
	}
	if got := laneOf(t, o, "s1").Bead; got != "acme-c1.1" {
		t.Errorf("s1 bead = %q", got)
	}
	if got := laneOf(t, o, "s2").Bead; got != "other-a1" {
		t.Errorf("s2 bead = %q", got)
	}
	if got := laneOf(t, o, "s3").Bead; got != "" {
		t.Errorf("s3 bead = %q, want none", got)
	}
	want := map[string]OverviewBead{
		"acme-c1.1": {Title: "Grandchild", Parent: "acme-c1"},
		"acme-c1":   {Title: "Child task", Parent: "acme-r0"},
		"acme-r0":   {},
		"other-a1":  {Title: "Alone"},
	}
	for id, w := range want {
		g, ok := o.Beads[id]
		if !ok || g.Title != w.Title || g.Parent != w.Parent {
			t.Errorf("beads[%s] = %+v (%v), want %+v", id, g, ok, w)
		}
	}
	if len(o.Beads) != len(want) {
		t.Errorf("beads = %+v, want only the chains", o.Beads)
	}
	// no lane on a bead: no beads at all
	o2, err := ovCatalog(s3).Overview(ovQuery(time.Hour, 3))
	if err != nil || o2.Beads != nil {
		t.Errorf("beads without any bead lane = %+v, %v", o2.Beads, err)
	}
}
