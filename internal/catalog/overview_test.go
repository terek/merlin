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
	}{{1, "15m"}, {2, "15m"}, {3, "30m"}, {7, "1h"}, {30, "6h"}, {90, "12h"}, {300, "1d"}} {
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

func TestOverviewEvents(t *testing.T) {
	zero, one := 0, 1
	p := syn("claude", "p", "/w", 0, 90, []model.Turn{turn(0, "u0", "go", 0), turn(1, "u1", "more", 20)}, msgSpec{"m1", 0, 1, 0})
	p.Agents = []model.Agent{
		{ID: "a1", Kind: model.AgentSubagent, StartedAt: at(1), SpawnTurn: &zero},
		{ID: "a2", Kind: model.AgentSubagent, StartedAt: at(2), SpawnTurn: &zero},
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
	// Slot 0 is 09:30 to 10:30Z, slot 1 to 11:30Z.
	want := []OverviewEvent{
		{0, "agent", "subagent", 2},  // a1, a2
		{0, "agent", "teammate", 1},  // a3
		{0, "compaction", "cold", 2}, // s1 and s4 (p owns s4)
		{0, "compaction", "unknown", 1},
		{0, "compaction", "warm", 2}, // s2 and the agent's s5
		{1, "agent", "fork", 1},      // a4 at 11:10Z
		{1, "agent", "subagent", 1},  // c1
		{1, "agent", "workflow", 1},
		{1, "session", "fork", 1}, // c starts at 11:05Z
	}
	if g := group(t, o, "/w"); !reflect.DeepEqual(g.Events, want) {
		t.Errorf("events:\n got %+v\nwant %+v", g.Events, want)
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
	if o.Lanes != nil {
		t.Errorf("lanes without group: %+v", o.Lanes)
	}

	w := "/w"
	q.Group = &w
	o, _ = cat.Overview(q)
	if len(o.Lanes) != 2 || o.Lanes[0].ID != "b" || o.Lanes[1].ID != "a" {
		t.Fatalf("lanes = %+v, want b then a (by startedAt)", o.Lanes)
	}
	l := o.Lanes[0]
	wantNear(t, "lane usd", l.USD, 2)
	if len(l.USDSlots) != 2 || len(l.Context) != 2 || l.Events == nil || l.Title == "" || l.StartedAt.IsZero() {
		t.Errorf("lane = %+v", l)
	}

	// Group "" is the sessions with no value: by repo, with no places, that is all of them.
	none := ""
	q.By, q.Group = GroupRepo, &none
	o, _ = cat.Overview(q)
	if len(o.Groups) != 1 || o.Groups[0].Key != "" || o.Groups[0].Name != "(no repository)" || len(o.Lanes) != 4 {
		t.Errorf("by repo: groups %+v, %d lanes", o.Groups, len(o.Lanes))
	}
	other := "/nowhere"
	q.Group = &other
	if o, _ = cat.Overview(q); len(o.Lanes) != 0 {
		t.Errorf("lanes of an unknown group: %+v", o.Lanes)
	}
}
