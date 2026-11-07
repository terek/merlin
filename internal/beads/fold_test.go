package beads

import (
	"encoding/json"
	"math/rand"
	"reflect"
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

var foldT0 = time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)

func foldAt(min int) time.Time { return foldT0.Add(time.Duration(min) * time.Minute) }

func foldInt(v int) *int { return &v }

// ev builds an ok event of a session at minute min.
func fev(sess, db string, min int, op model.BeadOp, mod func(*model.BeadEvent), ids ...string) Observed {
	e := model.BeadEvent{At: foldAt(min), Op: op, IDs: ids, Outcome: model.BeadOK}
	if mod != nil {
		mod(&e)
	}
	return Observed{Session: sess, DB: db, Event: e}
}

func issueOf2(t *testing.T, f *Folded, id string) Issue {
	t.Helper()
	is, _, ok := f.Issue(id)
	if !ok {
		t.Fatalf("bead %s not found", id)
	}
	return is
}

func dbByKey(t *testing.T, f *Folded, key string) Database {
	t.Helper()
	for _, d := range f.Databases {
		if d.Key == key {
			return d
		}
	}
	t.Fatalf("database %s not found in %v", key, foldKeys(f))
	return Database{}
}

func foldKeys(f *Folded) []string {
	var k []string
	for _, d := range f.Databases {
		k = append(k, d.Key)
	}
	return k
}

func TestFoldNoExport(t *testing.T) {
	snap := []Database{{Version: 1, Key: "A", Dirs: []string{"/x/.beads"}, Issues: []Issue{},
		Statuses: []Status{{ID: "acme-a1", Status: "in_progress", At: foldAt(5)}}}}
	evs := []Observed{
		fev("claude/s1", "A", 1, model.BeadCreate, func(e *model.BeadEvent) {
			e.Title, e.Type, e.Priority = "First", "task", foldInt(2)
		}, "acme-a1"),
		fev("claude/s1", "A", 2, model.BeadCreate, func(e *model.BeadEvent) { e.Title, e.Parent = "Child", "acme-a1" }, "acme-a9"),
		fev("claude/s1", "A", 3, model.BeadClaim, nil, "acme-a9"),
		fev("claude/s1", "A", 8, model.BeadClose, func(e *model.BeadEvent) { e.Reason = "done" }, "acme-a9"),
	}
	f := Fold(snap, evs)
	if got := f.DatabaseOf("acme-a1"); got != "A" {
		t.Fatalf("db = %q", got)
	}
	db := dbByKey(t, f, "A")
	if !reflect.DeepEqual(db.Prefixes, []string{"acme"}) || len(db.Issues) != 2 {
		t.Fatalf("db = %+v", db)
	}
	a1, a9 := issueOf2(t, f, "acme-a1"), issueOf2(t, f, "acme-a9")
	if a1.Title != "First" || a1.Type != "task" || a1.Priority == nil || *a1.Priority != 2 || a1.Source != SourceSessions {
		t.Fatalf("a1 = %+v", a1)
	}
	if a1.Status != "in_progress" { // interactions at minute 5 beats the create's open at 1
		t.Fatalf("a1 status = %q", a1.Status)
	}
	if a9.Parent != "acme-a1" || a9.Title != "Child" || a9.Status != "closed" || a9.CloseReason != "done" || !a9.ClosedAt.Equal(foldAt(8)) {
		t.Fatalf("a9 = %+v", a9)
	}
	if !a9.CreatedAt.Equal(foldAt(2)) || !a9.FirstSeen.Equal(foldAt(2)) || !a9.LastSeen.Equal(foldAt(8)) {
		t.Fatalf("a9 times = %+v", a9)
	}
	// No snapshot at all: the prefix gets a database of its own.
	f = Fold(nil, evs)
	if f.DatabaseOf("acme-a1") != "prefix:acme" || len(f.Databases) != 1 {
		t.Fatalf("dbs = %v", foldKeys(f))
	}
}

func TestFoldExportWins(t *testing.T) {
	snap := []Database{{Key: "A", Prefixes: []string{"acme"}, Issues: []Issue{
		{ID: "acme-a1", Title: "Exported", Status: "open", Type: "bug", CreatedAt: foldAt(-60), Labels: []string{"l"}},
		{ID: "acme-a2", Status: "closed", ClosedAt: foldAt(-30), CloseReason: "r"},
	}}}
	evs := []Observed{
		fev("s", "A", 1, model.BeadUpdate, func(e *model.BeadEvent) { e.Title = "Renamed"; e.Status = "closed" }, "acme-a1"),
		fev("s", "A", 2, model.BeadUpdate, func(e *model.BeadEvent) { e.Title = "From events" }, "acme-a2"),
		fev("s", "A", 3, model.BeadCreate, func(e *model.BeadEvent) { e.Title = "New" }, "acme-a3"),
		fev("s", "A", 4, model.BeadShow, func(e *model.BeadEvent) {
			e.Seen = []model.BeadSeen{{ID: "acme-a1", Type: "task", Priority: foldInt(1)}}
		}, "acme-a1"),
	}
	f := Fold(snap, evs)
	a1, a2, a3 := issueOf2(t, f, "acme-a1"), issueOf2(t, f, "acme-a2"), issueOf2(t, f, "acme-a3")
	// Export wins, even for the empty priority; its title and status stand.
	if a1.Title != "Exported" || a1.Status != "open" || a1.Type != "bug" || a1.Priority != nil || a1.Source != SourceExport {
		t.Fatalf("a1 = %+v", a1)
	}
	if !a1.CreatedAt.Equal(foldAt(-60)) || !a1.FirstSeen.Equal(foldAt(1)) || !a1.LastSeen.Equal(foldAt(4)) || len(a1.Labels) != 1 {
		t.Fatalf("a1 = %+v", a1)
	}
	// An export without a title falls back to the sessions'.
	if a2.Title != "From events" || a2.Status != "closed" || a2.CloseReason != "r" {
		t.Fatalf("a2 = %+v", a2)
	}
	if a3.Title != "New" || a3.Source != SourceSessions || a3.Status != "open" {
		t.Fatalf("a3 = %+v", a3)
	}
}

func TestFoldPrefixDatabase(t *testing.T) {
	snap := []Database{{Key: "A", Prefixes: []string{"acme"}, Issues: []Issue{{ID: "acme-a1"}}}}
	evs := []Observed{
		fev("s", "A", 1, model.BeadClaim, nil, "zed-q9"),
		fev("s", "", 2, model.BeadClose, nil, "zed-q9.1"),
		fev("s", "A", 3, model.BeadClaim, nil, "nodash"),
	}
	f := Fold(snap, evs)
	// zed is learned by A at event 1, so no synthetic database is needed.
	if f.DatabaseOf("zed-q9") != "A" {
		t.Fatalf("learned: %v", foldKeys(f))
	}
	f = Fold(snap, evs[1:2])
	if f.DatabaseOf("zed-q9.1") != "prefix:zed" {
		t.Fatalf("keys %v", foldKeys(f))
	}
	d := dbByKey(t, f, "prefix:zed")
	if len(d.Issues) != 2 || d.Issues[0].ID != "zed-q9" || d.Issues[0].Source != SourceImplied || !reflect.DeepEqual(d.Prefixes, []string{"zed"}) || len(d.Dirs) != 0 {
		t.Fatalf("d = %+v", d)
	}
	if _, _, ok := f.Issue("nodash"); ok {
		t.Fatal("bead without prefix kept")
	}
}

func TestFoldStubs(t *testing.T) {
	evs := []Observed{
		fev("s", "A", 1, model.BeadCreate, func(e *model.BeadEvent) { e.Parent = "acme-p" }, "acme-a1.2.3"),
	}
	f := Fold([]Database{{Key: "A"}}, evs)
	for _, id := range []string{"acme-a1.2", "acme-a1", "acme-p"} {
		is := issueOf2(t, f, id)
		if is.Source != SourceImplied || is.Title != "" || !is.FirstSeen.IsZero() {
			t.Fatalf("%s = %+v", id, is)
		}
	}
	if issueOf2(t, f, "acme-a1.2.3").Parent != "acme-p" || issueOf2(t, f, "acme-a1.2").Parent != "acme-a1" || issueOf2(t, f, "acme-a1").Parent != "" {
		t.Fatal("parents")
	}
	if f.DatabaseOf("acme-p") != "A" {
		t.Fatal("stub db")
	}
}

func TestFoldParentPrecedence(t *testing.T) {
	parentChild := func(p string) func(*model.BeadEvent) {
		return func(e *model.BeadEvent) { e.DepType = "parent-child" }
	}
	tests := []struct {
		name string
		evs  []Observed
		want string
	}{
		{"dotted only", []Observed{fev("s", "A", 1, model.BeadClaim, nil, "acme-a.1")}, "acme-a"},
		{"dep beats dotted", []Observed{fev("s", "A", 1, model.BeadDep, parentChild(""), "acme-a.1", "acme-z")}, "acme-z"},
		{"create deps beats dotted", []Observed{fev("s", "A", 1, model.BeadCreate, func(e *model.BeadEvent) {
			e.Deps = []model.BeadDepRef{{ID: "acme-d", Type: "parent-child"}}
		}, "acme-a.1")}, "acme-d"},
		{"create beats dep", []Observed{
			fev("s", "A", 1, model.BeadCreate, func(e *model.BeadEvent) { e.Parent = "acme-c" }, "acme-a.1"),
			fev("s", "A", 2, model.BeadDep, parentChild(""), "acme-a.1", "acme-z"),
		}, "acme-c"},
		{"update beats create", []Observed{
			fev("s", "A", 3, model.BeadCreate, func(e *model.BeadEvent) { e.Parent = "acme-c" }, "acme-a.1"),
			fev("s", "A", 1, model.BeadUpdate, func(e *model.BeadEvent) { e.Parent = "acme-u" }, "acme-a.1"),
		}, "acme-u"},
		{"latest update wins", []Observed{
			fev("s", "A", 1, model.BeadUpdate, func(e *model.BeadEvent) { e.Parent = "acme-u1" }, "acme-a.1"),
			fev("s", "A", 2, model.BeadUpdate, func(e *model.BeadEvent) { e.Parent = "acme-u2" }, "acme-a.1"),
		}, "acme-u2"},
		{"seen beats dotted", []Observed{fev("s", "A", 1, model.BeadShow, func(e *model.BeadEvent) {
			e.Seen = []model.BeadSeen{{ID: "acme-a.1", Parent: "acme-sp"}}
		}, "acme-a.1")}, "acme-sp"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := Fold([]Database{{Key: "A"}}, tc.evs)
			if got := issueOf2(t, f, "acme-a.1").Parent; got != tc.want {
				t.Fatalf("parent = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFoldParentCycle(t *testing.T) {
	// b is the update parent of a, and a the create parent of b: the lower tier is dropped, b falls
	// back to the dotted parent (none for a root).
	evs := []Observed{
		fev("s", "A", 1, model.BeadUpdate, func(e *model.BeadEvent) { e.Parent = "acme-b" }, "acme-a"),
		fev("s", "A", 2, model.BeadCreate, func(e *model.BeadEvent) { e.Parent = "acme-a" }, "acme-b"),
		fev("s", "A", 3, model.BeadUpdate, func(e *model.BeadEvent) { e.Parent = "acme-c.1" }, "acme-c"),
	}
	f := Fold([]Database{{Key: "A"}}, evs)
	if p := issueOf2(t, f, "acme-a").Parent; p != "acme-b" {
		t.Fatalf("a parent = %q", p)
	}
	if p := issueOf2(t, f, "acme-b").Parent; p != "" {
		t.Fatalf("b parent = %q", p)
	}
	// Precedence is by source kind: c's update --parent c.1 outranks c.1's dotted id, which would
	// close a loop and is dropped (no parent left).
	if issueOf2(t, f, "acme-c.1").Parent != "" || issueOf2(t, f, "acme-c").Parent != "acme-c.1" {
		t.Fatal("dotted cycle")
	}
}

func TestFoldFailedIgnored(t *testing.T) {
	failed := func(e *model.BeadEvent) { e.Outcome = model.BeadFailed; e.Title = "Bad"; e.Status = "closed" }
	evs := []Observed{
		fev("s", "A", 5, model.BeadCreate, func(e *model.BeadEvent) { e.Title = "Good" }, "acme-a1"),
		fev("s", "A", 6, model.BeadClose, failed, "acme-a1"),
		fev("s", "A", 7, model.BeadUpdate, func(e *model.BeadEvent) { failed(e); e.Op = model.BeadUpdate }, "acme-a1"),
		fev("s", "A", 1, model.BeadClaim, failed, "acme-only-failed"),
		fev("s", "A", 9, model.BeadCreate, func(e *model.BeadEvent) { failed(e); e.Parent = "zed-q" }, "acme-a1"),
	}
	f := Fold([]Database{{Key: "A"}}, evs)
	a1 := issueOf2(t, f, "acme-a1")
	if a1.Title != "Good" || a1.Status != "open" || !a1.FirstSeen.Equal(foldAt(5)) || !a1.LastSeen.Equal(foldAt(5)) || a1.Parent != "" {
		t.Fatalf("a1 = %+v", a1)
	}
	if _, _, ok := f.Issue("acme-only-failed"); ok {
		t.Fatal("failed-only bead kept")
	}
	if f.DatabaseOf("zed-q") != "prefix:zed" { // not learned from a failed call
		t.Fatal("learned from failed")
	}
}

func TestFoldUnknownOutcomeCounts(t *testing.T) {
	evs := []Observed{
		fev("s", "A", 1, model.BeadCreate, nil, "acme-a1"),
		fev("s", "A", 2, model.BeadClaim, func(e *model.BeadEvent) { e.Outcome = model.BeadUnknown; e.Status = "" }, "acme-a1"),
	}
	f := Fold([]Database{{Key: "A"}}, evs)
	if s := issueOf2(t, f, "acme-a1").Status; s != "in_progress" {
		t.Fatalf("status = %q", s)
	}
}

func TestFoldReopenClearsClose(t *testing.T) {
	evs := []Observed{
		fev("s", "A", 1, model.BeadClose, func(e *model.BeadEvent) { e.Reason = "x" }, "acme-a1"),
		fev("s", "A", 2, model.BeadReopen, nil, "acme-a1"),
		fev("s", "A", 3, model.BeadClose, func(e *model.BeadEvent) { e.Reason = "y" }, "acme-b1"),
		fev("s", "A", 4, model.BeadReopen, nil, "acme-b1"),
		fev("s", "A", 5, model.BeadClose, func(e *model.BeadEvent) { e.Reason = "z" }, "acme-b1"),
	}
	f := Fold([]Database{{Key: "A"}}, evs)
	a1, b1 := issueOf2(t, f, "acme-a1"), issueOf2(t, f, "acme-b1")
	if a1.Status != "open" || !a1.ClosedAt.IsZero() || a1.CloseReason != "" {
		t.Fatalf("a1 = %+v", a1)
	}
	if b1.Status != "closed" || b1.CloseReason != "z" || !b1.ClosedAt.Equal(foldAt(5)) {
		t.Fatalf("b1 = %+v", b1)
	}
}

func TestFoldGone(t *testing.T) {
	mt := foldAt(100)
	snap := []Database{{Key: "A", Prefixes: []string{"acme"},
		Sources: []Source{{Path: "/x/.beads/issues.jsonl", MtimeNs: mt.UnixNano()}, {Path: "/x/.beads/interactions.jsonl", MtimeNs: foldAt(500).UnixNano()}},
		Issues: []Issue{
			{ID: "acme-g1", Title: "Gone one", Status: "open", Gone: true},
			{ID: "acme-g2", Title: "Gone two", Status: "open", Gone: true},
			{ID: "acme-g3", Title: "Gone three", Status: "closed", Gone: true, ClosedAt: foldAt(50), CloseReason: "old"},
		}}}
	evs := []Observed{
		fev("s", "A", 101, model.BeadClose, func(e *model.BeadEvent) { e.Reason = "later" }, "acme-g1"),
		fev("s", "A", 99, model.BeadClose, func(e *model.BeadEvent) { e.Reason = "earlier" }, "acme-g2"),
		fev("s", "A", 120, model.BeadReopen, nil, "acme-g3"),
	}
	f := Fold(snap, evs)
	g1, g2, g3 := issueOf2(t, f, "acme-g1"), issueOf2(t, f, "acme-g2"), issueOf2(t, f, "acme-g3")
	if g1.Status != "closed" || g1.CloseReason != "later" || g1.Title != "Gone one" || !g1.Gone || g1.Source != SourceExport {
		t.Fatalf("g1 = %+v", g1)
	}
	if g2.Status != "open" || g2.CloseReason != "" {
		t.Fatalf("g2 = %+v", g2)
	}
	if g3.Status != "open" || !g3.ClosedAt.IsZero() || g3.CloseReason != "" {
		t.Fatalf("g3 = %+v", g3)
	}
	// interactions.jsonl statuses follow the same rule.
	snap[0].Statuses = []Status{{ID: "acme-g2", Status: "in_progress", At: foldAt(90)}, {ID: "acme-g1", Status: "blocked", At: foldAt(150)}}
	f = Fold(snap, evs)
	if s := issueOf2(t, f, "acme-g2").Status; s != "open" {
		t.Fatalf("g2 status = %q", s)
	}
	if s := issueOf2(t, f, "acme-g1").Status; s != "blocked" {
		t.Fatalf("g1 status = %q", s)
	}
}

func TestFoldInteractionsVsEvents(t *testing.T) {
	snap := []Database{{Key: "A", Prefixes: []string{"acme"}, Statuses: []Status{
		{ID: "acme-a1", Status: "closed", At: foldAt(10), Reason: "int"},
		{ID: "acme-a2", Status: "closed", At: foldAt(1)},
	}}}
	evs := []Observed{
		fev("s", "A", 5, model.BeadClaim, nil, "acme-a1"), // before interactions: loses
		fev("s", "A", 5, model.BeadClaim, nil, "acme-a2"), // after interactions: wins
		fev("s", "A", 6, model.BeadShow, nil, "acme-a1"),
	}
	f := Fold(snap, evs)
	a1, a2 := issueOf2(t, f, "acme-a1"), issueOf2(t, f, "acme-a2")
	if a1.Status != "closed" || a1.CloseReason != "int" || !a1.ClosedAt.Equal(foldAt(10)) {
		t.Fatalf("a1 = %+v", a1)
	}
	if a2.Status != "in_progress" {
		t.Fatalf("a2 = %+v", a2)
	}
	// A seen status counts at the event's time.
	evs = append(evs, fev("s", "A", 20, model.BeadShow, func(e *model.BeadEvent) {
		e.Seen = []model.BeadSeen{{ID: "acme-a1", Status: "open"}}
	}, "acme-a1"))
	f = Fold(snap, evs)
	if a1 := issueOf2(t, f, "acme-a1"); a1.Status != "open" || !a1.ClosedAt.IsZero() {
		t.Fatalf("a1 = %+v", a1)
	}
}

func TestFoldOutputOnlyDoesNotLearn(t *testing.T) {
	snap := []Database{{Key: "A", Prefixes: []string{"acme"}}, {Key: "B"}}
	evs := []Observed{
		fev("s", "A", 1, model.BeadClose, func(e *model.BeadEvent) { e.OutputOnly = true; e.Title = "Quoted" }, "zed-q1"),
		fev("s", "B", 2, model.BeadClose, func(e *model.BeadEvent) { e.OutputOnly = true }, "yak-q1"),
	}
	f := Fold(snap, evs)
	if f.DatabaseOf("zed-q1") != "prefix:zed" || f.DatabaseOf("yak-q1") != "prefix:yak" {
		t.Fatalf("dbs = %v", foldKeys(f))
	}
	// The bead is still folded.
	if is := issueOf2(t, f, "zed-q1"); is.Title != "Quoted" || is.Status != "closed" {
		t.Fatalf("zed-q1 = %+v", is)
	}
	for _, d := range f.Databases {
		if d.Key == "A" || d.Key == "B" {
			if len(d.Prefixes) > 1 || (d.Key == "B" && len(d.Prefixes) != 0) {
				t.Fatalf("%s learned %v", d.Key, d.Prefixes)
			}
		}
	}
}

func TestFoldLearningTies(t *testing.T) {
	snap := []Database{{Key: "B"}, {Key: "A"}, {Key: "C"}}
	evs := []Observed{
		fev("s", "B", 1, model.BeadClaim, nil, "zed-1"),
		fev("s", "A", 2, model.BeadClaim, nil, "zed-2"),
		fev("s", "C", 3, model.BeadClaim, nil, "zed-3"),
		// yak: C has two events, A one.
		fev("s", "C", 4, model.BeadClaim, nil, "yak-1"),
		fev("s", "C", 5, model.BeadClaim, nil, "yak-2"),
		fev("s", "A", 6, model.BeadClaim, nil, "yak-3"),
		// Many ids of one prefix in one event are one vote.
		fev("s", "A", 7, model.BeadClose, nil, "wob-1", "wob-2", "wob-3"),
		fev("s", "B", 8, model.BeadClaim, nil, "wob-4"),
		fev("s", "B", 9, model.BeadClaim, nil, "wob-5"),
	}
	f := Fold(snap, evs)
	if f.DatabaseOf("zed-9") != "A" || f.DatabaseOf("yak-9") != "C" || f.DatabaseOf("wob-9") != "B" {
		t.Fatalf("zed %s yak %s wob %s", f.DatabaseOf("zed-9"), f.DatabaseOf("yak-9"), f.DatabaseOf("wob-9"))
	}
	if got := dbByKey(t, f, "A").Prefixes; !reflect.DeepEqual(got, []string{"zed"}) {
		t.Fatalf("A prefixes = %v", got)
	}
	if got := dbByKey(t, f, "B").Prefixes; !reflect.DeepEqual(got, []string{"wob"}) {
		t.Fatalf("B prefixes = %v", got)
	}
}

func TestFoldExportPrefixNotReassigned(t *testing.T) {
	snap := []Database{{Key: "A", Issues: []Issue{{ID: "acme-a1"}}}, {Key: "B"}}
	f := Fold(snap, []Observed{fev("s", "B", 1, model.BeadClaim, nil, "acme-new")})
	if f.DatabaseOf("acme-new") != "A" {
		t.Fatal("export prefix moved")
	}
	// The first database by key holds an id both exports have.
	snap = []Database{{Key: "Z", Issues: []Issue{{ID: "acme-a1", Title: "z"}}}, {Key: "A", Issues: []Issue{{ID: "acme-a1", Title: "a"}}}}
	f = Fold(snap, nil)
	if is, db, _ := f.Issue("acme-a1"); db != "A" || is.Title != "a" || len(dbByKey(t, f, "Z").Issues) != 0 {
		t.Fatalf("%v %s", is, db)
	}
}

func TestFoldDatabaseOfUnseen(t *testing.T) {
	snap := []Database{{Key: "A", Prefixes: []string{"acme"}}}
	f := Fold(snap, []Observed{fev("s", "A", 1, model.BeadClaim, nil, "acme-a1")})
	for id, want := range map[string]string{
		"acme-never":   "A",
		"acme-never.1": "A",
		"zed-q9":       "prefix:zed",
		"my-app-k2":    "prefix:my-app",
		"nodash":       "",
		"":             "",
		"acme-a1":      "A",
	} {
		if got := f.DatabaseOf(id); got != want {
			t.Errorf("DatabaseOf(%q) = %q, want %q", id, got, want)
		}
	}
}

func TestFoldTitles(t *testing.T) {
	evs := []Observed{
		fev("s", "A", 1, model.BeadCreate, func(e *model.BeadEvent) { e.Title = "one" }, "acme-a1"),
		fev("s", "A", 2, model.BeadUpdate, func(e *model.BeadEvent) { e.Title = "two" }, "acme-a1"),
		fev("s", "A", 3, model.BeadClose, func(e *model.BeadEvent) { e.Title = "multi" }, "acme-a1", "acme-a2"),
		fev("s", "A", 4, model.BeadComment, func(e *model.BeadEvent) { e.Title = "no" }, "acme-a1"),
		fev("s", "A", 5, model.BeadShow, func(e *model.BeadEvent) {
			e.Seen = []model.BeadSeen{{ID: "acme-a2", Title: "seen"}}
		}, "acme-a2"),
		fev("s", "A", 6, model.BeadClose, func(e *model.BeadEvent) { e.Title = "three" }, "acme-a1"),
	}
	f := Fold([]Database{{Key: "A"}}, evs)
	if got := issueOf2(t, f, "acme-a1").Title; got != "three" {
		t.Fatalf("a1 title = %q", got)
	}
	if got := issueOf2(t, f, "acme-a2").Title; got != "seen" {
		t.Fatalf("a2 title = %q", got)
	}
}

// foldCase builds ~30 events over 3 sessions with equal timestamps in places.
func foldCase() ([]Database, []Observed) {
	snap := []Database{
		{Version: 1, Key: "B", Dirs: []string{"/b/.beads"}, Prefixes: []string{"bee"}, Issues: []Issue{
			{ID: "bee-1", Title: "Bee", Priority: foldInt(1), Labels: []string{"x"}, Deps: []Dep{{ID: "bee-2", Type: "blocks"}}},
			{ID: "bee-2", Gone: true, Status: "open"},
		}, Sources: []Source{{Path: "/b/.beads/issues.jsonl", MtimeNs: foldAt(2).UnixNano()}}},
		{Version: 1, Key: "A", Dirs: []string{"/a/.beads"}, Statuses: []Status{{ID: "acme-a1", Status: "closed", At: foldAt(3)}}},
	}
	var evs []Observed
	sessions := []string{"claude/s1", "claude/s2", "codex/s3"}
	for i := 0; i < 30; i++ {
		s := sessions[i%3]
		min := i / 3 // equal times across sessions, and pairs within one
		db := []string{"A", "B", ""}[i%3]
		e := model.BeadEvent{At: foldAt(min), Outcome: model.BeadOK, ToolUseID: []string{"t1", "t2", "t1"}[i%3]}
		switch i % 6 {
		case 0:
			e.Op, e.IDs, e.Title, e.Parent = model.BeadCreate, []string{"acme-a" + string(rune('1'+i%5))}, "T"+string(rune('a'+i%7)), "acme-root"
		case 1:
			e.Op, e.IDs, e.Status = model.BeadClaim, []string{"acme-a1"}, "in_progress"
		case 2:
			e.Op, e.IDs, e.Reason = model.BeadClose, []string{"bee-2"}, "r"+string(rune('a'+i))
		case 3:
			e.Op, e.IDs, e.DepType = model.BeadDep, []string{"zed-q9.1", "zed-q9"}, "parent-child"
		case 4:
			e.Op, e.IDs, e.Parent = model.BeadUpdate, []string{"acme-a2"}, "acme-p"+string(rune('0'+i%3))
		case 5:
			e.Op, e.IDs, e.OutputOnly, e.Outcome = model.BeadReopen, []string{"yak-" + string(rune('a'+i%4))}, true, model.BeadUnknown
		}
		evs = append(evs, Observed{Session: s, DB: db, Event: e})
	}
	return snap, evs
}

func TestFoldDeterministic(t *testing.T) {
	snap, evs := foldCase()
	before, _ := json.Marshal(snap)
	beforeEvs, _ := json.Marshal(evs)
	want, _ := json.Marshal(Fold(snap, evs).Databases)
	if after, _ := json.Marshal(snap); string(after) != string(before) {
		t.Fatal("snapshots mutated")
	}
	if after, _ := json.Marshal(evs); string(after) != string(beforeEvs) {
		t.Fatal("events mutated")
	}
	for _, seed := range []int64{1, 2, 3, 42, 1234} {
		r := rand.New(rand.NewSource(seed))
		sh := append([]Observed(nil), evs...)
		r.Shuffle(len(sh), func(i, j int) { sh[i], sh[j] = sh[j], sh[i] })
		ss := append([]Database(nil), snap...)
		r.Shuffle(len(ss), func(i, j int) { ss[i], ss[j] = ss[j], ss[i] })
		f := Fold(ss, sh)
		got, _ := json.Marshal(f.Databases)
		if string(got) != string(want) {
			t.Fatalf("seed %d differs:\n%s\n%s", seed, got, want)
		}
		if !reflect.DeepEqual(f.Databases, Fold(snap, evs).Databases) {
			t.Fatalf("seed %d: not DeepEqual", seed)
		}
	}
	// Equal timestamps are broken by session, so the shuffles above matter: sanity check the result.
	f := Fold(snap, evs)
	if len(f.Databases) < 3 {
		t.Fatalf("databases = %v", foldKeys(f))
	}
}

// An exported id stays in the database whose export has it, even when another database (earlier by
// key) owns its prefix.
func TestFoldExportIDBeatsPrefixOwner(t *testing.T) {
	snap := []Database{
		{Version: 1, Key: "A", Issues: []Issue{{ID: "acme-1", Title: "one", Status: "open"}}},
		{Version: 1, Key: "B", Issues: []Issue{{ID: "acme-2", Title: "two", Status: "open"}},
			Statuses: []Status{{ID: "acme-2", Status: "closed", At: foldAt(1)}}},
	}
	f := Fold(snap, []Observed{fev("claude/s1", "B", 2, model.BeadShow, nil, "acme-2")})
	if got := f.DatabaseOf("acme-2"); got != "B" {
		t.Fatalf("DatabaseOf(acme-2) = %q, want B", got)
	}
	if _, key, ok := f.Issue("acme-2"); !ok || key != "B" {
		t.Fatalf("Issue(acme-2) in %q", key)
	}
	if n := len(dbByKey(t, f, "B").Issues); n != 1 {
		t.Fatalf("B has %d issues", n)
	}
}

// closedAt and closeReason come from the latest close in time, and not from a close a later
// reopen undid.
func TestFoldClosedFromLatestClose(t *testing.T) {
	snap := []Database{{Version: 1, Key: "A", Issues: []Issue{},
		Statuses: []Status{{ID: "acme-a1", Status: "closed", At: foldAt(12), Reason: "late"}}}}
	evs := []Observed{
		fev("claude/s1", "A", 1, model.BeadCreate, nil, "acme-a1"),
		fev("claude/s1", "A", 10, model.BeadClose, func(e *model.BeadEvent) { e.Reason = "early" }, "acme-a1"),
		fev("claude/s1", "A", 1, model.BeadCreate, nil, "acme-b1"),
		fev("claude/s1", "A", 2, model.BeadClose, func(e *model.BeadEvent) { e.Reason = "r1" }, "acme-b1"),
		fev("claude/s1", "A", 3, model.BeadReopen, nil, "acme-b1"),
		fev("claude/s1", "A", 4, model.BeadShow, func(e *model.BeadEvent) {
			e.Seen = []model.BeadSeen{{ID: "acme-b1", Status: "closed"}}
		}),
	}
	f := Fold(snap, evs)
	if a := issueOf2(t, f, "acme-a1"); a.Status != "closed" || !a.ClosedAt.Equal(foldAt(12)) || a.CloseReason != "late" {
		t.Errorf("a1 = %s %v %q, want closed at 12 late", a.Status, a.ClosedAt, a.CloseReason)
	}
	if b := issueOf2(t, f, "acme-b1"); b.Status != "closed" || !b.ClosedAt.Equal(foldAt(4)) || b.CloseReason != "" {
		t.Errorf("b1 = %s %v %q, want closed at 4 with no reason", b.Status, b.ClosedAt, b.CloseReason)
	}
}
