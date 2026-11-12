package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
)

// ovRig serves two sessions in /main and /other, three hours before testNow, one of them with
// a copy of the first's message, and a scripted run. testZone is UTC+2.
func ovRig(t *testing.T) *rig {
	t.Helper()
	r := newRig(t)
	t1 := testNow.Add(-3 * time.Hour) // 09:00Z
	zero := 0
	add := func(id, dir string, kind model.SessionKind, start time.Time, msgs ...model.Message) *model.SessionDigest {
		d := &model.SessionDigest{SchemaVersion: model.SchemaVersion, Harness: "claude", ID: id, ProjectKey: "k" + dir, Project: dir,
			Cwd: dir, Kind: kind, Title: "title " + id, StartedAt: start, LastActivityAt: start.Add(time.Hour),
			Turns: []model.Turn{{Index: 0, UUID: "u-" + id, Origin: model.OriginHuman, StartedAt: start}}, Messages: msgs}
		for i := range d.Messages {
			d.Messages[i].Turn = &zero
			d.Messages[i].Model = "sonnet"
		}
		return d
	}
	m := func(id string, at time.Time, usd float64, in int64) model.Message {
		return model.Message{ID: id, At: at, USD: usd, Tokens: model.Tokens{Input: in}}
	}
	a := add("a", "/main", model.KindInteractive, t1, m("m1", t1, 1, 1000), m("m2", t1.Add(70*time.Minute), 2, 4000))
	a.Agents = []model.Agent{{ID: "ag", Kind: model.AgentSubagent, StartedAt: t1.Add(time.Minute), SpawnTurn: &zero}}
	a.Compactions = []model.Compaction{{At: t1.Add(2 * time.Minute), Summary: "s", Call: &model.CompactionCall{Cache: model.CacheCold}}}
	// b shares m1 with a (a copy: billed once) and has a message of its own.
	b := add("b", "/main", model.KindInteractive, t1.Add(10*time.Minute), m("m1", t1, 1, 1000), m("m3", t1.Add(20*time.Minute), 4, 500))
	b.Lineage.ForkedFrom = &model.ForkRef{SessionID: "a", MessageUUID: "u-a"}
	// Text for the lane previews: a is named and recapped; b inherits a's turn 0 and has an
	// own turn 1; c and s have none.
	a.Name = "my a"
	a.Turns[0].UserText = "open the a thing"
	a.Recaps = []model.Recap{{At: t1.Add(5 * time.Minute), Text: "old recap"}, {At: t1.Add(50 * time.Minute), Text: "latest recap of a"}}
	b.Turns = []model.Turn{
		{Index: 0, UUID: "u-a", Origin: model.OriginHuman, StartedAt: t1, UserText: "inherited ask"},
		{Index: 1, UUID: "u-b2", Origin: model.OriginHuman, StartedAt: t1.Add(15 * time.Minute), UserText: "own ask"},
	}
	c := add("c", "/other", model.KindInteractive, t1, m("c1", t1, 8, 100))
	s := add("s", "/main", model.KindSDK, t1, m("s1", t1, 0.5, 0))
	cat := catalog.New()
	cat.SetLocation(testZone)
	for _, d := range []*model.SessionDigest{a, b, c, s} {
		cat.Upsert(d)
	}
	r.cat = cat
	return r
}

func (r *rig) overview(query string) (Overview, int) {
	r.t.Helper()
	var o Overview
	code := r.get("/api/overview"+query, &o)
	return o, code
}

func TestOverviewRoute(t *testing.T) {
	r := ovRig(t)
	// No parameters: to = testNow (12:00Z), from a week before, 168 hour slots in UTC+2.
	o, code := r.overview("")
	if code != 200 {
		t.Fatalf("status %d", code)
	}
	if o.Slot != "1h" || o.SlotMs != 3600000 || o.Slots != 168 || o.By != "dir" ||
		o.From.Format(time.RFC3339) != "2026-12-25T12:00:00Z" || o.To.Format(time.RFC3339) != "2027-01-01T12:00:00Z" {
		t.Fatalf("header: %+v", o)
	}
	if len(o.Groups) != 2 || o.Groups[0].Key != "/other" || o.Groups[1].Key != "/main" {
		t.Fatalf("groups: %+v", o.Groups)
	}
	main := o.Groups[1] // /other spent 8, /main 7
	if len(main.USDSlots) != 168 || len(main.ContextPeak) != 168 || len(main.ContextSum) != 168 || len(main.Active) != 168 {
		t.Fatalf("arrays not dense")
	}
	// m1 once ($1) + m2 ($2) + m3 ($4); the scripted run is apart.
	if !near(main.USD, 7) || main.Sessions != 2 || main.Name != "main" {
		t.Errorf("main: usd %v sessions %d name %q", main.USD, main.Sessions, main.Name)
	}
	// 09:00Z is slot 165 (from 12:00Z Dec 25 + 165h), 10:10Z is slot 166.
	if i := 165; !near(main.USDSlots[i], 5) || !near(main.USDSlots[i+1], 2) {
		t.Errorf("slots %v %v", main.USDSlots[165], main.USDSlots[166])
	}
	if main.ContextSum[165] != 1500 || main.ContextPeak[165] != 1000 || main.ContextPeak[166] != 4000 {
		t.Errorf("context: sum %d peak %d / %d", main.ContextSum[165], main.ContextPeak[165], main.ContextPeak[166])
	}
	// a's m1 (09:00) is followed by m2 70 minutes later: idle until then, but slot 165 holds
	// m1 as context and slot 166 has m2's.
	if len(main.IdleSum) != 168 || len(main.IdlePeak) != 168 || main.IdleSum[165] != 0 || main.IdleSum[166] != 0 {
		t.Errorf("idle: %v", main.IdleSum[160:])
	}
	if main.Turns != 2 || main.Agents != 1 {
		t.Errorf("main: turns %d agents %d", main.Turns, main.Agents)
	}
	// The agent (a zero-length span: no end, no messages) and the fork b.
	t1 := testNow.Add(-3 * time.Hour)
	wantSpans := []catalog.OverviewSpan{
		{Kind: "subagent", Start: t1.Add(time.Minute), End: t1.Add(time.Minute), Session: catalog.SessionRef{Harness: "claude", ID: "a"}},
		{Kind: "session-fork", Start: t1.Add(10 * time.Minute), End: t1.Add(70 * time.Minute), Session: catalog.SessionRef{Harness: "claude", ID: "b"}, Title: "title b"},
	}
	if !reflect.DeepEqual(main.Spans, wantSpans) {
		t.Errorf("spans %+v, want %+v", main.Spans, wantSpans)
	}
	if o.Scripted.Sessions != 1 || !near(o.Scripted.USD, 0.5) || len(o.Scripted.USDSlots) != 168 {
		t.Errorf("scripted %+v", o.Scripted)
	}
	// Lanes come without group: /other first (the group order), then /main by usd: b, a.
	if len(o.Lanes) != 3 || o.Lanes[0].ID != "c" || o.Lanes[1].ID != "b" || o.Lanes[2].ID != "a" || o.Lanes[1].Group != "/main" {
		t.Errorf("lanes: %+v", o.Lanes)
	}
	if main.Priciest.ID != "b" {
		t.Errorf("priciest %+v", main.Priciest)
	}
}

func TestOverviewRoutePreviews(t *testing.T) {
	r := ovRig(t)
	o, _ := r.overview("")
	lanes := map[string]OverviewLane{}
	for _, l := range o.Lanes {
		lanes[l.ID] = l
	}
	a, b, c := lanes["a"], lanes["b"], lanes["c"]
	if a.Name != "my a" || a.Recap == nil || a.Recap.Text != "latest recap of a" || a.Recap.Truncated {
		t.Errorf("a name %q recap %+v", a.Name, a.Recap)
	}
	if a.FirstPrompt == nil || a.FirstPrompt.Text != "open the a thing" || a.FirstPrompt.Turn != 0 ||
		a.LastPrompt == nil || a.LastPrompt.Text != "open the a thing" {
		t.Errorf("a prompts %+v %+v", a.FirstPrompt, a.LastPrompt)
	}
	// The fork prefers its first own human turn; the last prompt is the latest.
	if b.FirstPrompt == nil || b.FirstPrompt.Text != "own ask" || b.FirstPrompt.Turn != 1 ||
		b.LastPrompt == nil || b.LastPrompt.Text != "own ask" {
		t.Errorf("b prompts %+v %+v", b.FirstPrompt, b.LastPrompt)
	}
	if b.Name != "" || b.Recap != nil {
		t.Errorf("b name %q recap %+v", b.Name, b.Recap)
	}
	// With no own human turn with text, the first inherited one is used.
	d := &model.SessionDigest{Turns: []model.Turn{
		{Index: 0, Origin: model.OriginHuman, UserText: "  "},
		{Index: 1, Origin: model.OriginHuman, UserText: "inherited"},
		{Index: 2, Origin: model.OriginHuman, UserText: "  "},
	}}
	if p := firstPrompt(d, []int{1}); p == nil || p.Text != "inherited" || p.Turn != 1 {
		t.Errorf("only inherited: %+v", p)
	}
	// Absent: no name, recap or prompt text, and the keys are not on the wire.
	if c.Name != "" || c.Recap != nil || c.FirstPrompt != nil || c.LastPrompt != nil {
		t.Errorf("c: %+v", c)
	}
	resp, err := http.Get(r.srv.URL + "/api/overview?group=%2Fother")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var keys struct {
		Lanes []map[string]json.RawMessage `json:"lanes"`
	}
	if err := json.Unmarshal(raw, &keys); err != nil || len(keys.Lanes) != 1 {
		t.Fatalf("wire: %v %d", err, len(keys.Lanes))
	}
	for _, k := range []string{"name", "recap", "firstPrompt", "lastPrompt"} {
		if _, has := keys.Lanes[0][k]; has {
			t.Errorf("key %q on a lane without it", k)
		}
	}
}

func TestOverviewRouteParameters(t *testing.T) {
	r := ovRig(t)
	from, to := testNow.Add(-4*time.Hour), testNow
	// RFC 3339 and Unix milliseconds name the same range; project is dir.
	var rfc, ms Overview
	r.get("/api/overview?by=project&slot=1h&from="+url.QueryEscape(from.Format(time.RFC3339))+"&to="+url.QueryEscape(to.Format(time.RFC3339)), &rfc)
	r.get("/api/overview?by=dir&slot=1h&from="+strconv.FormatInt(from.UnixMilli(), 10)+"&to="+strconv.FormatInt(to.UnixMilli(), 10), &ms)
	if !reflect.DeepEqual(rfc, ms) || rfc.Slots != 4 || rfc.By != "dir" {
		t.Errorf("rfc %+v\n ms %+v", rfc, ms)
	}
	// 1d slots start at local (UTC+2) midnight: 2026-12-31T22:00Z.
	o, _ := r.overview("?slot=1d&from=2026-12-31T20:00:00Z&to=2027-01-01T12:00:00Z")
	if o.From.Format(time.RFC3339) != "2026-12-30T22:00:00Z" || o.Slots != 2 {
		t.Errorf("1d: from %s, %d slots", o.From, o.Slots)
	}
	for _, by := range []string{"checkout", "repo", "remote"} {
		o, code := r.overview("?by=" + by)
		if code != 200 || o.By != catalog.GroupBy(by) || len(o.Groups) != 1 || o.Groups[0].Key != "" {
			t.Errorf("by=%s: %d %+v", by, code, o.Groups)
		}
	}
}

func TestOverviewRouteLanes(t *testing.T) {
	r := ovRig(t)
	o, _ := r.overview("?group=%2Fmain")
	if len(o.Groups) != 1 || o.Groups[0].Key != "/main" {
		t.Errorf("groups with group=: %+v", o.Groups)
	}
	if len(o.Lanes) != 2 || o.Lanes[0].ID != "b" || o.Lanes[1].ID != "a" {
		t.Fatalf("lanes %+v", o.Lanes)
	}
	b, a := o.Lanes[0], o.Lanes[1]
	if !near(b.USD, 4) || !near(a.USD, 3) || b.Group != "/main" {
		t.Errorf("lane usd %v %v, group %q", b.USD, a.USD, b.Group)
	}
	// a: m1 at 09:00Z (slot 165) and m2 at 10:10Z (slot 166): trimmed to those two. b: m3 at
	// 09:20Z (slot 165) only.
	if a.Slot0 != 165 || len(a.Context) != 2 || len(a.USDSlots) != 2 || len(a.Idle) != 2 || len(a.Active) != 2 || a.Context[0] != 1000 || a.Context[1] != 4000 {
		t.Errorf("lane a: slot0 %d, %v %v", a.Slot0, a.Context, a.Idle)
	}
	if b.Slot0 != 165 || len(b.Context) != 1 || a.Turns != 1 || a.Agents != 1 || b.Agents != 0 {
		t.Errorf("lane b: slot0 %d, %d slots; turns a %d, agents a %d b %d", b.Slot0, len(b.Context), a.Turns, a.Agents, b.Agents)
	}
	// group= is the group with no value.
	o, _ = r.overview("?by=repo&group=")
	if len(o.Lanes) != 3 {
		t.Errorf("group= lanes: %d, want 3", len(o.Lanes))
	}
	if o, _ = r.overview("?by=repo"); len(o.Lanes) != 3 {
		t.Errorf("no group, lanes: %d, want 3", len(o.Lanes))
	}
	// The wire form: lanes is always there, and group even when empty.
	resp, err := http.Get(r.srv.URL + "/api/overview?by=repo")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var keys struct {
		Lanes []map[string]json.RawMessage `json:"lanes"`
	}
	if err := json.Unmarshal(raw, &keys); err != nil {
		t.Fatal(err)
	}
	if len(keys.Lanes) != 3 {
		t.Fatalf("lanes on the wire: %d", len(keys.Lanes))
	}
	for _, k := range []string{"group", "turns", "agents", "slot0", "usdSlots", "context", "idle", "active", "spans"} {
		if _, has := keys.Lanes[0][k]; !has {
			t.Errorf("lane key %q missing", k)
		}
	}
	if string(keys.Lanes[0]["group"]) != `""` {
		t.Errorf("lane group = %s", keys.Lanes[0]["group"])
	}
	var top map[string]json.RawMessage
	json.Unmarshal(raw, &top)
	for _, k := range []string{"from", "to", "slot", "slotMs", "slots", "by", "groups", "scripted", "lanes"} {
		if _, has := top[k]; !has {
			t.Errorf("key %q missing", k)
		}
	}
	var groups []map[string]json.RawMessage
	json.Unmarshal(top["groups"], &groups)
	for _, k := range []string{"turns", "agents", "idleSum", "idlePeak"} {
		if _, has := groups[0][k]; !has {
			t.Errorf("group key %q missing", k)
		}
	}
	if _, has := groups[0]["events"]; has {
		t.Error("group still has events")
	}
}

func TestOverviewRouteErrors(t *testing.T) {
	r := ovRig(t)
	for _, q := range []string{
		"?slot=7m", "?slot=3m", "?slot=1w", "?by=session", "?by=prefix",
		"?from=yesterday", "?to=x", "?from=2027-01-02T00:00:00Z&to=2027-01-01T00:00:00Z",
		"?slot=15m&from=2026-01-01T00:00:00Z&to=2026-12-01T00:00:00Z", // 32,000 slots
		"?from=2019-01-01T00:00:00Z&to=2027-01-01T00:00:00Z",          // 2,922 days, even with 1d
	} {
		r.wantError("/api/overview"+q, 400, CodeInvalidParameter)
	}
	// 1d slots: more than 2,000 days is refused, 1,461 is not.
	if _, code := r.overview("?slot=1d&from=2021-07-10T00:00:00Z&to=2027-01-01T00:00:00Z"); code != 400 {
		t.Errorf("2,000+ days: %d", code)
	}
	if o, code := r.overview("?slot=1d&from=2023-01-01T00:00:00Z&to=2027-01-01T00:00:00Z"); code != 200 || o.Slots < 1400 {
		t.Errorf("1,461 days: %d, %d slots", code, o.Slots)
	}
}
