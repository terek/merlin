package server

import (
	"bytes"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/model"
)

const (
	costStateID = "16161616-0000-4000-8000-000000000001" // has reported windows
	subNestID   = "08080808-0000-4000-8000-000000000001" // has agents and messages
	sdkID       = "15151515-0000-4000-8000-000000000001" // scripted run
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func listSessions(t *testing.T, r *rig, query string) SessionList {
	t.Helper()
	var l SessionList
	if code := r.get("/api/sessions"+query, &l); code != 200 {
		t.Fatalf("GET /api/sessions%s = %d", query, code)
	}
	return l
}

func TestProjects(t *testing.T) {
	r := newRig(t)
	var l ProjectList
	if code := r.get("/api/projects", &l); code != 200 {
		t.Fatal(code)
	}
	if len(l.Projects) == 0 {
		t.Fatal("no projects")
	}
	var sessions, scripted int
	var total float64
	for i, p := range l.Projects {
		if i > 0 && p.LastActivityAt.After(l.Projects[i-1].LastActivityAt) {
			t.Errorf("projects not ordered by last activity at %d", i)
		}
		sessions += p.Sessions
		scripted += p.ScriptedRuns
		total += p.Cost.TotalUSD
		if p.Project == "" || p.ProjectKey == "" || p.Harness != "claude" {
			t.Errorf("incomplete project %+v", p)
		}
	}
	if sessions != 34 || scripted != 1 {
		t.Errorf("sessions %d scripted %d, want 34 and 1", sessions, scripted)
	}
	if want := r.cat.Total(catalog.Filter{}).TotalUSD; !near(total, want) {
		t.Errorf("project costs add up to %v, catalog total %v", total, want)
	}
}

func TestSessionsList(t *testing.T) {
	r := newRig(t)
	l := listSessions(t, r, "?limit=500")
	if l.Total != 34 || len(l.Sessions) != 34 {
		t.Fatalf("total %d, listed %d, want 34", l.Total, len(l.Sessions))
	}
	if l.NextCursor != "" {
		t.Errorf("cursor on the last page")
	}
	if len(l.Scripted) != 1 || l.Scripted[0].Count != 1 {
		t.Errorf("scripted lines: %+v", l.Scripted)
	}
	for i, s := range l.Sessions {
		if s.Key.ID == sdkID || s.Kind == model.KindSDK {
			t.Errorf("scripted session listed: %+v", s.Key)
		}
		if i > 0 && s.LastActivityAt.After(l.Sessions[i-1].LastActivityAt) {
			t.Errorf("not newest first at %d", i)
		}
		if s.State != catalog.StateEnded {
			t.Errorf("%s state %q, want ended", s.Key.ID, s.State)
		}
	}
	// A summary has no turns or messages: the raw body must not contain them.
	resp, err := http.Get(r.srv.URL + "/api/sessions?limit=5")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`"userText"`, `"messages"`, `"turns":[`} {
		if strings.Contains(buf.String(), bad) {
			t.Errorf("list body contains %s", bad)
		}
	}
	var nest SessionSummary
	for _, s := range l.Sessions {
		if s.Key.ID == subNestID {
			nest = s
		}
	}
	if nest.Agents == 0 || nest.Turns != 1 || nest.Cost.BestUSD <= 0 {
		t.Errorf("subnest summary: %+v", nest)
	}
}

func TestSessionsFilters(t *testing.T) {
	r := newRig(t)
	all := listSessions(t, r, "?limit=500")

	t.Run("project", func(t *testing.T) {
		l := listSessions(t, r, "?project="+url.QueryEscape("/home/dev/acme/nest"))
		if l.Total != 1 || l.Sessions[0].Project != "/home/dev/acme/nest" {
			t.Errorf("by path: %d sessions", l.Total)
		}
		l = listSessions(t, r, "?project=-home-dev-acme-nest") // the storage key
		if l.Total != 2 {
			t.Errorf("by key: %d sessions, want 2", l.Total)
		}
		if l = listSessions(t, r, "?project=/nowhere"); l.Total != 0 || len(l.Sessions) != 0 {
			t.Errorf("unknown project: %d", l.Total)
		}
	})
	t.Run("kind", func(t *testing.T) {
		if l := listSessions(t, r, "?kind=interactive&limit=500"); l.Total != 34 {
			t.Errorf("interactive: %d", l.Total)
		}
		if l := listSessions(t, r, "?kind=background"); l.Total != 0 {
			t.Errorf("background: %d", l.Total)
		}
		r.wantError("/api/sessions?kind=sdk", 400, CodeInvalidParameter)
		r.wantError("/api/sessions?kind=nope", 400, CodeInvalidParameter)
	})
	t.Run("since until", func(t *testing.T) {
		l := listSessions(t, r, "?since=2026-09-20&limit=500")
		for _, s := range l.Sessions {
			if s.LastActivityAt.Before(time.Date(2026, 9, 20, 0, 0, 0, 0, testZone)) {
				t.Errorf("%s before since", s.Key.ID)
			}
		}
		if l.Total == 0 || l.Total == all.Total {
			t.Errorf("since=2026-09-20 selected %d of %d", l.Total, all.Total)
		}
		// A date-only until includes that whole day (local).
		l = listSessions(t, r, "?since=2026-09-13&until=2026-09-13&limit=500")
		if l.Total == 0 {
			t.Errorf("until=2026-09-13 dropped the day")
		}
		for _, s := range l.Sessions {
			if s.LastActivityAt.In(testZone).Format("2006-01-02") != "2026-09-13" {
				t.Errorf("%s outside 2026-09-13: %v", s.Key.ID, s.LastActivityAt)
			}
		}
		if l := listSessions(t, r, "?since=2026-09-13T10:00:00Z&until=2026-09-13T10:01:00Z"); l.Total == 0 {
			t.Errorf("RFC 3339 range found nothing")
		}
		r.wantError("/api/sessions?since=yesterday", 400, CodeInvalidParameter)
		r.wantError("/api/sessions?until=x", 400, CodeInvalidParameter)
		r.wantError("/api/sessions?since=2026-09-20&until=2026-09-01T00:00:00Z", 400, CodeInvalidParameter)
	})
	t.Run("state", func(t *testing.T) {
		newest := all.Sessions[0]
		r.registry = catalog.Registry{newest.Key: {PID: 1, SessionID: newest.Key.ID, Status: "busy"}}
		l := listSessions(t, r, "?state=running")
		if l.Total != 1 || l.Sessions[0].Key != newest.Key || l.Sessions[0].State != catalog.StateBusy {
			t.Errorf("running: %+v", l.Sessions)
		}
		if l := listSessions(t, r, "?state=ended"); l.Total != 33 {
			t.Errorf("ended: %d", l.Total)
		}
		if l := listSessions(t, r, "?state=running,ended"); l.Total != 34 {
			t.Errorf("running,ended: %d", l.Total)
		}
		r.registry = nil
		if l := listSessions(t, r, "?state=running"); l.Total != 0 {
			t.Errorf("running without registry: %d", l.Total)
		}
		r.wantError("/api/sessions?state=sleeping", 400, CodeInvalidParameter)
	})
	t.Run("recent", func(t *testing.T) {
		last := all.Sessions[0].LastActivityAt
		now := testNow
		r2 := newRig(t, func(o *Options) { o.Now = func() time.Time { return last.Add(5 * time.Minute) } })
		_ = now
		l := listSessions(t, r2, "?state=recent")
		if l.Total == 0 || l.Sessions[0].State != catalog.StateRecent {
			t.Errorf("recent: %+v", l.Total)
		}
	})
}

func TestSessionsPagination(t *testing.T) {
	r := newRig(t)
	all := listSessions(t, r, "?limit=500")
	var got []model.SessionKey
	cursor := ""
	pages := 0
	for {
		q := "?limit=7"
		if cursor != "" {
			q += "&cursor=" + cursor
		}
		l := listSessions(t, r, q)
		pages++
		if l.Total != 34 {
			t.Errorf("page %d total %d", pages, l.Total)
		}
		if cursor == "" && len(l.Scripted) == 0 {
			t.Errorf("first page lacks scripted lines")
		}
		if cursor != "" && len(l.Scripted) != 0 {
			t.Errorf("page %d repeats scripted lines", pages)
		}
		for _, s := range l.Sessions {
			got = append(got, s.Key)
		}
		if l.NextCursor == "" {
			break
		}
		if len(l.Sessions) != 7 {
			t.Errorf("page %d has %d sessions", pages, len(l.Sessions))
		}
		cursor = l.NextCursor
		if pages > 10 {
			t.Fatal("too many pages")
		}
	}
	if pages != 5 || len(got) != len(all.Sessions) {
		t.Fatalf("%d pages, %d sessions", pages, len(got))
	}
	for i := range got {
		if got[i] != all.Sessions[i].Key {
			t.Fatalf("page order differs at %d", i)
		}
	}
	// A cursor keeps working after the list changed (it names a position, not an index).
	l := listSessions(t, r, "?limit=3")
	r.cat.Remove(l.Sessions[0].Key)
	if l2 := listSessions(t, r, "?limit=3&cursor="+l.NextCursor); len(l2.Sessions) != 3 || l2.Sessions[0].Key != all.Sessions[3].Key {
		t.Errorf("cursor after removal: %+v", l2.Sessions)
	}
	r.wantError("/api/sessions?cursor=garbage", 400, CodeInvalidParameter)
	r.wantError("/api/sessions?limit=0", 400, CodeInvalidParameter)
	r.wantError("/api/sessions?limit=501", 400, CodeInvalidParameter)
	r.wantError("/api/sessions?limit=x", 400, CodeInvalidParameter)
}

func TestSessionDetail(t *testing.T) {
	r := newRig(t)
	var d SessionDetail
	if code := r.get("/api/sessions/claude/"+costStateID, &d); code != 200 {
		t.Fatal(code)
	}
	if d.Digest == nil || d.Digest.ID != costStateID || len(d.Digest.Turns) != 3 {
		t.Fatalf("digest: %+v", d.Digest)
	}
	if len(d.Digest.Messages) != 0 || d.MessageCount != 6 {
		t.Errorf("messages in body: %d, count %d", len(d.Digest.Messages), d.MessageCount)
	}
	if d.Cost.Flag != catalog.CostExact || len(d.Cost.Windows) == 0 || !near(d.Cost.BestUSD, d.Summary.Cost.BestUSD) {
		t.Errorf("cost: %+v", d.Cost)
	}
	if d.Summary.Key.ID != costStateID || d.Summary.State != catalog.StateEnded {
		t.Errorf("summary: %+v", d.Summary)
	}
	if d.Family.Root.ID != costStateID || len(d.Family.Members) != 1 || len(d.Family.Leaves) != 1 {
		t.Errorf("family: %+v", d.Family)
	}
	if d.Lineage.Children == nil || d.Lineage.InheritedTurns == nil {
		t.Errorf("lineage slices must be [] not null")
	}

	t.Run("messages", func(t *testing.T) {
		var m SessionDetail
		r.get("/api/sessions/claude/"+costStateID+"?messages=1", &m)
		if len(m.Digest.Messages) != 6 {
			t.Errorf("messages=1: %d messages", len(m.Digest.Messages))
		}
		// the shared digest must not have been changed by serving without messages
		var again SessionDetail
		r.get("/api/sessions/claude/"+costStateID+"?messages=true", &again)
		if len(again.Digest.Messages) != 6 {
			t.Errorf("messages dropped from the catalog's digest")
		}
		r.wantError("/api/sessions/claude/"+costStateID+"?messages=maybe", 400, CodeInvalidParameter)
	})
	t.Run("prefix", func(t *testing.T) {
		var p SessionDetail
		if code := r.get("/api/sessions/claude/0808", &p); code != 200 || p.Digest.ID != subNestID {
			t.Errorf("prefix: %d %+v", code, p.Summary.Key)
		}
		if len(p.Digest.Agents) == 0 {
			t.Errorf("no agents in digest")
		}
	})
	t.Run("lineage", func(t *testing.T) {
		var c SessionDetail
		r.get("/api/sessions/claude/"+sid("13", "02").ID, &c)
		if c.Lineage.Parent == nil || c.Lineage.Parent.Parent != sid("13", "01") {
			t.Fatalf("parent: %+v", c.Lineage.Parent)
		}
		if len(c.Lineage.InheritedTurns) == 0 || c.Lineage.FirstOwnTurn <= 0 {
			t.Errorf("inherited turns %v first own %d", c.Lineage.InheritedTurns, c.Lineage.FirstOwnTurn)
		}
		if c.Cost.InheritedUSD <= 0 {
			t.Errorf("inherited cost %v", c.Cost.InheritedUSD)
		}
		if len(c.Family.Members) != 2 || c.Family.Root != sid("13", "01") || len(c.Family.Leaves) != 1 || c.Family.Leaves[0] != sid("13", "02") {
			t.Errorf("family: %+v", c.Family)
		}
		if c.Family.Members[1].Parent == nil || *c.Family.Members[1].Parent != sid("13", "01") {
			t.Errorf("member parent: %+v", c.Family.Members[1])
		}
		if c.Summary.Lineage.Parent == nil || c.Summary.Lineage.InheritedTurns != len(c.Lineage.InheritedTurns) {
			t.Errorf("summary lineage: %+v", c.Summary.Lineage)
		}
		var p SessionDetail
		r.get("/api/sessions/claude/"+sid("13", "01").ID, &p)
		if len(p.Lineage.Children) != 1 || p.Lineage.Children[0].Child != sid("13", "02") || p.Lineage.Leaf {
			t.Errorf("parent side: %+v", p.Lineage)
		}
	})
	t.Run("liveness", func(t *testing.T) {
		r.registry = catalog.Registry{{Harness: "claude", ID: costStateID}: {PID: 9, Status: "idle"}}
		defer func() { r.registry = nil }()
		var s SessionDetail
		r.get("/api/sessions/claude/"+costStateID, &s)
		if s.Summary.State != catalog.StateIdle {
			t.Errorf("state %q", s.Summary.State)
		}
	})
	t.Run("errors", func(t *testing.T) {
		r.wantError("/api/sessions/claude/ffffffff", 404, CodeNotFound)
		r.wantError("/api/sessions/codex/"+costStateID, 404, CodeNotFound)
		e := r.wantError("/api/sessions/claude/1", 409, CodeAmbiguousID)
		if len(e.Error.Candidates) < 2 || e.Error.Candidates[0].Key.ID == "" || e.Error.Candidates[0].Project == "" {
			t.Errorf("candidates: %+v", e.Error.Candidates)
		}
		for _, c := range e.Error.Candidates {
			if !strings.HasPrefix(c.Key.ID, "1") {
				t.Errorf("candidate %s does not match", c.Key.ID)
			}
		}
	})
	t.Run("scripted", func(t *testing.T) {
		// Never listed or matched by prefix; served only to the exact id.
		r.wantError("/api/sessions/claude/1515", 404, CodeNotFound)
		var s SessionDetail
		if code := r.get("/api/sessions/claude/"+sdkID, &s); code != 200 || s.Summary.Kind != model.KindSDK {
			t.Errorf("exact scripted id: %d", code)
		}
	})
}

func TestSearch(t *testing.T) {
	r := newRig(t)
	var res SearchResult
	if code := r.get("/api/search?q=changelog", &res); code != 200 {
		t.Fatal(code)
	}
	if len(res.Hits) == 0 || res.Truncated || res.Query != "changelog" {
		t.Fatalf("%+v", res)
	}
	h := res.Hits[0]
	if h.Session.ID != "21212121-0000-4000-8000-000000000001" || h.Snippet == "" || h.Field == "" {
		t.Errorf("hit: %+v", h)
	}
	if h.Turn < -1 {
		t.Errorf("turn %d", h.Turn)
	}

	r.get("/api/search?q=the&limit=2", &res)
	if len(res.Hits) != 2 || !res.Truncated {
		t.Errorf("limit: %d hits truncated=%v", len(res.Hits), res.Truncated)
	}
	r.get("/api/search?q=the&project="+url.QueryEscape("/home/dev/acme/nest")+"&limit=500", &res)
	if len(res.Hits) == 0 {
		t.Fatal("no hits in project")
	}
	for _, h := range res.Hits {
		if h.Project != "/home/dev/acme/nest" {
			t.Errorf("hit from %s", h.Project)
		}
	}
	r.get("/api/search?q=the&kind=background", &res)
	if len(res.Hits) != 0 || res.Hits == nil {
		t.Errorf("kind filter: %+v", res.Hits)
	}
	r.get("/api/search?q=zzzznothing", &res)
	if res.Hits == nil || len(res.Hits) != 0 {
		t.Errorf("no match must be []: %+v", res.Hits)
	}
	r.get("/api/search?q=the&since=2026-09-22&limit=500", &res)
	for _, h := range res.Hits {
		if h.At.Before(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)) {
			t.Errorf("stale hit %v", h.At)
		}
	}
	r.wantError("/api/search", 400, CodeInvalidParameter)
	r.wantError("/api/search?q=%20", 400, CodeInvalidParameter)
	r.wantError("/api/search?q=x&kind=sdk", 400, CodeInvalidParameter)
	r.wantError("/api/search?q=x&limit=-1", 400, CodeInvalidParameter)
}

func TestCost(t *testing.T) {
	r := newRig(t)
	total := r.cat.Total(catalog.Filter{})
	for _, by := range []string{"project", "day", "model", "kind", "session"} {
		var c CostTable
		if code := r.get("/api/cost?by="+by+"&limit=500", &c); code != 200 {
			t.Fatalf("by=%s: %d", by, code)
		}
		var sum float64
		for _, row := range c.Rows {
			sum += row.TotalUSD
			if row.Key == "" {
				t.Errorf("by=%s: row without key", by)
			}
		}
		if c.By != by || len(c.Rows) == 0 || !near(sum, c.Total.TotalUSD) || !near(c.Total.TotalUSD, total.TotalUSD) {
			t.Errorf("by=%s: rows sum %v, total %v, catalog %v", by, sum, c.Total.TotalUSD, total.TotalUSD)
		}
		if c.Sessions != 35 || c.Backing.ScriptedRuns != 1 || c.Backing.Exact+c.Backing.Partial+c.Backing.Estimated != 34 {
			t.Errorf("by=%s: sessions %d backing %+v", by, c.Sessions, c.Backing)
		}
		if !near(c.Total.TotalUSD, c.Total.ReportedUSD+c.Total.AttributedUSD) {
			t.Errorf("by=%s: money does not add up: %+v", by, c.Total)
		}
	}

	var c CostTable
	r.get("/api/cost", &c)
	if c.By != "project" {
		t.Errorf("default by = %q", c.By)
	}
	r.get("/api/cost?by=day", &c)
	for i := 1; i < len(c.Rows); i++ {
		if c.Rows[i].Key <= c.Rows[i-1].Key {
			t.Errorf("days not ascending: %s after %s", c.Rows[i].Key, c.Rows[i-1].Key)
		}
	}
	r.get("/api/cost?by=kind", &c)
	var sdk *CostRow
	for i := range c.Rows {
		if c.Rows[i].Key == "sdk" {
			sdk = &c.Rows[i]
		}
	}
	if sdk == nil || sdk.Sessions != 1 {
		t.Errorf("scripted spend must appear as kind sdk: %+v", c.Rows)
	}
	r.get("/api/cost?by=model", &c)
	var overhead bool
	for _, row := range c.Rows {
		overhead = overhead || row.Key == catalog.OverheadModel
	}
	if !overhead {
		t.Errorf("model table lacks the overhead row: %+v", c.Rows)
	}

	t.Run("session", func(t *testing.T) {
		r.get("/api/cost?by=session&limit=3", &c)
		if len(c.Rows) != 3 || !c.Truncated {
			t.Fatalf("rows %d truncated %v", len(c.Rows), c.Truncated)
		}
		if c.Rows[0].TotalUSD < c.Rows[1].TotalUSD || c.Rows[0].Flag == "" {
			t.Errorf("rows: %+v", c.Rows)
		}
		for _, row := range c.Rows {
			if row.Harness != "claude" || row.Project == "" || row.LastActivityAt.IsZero() {
				t.Errorf("a session row names its harness, project and last activity: %+v", row)
			}
		}
		if !near(c.Total.TotalUSD, total.TotalUSD) {
			t.Errorf("a limit must not change the total")
		}
		r.get("/api/cost?by=session&limit=500&project="+url.QueryEscape("/home/dev/acme/sdk"), &c)
		if len(c.Rows) != 1 || !strings.HasPrefix(c.Rows[0].Key, "scripted:") || c.Rows[0].Sessions != 1 ||
			c.Rows[0].Project != "/home/dev/acme/sdk" || c.Rows[0].Harness != "" {
			t.Errorf("scripted runs row: %+v", c.Rows)
		}
	})
	t.Run("filters", func(t *testing.T) {
		r.get("/api/cost?by=day&project="+url.QueryEscape("/home/dev/acme/nest"), &c)
		if len(c.Rows) != 1 || c.Rows[0].Key != "2026-09-22" || c.Project != "/home/dev/acme/nest" {
			t.Errorf("project filter: %+v", c.Rows)
		}
		r.get("/api/cost?by=day&since=2026-09-20&until=2026-09-21", &c)
		if len(c.Rows) != 2 || c.Rows[0].Key != "2026-09-20" || c.Rows[1].Key != "2026-09-21" || c.Since == nil || c.Until == nil {
			t.Errorf("day range: %+v", c.Rows)
		}
		want := r.cat.Total(catalog.Filter{DayFrom: "2026-09-20", DayTo: "2026-09-21"})
		if !near(c.Total.TotalUSD, want.TotalUSD) {
			t.Errorf("total %v want %v", c.Total.TotalUSD, want.TotalUSD)
		}
		r.get("/api/cost?by=project&since=2026-09-22", &c)
		if len(c.Rows) != 2 { // nest and nest/inner
			t.Errorf("since: %+v", c.Rows)
		}
	})
	t.Run("errors", func(t *testing.T) {
		r.wantError("/api/cost?by=planet", 400, CodeInvalidParameter)
		r.wantError("/api/cost?since=soon", 400, CodeInvalidParameter)
		r.wantError("/api/cost?limit=0", 400, CodeInvalidParameter)
	})
}

func TestMethodAndRoutes(t *testing.T) {
	r := newRig(t)
	for _, p := range []string{"/api/projects", "/api/sessions", "/api/sessions/claude/" + costStateID, "/api/search?q=x", "/api/cost", "/api/events"} {
		for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
			req, _ := http.NewRequest(m, r.srv.URL+p, nil)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 405 || resp.Header.Get("Allow") == "" {
				t.Errorf("%s %s = %d", m, p, resp.StatusCode)
			}
		}
	}
	r.wantError("/api/nothing", 404, CodeNotFound)
	r.wantError("/api/sessions/claude", 404, CodeNotFound)

	req, _ := http.NewRequest(http.MethodHead, r.srv.URL+"/api/projects", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Errorf("HEAD: %v %v", err, resp)
	}
	resp.Body.Close()
}

func TestHeaders(t *testing.T) {
	r := newRig(t)
	req, _ := http.NewRequest(http.MethodGet, r.srv.URL+"/api/projects", nil)
	req.Header.Set("Origin", "http://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	for k := range resp.Header {
		if strings.HasPrefix(strings.ToLower(k), "access-control-") {
			t.Errorf("CORS header %s", k)
		}
	}
	if resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("headers: %v", resp.Header)
	}
}

func TestHostGuard(t *testing.T) {
	r := newRig(t)
	allowed := []string{"127.0.0.1", "127.0.0.1:7433", "localhost", "localhost:7433", "LOCALHOST:80"}
	denied := []string{"evil.example", "evil.example:7433", "127.0.0.1.evil.example", "localhost.evil.example:7433",
		"192.168.1.5:7433", "0.0.0.0:7433", "[::1]:7433", "::1", "", "127.0.0.1:7433:1"}
	for _, p := range []string{"/api/projects", "/api/sessions", "/api/events", "/api/nothing"} {
		for _, h := range allowed {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, p, nil)
			req.Host = h
			if p == "/api/events" {
				req = req.WithContext(canceled())
			}
			r.api.Handler().ServeHTTP(rec, req)
			if rec.Code == 403 {
				t.Errorf("GET %s Host %q: 403", p, h)
			}
		}
		for _, h := range denied {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, p, nil)
			req.Host = h
			r.api.Handler().ServeHTTP(rec, req)
			if rec.Code != 403 {
				t.Errorf("GET %s Host %q = %d, want 403", p, h, rec.Code)
			}
			if !strings.Contains(rec.Body.String(), CodeForbiddenHost) {
				t.Errorf("GET %s Host %q: body %s", p, h, rec.Body.String())
			}
		}
	}
	// the guard comes before the method check
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", nil)
	req.Host = "evil.example"
	r.api.Handler().ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Errorf("POST from a foreign Host = %d", rec.Code)
	}
}

func TestUnavailable(t *testing.T) {
	r := newRig(t, func(o *Options) { o.Catalog = func() *catalog.Catalog { return nil } })
	r.wantError("/api/sessions", 503, CodeUnavailable)
	r.wantError("/api/cost", 503, CodeUnavailable)
}

func TestHostileText(t *testing.T) {
	// The hostile fixture carries markup and control characters in its text; the JSON
	// must round-trip them untouched.
	r := newRig(t)
	for _, in := range r.cat.List(catalog.Filter{}, catalog.Liveness{}).Sessions {
		var d SessionDetail
		if code := r.get("/api/sessions/claude/"+in.Key.ID+"?messages=1", &d); code != 200 {
			t.Fatalf("%s: %d", in.Key.ID, code)
		}
		orig, _ := r.cat.Digest(in.Key)
		if d.Digest.Title != orig.Title || len(d.Digest.Turns) != len(orig.Turns) || len(d.Digest.Messages) != len(orig.Messages) {
			t.Errorf("%s changed in transit", in.Key.ID)
		}
		for i := range orig.Turns {
			if d.Digest.Turns[i].UserText != orig.Turns[i].UserText {
				t.Errorf("%s turn %d text changed", in.Key.ID, i)
			}
		}
	}
}
