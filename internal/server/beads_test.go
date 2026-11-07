package server

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/internal/beads"
	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/repos"
)

// beadRig is an API over a test-local catalog: three sessions in /w, two of them with bd calls
// on acme-a1 (a parent's child acme-c1 among them), one on no bead.
func beadRig(t *testing.T) *rig {
	t.Helper()
	bd := filepath.Join(t.TempDir(), ".beads")
	if err := os.MkdirAll(bd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bd, "metadata.json"), []byte(`{"project_id":"p-acme"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	line := `{"id":"i1","kind":"field_change","created_at":"2026-10-01T10:02:00Z","issue_id":"acme-a1",` +
		`"extra":{"field":"status","new_value":"in_progress","old_value":"open"}}` + "\n"
	if err := os.WriteFile(filepath.Join(bd, "interactions.jsonl"), []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := beads.OpenRegistry(t.TempDir())
	if _, err := reg.Refresh(bd); err != nil {
		t.Fatal(err)
	}
	db, ok := reg.ForDir(bd)
	if !ok {
		t.Fatal("no bead database")
	}

	t0 := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
	at := func(min int) time.Time { return t0.Add(time.Duration(min) * time.Minute) }
	session := func(id string, usd float64, mins ...int) *model.SessionDigest {
		zero := 0
		d := &model.SessionDigest{
			SchemaVersion: model.SchemaVersion, Harness: "claude", ID: id, ProjectKey: "key-w", Project: "/w", Cwd: "/w",
			Kind: model.KindInteractive, Title: "session " + id, StartedAt: at(mins[0]), LastActivityAt: at(mins[len(mins)-1]),
			Turns: []model.Turn{{Index: 0, UUID: id + "-u0", StartedAt: at(mins[0]), UserText: "go", Origin: model.OriginHuman}},
		}
		for i, m := range mins {
			d.Messages = append(d.Messages, model.Message{ID: id + "-m" + string(rune('a'+i)), At: at(m), Model: "sonnet", USD: usd, Turn: &zero})
			d.Cost.USD += usd
		}
		return d
	}
	ev := func(min int, op model.BeadOp, ids ...string) model.BeadEvent {
		return model.BeadEvent{At: at(min), Op: op, IDs: ids, Cwd: "/w", Outcome: model.BeadOK}
	}
	s1 := session("s1", 1, 0, 1, 2, 3, 4, 5, 6)
	create := ev(0, model.BeadCreate, "acme-a1")
	create.Title = "Alpha work"
	child := ev(1, model.BeadCreate, "acme-c1")
	child.Title, child.Parent = "Child task", "acme-a1"
	s1.Beads = []model.BeadEvent{create, child, ev(2, model.BeadClaim, "acme-a1"), ev(4, model.BeadClose, "acme-a1"),
		ev(5, model.BeadClaim, "acme-c1")}
	s2 := session("s2", 2, 10, 11, 12)
	s2.Beads = []model.BeadEvent{ev(10, model.BeadClaim, "acme-c1"), ev(12, model.BeadClose, "acme-c1")}
	s3 := session("s3", 5, 20, 21)

	return newRig(t, func(o *Options) {
		c := catalog.New()
		c.SetLocation(testZone)
		for _, d := range []*model.SessionDigest{s1, s2, s3} {
			c.Upsert(d)
		}
		c.SetPlaces(catalog.Places{
			Repos: map[string]repos.Repo{"/w": {Checkout: "/w", GitCommonDir: "/w/.git", Beads: db.Dirs[0]}},
			Beads: reg.All(),
		})
		o.Catalog = func() *catalog.Catalog { return c }
	})
}

func TestGroupsBeadKeys(t *testing.T) {
	r := beadRig(t)
	var total float64
	for _, k := range groupKeys {
		var g GroupList
		if st := r.get("/api/groups?by="+string(k), &g); st != 200 {
			t.Fatalf("by=%s: status %d", k, st)
		}
		if len(g.Groups) == 0 {
			t.Fatalf("by=%s: no groups", k)
		}
		var sum float64
		sessions := 0
		for _, x := range g.Groups {
			sum += x.Money.TotalUSD
			sessions += x.Sessions
		}
		if k == catalog.GroupDir {
			total = sum
		}
		if math.Abs(sum-total) > 1e-9 || sessions != 3 {
			t.Errorf("by=%s: cost %v sessions %d, want %v and 3 (%+v)", k, sum, sessions, total, g.Groups)
		}
		if last := g.Groups[len(g.Groups)-1]; (k == catalog.GroupBead || k == catalog.GroupFamily) && last.Key != "" {
			t.Errorf("by=%s: last group %+v, want the no-bead group", k, last)
		}
	}
	var g GroupList
	r.get("/api/groups?by=bead", &g)
	for _, x := range g.Groups {
		if x.Key == "" && x.Name != "(no bead)" {
			t.Errorf("no-bead group name %q", x.Name)
		}
	}
}

func TestGroupsUnknownBy(t *testing.T) {
	r := beadRig(t)
	e := r.wantError("/api/groups?by=nope", 400, CodeInvalidParameter)
	for _, k := range groupKeys {
		if !strings.Contains(e.Error.Message, string(k)) {
			t.Errorf("message %q does not name %s", e.Error.Message, k)
		}
	}
}

func TestBeadDetail(t *testing.T) {
	r := beadRig(t)
	var b catalog.BeadDetail
	if st := r.get("/api/beads/acme-c1", &b); st != 200 {
		t.Fatalf("status %d", st)
	}
	if b.ID != "acme-c1" || b.Source == "" || b.Root != "acme-a1" || len(b.Ancestors) != 1 || len(b.Sessions) != 2 || len(b.Timeline) < 3 {
		t.Errorf("bead = %+v", b)
	}
	r.wantError("/api/beads/acme-zzz", 404, CodeNotFound)
	var l BeadList
	if st := r.get("/api/beads", &l); st != 200 || len(l.Families) == 0 {
		t.Errorf("GET /api/beads = %d %+v", st, l)
	}
}
