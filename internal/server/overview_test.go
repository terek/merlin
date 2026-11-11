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
			Turns: []model.Turn{{Index: 0, UUID: "u-" + id, Origin: model.OriginHuman}}, Messages: msgs}
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
	if want := []catalog.OverviewEvent{{Slot: 165, Type: "agent", Kind: "subagent", N: 1}, {Slot: 165, Type: "compaction", Kind: "cold", N: 1},
		{Slot: 165, Type: "session", Kind: "fork", N: 1}}; !reflect.DeepEqual(main.Events, want) {
		t.Errorf("events %+v, want %+v", main.Events, want)
	}
	if o.Scripted.Sessions != 1 || !near(o.Scripted.USD, 0.5) || len(o.Scripted.USDSlots) != 168 {
		t.Errorf("scripted %+v", o.Scripted)
	}
	if o.Lanes != nil {
		t.Errorf("lanes without group: %+v", o.Lanes)
	}
	if main.Priciest.ID != "b" {
		t.Errorf("priciest %+v", main.Priciest)
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
	if len(o.Lanes) != 2 || o.Lanes[0].ID != "a" || o.Lanes[1].ID != "b" || len(o.Lanes[0].Context) != 168 {
		t.Fatalf("lanes %+v", o.Lanes)
	}
	if !near(o.Lanes[0].USD, 3) || !near(o.Lanes[1].USD, 4) {
		t.Errorf("lane usd %v %v", o.Lanes[0].USD, o.Lanes[1].USD)
	}
	// group= is the group with no value; absent means no lanes.
	o, _ = r.overview("?by=repo&group=")
	if len(o.Lanes) != 3 {
		t.Errorf("group= lanes: %d, want 3", len(o.Lanes))
	}
	if o, _ = r.overview("?by=repo"); o.Lanes != nil {
		t.Errorf("no group, lanes: %+v", o.Lanes)
	}
	// The wire form: no lanes key without group.
	resp, err := http.Get(r.srv.URL + "/api/overview")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil {
		t.Fatal(err)
	}
	if _, has := keys["lanes"]; has {
		t.Error("lanes key present without group")
	}
	for _, k := range []string{"from", "to", "slot", "slotMs", "slots", "by", "groups", "scripted"} {
		if _, has := keys[k]; !has {
			t.Errorf("key %q missing", k)
		}
	}
}

func TestOverviewRouteErrors(t *testing.T) {
	r := ovRig(t)
	for _, q := range []string{
		"?slot=7m", "?slot=1w", "?by=session", "?by=prefix",
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
