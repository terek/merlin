package server

import (
	"math"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/model"
)

func listTrees(t *testing.T, r *rig, query string) TreeList {
	t.Helper()
	var l TreeList
	if code := r.get("/api/sessions?by=tree"+query, &l); code != 200 {
		t.Fatalf("GET /api/sessions?by=tree%s = %d", query, code)
	}
	return l
}

func TestSessionsByTree(t *testing.T) {
	r := newRig(t)
	all := listSessions(t, r, "?limit=500")
	roots := map[model.SessionKey]int{}
	for _, s := range all.Sessions {
		roots[s.Lineage.Root]++
	}

	l := listTrees(t, r, "&limit=500")
	if l.Total != len(roots) || len(l.Trees) != len(roots) || l.Sessions != all.Total {
		t.Fatalf("total %d, listed %d, sessions %d; want %d trees of %d sessions", l.Total, len(l.Trees), l.Sessions, len(roots), all.Total)
	}
	if l.NextCursor != "" || len(l.Scripted) != len(all.Scripted) {
		t.Errorf("cursor %q, scripted %+v", l.NextCursor, l.Scripted)
	}
	for i, tr := range l.Trees {
		if i > 0 && tr.LastActivityAt.After(l.Trees[i-1].LastActivityAt) {
			t.Errorf("not newest first at %d", i)
		}
		if len(tr.Sessions) != roots[tr.Root] {
			t.Errorf("tree %s has %d sessions, want %d", tr.Root.ID, len(tr.Sessions), roots[tr.Root])
		}
		var last time.Time
		var usd float64
		open := false
		for _, s := range tr.Sessions {
			if s.Lineage.Root != tr.Root {
				t.Errorf("tree %s holds %s of root %s", tr.Root.ID, s.Key.ID, s.Lineage.Root.ID)
			}
			if s.LastActivityAt.After(last) {
				last = s.LastActivityAt
			}
			usd += s.Cost.BestUSD
			if s.Key == tr.Open {
				open = s.Lineage.Leaf
			}
		}
		if !tr.LastActivityAt.Equal(last) || math.Abs(tr.BestUSD-usd) > 1e-9 {
			t.Errorf("tree %s: last activity %v / %v, cost %v / %v", tr.Root.ID, tr.LastActivityAt, last, tr.BestUSD, usd)
		}
		if !open {
			t.Errorf("tree %s opens %s, not one of its leaves", tr.Root.ID, tr.Open.ID)
		}
		if tr.Sessions[0].Key != tr.Root {
			t.Errorf("tree %s does not start with its root", tr.Root.ID)
		}
	}

	t.Run("family", func(t *testing.T) {
		var fam TreeSummary
		for _, tr := range l.Trees {
			if tr.Root == sid("13", "01") {
				fam = tr
			}
		}
		if len(fam.Sessions) != 2 || fam.Sessions[1].Key != sid("13", "02") || fam.Open != sid("13", "02") {
			t.Fatalf("family tree: %+v", fam)
		}
		// A filter that selects only one member still lists the whole tree.
		newer := fam.Sessions[0]
		if fam.Sessions[1].LastActivityAt.After(newer.LastActivityAt) {
			newer = fam.Sessions[1]
		}
		since := "&since=" + newer.LastActivityAt.UTC().Format(time.RFC3339Nano)
		if ls := listSessions(t, r, "?limit=500"+since); len(ls.Sessions) == 0 {
			t.Fatal("since selected nothing")
		}
		found := false
		for _, tr := range listTrees(t, r, "&limit=500"+since).Trees {
			if tr.Root == fam.Root {
				found = len(tr.Sessions) == 2
			}
		}
		if !found {
			t.Errorf("tree not listed whole when only %s matches", newer.Key.ID)
		}
	})

	t.Run("state", func(t *testing.T) {
		r.registry = catalog.Registry{sid("13", "02"): {PID: 1, SessionID: sid("13", "02").ID, Status: "busy"}}
		defer func() { r.registry = nil }()
		run := listTrees(t, r, "&state=running")
		if run.Total != 1 || run.Trees[0].Root != sid("13", "01") || len(run.Trees[0].Sessions) != 2 {
			t.Fatalf("running: %+v", run)
		}
		if s := run.Trees[0].Sessions[1]; s.State != catalog.StateBusy {
			t.Errorf("member state %q", s.State)
		}
	})

	t.Run("pages", func(t *testing.T) {
		var got []model.SessionKey
		cursor := ""
		for pages := 0; ; pages++ {
			if pages > 20 {
				t.Fatal("too many pages")
			}
			q := "&limit=4"
			if cursor != "" {
				q += "&cursor=" + cursor
			}
			p := listTrees(t, r, q)
			if p.Total != l.Total {
				t.Errorf("page total %d", p.Total)
			}
			if cursor != "" && len(p.Scripted) != 0 {
				t.Errorf("a later page repeats scripted lines")
			}
			for _, tr := range p.Trees {
				got = append(got, tr.Root)
			}
			if cursor = p.NextCursor; cursor == "" {
				break
			}
		}
		if len(got) != len(l.Trees) {
			t.Fatalf("paged %d trees, want %d", len(got), len(l.Trees))
		}
		for i := range got {
			if got[i] != l.Trees[i].Root {
				t.Fatalf("page order differs at %d", i)
			}
		}
	})

	r.wantError("/api/sessions?by=project", 400, CodeInvalidParameter)
	if code := r.get("/api/sessions?by=session&limit=1", &SessionList{}); code != 200 {
		t.Errorf("by=session: %d", code)
	}
}

func TestSearchHitRoot(t *testing.T) {
	r := newRig(t)
	all := listSessions(t, r, "?limit=500")
	root := map[model.SessionKey]model.SessionKey{}
	for _, s := range all.Sessions {
		root[s.Key] = s.Lineage.Root
	}
	var res SearchResult
	r.get("/api/search?q=the&limit=500", &res)
	if len(res.Hits) == 0 {
		t.Fatal("no hits")
	}
	for _, h := range res.Hits {
		if h.Root != root[h.Session] {
			t.Errorf("hit in %s has root %s, want %s", h.Session.ID, h.Root.ID, root[h.Session].ID)
		}
	}
}
