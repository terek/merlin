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

func group(t *testing.T, o Overview, key string) OverviewGroup {
	t.Helper()
	for _, g := range o.Groups {
		if g.Key == key {
			return g
		}
	}
	t.Fatalf("no group %q in %+v", key, o.Groups)
	return OverviewGroup{}
}

func TestOverviewCopiedMessageCountedOnce(t *testing.T) {
	p := syn("claude", "p", "/w", 0, 20, []model.Turn{turn(0, "u0", "go", 0)}, msgSpec{"m1", 0, 1, 0}, msgSpec{"m2", 5, 2, 0})
	c := syn("claude", "c", "/w", 8, 20, []model.Turn{turn(0, "u0", "go", 0)}, msgSpec{"m1", 0, 1, 0}, msgSpec{"m2", 5, 2, 0}, msgSpec{"m3", 10, 4, 0})
	c.Lineage.ForkedFrom = &model.ForkRef{SessionID: "p", MessageUUID: "u0"}
	o, err := ovCatalog(p, c).Overview(ovQuery(time.Hour, 3))
	if err != nil {
		t.Fatal(err)
	}
	g := group(t, o, "/w")
	wantNear(t, "usd", g.USD, 7)
	if g.Sessions != 2 {
		t.Errorf("sessions = %d, want 2", g.Sessions)
	}
	// m1, m2 at 10:00 and 10:05Z, m3 at 10:10Z: all in slot 0 (09:30 to 10:30Z).
	wantNear(t, "slot 0", g.USDSlots[0], 7)
	if g.Active[0] != 2 {
		t.Errorf("active[0] = %d, want 2 (the parent and the child's own message)", g.Active[0])
	}
	if g.Priciest.ID != "p" && g.Priciest.ID != "c" {
		t.Errorf("priciest %+v", g.Priciest)
	}
	wantNear(t, "priciest usd", g.Priciest.USD, 4)
	if g.Priciest.ID != "c" {
		t.Errorf("priciest = %s, want c (own 4 vs 3)", g.Priciest.ID)
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
	wantNear(t, "6h slot 0", group(t, o, "/w").USDSlots[0], 1)
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
		"bad by":     {From: at(0), To: at(60), By: GroupBead},
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

func TestOverviewContextPeakAndSum(t *testing.T) {
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
	g := group(t, o, "/w")
	if want := []int64{20000, 3, 0}; !reflect.DeepEqual(g.ContextPeak, want) {
		t.Errorf("contextPeak = %v, want %v", g.ContextPeak, want)
	}
	if want := []int64{27000, 3, 0}; !reflect.DeepEqual(g.ContextSum, want) {
		t.Errorf("contextSum = %v, want %v", g.ContextSum, want)
	}
	if want := []int{2, 1, 0}; !reflect.DeepEqual(g.Active, want) {
		t.Errorf("active = %v, want %v", g.Active, want)
	}
	wantNear(t, "slot 0 usd (agent message included)", g.USDSlots[0], 4.5)
	wantNear(t, "usd", g.USD, 5.5)
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
	g := group(t, o, "/w")
	// Spans: a1 and a2 are one span each; a3 is a teammate; a4 a fork; a5 a workflow;
	// c1 a subagent of turn 1; c's copy of a1 is an inherited turn's; c is a fork of p.
	type sp struct {
		kind string
		sess string
		at   int
	}
	var got []sp
	for _, s := range g.Spans {
		got = append(got, sp{s.Kind, s.Session.ID, int(s.Start.Sub(t0) / time.Minute)})
	}
	wantSp := []sp{{"subagent", "p", 1}, {"subagent", "p", 2}, {"teammate", "p", 3}, {"session-fork", "c", 65},
		{"subagent", "c", 67}, {"fork", "p", 70}, {"workflow", "p", 71}}
	if !reflect.DeepEqual(got, wantSp) {
		t.Errorf("spans:\n got %+v\nwant %+v", got, wantSp)
	}
	// p: turns 0 and 1 started in the range, 5 agents (a6 is a compact agent). c: its inherited
	// turn 0 and a1 are not its own; turn 1 and c1 are. The branch itself is not an agent.
	if g.Turns != 3 || g.Agents != 6 {
		t.Errorf("group turns %d agents %d, want 3 and 6", g.Turns, g.Agents)
	}
	w := "/w"
	q := ovQuery(time.Hour, 3)
	q.Group = &w
	o, _ = cat.Overview(q)
	lanes := map[string]OverviewLane{}
	for _, l := range o.Lanes {
		lanes[l.ID] = l
	}
	if l := lanes["p"]; l.Turns != 2 || l.Agents != 5 || l.Group != "/w" {
		t.Errorf("lane p: turns %d agents %d group %q", l.Turns, l.Agents, l.Group)
	}
	if l := lanes["c"]; l.Turns != 1 || l.Agents != 1 {
		t.Errorf("lane c: turns %d agents %d", l.Turns, l.Agents)
	}
	// A range after the first turn and the first agents: only what started in it counts.
	q = OverviewQuery{From: at(60), To: at(180), Slot: time.Hour, Group: &w}
	o, _ = cat.Overview(q)
	lanes = map[string]OverviewLane{}
	for _, l := range o.Lanes {
		lanes[l.ID] = l
	}
	if l := lanes["p"]; l.Turns != 0 || l.Agents != 2 {
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
	g := group(t, o, "/w")
	type sp struct {
		kind       string
		start, end int
		title      string
	}
	min := func(t time.Time) int { return int(t.Sub(t0) / time.Minute) }
	var got []sp
	for _, s := range g.Spans {
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
	if g := group(t, o, "/w"); len(g.Spans) != 1 || g.Spans[0].Title != "d-o1" || g.Agents != 1 {
		t.Errorf("range spans: %+v, agents %d", g.Spans, g.Agents)
	}
	o, _ = ovCatalog(p).Overview(OverviewQuery{From: at(7), To: at(50), Slot: 5 * time.Minute})
	// The range starts at 10:05Z: s3 (3 to 9) overlaps it and is listed, but started before it.
	if g := group(t, o, "/w"); len(g.Spans) != 8 || g.Agents != 3 {
		t.Errorf("early start: %d spans, %d agents; want 8 and 3", len(g.Spans), g.Agents)
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
	w := "/w"
	q := ovQuery(time.Hour, 3)
	q.Group = &w
	o, err := cat.Overview(q)
	if err != nil {
		t.Fatal(err)
	}
	g := group(t, o, "/w")
	if len(g.Spans) != 2 || g.Spans[1].Kind != "continuation" || g.Spans[1].Session.ID != "c" || g.Spans[1].Title != "session c" ||
		!g.Spans[1].Start.Equal(at(40)) || !g.Spans[1].End.Equal(at(90)) {
		t.Errorf("group spans: %+v", g.Spans)
	}
	if len(o.Lanes) != 2 {
		t.Fatalf("lanes %+v", o.Lanes)
	}
	lc, lp := o.Lanes[0], o.Lanes[1] // equal usd: by id
	if len(lp.Spans) != 1 || lp.Spans[0].Kind != "subagent" || len(lc.Spans) != 1 || lc.Spans[0].Kind != "continuation" {
		t.Errorf("lane spans: %+v / %+v", lp.Spans, lc.Spans)
	}
	// p: one call at 10:00Z (slot 0); c: one call of its own at 10:41Z (slot 1).
	if want := []int{1, 0, 0}; !reflect.DeepEqual(dense(lp, lp.Active, 3), want) {
		t.Errorf("p active %v, want %v", lp.Active, want)
	}
	if want := []int{0, 1, 0}; !reflect.DeepEqual(dense(lc, lc.Active, 3), want) {
		t.Errorf("c active %v, want %v", lc.Active, want)
	}
}

// dense puts a lane's trimmed array back at its slot in n slots.
func dense[T any](l OverviewLane, a []T, n int) []T {
	out := make([]T, n)
	copy(out[l.Slot0:], a)
	return out
}

func TestOverviewHeldContext(t *testing.T) {
	hold := func(next int) Overview {
		a := syn("claude", "a", "/w", 0, 60, nil)
		msg(a, "a1", 0, 1, "", model.Tokens{Input: 5000})
		msg(a, "a2", next, 1, "", model.Tokens{Input: 100})
		w := "/w"
		q := OverviewQuery{From: at(0), To: at(15), Slot: time.Minute, Group: &w}
		o, err := ovCatalog(a).Overview(q)
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
	g := group(t, o, "/w")
	if g.ContextPeak[2] != 5000 || g.ContextSum[2] != 5000 || g.Active[2] != 1 {
		t.Errorf("group at slot 2: peak %d sum %d active %d", g.ContextPeak[2], g.ContextSum[2], g.Active[2])
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
	if g := group(t, o, "/w"); g.ContextPeak[0] != 7000 || g.ContextPeak[1] != 7000 || g.ContextPeak[2] != 0 || g.Active[0] != 1 {
		t.Errorf("held into range: peak %v active %v", g.ContextPeak, g.Active)
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
	g := group(t, o, "/w")
	if g.Sessions != 1 {
		t.Errorf("group sessions = %d, want 1", g.Sessions)
	}
	wantNear(t, "group usd", g.USD, 1)
	if o.Scripted.Sessions != 1 || !near(o.Scripted.USD, 0.75) || !reflect.DeepEqual(o.Scripted.USDSlots, []float64{0.25, 0.5, 0}) {
		t.Errorf("scripted = %+v", o.Scripted)
	}
}

func TestOverviewGroupsOrderAndLanes(t *testing.T) {
	a := syn("claude", "a", "/w", 20, 30, nil, msgSpec{"a1", 20, 1, 0})
	b := syn("claude", "b", "/w", 0, 30, nil, msgSpec{"b1", 0, 2, 0})
	d := syn("claude", "d", "/x", 0, 30, nil, msgSpec{"d1", 0, 5, 0})
	e := syn("claude", "e", "/y", 0, 30, nil, msgSpec{"e1", 0, 5, 0})
	old := syn("claude", "old", "/w", -600, -590, nil, msgSpec{"o1", -600, 9, 0}) // outside the range
	cat := ovCatalog(a, b, d, e, old)

	q := ovQuery(time.Hour, 2)
	o, err := cat.Overview(q)
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	for _, g := range o.Groups {
		keys = append(keys, g.Key)
	}
	if want := []string{"/x", "/y", "/w"}; !reflect.DeepEqual(keys, want) { // 5, 5 (by key), 3
		t.Errorf("groups = %v, want %v", keys, want)
	}
	// Lanes come without a group parameter: by the order of the groups, then usd, then id.
	var ids []string
	for _, l := range o.Lanes {
		ids = append(ids, l.Group+":"+l.ID)
	}
	if want := []string{"/x:d", "/y:e", "/w:b", "/w:a"}; !reflect.DeepEqual(ids, want) {
		t.Errorf("lanes = %v, want %v", ids, want)
	}

	w := "/w"
	q.Group = &w
	o, _ = cat.Overview(q)
	if len(o.Groups) != 1 || o.Groups[0].Key != "/w" {
		t.Errorf("group filter: groups %+v", o.Groups)
	}
	if len(o.Lanes) != 2 || o.Lanes[0].ID != "b" || o.Lanes[1].ID != "a" {
		t.Fatalf("lanes = %+v, want b then a (by usd)", o.Lanes)
	}
	l := o.Lanes[0]
	wantNear(t, "lane usd", l.USD, 2)
	if len(l.USDSlots) != 1 || len(l.Context) != 1 || len(l.Active) != 1 || len(l.Idle) != 1 || l.Spans == nil || l.Title == "" || l.StartedAt.IsZero() {
		t.Errorf("lane = %+v", l)
	}

	// Group "" is the sessions with no value: by repo, with no places, that is all of them.
	none := ""
	q.By, q.Group = GroupRepo, &none
	o, _ = cat.Overview(q)
	if len(o.Groups) != 1 || o.Groups[0].Key != "" || o.Groups[0].Name != "(no repository)" || len(o.Lanes) != 4 || o.Lanes[0].Group != "" {
		t.Errorf("by repo: groups %+v, %d lanes", o.Groups, len(o.Lanes))
	}
	other := "/nowhere"
	q.Group = &other
	if o, _ = cat.Overview(q); len(o.Lanes) != 0 {
		t.Errorf("lanes of an unknown group: %+v", o.Lanes)
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
	w := "/w"
	o, err := ovCatalog(a, b).Overview(OverviewQuery{From: at(0), To: at(150), Slot: 5 * time.Minute, Group: &w})
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
	g := group(t, o, "/w")
	for i := range 30 {
		bi := int64(0)
		if i >= lb.Slot0 && i-lb.Slot0 < len(lb.Idle) {
			bi = lb.Idle[i-lb.Slot0]
		}
		if g.IdleSum[i] != idle[i]+bi || g.IdlePeak[i] != max(idle[i], bi) {
			t.Errorf("group idle at %d: sum %d peak %d, lanes %d and %d", i, g.IdleSum[i], g.IdlePeak[i], idle[i], bi)
		}
	}
	// b: 70 at 10:00, next call 30 minutes later: idle through slots 1..5 (70) and slot 6
	// is the call's own context.
	if bi := dense(lb, lb.Idle, 30); bi[1] != 70 || bi[5] != 70 || bi[0] != 0 || bi[6] != 0 {
		t.Errorf("b idle %v", bi[:8])
	}
	if g.IdleSum[1] != 5000+70 || g.IdlePeak[1] != 5000 {
		t.Errorf("group slot 1: sum %d peak %d", g.IdleSum[1], g.IdlePeak[1])
	}
}

func TestOverviewLaneTrimming(t *testing.T) {
	a := syn("claude", "a", "/w", 0, 200, nil)
	msg(a, "a1", 62, 1, "", model.Tokens{Input: 900}) // slot 2 of 1h slots from 09:30Z... see below
	msg(a, "a2", 70, 1, "", model.Tokens{Input: 100})
	w := "/w"
	o, err := ovCatalog(a).Overview(OverviewQuery{From: ovFrom, To: ovFrom.Add(8 * time.Hour), Slot: time.Hour, Group: &w})
	if err != nil {
		t.Fatal(err)
	}
	l := o.Lanes[0]
	// 09:30Z + 2 h = 11:30Z: the call at 11:02Z is slot 1, the other at 11:10Z too; the
	// 5-minute-plus gap is 8 minutes: idle from 11:02 to 11:10, all inside slot 1.
	if l.Slot0 != 1 || len(l.USDSlots) != 1 || len(l.Context) != 1 || len(l.Idle) != 1 || len(l.Active) != 1 {
		t.Fatalf("lane: slot0 %d, lens %d %d %d %d", l.Slot0, len(l.USDSlots), len(l.Context), len(l.Idle), len(l.Active))
	}
	if l.Context[0] != 900 || l.Idle[0] != 0 || !near(l.USDSlots[0], 2) {
		t.Errorf("lane: %+v", l)
	}
	g := group(t, o, "/w")
	if len(g.USDSlots) != 8 || len(g.IdleSum) != 8 || len(g.IdlePeak) != 8 || len(g.ContextPeak) != 8 || len(g.Active) != 8 {
		t.Errorf("group arrays are not dense")
	}
	// Idle that runs into later slots extends the lane's arrays.
	b := syn("claude", "b", "/w", 0, 200, nil)
	msg(b, "b1", 5, 1, "", model.Tokens{Input: 900})
	msg(b, "b2", 125, 1, "", model.Tokens{Input: 100}) // 2 h later: nothing held
	msg(b, "b3", 160, 1, "", model.Tokens{Input: 100}) // 35 min after b2: idle
	o, _ = ovCatalog(b).Overview(OverviewQuery{From: ovFrom, To: ovFrom.Add(8 * time.Hour), Slot: time.Hour, Group: &w})
	l = o.Lanes[0]
	// b1 10:05Z slot 0; b2 12:05Z slot 2; b3 12:40Z slot 3. Idle 100 from b2 to b3: slot 2 has
	// context 100 (the call), slot 3 context 100 (the call): idle never shows.
	if l.Slot0 != 0 || len(l.Context) != 4 {
		t.Errorf("b: slot0 %d, %d slots", l.Slot0, len(l.Context))
	}
}

func TestOverviewLanesWithoutGroupAndFilter(t *testing.T) {
	a := syn("claude", "a", "/w", 0, 30, nil, msgSpec{"a1", 0, 1, 0})
	b := syn("claude", "b", "/x", 0, 30, nil, msgSpec{"b1", 0, 3, 0})
	old := syn("claude", "old", "/w", -600, -590, nil, msgSpec{"o1", -600, 9, 0})
	s := syn("claude", "s", "/w", 0, 5, nil, msgSpec{"s1", 0, 7, 0})
	s.Kind = model.KindSDK
	cat := ovCatalog(a, b, old, s)
	o, err := cat.Overview(ovQuery(time.Hour, 2))
	if err != nil {
		t.Fatal(err)
	}
	if len(o.Lanes) != 2 || o.Lanes[0].ID != "b" || o.Lanes[0].Group != "/x" || o.Lanes[1].ID != "a" || o.Lanes[1].Group != "/w" {
		t.Errorf("lanes %+v", o.Lanes)
	}
	w := "/w"
	q := ovQuery(time.Hour, 2)
	q.Group = &w
	o, _ = cat.Overview(q)
	if len(o.Groups) != 1 || len(o.Lanes) != 1 || o.Lanes[0].ID != "a" {
		t.Errorf("filter: groups %d lanes %+v", len(o.Groups), o.Lanes)
	}
	// No lanes is an empty list, not null.
	o, _ = cat.Overview(OverviewQuery{From: at(5000), To: at(5060), Slot: time.Hour})
	if o.Lanes == nil || len(o.Lanes) != 0 {
		t.Errorf("empty lanes: %#v", o.Lanes)
	}
}
