package pi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/internal/harness"
	"github.com/terek/merlin/internal/model"
)

// fakePricer prices model "m" at $1/M input, $0.10/M cache read, $10/M output.
type fakePricer struct{}

func (fakePricer) Cost(name string, tok model.Tokens, fast bool) (model.ModelCost, bool) {
	if name != "m" {
		return model.ModelCost{}, false
	}
	return model.ModelCost{Tokens: tok, USD: (float64(tok.Input) + float64(tok.CacheRead)*0.1 + float64(tok.Output)*10) / 1e6}, true
}

var t0 = time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)

func ts(sec int) string { return t0.Add(time.Duration(sec) * time.Second).Format(time.RFC3339Nano) }
func ms(sec int) int64  { return t0.Add(time.Duration(sec) * time.Second).UnixMilli() }

// file builds a session file line by line.
type file struct {
	t     *testing.T
	lines []string
}

func newFile(t *testing.T, id, cwd string, extra map[string]any) *file {
	h := map[string]any{"type": "session", "version": 3, "id": id, "timestamp": ts(0), "cwd": cwd}
	for k, v := range extra {
		h[k] = v
	}
	f := &file{t: t}
	return f.raw(h)
}

func (f *file) raw(v any) *file {
	b, err := json.Marshal(v)
	if err != nil {
		f.t.Fatal(err)
	}
	f.lines = append(f.lines, string(b))
	return f
}

func (f *file) entry(typ, id, parent string, sec int, extra map[string]any) *file {
	e := map[string]any{"type": typ, "id": id, "parentId": nil, "timestamp": ts(sec)}
	if parent != "" {
		e["parentId"] = parent
	}
	for k, v := range extra {
		e[k] = v
	}
	return f.raw(e)
}

func (f *file) msg(id, parent string, sec int, m map[string]any) *file {
	m["timestamp"] = ms(sec)
	return f.entry("message", id, parent, sec+1, map[string]any{"message": m})
}

func (f *file) user(id, parent string, sec int, text string) *file {
	return f.msg(id, parent, sec, map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": text}}})
}

func use(in, out, cr, cw int64, cost float64) map[string]any {
	return map[string]any{"input": in, "output": out, "cacheRead": cr, "cacheWrite": cw, "totalTokens": in + out + cr + cw,
		"cost": map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": cost}}
}

func (f *file) asst(id, parent string, sec int, mdl, text, stop string, u map[string]any, calls ...map[string]any) *file {
	content := []any{}
	if text != "" {
		content = append(content, map[string]any{"type": "text", "text": text})
	}
	for _, c := range calls {
		content = append(content, map[string]any{"type": "toolCall", "id": c["id"], "name": c["name"], "arguments": c["args"]})
	}
	return f.msg(id, parent, sec, map[string]any{"role": "assistant", "content": content, "provider": "acme", "model": mdl,
		"stopReason": stop, "usage": u})
}

func call(id, name string, args map[string]any) map[string]any {
	return map[string]any{"id": id, "name": name, "args": args}
}

func (f *file) result(id, parent string, sec int, callID, tool string, isErr bool, text string, details map[string]any) *file {
	return f.msg(id, parent, sec, map[string]any{"role": "toolResult", "toolCallId": callID, "toolName": tool, "isError": isErr,
		"content": []any{map[string]any{"type": "text", "text": text}}, "details": details})
}

func (f *file) write(dir, name string) string {
	f.t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(strings.Join(f.lines, "\n")+"\n"), 0o644); err != nil {
		f.t.Fatal(err)
	}
	return p
}

func discover(t *testing.T, dir string) (*Harness, harness.Discovery) {
	t.Helper()
	h := New(dir, fakePricer{})
	disc, err := h.Discover()
	if err != nil {
		t.Fatal(err)
	}
	return h, disc
}

func build(t *testing.T, dir, id string) *model.SessionDigest {
	t.Helper()
	h, disc := discover(t, dir)
	for _, s := range disc.Sessions {
		if s.Key.ID == id {
			d, err := h.Build(s)
			if err != nil {
				t.Fatal(err)
			}
			return d
		}
	}
	t.Fatalf("session %s not discovered (%v)", id, disc.Warnings)
	return nil
}

func near(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }

// ---- one session with every entry type ----------------------------------------------------

// r1 model_change (root)
// u1 prompt "Fix the build."
// a1 assistant (tool calls: bash bd close, edit)      cost recorded 0.5
// r2 bash result            r3 edit result (+2 -1)
// a2 assistant final text                              zero cost, tokens: table
// c1 compaction with usage
// u2 prompt                 (on the path)
// a3 assistant, local-ish model unknown                 zero cost, unknown model -> Unpriced
// u3 prompt (sibling of u2, abandoned branch)
// a4 assistant under u3                                 cost 0.25, retained
// ...path continues from a3.
func writeFull(t *testing.T, dir string) {
	f := newFile(t, "sess-1", "/home/dev/acme", nil)
	f.entry("model_change", "r1", "", 1, map[string]any{"provider": "acme", "modelId": "m"})
	f.entry("thinking_level_change", "r0", "r1", 1, map[string]any{"thinkingLevel": "high"})
	f.user("u1", "r0", 2, "Fix the build.")
	f.asst("a1", "u1", 3, "m", "Looking.", "toolUse", use(100, 20, 1000, 300, 0.5),
		call("c1", "bash", map[string]any{"command": "bd close acme-1 --reason done"}),
		call("c2", "edit", map[string]any{"path": "src/main.go"}))
	f.result("r2", "a1", 4, "c1", "bash", false, "✓ Closed issue: acme-1", nil)
	f.result("r3", "r2", 5, "c2", "edit", false, "ok", map[string]any{"diff": "+1 new\n+2 newer\n-1 old\n 3 same\n"})
	f.asst("a2", "r3", 6, "m", "All fixed.", "stop", use(1000, 50, 0, 0, 0))
	f.entry("compaction", "c0", "a2", 7, map[string]any{"summary": "Fixed the build.", "firstKeptEntryId": "u1", "tokensBefore": 5000,
		"details": map[string]any{}, "fromHook": false, "usage": use(2000, 100, 0, 0, 0.01)})
	f.user("u2", "c0", 10, "Now the tests.")
	f.asst("a3", "u2", 11, "mystery", "Done.", "stop", use(500, 10, 0, 0, 0))
	f.user("u3", "c0", 20, "Now something else entirely.")
	f.asst("a4", "u3", 21, "m", "Abandoned work.", "stop", use(10, 10, 0, 0, 0.25))
	f.entry("label", "l1", "a3", 12, map[string]any{"targetId": "a3", "label": "x"})
	f.entry("custom", "x1", "l1", 13, map[string]any{"customType": "ext", "data": map[string]any{}})
	f.entry("custom_message", "x2", "x1", 14, map[string]any{"customType": "ext", "content": "ext text", "display": true})
	f.entry("context_edit", "x3", "x2", 15, map[string]any{"targetId": "a3", "replacement": nil})
	f.entry("session_info", "s1", "x3", 16, map[string]any{"name": "Build session"})
	f.msg("m1", "s1", 17, map[string]any{"role": "bashExecution", "command": "bd update acme-2 --status in_progress", "output": "✓ Updated issue: acme-2", "exitCode": 0})
	f.msg("m2", "m1", 18, map[string]any{"role": "system", "content": "sys"})
	f.msg("m3", "m2", 19, map[string]any{"role": "wizard", "content": "?"})
	f.entry("branch_summary", "b1", "m3", 19, map[string]any{"fromId": "a4", "summary": "bs", "usage": use(30, 5, 0, 0, 0)})
	f.entry("usage", "g1", "b1", 22, map[string]any{"kind": "cache_warm", "provider": "acme", "model": "m", "usage": use(1000, 0, 0, 0, 0)})
	f.entry("hologram", "z1", "g1", 23, nil)
	f.lines = append(f.lines, "{not json")
	f.write(dir, "--home-dev-acme--/2026-10-01T09-00-00-000Z_sess-1.jsonl")
}

func TestFullSession(t *testing.T) {
	dir := t.TempDir()
	writeFull(t, dir)
	d := build(t, dir, "sess-1")

	if d.Harness != "pi" || d.ParserVersion != ParserVersion || d.Project != "/home/dev/acme" || d.Title != "Build session" || d.Kind != model.KindInteractive {
		t.Errorf("header fields: %+v", d)
	}
	if d.ProjectKey != "-home-dev-acme" {
		t.Errorf("project key %q", d.ProjectKey)
	}
	if got := d.Diagnostics; got.BadLines != 1 || got.UnknownTypes["hologram"] != 1 || got.UnknownTypes["message:wizard"] != 1 || len(got.UnknownTypes) != 2 {
		t.Errorf("diagnostics: %+v", got)
	}
	if len(d.Diagnostics.UnpricedModels) != 1 || d.Diagnostics.UnpricedModels[0] != "mystery" {
		t.Errorf("unpriced models %v", d.Diagnostics.UnpricedModels)
	}

	// Turns: u1, u2 and u3 by time. The last line is unparseable, so the leaf is the
	// unknown entry z1, whose chain goes through u2: u3 is the abandoned one.
	if len(d.Turns) != 3 {
		t.Fatalf("turns = %d", len(d.Turns))
	}
	for i, wantAb := range []bool{false, false, true} {
		if d.Turns[i].Abandoned != wantAb {
			t.Errorf("turn %d abandoned = %v", i, d.Turns[i].Abandoned)
		}
	}
	t1 := d.Turns[0]
	if t1.UserText != "Fix the build." || t1.FinalText != "All fixed." || t1.UUID != "u1."+itoa(ms(2)) || t1.ToolCalls != 2 ||
		t1.ToolsByName["bash"] != 1 || t1.ToolsByName["edit"] != 1 {
		t.Errorf("turn 1: %+v", t1)
	}
	if len(t1.FilesTouched) != 1 || t1.FilesTouched[0] != "/home/dev/acme/src/main.go" {
		t.Errorf("files %v", t1.FilesTouched)
	}
	if len(t1.WorkDirs) != 2 {
		t.Errorf("work dirs %v", t1.WorkDirs)
	}
	if d.Stats.LinesAdded != 2 || d.Stats.LinesRemoved != 1 || d.Stats.HumanTurns != 2 || d.Stats.Turns != 3 {
		t.Errorf("stats %+v", d.Stats)
	}
	if d.Turns[1].Epoch != 1 {
		t.Errorf("epoch of the second turn = %d", d.Turns[1].Epoch)
	}

	// Compaction on the path with its recorded call.
	if len(d.Compactions) != 1 {
		t.Fatalf("compactions %+v", d.Compactions)
	}
	c := d.Compactions[0]
	if c.Summary != "Fixed the build." || c.PreTokens != 5000 || c.MessageID == "" || c.Call == nil || c.Call.Cache != model.CacheCold || c.Trigger != "" {
		t.Errorf("compaction %+v call %+v", c, c.Call)
	}

	// Cost: a1 recorded 0.5; a2 zero cost -> table (1000 in, 50 out = 0.0015); compaction
	// recorded 0.01; a3 unknown model -> unpriced; a4 abandoned, recorded 0.25 retained;
	// the branch summary's model is a guess, the nearest assistant above it (a3, unpriced);
	// the usage entry names its model and is priced by the table (1000 in = 0.001).
	byID := map[string]model.Message{}
	for _, m := range d.Messages {
		byID[m.ID] = m
	}
	a1 := byID["a1."+itoa(ms(3))]
	if !a1.Recorded || !near(a1.USD, 0.5) || a1.CacheWrite5m != 300 || a1.CacheWrite1h != 0 || a1.CacheRead != 1000 || a1.Input != 100 {
		t.Errorf("a1 %+v", a1)
	}
	a2 := byID["a2."+itoa(ms(6))]
	if a2.Recorded || a2.Unpriced || !near(a2.USD, 0.0015) {
		t.Errorf("a2 %+v", a2)
	}
	a3 := byID["a3."+itoa(ms(11))]
	if a3.Recorded || !a3.Unpriced || a3.USD != 0 {
		t.Errorf("a3 %+v", a3)
	}
	a4 := byID["a4."+itoa(ms(21))]
	if !a4.Recorded || !near(a4.USD, 0.25) || a4.Turn == nil || *a4.Turn != 2 {
		t.Errorf("a4 %+v", a4)
	}
	if len(d.Messages) != 7 {
		t.Errorf("messages = %d", len(d.Messages))
	}
	want := 0.5 + 0.0015 + 0.01 + 0.25 + 0.001
	if !near(d.Cost.USD, want) || d.Cost.UnpricedMessages != 2 {
		t.Errorf("cost %+v, want %v", d.Cost, want)
	}
	for i := 1; i < len(d.Messages); i++ {
		a, b := d.Messages[i-1], d.Messages[i]
		if b.At.Before(a.At) || (b.At.Equal(a.At) && b.ID < a.ID) {
			t.Errorf("messages out of order at %d", i)
		}
	}

	// Beads from the bash tool call and from the user's own ! command.
	if len(d.Beads) != 2 {
		t.Fatalf("beads %+v", d.Beads)
	}
	if d.Beads[0].Op != model.BeadClose || d.Beads[0].MessageID != "a1."+itoa(ms(3)) || d.Beads[1].Op != model.BeadUpdate {
		t.Errorf("beads %+v", d.Beads)
	}
	if d.EndState != model.EndUnknown && d.EndState != model.EndClean {
		t.Errorf("end state %q", d.EndState)
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

// ---- purity ---------------------------------------------------------------------------------

func TestDigestIsPure(t *testing.T) {
	dir := t.TempDir()
	writeFull(t, dir)
	a, _ := json.Marshal(build(t, dir, "sess-1"))
	b, _ := json.Marshal(build(t, dir, "sess-1"))
	if string(a) != string(b) {
		t.Error("two builds differ")
	}
}

// ---- abandoned turn keeps its spend ---------------------------------------------------------

func TestBranchesAndOrphan(t *testing.T) {
	dir := t.TempDir()
	f := newFile(t, "br", "/home/dev/x", nil)
	f.user("u1", "", 1, "first")
	f.asst("a1", "u1", 2, "m", "one", "stop", use(10, 10, 0, 0, 0.1))
	f.user("u2", "a1", 3, "edited prompt, old branch") // abandoned: u3 replaces it
	f.asst("a2", "u2", 4, "m", "old answer", "aborted", use(10, 10, 0, 0, 0.2))
	f.user("u3", "a1", 5, "edited prompt")
	f.asst("a3", "u3", 6, "m", "new answer", "stop", use(10, 10, 0, 0, 0.3))
	f.user("u9", "gone", 7, "orphan prompt") // missing parent: a root of its own, last in the file -> the leaf
	f.write(dir, "br.jsonl")
	d := build(t, dir, "br")
	if len(d.Turns) != 4 {
		t.Fatalf("turns %d", len(d.Turns))
	}
	// The leaf is u9 (an orphan root), so only it is on the path: every other turn is
	// abandoned. A second file shows the usual case below.
	if !near(d.Cost.USD, 0.6) {
		t.Errorf("all spend counts: %v", d.Cost.USD)
	}

	g := newFile(t, "br2", "/home/dev/x", nil)
	g.user("u1", "", 1, "first")
	g.asst("a1", "u1", 2, "m", "one", "stop", use(10, 10, 0, 0, 0.1))
	g.user("u2", "a1", 3, "old branch")
	g.asst("a2", "u2", 4, "m", "old answer", "aborted", use(10, 10, 0, 0, 0.2))
	g.user("u3", "a1", 5, "edited prompt")
	g.asst("a3", "u3", 6, "m", "new answer", "stop", use(10, 10, 0, 0, 0.3))
	g.write(dir, "br2.jsonl")
	d = build(t, dir, "br2")
	var ab []bool
	for _, tr := range d.Turns {
		ab = append(ab, tr.Abandoned)
	}
	if len(ab) != 3 || ab[0] || !ab[1] || ab[2] {
		t.Errorf("abandoned = %v", ab)
	}
	if !d.Turns[1].Interrupted || d.Turns[1].FinalText != "" || !near(d.Turns[1].Cost.USD, 0.2) || !near(d.Cost.USD, 0.6) {
		t.Errorf("abandoned turn %+v cost %v", d.Turns[1], d.Cost.USD)
	}
	if d.Stats.HumanTurns != 2 || d.Title != "first" {
		t.Errorf("stats %+v title %q", d.Stats, d.Title)
	}
}

// ---- cost rules -------------------------------------------------------------------------------

func TestCostRules(t *testing.T) {
	dir := t.TempDir()
	f := newFile(t, "cost", "/home/dev/x", nil)
	f.user("u1", "", 1, "go")
	f.asst("a1", "u1", 2, "m", "", "stop", use(0, 0, 0, 0, 0))        // no tokens, no cost: not billed
	f.asst("a2", "a1", 3, "m", "", "stop", use(1000000, 0, 0, 0, 0))  // table: $1
	f.asst("a3", "a2", 4, "other", "", "stop", use(1000, 0, 0, 0, 0)) // unknown model
	u := use(100, 100, 0, 700, 0.5)
	u["cacheWrite1h"] = 200
	f.asst("a4", "a3", 5, "m", "", "stop", u) // buckets
	loc := f.asst("a5", "a4", 6, "m", "", "stop", use(1000000, 0, 0, 0, 0))
	_ = loc
	f.lines[len(f.lines)-1] = strings.Replace(f.lines[len(f.lines)-1], `"provider":"acme"`, `"provider":"LlamaBarn"`, 1)
	f.write(dir, "c.jsonl")
	d := build(t, dir, "cost")
	if len(d.Messages) != 4 {
		t.Fatalf("messages %d", len(d.Messages))
	}
	by := map[string]model.Message{}
	for _, m := range d.Messages {
		by[strings.Split(m.ID, ".")[0]] = m
	}
	if !near(by["a2"].USD, 1) || by["a2"].Recorded {
		t.Errorf("a2 %+v", by["a2"])
	}
	if !by["a3"].Unpriced {
		t.Errorf("a3 %+v", by["a3"])
	}
	if !by["a5"].Unpriced || by["a5"].USD != 0 {
		t.Errorf("a local model stays unpriced: %+v", by["a5"])
	}
	a4 := by["a4"]
	if !a4.Recorded || a4.CacheWrite1h != 200 || a4.CacheWrite5m != 500 {
		t.Errorf("a4 %+v", a4)
	}
	if d.Cost.UnpricedMessages != 2 || !near(d.Cost.USD, 1.5) {
		t.Errorf("cost %+v", d.Cost)
	}
}

// ---- ids across sessions, forks, copies -------------------------------------------------------

func TestIdsAndForks(t *testing.T) {
	dir := t.TempDir()
	// two unrelated sessions draw the same 8-hex entry id at different times
	for i, id := range []string{"one", "two"} {
		f := newFile(t, id, "/home/dev/"+id, nil)
		f.user("deadbeef", "", 1+i*100, "hello")
		f.asst("cafebabe", "deadbeef", 2+i*100, "m", "hi", "stop", use(10, 10, 0, 0, 0.1))
		f.write(dir, id+".jsonl")
	}
	a, b := build(t, dir, "one"), build(t, dir, "two")
	if a.Messages[0].ID == b.Messages[0].ID || a.Turns[0].UUID == b.Turns[0].UUID {
		t.Errorf("ids collide: %q %q", a.Messages[0].ID, b.Messages[0].ID)
	}
	// a fork copies entries with ids and timestamps
	fk := newFile(t, "fork", "/home/dev/one", map[string]any{"parentSession": "/home/dev/.pi/agent/sessions/--home-dev-one--/2026-10-01T09-00-00-000Z_one.jsonl"})
	fk.user("deadbeef", "", 1, "hello")
	fk.asst("cafebabe", "deadbeef", 2, "m", "hi", "stop", use(10, 10, 0, 0, 0.1))
	fk.user("11111111", "cafebabe", 50, "new work")
	fk.asst("22222222", "11111111", 51, "m", "ok", "stop", use(10, 10, 0, 0, 0.4))
	fk.write(dir, "fork.jsonl")
	d := build(t, dir, "fork")
	if d.Lineage.ForkedFrom == nil || d.Lineage.ForkedFrom.SessionID != "one" {
		t.Errorf("lineage %+v", d.Lineage)
	}
	if d.Messages[0].ID != a.Messages[0].ID {
		t.Errorf("a copy keeps its message id: %q vs %q", d.Messages[0].ID, a.Messages[0].ID)
	}
}

// ---- discovery ---------------------------------------------------------------------------------

func TestDiscovery(t *testing.T) {
	dir := t.TempDir()
	short := newFile(t, "same", "/home/dev/p", nil)
	short.user("u1", "", 1, "hi")
	short.write(dir, "a/short.jsonl")
	long := newFile(t, "same", "/home/dev/p", nil)
	long.user("u1", "", 1, "hi")
	long.asst("a1", "u1", 2, "m", "hello", "stop", use(1, 1, 0, 0, 0.1))
	longPath := long.write(dir, "b/long.jsonl")
	// a dataset manifest is not a session
	if err := os.WriteFile(filepath.Join(dir, "manifest.jsonl"), []byte(`{"file":"x.jsonl","source_hash":"h","redacted_hash":"h2","redaction_key":"k"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "empty.jsonl"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	newFile(t, "other", "", nil).write(dir, "flat.jsonl") // no cwd: still a session
	h, disc := discover(t, dir)
	if len(disc.Sessions) != 2 {
		t.Fatalf("sessions %+v", disc.Sessions)
	}
	if len(disc.Warnings) != 1 || !strings.Contains(disc.Warnings[0], "keeping the longer") || !strings.Contains(disc.Warnings[0], longPath) {
		t.Errorf("warnings %v", disc.Warnings)
	}
	for _, s := range disc.Sessions {
		if s.Key.ID == "same" && s.Fingerprint[0].Path != longPath {
			t.Errorf("kept %s", s.Fingerprint[0].Path)
		}
		if s.Key.ID == "other" && s.ProjectKey != "-" {
			t.Errorf("project key %q", s.ProjectKey)
		}
	}
	if s, ok, err := h.Locate(harness.SessionRef{ID: "other"}); err != nil || !ok || s.Key.ID != "other" {
		t.Errorf("locate: %+v %v %v", s, ok, err)
	}
	if _, ok, _ := h.Locate(harness.SessionRef{ID: "nope"}); ok {
		t.Error("located a session that is not there")
	}
	// a missing directory is no sessions
	if disc, err := New(filepath.Join(dir, "nope"), fakePricer{}).Discover(); err != nil || len(disc.Sessions) != 0 {
		t.Errorf("missing dir: %+v %v", disc, err)
	}
	if refs, err := h.LiveSessions(); refs != nil || err != nil {
		t.Error("LiveSessions must give no signal")
	}
	if _, ok := h.ParseHook([]byte(`{"hook_event_name":"Stop","session_id":"same"}`)); ok {
		t.Error("ParseHook must decline")
	}
}

// The header cache is keyed by path and size: a file that grows keeps its cached header and a
// file that changes size is read again.
func TestHeaderCache(t *testing.T) {
	dir := t.TempDir()
	p := newFile(t, "c1", "/home/dev/p", nil).write(dir, "c.jsonl")
	var c headerCache
	h, ok, err := c.get(p, 100)
	if err != nil || !ok || h.ID != "c1" {
		t.Fatalf("%+v %v %v", h, ok, err)
	}
	if err := os.WriteFile(p, []byte(`{"type":"session","id":"c2"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if h, _, _ := c.get(p, 100); h.ID != "c1" {
		t.Errorf("same size should be served from the cache, got %q", h.ID)
	}
	if h, _, _ := c.get(p, 99); h.ID != "c2" {
		t.Errorf("a smaller file is read again, got %q", h.ID)
	}
}

// ---- long lines, tolerance ------------------------------------------------------------------

func TestLongLineAndTolerance(t *testing.T) {
	dir := t.TempDir()
	f := newFile(t, "long", "/home/dev/p", nil)
	f.user("u1", "", 1, "run it")
	f.asst("a1", "u1", 2, "m", "", "toolUse", use(10, 10, 0, 0, 0.1), call("c1", "bash", map[string]any{"command": "ls"}))
	f.result("r1", "a1", 3, "c1", "bash", false, strings.Repeat("x", 3<<20), nil) // over 1 MB
	f.asst("a2", "r1", 4, "m", "done", "stop", use(10, 10, 0, 0, 0.1))
	// content as a string, a wrongly typed field, and an unfinished last line
	f.msg("u2", "a2", 5, map[string]any{"role": "user", "content": "plain string prompt"})
	f.lines = append(f.lines, `{"type":"message","id":"e1","parentId":"u2","timestamp":"`+ts(6)+`","message":{"role":"assistant","model":7,"stopReason":false,"usage":{"input":"x","output":3,"cost":{"total":"?"}},"content":5}}`)
	p := f.write(dir, "l.jsonl")
	fh, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	fh.WriteString(`{"type":"message","id":"cut`)
	fh.Close()
	d := build(t, dir, "long")
	if d.Diagnostics.BadLines != 0 {
		t.Errorf("bad lines %d", d.Diagnostics.BadLines)
	}
	if d.Turns[0].FinalText != "done" || d.Turns[1].UserText != "plain string prompt" {
		t.Errorf("turns %+v", d.Turns)
	}
	if len(d.Messages) != 3 { // a1, a2, e1 (3 output tokens)
		t.Errorf("messages %d", len(d.Messages))
	}
}

// ---- support table ---------------------------------------------------------------------------

func TestSupportIsSound(t *testing.T) {
	if p := harness.CheckSupport(Support()); len(p) > 0 {
		t.Errorf("support table: %v", p)
	}
}
