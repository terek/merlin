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
	if o.Slot != "1h" || o.SlotMs != 3600000 || o.Slots != 168 ||
		o.From.Format(time.RFC3339) != "2026-12-25T12:00:00Z" || o.To.Format(time.RFC3339) != "2027-01-01T12:00:00Z" {
		t.Fatalf("header: %+v", o)
	}
	// By usd: c (8), then b (m3, 4: the copy of m1 is a's), then a (m1 and m2, 3); the scripted
	// run is apart.
	if len(o.Lanes) != 3 || o.Lanes[0].ID != "c" || o.Lanes[1].ID != "b" || o.Lanes[2].ID != "a" {
		t.Fatalf("lanes: %+v", o.Lanes)
	}
	c, b, a := o.Lanes[0], o.Lanes[1], o.Lanes[2]
	if !near(c.USD, 8) || !near(b.USD, 4) || !near(a.USD, 3) || c.Dir != "/other" || b.Dir != "/main" {
		t.Errorf("usd %v %v %v, dirs %q %q", c.USD, b.USD, a.USD, c.Dir, b.Dir)
	}
	// a: m1 at 09:00Z (slot 165) and m2 at 10:10Z (slot 166): trimmed to those two. b: m3 at
	// 09:20Z (slot 165) only.
	if a.Slot0 != 165 || len(a.Context) != 2 || len(a.Idle) != 2 || len(a.Active) != 2 || a.Context[0] != 1000 || a.Context[1] != 4000 {
		t.Errorf("lane a: slot0 %d, %v %v", a.Slot0, a.Context, a.Idle)
	}
	if b.Slot0 != 165 || len(b.Context) != 1 || a.Turns != 1 || a.Agents != 1 || b.Agents != 0 {
		t.Errorf("lane b: slot0 %d, %d slots; turns a %d, agents a %d b %d", b.Slot0, len(b.Context), a.Turns, a.Agents, b.Agents)
	}
	// The agent (a zero-length span: no end, no messages) and the fork b.
	t1 := testNow.Add(-3 * time.Hour)
	if want := []catalog.OverviewSpan{{Kind: "subagent", Start: t1.Add(time.Minute), End: t1.Add(time.Minute),
		Session: catalog.SessionRef{Harness: "claude", ID: "a"}}}; !reflect.DeepEqual(a.Spans, want) {
		t.Errorf("a spans %+v, want %+v", a.Spans, want)
	}
	if want := []catalog.OverviewSpan{{Kind: "session-fork", Start: t1.Add(10 * time.Minute), End: t1.Add(70 * time.Minute),
		Session: catalog.SessionRef{Harness: "claude", ID: "b"}, Title: "title b"}}; !reflect.DeepEqual(b.Spans, want) {
		t.Errorf("b spans %+v, want %+v", b.Spans, want)
	}
	if o.Scripted.Sessions != 1 || !near(o.Scripted.USD, 0.5) {
		t.Errorf("scripted %+v", o.Scripted)
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
	// c is the first lane on the wire: without the keys it has no value for.
	for _, k := range []string{"name", "recap", "firstPrompt", "lastPrompt"} {
		if _, has := r.wireLanes()[0][k]; has {
			t.Errorf("key %q on a lane without it", k)
		}
	}
}

// wireLanes is /api/overview's lanes as raw JSON objects, and its top level.
func (r *rig) wireLanes() []map[string]json.RawMessage {
	lanes, _ := r.wire()
	return lanes
}

func (r *rig) wire() ([]map[string]json.RawMessage, map[string]json.RawMessage) {
	r.t.Helper()
	resp, err := http.Get(r.srv.URL + "/api/overview")
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var top map[string]json.RawMessage
	var lanes []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		r.t.Fatal(err)
	}
	if err := json.Unmarshal(top["lanes"], &lanes); err != nil || len(lanes) == 0 {
		r.t.Fatalf("lanes on the wire: %v, %d", err, len(lanes))
	}
	return lanes, top
}

func TestOverviewRouteParameters(t *testing.T) {
	r := ovRig(t)
	from, to := testNow.Add(-4*time.Hour), testNow
	// RFC 3339 and Unix milliseconds name the same range; a by= of an older page is ignored.
	var rfc, ms Overview
	r.get("/api/overview?by=repo&slot=1h&from="+url.QueryEscape(from.Format(time.RFC3339))+"&to="+url.QueryEscape(to.Format(time.RFC3339)), &rfc)
	r.get("/api/overview?slot=1h&from="+strconv.FormatInt(from.UnixMilli(), 10)+"&to="+strconv.FormatInt(to.UnixMilli(), 10), &ms)
	if !reflect.DeepEqual(rfc, ms) || rfc.Slots != 4 || len(rfc.Lanes) != 3 {
		t.Errorf("rfc %+v\n ms %+v", rfc, ms)
	}
	// 1d slots start at local (UTC+2) midnight: 2026-12-31T22:00Z.
	o, _ := r.overview("?slot=1d&from=2026-12-31T20:00:00Z&to=2027-01-01T12:00:00Z")
	if o.From.Format(time.RFC3339) != "2026-12-30T22:00:00Z" || o.Slots != 2 {
		t.Errorf("1d: from %s, %d slots", o.From, o.Slots)
	}
}

func TestOverviewRouteWire(t *testing.T) {
	r := ovRig(t)
	lanes, top := r.wire()
	for _, k := range []string{"from", "to", "slot", "slotMs", "slots", "scripted", "lanes"} {
		if _, has := top[k]; !has {
			t.Errorf("key %q missing", k)
		}
	}
	for _, k := range []string{"by", "groups"} {
		if _, has := top[k]; has {
			t.Errorf("key %q still there", k)
		}
	}
	if string(top["scripted"]) != `{"sessions":1,"usd":0.5}` {
		t.Errorf("scripted = %s", top["scripted"])
	}
	for _, k := range []string{"dir", "turns", "agents", "slot0", "context", "idle", "active", "spans"} {
		if _, has := lanes[0][k]; !has {
			t.Errorf("lane key %q missing", k)
		}
	}
	// no places beyond the directory in this rig: checkout, repo and remote are left out
	for _, k := range []string{"group", "usdSlots", "checkout", "repo", "remote"} {
		if _, has := lanes[0][k]; has {
			t.Errorf("lane key %q on the wire", k)
		}
	}
}

func TestOverviewRouteErrors(t *testing.T) {
	r := ovRig(t)
	for _, q := range []string{
		"?slot=7m", "?slot=3m", "?slot=1w",
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

// A lane carries its bead and the answer the chains of those beads (acme-c1's parent acme-a1).
func TestOverviewBeads(t *testing.T) {
	r := beadRig(t)
	o, code := r.overview("?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z&slot=1h")
	if code != 200 {
		t.Fatalf("status %d", code)
	}
	beadOf := map[string]string{}
	for _, l := range o.Lanes {
		beadOf[l.ID] = l.Bead
	}
	if beadOf["s1"] != "acme-a1" || beadOf["s2"] != "acme-c1" || beadOf["s3"] != "" {
		t.Errorf("lane beads = %v", beadOf)
	}
	if c := o.Beads["acme-c1"]; c.Title != "Child task" || c.Parent != "acme-a1" {
		t.Errorf("beads[acme-c1] = %+v", c)
	}
	if a := o.Beads["acme-a1"]; a.Title != "Alpha work" || a.Parent != "" {
		t.Errorf("beads[acme-a1] = %+v", a)
	}
	// without a bead in the range's lanes, the key is absent
	var raw map[string]json.RawMessage
	r.get("/api/overview?from=2026-10-01T10:19:00Z&to=2026-10-01T10:30:00Z&slot=1m", &raw)
	if _, has := raw["beads"]; has {
		t.Errorf("beads present for a range with no bead lane")
	}
}
