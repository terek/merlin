package catalog

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/fixtures"
	"github.com/terek/merlin/explorer/internal/model"
)

const eps = 1e-9

func near(a, b float64) bool { return math.Abs(a-b) < eps }

func wantNear(t *testing.T, what string, got, want float64) {
	t.Helper()
	if !near(got, want) {
		t.Errorf("%s = %.9f, want %.9f", what, got, want)
	}
}

// goldens reads the golden digests of the 35 fixture sessions.
func goldens(t testing.TB) []*model.SessionDigest {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(fixtures.Root(), "golden", "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no golden digests: %v", err)
	}
	sort.Strings(files)
	var out []*model.SessionDigest
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var d model.SessionDigest
		if err := json.Unmarshal(b, &d); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		out = append(out, &d)
	}
	return out
}

func fixtureCatalog(t testing.TB) *Catalog {
	t.Helper()
	c := New()
	for _, d := range goldens(t) {
		c.Upsert(d)
	}
	return c
}

// sid builds a fixture session key: scenario "13", variant "01".
func sid(scenario, variant string) model.SessionKey {
	return model.SessionKey{Harness: "claude", ID: scenario + scenario + scenario + scenario + "-0000-4000-8000-0000000000" + variant}
}

// setZone points time.Local at a zone for the test.
func setZone(t *testing.T, name string) {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Skipf("no tzdata for %s: %v", name, err)
	}
	old := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = old })
}

var t0 = time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)

func at(min int) time.Time { return t0.Add(time.Duration(min) * time.Minute) }

type msgSpec struct {
	id   string
	min  int
	usd  float64
	turn int
}

// syn builds a small synthetic interactive digest. Turn i has uuid "u<i>" unless the turn
// list is given explicitly through the turns argument.
func syn(harness, id, project string, startMin, lastMin int, turns []model.Turn, msgs ...msgSpec) *model.SessionDigest {
	d := &model.SessionDigest{
		SchemaVersion:  model.SchemaVersion,
		Harness:        harness,
		ID:             id,
		ProjectKey:     "key-" + project,
		Project:        project,
		Cwd:            project,
		Kind:           model.KindInteractive,
		Title:          "session " + id,
		StartedAt:      at(startMin),
		LastActivityAt: at(lastMin),
		Turns:          turns,
	}
	for _, m := range msgs {
		tn := m.turn
		d.Messages = append(d.Messages, model.Message{ID: m.id, At: at(m.min), Model: "sonnet", USD: m.usd, Turn: &tn})
		d.Cost.USD += m.usd
	}
	return d
}

func turn(i int, uuid, prompt string, startMin int) model.Turn {
	return model.Turn{Index: i, UUID: uuid, StartedAt: at(startMin), UserText: prompt, Origin: model.OriginHuman}
}

func key(id string) model.SessionKey { return model.SessionKey{Harness: "claude", ID: id} }

func window(fromMin, toMin int, usd float64) model.ReportedWindow {
	return model.ReportedWindow{From: at(fromMin), To: at(toMin), TotalUSD: usd}
}

func withWindows(d *model.SessionDigest, ws ...model.ReportedWindow) *model.SessionDigest {
	r := &model.Reported{Windows: ws}
	for _, w := range ws {
		r.TotalUSD += w.TotalUSD
	}
	d.Reported = r
	return d
}
