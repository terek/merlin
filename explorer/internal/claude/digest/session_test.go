package digest

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/terek/merlin/explorer/internal/claude/discover"
	"github.com/terek/merlin/explorer/internal/fixtures"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/pricing"
)

// fixtureDigest builds one fixture session by id.
func fixtureDigest(t testing.TB, id string) *model.SessionDigest {
	t.Helper()
	for _, src := range fixtureSources(t) {
		if src.ID == id {
			return buildFixture(t, src)
		}
	}
	t.Fatalf("no fixture session %s", id)
	return nil
}

func sid(scenario, variant string) string {
	return scenario + scenario + scenario + scenario + "-0000-4000-8000-0000000000" + variant
}

func copyTree(t *testing.T, from, to string) {
	t.Helper()
	err := filepath.WalkDir(from, func(p string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, p)
		if e.IsDir() {
			return os.MkdirAll(filepath.Join(to, rel), 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(to, rel), b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// A digest is a pure function of the session's files: building twice, with the listing in
// another order, or from a copy of the tree at another place gives the same JSON.
func TestBuildSessionIsPure(t *testing.T) {
	root := t.TempDir()
	copyTree(t, filepath.Join(fixtures.ClaudeDir(), "projects"), filepath.Join(root, "projects"))
	copied, err := discover.Scan(filepath.Join(root, "projects"))
	if err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewSource(1))
	srcs := fixtureSources(t)
	if len(copied.Sessions) != len(srcs) {
		t.Fatalf("copied tree has %d sessions, want %d", len(copied.Sessions), len(srcs))
	}
	for i, src := range srcs {
		want, err := json.Marshal(buildFixture(t, src))
		if err != nil {
			t.Fatal(err)
		}
		again, _ := json.Marshal(buildFixture(t, src))
		if !bytes.Equal(want, again) {
			t.Errorf("%s: two builds differ", src.ID)
		}

		shuffled := src
		shuffled.Agents = slices.Clone(src.Agents)
		shuffled.Fingerprint = slices.Clone(src.Fingerprint)
		rng.Shuffle(len(shuffled.Agents), func(a, b int) { shuffled.Agents[a], shuffled.Agents[b] = shuffled.Agents[b], shuffled.Agents[a] })
		rng.Shuffle(len(shuffled.Fingerprint), func(a, b int) {
			shuffled.Fingerprint[a], shuffled.Fingerprint[b] = shuffled.Fingerprint[b], shuffled.Fingerprint[a]
		})
		got, _ := json.Marshal(buildFixture(t, shuffled))
		if !bytes.Equal(want, got) {
			t.Errorf("%s: shuffled listing changes the digest", src.ID)
		}

		// Same files elsewhere: equal once paths are made relative and mtimes dropped.
		other := copied.Sessions[i]
		if other.ID != src.ID {
			t.Fatalf("session order differs: %s vs %s", other.ID, src.ID)
		}
		a := goldenJSON(t, buildFixture(t, src), fixtures.ClaudeDir())
		b := goldenJSON(t, buildFixture(t, other), root)
		if !bytes.Equal(a, b) {
			t.Errorf("%s: digest depends on where the tree is", src.ID)
		}
	}
}

func TestSourceIsTheFingerprint(t *testing.T) {
	for _, src := range fixtureSources(t) {
		d := buildFixture(t, src)
		if !discover.Fingerprint(d.Source).Equal(src.Fingerprint) {
			t.Errorf("%s: source = %v, want %v", src.ID, d.Source, src.Fingerprint)
		}
		if d.ParserVersion != ParserVersion || d.SchemaVersion != model.SchemaVersion || d.Harness != "claude" {
			t.Errorf("%s: versions/harness = %d %d %q", src.ID, d.ParserVersion, d.SchemaVersion, d.Harness)
		}
	}
}

func TestKindOfFixtures(t *testing.T) {
	cases := map[string]model.SessionKind{
		sid("15", "01"):                        model.KindSDK,         // every record sdk-cli
		sid("13", "10"):                        model.KindInteractive, // mixes cli and sdk-cli
		sid("01", "01"):                        model.KindInteractive,
		"12121212-0000-4000-8000-000000000001": model.KindInteractive, // orphan
	}
	for id, want := range cases {
		if got := fixtureDigest(t, id).Kind; got != want {
			t.Errorf("%s: kind = %q, want %q", id, got, want)
		}
	}
}

func TestTitlePrecedenceOnFixtures(t *testing.T) {
	cases := map[string]string{
		"03030303-0000-4000-8000-000000000001": "My logout work",                          // custom beats later ai-title
		"01010101-0000-4000-8000-000000000001": "Add login page",                          // ai-title
		"02020202-0000-4000-8000-000000000001": "list the exported functions in utils.ts", // first prompt
		"12121212-0000-4000-8000-000000000001": "Scan the repo for TODO comments.",        // orphan: first agent prompt
	}
	for id, want := range cases {
		if got := fixtureDigest(t, id).Title; got != want {
			t.Errorf("%s: title = %q, want %q", id, got, want)
		}
	}
}

func TestReportedCostOnFixtures(t *testing.T) {
	d := fixtureDigest(t, "16161616-0000-4000-8000-000000000001")
	r := d.Reported
	if r == nil || len(r.Windows) != 1 {
		t.Fatalf("reported = %+v", r)
	}
	near(t, "reported total", r.TotalUSD, 0.1172)
	near(t, "window total", r.Windows[0].TotalUSD, 0.1172)
	if got := r.Windows[0].From.UTC().Format("2006-01-02T15:04:05Z"); got != "2026-09-16T10:00:00Z" {
		t.Errorf("window from = %s", got)
	}
	for name := range r.ByModel {
		if strings.Contains(name, "[1m]") {
			t.Errorf("model %q not normalised", name)
		}
	}
	near(t, "opus", r.ByModel["claude-opus-5-5"].USD, 0.0516)
	if d.Stats.LinesAdded != 10 || d.Stats.LinesRemoved != 2 {
		t.Errorf("lines = %d/%d", d.Stats.LinesAdded, d.Stats.LinesRemoved)
	}
	if got := fixtureDigest(t, "01010101-0000-4000-8000-000000000001").Reported; got != nil {
		t.Errorf("session without cost-state has reported %+v", got)
	}
}

func TestLineageOnFixtures(t *testing.T) {
	marked := fixtureDigest(t, sid("13", "06")).Lineage
	if marked.ForkedFrom == nil || marked.ForkedFrom.SessionID != sid("13", "05") {
		t.Errorf("13c B lineage = %+v", marked)
	}
	if l := fixtureDigest(t, sid("13", "05")).Lineage; l.ForkedFrom != nil || len(l.InheritedFrom) != 0 {
		t.Errorf("13c A lineage = %+v", l)
	}
	partial := fixtureDigest(t, sid("13", "08")).Lineage
	if !slices.Equal(partial.InheritedFrom, []string{sid("13", "07")}) || partial.ForkedFrom != nil {
		t.Errorf("13d B lineage = %+v", partial)
	}
	// Unmarked copies carry no lineage: the catalog works that out.
	if l := fixtureDigest(t, sid("13", "02")).Lineage; l.ForkedFrom != nil || len(l.InheritedFrom) != 0 {
		t.Errorf("13a B lineage = %+v", l)
	}
}

func TestStatsOnFixtures(t *testing.T) {
	d := fixtureDigest(t, "14141414-0000-4000-8000-000000000001")
	if d.Stats.Turns != 6 || d.Stats.HumanTurns != 4 {
		t.Errorf("rewind stats = %+v", d.Stats)
	}
	d = fixtureDigest(t, "07070707-0000-4000-8000-000000000001")
	if d.Stats.Turns != 3 || d.Stats.HumanTurns != 2 {
		t.Errorf("background stats = %+v", d.Stats)
	}
	d = fixtureDigest(t, "03030303-0000-4000-8000-000000000001")
	if d.Stats.HumanTurns != 4 { // commands count as human turns
		t.Errorf("slash stats = %+v", d.Stats)
	}
}

// --- synthetic sessions ---------------------------------------------------------------

func env(l L, kv ...any) L {
	for i := 0; i+1 < len(kv); i += 2 {
		l[kv[i].(string)] = kv[i+1]
	}
	return l
}

func writeJSONL(t *testing.T, path string, lines ...L) {
	t.Helper()
	var sb strings.Builder
	for _, l := range lines {
		b, err := json.Marshal(l)
		if err != nil {
			t.Fatal(err)
		}
		sb.Write(b)
		sb.WriteByte('\n')
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(sb.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

// buildSynthetic writes one session into a temporary projects tree and builds it.
func buildSynthetic(t *testing.T, lines ...L) *model.SessionDigest {
	t.Helper()
	const id = "99999999-0000-4000-8000-000000000001"
	dir := filepath.Join(t.TempDir(), "projects")
	writeJSONL(t, filepath.Join(dir, "-home-dev-syn", id+".jsonl"), lines...)
	res, err := discover.Scan(dir)
	if err != nil || len(res.Sessions) != 1 {
		t.Fatalf("scan: %v %v", err, res.Sessions)
	}
	d, err := BuildSession(res.Sessions[0], pricing.Default())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func costState(total float64, startMs int64, model string, usd float64, added int64) L {
	return L{"type": "cost-state", "totalCostUSD": total, "startTime": startMs, "totalLinesAdded": added, "totalLinesRemoved": 1,
		"modelUsage": L{model: L{"inputTokens": 10, "outputTokens": 5, "costUSD": usd}}}
}

func TestSessionTitleNameSlugRecaps(t *testing.T) {
	cwd := L{"cwd": "/home/dev/syn", "gitBranch": "main", "version": "2.1.1", "sessionId": "99999999-0000-4000-8000-000000000001"}
	d := buildSynthetic(t,
		env(prompt("p1", "", 0, "first line\nsecond line"), "cwd", cwd["cwd"], "gitBranch", "main", "version", "2.1.1", "slug", "brave-otter"),
		assistant("a1", "p1", 1, "m1", usage(1000, 100), text("done")),
		L{"type": "ai-title", "aiTitle": "Generated one"},
		L{"type": "ai-title", "aiTitle": "Generated two"},
		L{"type": "agent-name", "agentName": "scout"},
		L{"type": "system", "subtype": "away_summary", "content": "recap B", "timestamp": ts(90), "uuid": "r2", "parentUuid": "a1"},
		L{"type": "system", "subtype": "away_summary", "content": "recap A", "timestamp": ts(70), "uuid": "r1", "parentUuid": "a1"},
	)
	if d.Title != "Generated two" {
		t.Errorf("title = %q, want the last ai-title", d.Title)
	}
	if d.Name != "scout" || d.Slug != "brave-otter" {
		t.Errorf("name/slug = %q/%q", d.Name, d.Slug)
	}
	if len(d.Recaps) != 2 || d.Recaps[0].Text != "recap A" || d.Recaps[1].Text != "recap B" {
		t.Errorf("recaps = %+v", d.Recaps)
	}
	if d.Project != "/home/dev/syn" || d.Cwd != d.Project {
		t.Errorf("project/cwd = %q/%q", d.Project, d.Cwd)
	}
	if d.LastActivityAt.Format("15:04:05") != "10:01:30" {
		t.Errorf("lastActivityAt = %v", d.LastActivityAt)
	}

	// Without any title the first line of the first prompt is the title.
	d = buildSynthetic(t,
		prompt("p1", "", 0, "\nfirst line\nsecond line"),
		assistant("a1", "p1", 1, "m1", usage(1000, 100), text("done")),
	)
	if d.Title != "first line" {
		t.Errorf("title = %q", d.Title)
	}
	// A custom title beats an AI title wherever it sits.
	d = buildSynthetic(t,
		prompt("p1", "", 0, "hello"),
		L{"type": "custom-title", "customTitle": "Mine"},
		L{"type": "ai-title", "aiTitle": "Theirs"},
	)
	if d.Title != "Mine" {
		t.Errorf("title = %q", d.Title)
	}
}

func TestKindVariants(t *testing.T) {
	sdk := func(l L) L { return env(l, "entrypoint", "sdk-cli") }
	cli := func(l L) L { return env(l, "entrypoint", "cli") }
	if d := buildSynthetic(t, sdk(prompt("p1", "", 0, "x")), sdk(assistant("a1", "p1", 1, "m1", usage(1, 1), text("y")))); d.Kind != model.KindSDK {
		t.Errorf("all sdk-cli: kind = %q", d.Kind)
	}
	if d := buildSynthetic(t, cli(prompt("p1", "", 0, "x")), sdk(assistant("a1", "p1", 1, "m1", usage(1, 1), text("y")))); d.Kind != model.KindInteractive {
		t.Errorf("mixed: kind = %q", d.Kind)
	}
	bg := env(prompt("p1", "", 0, "x"), "sessionKind", "bg", "entrypoint", "cli")
	if d := buildSynthetic(t, bg); d.Kind != model.KindBackground {
		t.Errorf("bg: kind = %q", d.Kind)
	}
}

func TestEndStateVariants(t *testing.T) {
	end := func(stop string) L {
		l := assistant("a1", "p1", 1, "m1", usage(1, 1), text("y"))
		l["message"].(L)["stop_reason"] = stop
		return l
	}
	check := func(name string, want model.EndState, lines ...L) {
		t.Helper()
		if got := buildSynthetic(t, lines...).EndState; got != want {
			t.Errorf("%s: endState = %q, want %q", name, got, want)
		}
	}
	check("clean", model.EndClean, prompt("p1", "", 0, "x"), end("end_turn"))
	check("mid-turn on prompt", model.EndMidTurn, prompt("p1", "", 0, "x"))
	check("mid-turn on tool_use", model.EndMidTurn, prompt("p1", "", 0, "x"),
		assistant("a1", "p1", 1, "m1", usage(1, 1), tool("t1", "Bash", L{})))
	check("interrupted", model.EndInterrupted, prompt("p1", "", 0, "x"), end("end_turn"),
		prompt("p2", "a1", 3, "[Request interrupted by user]"))
}

func TestReportedWindowsSynthetic(t *testing.T) {
	const t1, t2 = int64(1790000000000), int64(1790003600000) // two process runs an hour apart
	d := buildSynthetic(t,
		prompt("p1", "", 0, "x"),
		assistant("a1", "p1", 10, "m1", usage(1000, 100), text("y")),
		costState(1.0, t1, "claude-opus-5-5[1m]", 1.0, 5),
		assistant("a2", "a1", 20, "m2", usage(1000, 100), text("y")),
		costState(2.0, t1, "claude-opus-5-5[1m]", 2.0, 8), // same run: replaces the first
		prompt("p2", "a2", 30, "again"),
		costState(0.5, t2, "claude-opus-5-5", 0.5, 3), // a later run, listed after
		assistant("a3", "p2", 40, "m3", usage(1000, 100), text("y")),
		costState(0.2, t2, "claude-opus-5-5", 0.2, 1), // total fell with the same start: a new window
	)
	r := d.Reported
	if r == nil || len(r.Windows) != 3 {
		t.Fatalf("windows = %+v", r)
	}
	w := r.Windows
	near(t, "w0", w[0].TotalUSD, 2.0)
	near(t, "w1", w[1].TotalUSD, 0.5)
	near(t, "w2", w[2].TotalUSD, 0.2)
	if w[0].From.Unix() != t1/1000 || w[1].From.Unix() != t2/1000 || w[2].From.Unix() != t2/1000 {
		t.Errorf("froms = %v %v %v", w[0].From, w[1].From, w[2].From)
	}
	// To = the latest record before the window's last cost-state.
	if got := w[0].To.Format("15:04:05"); got != "10:00:20" {
		t.Errorf("w0.to = %s", got)
	}
	if got := w[1].To.Format("15:04:05"); got != "10:00:30" {
		t.Errorf("w1.to = %s", got)
	}
	if got := w[2].To.Format("15:04:05"); got != "10:00:40" {
		t.Errorf("w2.to = %s", got)
	}
	near(t, "total", r.TotalUSD, 2.7)
	near(t, "opus", r.ByModel["claude-opus-5-5"].USD, 2.7)
	if len(r.ByModel) != 1 {
		t.Errorf("byModel = %v", r.ByModel)
	}
	if d.Stats.LinesAdded != 8+3+1 || d.Stats.LinesRemoved != 3 {
		t.Errorf("lines = %d/%d", d.Stats.LinesAdded, d.Stats.LinesRemoved)
	}
}
