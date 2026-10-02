package claude

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/claude/digest"
	"github.com/terek/merlin/explorer/internal/claude/discover"
	"github.com/terek/merlin/explorer/internal/fixtures"
	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/pricing"
)

// liveSeeds are fixed so a failure of the property test reproduces.
var liveSeeds = []int64{1, 2, 3, 7, 42}

func fixtureSessions(t testing.TB) []discover.Source {
	t.Helper()
	res, err := discover.Scan(filepath.Join(fixtures.ClaudeDir(), "projects"))
	if err != nil || len(res.Warnings) > 0 {
		t.Fatal(err, res.Warnings)
	}
	return res.Sessions
}

// target is the final content of one file of a session under test.
type target struct {
	rel     string // relative to the config directory
	data    []byte
	isJSONL bool
}

// stage returns the files of src with their final content, relative to the fixture config
// directory (which is what discovery paths are made relative to).
func stage(t testing.TB, src discover.Source) []target {
	t.Helper()
	root := fixtures.ClaudeDir()
	var out []target
	for _, f := range src.Fingerprint {
		rel, err := filepath.Rel(root, f.Path)
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(f.Path)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, target{rel: rel, data: data, isJSONL: strings.HasSuffix(rel, ".jsonl")})
	}
	return out
}

func write(t testing.TB, cfg string, rel string, data []byte) {
	t.Helper()
	p := filepath.Join(cfg, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func jsonOf(t testing.TB, d *model.SessionDigest) []byte {
	t.Helper()
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// locate re-lists the session in cfg.
func locate(t testing.TB, h *Harness, id string) harness.Session {
	t.Helper()
	s, found, err := h.Locate(harness.SessionRef{ID: id})
	if err != nil || !found {
		t.Fatalf("locate %s: found=%v err=%v", id, found, err)
	}
	return s
}

// buildBoth builds s with the harness and from scratch and fails if the JSON differs.
func buildBoth(t testing.TB, h *Harness, s harness.Session, what string) *model.SessionDigest {
	t.Helper()
	got, err := h.Build(s)
	if err != nil {
		t.Fatalf("%s: incremental build: %v", what, err)
	}
	want, err := digest.BuildSession(s.Handle.(discover.Source), h.pricer)
	if err != nil {
		t.Fatalf("%s: full build: %v", what, err)
	}
	if g, w := jsonOf(t, got), jsonOf(t, want); !bytes.Equal(g, w) {
		t.Fatalf("%s: incremental digest differs from a full rebuild\n got %s\nwant %s", what, clip(g), clip(w))
	}
	return got
}

func clip(b []byte) string {
	if len(b) > 600 {
		return string(b[:600]) + "..."
	}
	return string(b)
}

func newTestHarness(t testing.TB, cfg string) *Harness {
	t.Helper()
	return New(cfg, pricing.Default())
}

// cutPoints returns n ascending prefix lengths of data ending in len(data); about half
// fall on line boundaries and the rest in the middle of a line.
func cutPoints(rng *rand.Rand, data []byte, n int) []int {
	var nl []int // offsets just after each newline
	for i, c := range data {
		if c == '\n' {
			nl = append(nl, i+1)
		}
	}
	cuts := make([]int, 0, n)
	for i := 0; i < n-1; i++ {
		switch {
		case len(data) == 0:
			cuts = append(cuts, 0)
		case len(nl) > 0 && rng.Intn(2) == 0:
			cuts = append(cuts, nl[rng.Intn(len(nl))])
		default:
			cuts = append(cuts, rng.Intn(len(data)+1))
		}
	}
	cuts = append(cuts, len(data))
	sort.Ints(cuts)
	return cuts
}

// TestIncrementalMatchesFullBuild grows every fixture session from empty to full in random
// steps, builds incrementally after each step, and compares with a from-scratch build of
// the same files each time.
func TestIncrementalMatchesFullBuild(t *testing.T) {
	const steps = 7
	var total IncrementalStats
	defer func() {
		if total.AppendFiles == 0 || total.ReusedFiles == 0 || total.FullFiles == 0 {
			t.Errorf("the property test did not exercise every path: %+v", total)
		}
		t.Logf("followed reads over all fixtures and seeds: %+v", total)
	}()
	for _, src := range fixtureSessions(t) {
		files := stage(t, src)
		for _, seed := range liveSeeds {
			rng := rand.New(rand.NewSource(seed))
			cuts := make([][]int, len(files))
			for i, f := range files {
				cuts[i] = cutPoints(rng, f.data, steps)
			}
			cfg := t.TempDir()
			h := newTestHarness(t, cfg)
			h.Follow(harness.SessionRef{ID: src.ID})
			var last *model.SessionDigest
			written := make([]int, len(files)) // bytes on disk; -1: no file yet
			for i := range written {
				written[i] = -1
			}
			for step := 0; step < steps; step++ {
				for i, f := range files {
					data := f.data
					if f.isJSONL {
						data = f.data[:cuts[i][step]]
						if step == 0 && cuts[i][step] == 0 && i > 0 && rng.Intn(2) == 0 {
							continue // the file does not exist yet
						}
					}
					if len(data) != written[i] { // an untouched file keeps its mtime
						write(t, cfg, f.rel, data)
						written[i] = len(data)
					}
				}
				s, found, err := h.Locate(harness.SessionRef{ID: src.ID})
				if err != nil {
					t.Fatal(err)
				}
				if !found {
					continue
				}
				last = buildBoth(t, h, s, src.ProjectKey+"/"+src.ID)
			}
			if last == nil {
				t.Fatalf("%s: never built", src.ID)
			}
			st := h.IncrementalStats()
			total = IncrementalStats{total.FullFiles + st.FullFiles, total.AppendFiles + st.AppendFiles,
				total.ReusedFiles + st.ReusedFiles, total.BytesRead + st.BytesRead}
			// All files are complete now: the same as the fixture built whole.
			whole, err := digest.BuildSession(src, h.pricer)
			if err != nil {
				t.Fatal(err)
			}
			last.Source, whole.Source = nil, nil
			if !bytes.Equal(jsonOf(t, last), jsonOf(t, whole)) {
				t.Fatalf("%s seed %d: final digest differs from the fixture built whole", src.ID, seed)
			}
		}
	}
}

// oneFile is a session in a temp config with a single main transcript, for the fallback
// tests. Its lines are valid enough for the Builder.
type oneFile struct {
	t    *testing.T
	cfg  string
	h    *Harness
	id   string
	path string
	n    int
}

func newOneFile(t *testing.T) *oneFile {
	cfg := t.TempDir()
	o := &oneFile{t: t, cfg: cfg, h: newTestHarness(t, cfg), id: "aaaaaaaa-0000-4000-8000-000000000001"}
	o.path = filepath.Join(cfg, "projects", "-p", o.id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(o.path), 0o755); err != nil {
		t.Fatal(err)
	}
	o.h.Follow(harness.SessionRef{ID: o.id})
	return o
}

// turn returns the lines of one more prompt and answer; text is padded so that two turns
// with different words have the same length.
func (o *oneFile) turn(word string) string {
	o.n++
	ts := time.Date(2026, 1, 2, 3, 4, o.n, 0, time.UTC).Format("2006-01-02T15:04:05.000Z")
	u := `{"type":"user","uuid":"u` + word + `","parentUuid":null,"timestamp":"` + ts + `","sessionId":"` + o.id +
		`","cwd":"/w","version":"1","message":{"role":"user","content":"prompt ` + word + `"}}` + "\n"
	a := `{"type":"assistant","uuid":"a` + word + `","parentUuid":"u` + word + `","timestamp":"` + ts + `","sessionId":"` + o.id +
		`","message":{"id":"m` + word + `","role":"assistant","model":"claude-sonnet-4-5","stop_reason":"end_turn",` +
		`"content":[{"type":"text","text":"answer ` + word + `"}],"usage":{"input_tokens":3,"output_tokens":4}}}` + "\n"
	return u + a
}

func (o *oneFile) put(content string) {
	if err := os.WriteFile(o.path, []byte(content), 0o644); err != nil {
		o.t.Fatal(err)
	}
}

func (o *oneFile) appendTo(content string) {
	f, err := os.OpenFile(o.path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		o.t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		o.t.Fatal(err)
	}
}

func (o *oneFile) build(what string) *model.SessionDigest {
	return buildBoth(o.t, o.h, locate(o.t, o.h, o.id), what)
}

// delta runs f and returns how the followed builds read files meanwhile.
func (o *oneFile) delta(f func()) IncrementalStats {
	before := o.h.IncrementalStats()
	f()
	after := o.h.IncrementalStats()
	return IncrementalStats{after.FullFiles - before.FullFiles, after.AppendFiles - before.AppendFiles,
		after.ReusedFiles - before.ReusedFiles, after.BytesRead - before.BytesRead}
}

func (o *oneFile) wantReads(what string, got IncrementalStats, full, appended, reused int64) {
	o.t.Helper()
	if got.FullFiles != full || got.AppendFiles != appended || got.ReusedFiles != reused {
		o.t.Fatalf("%s: full/appended/reused = %d/%d/%d, want %d/%d/%d",
			what, got.FullFiles, got.AppendFiles, got.ReusedFiles, full, appended, reused)
	}
}

func TestIncrementalReadsOnlyWhatIsNew(t *testing.T) {
	o := newOneFile(t)
	t1, t2 := o.turn("one"), o.turn("two")
	o.put(t1)
	o.wantReads("first build", o.delta(func() { o.build("first") }), 1, 0, 0)

	o.appendTo(t2)
	st := o.delta(func() { o.build("append") })
	o.wantReads("append", st, 0, 1, 0)
	if st.BytesRead != int64(len(t2)) {
		t.Fatalf("append read %d bytes, want exactly the %d appended", st.BytesRead, len(t2))
	}

	st = o.delta(func() { o.build("unchanged") })
	o.wantReads("unchanged", st, 0, 0, 1)
	if st.BytesRead != 0 {
		t.Fatalf("unchanged file read %d bytes", st.BytesRead)
	}
}

func TestIncrementalPartialLastLine(t *testing.T) {
	o := newOneFile(t)
	t1, t2 := o.turn("one"), o.turn("two")
	o.put(t1)
	o.build("first")

	cut := len(t2) / 3 // inside the first line of the second turn
	o.appendTo(t2[:cut])
	st := o.delta(func() { o.build("partial") })
	o.wantReads("partial", st, 0, 1, 0)
	if st.BytesRead != 0 {
		t.Fatalf("a partial line was consumed: %d bytes", st.BytesRead)
	}
	if off := o.h.inc.states[o.id].files[o.path].offset; off != int64(len(t1)) {
		t.Fatalf("offset = %d, want %d (before the partial line)", off, len(t1))
	}

	o.appendTo(t2[cut:])
	st = o.delta(func() { o.build("completed") })
	o.wantReads("completed", st, 0, 1, 0)
	if st.BytesRead != int64(len(t2)) {
		t.Fatalf("read %d bytes after the line completed, want %d", st.BytesRead, len(t2))
	}
}

func TestIncrementalFallsBackToFullRead(t *testing.T) {
	tests := []struct {
		name string
		// change turns the file from base (already built) into something else.
		change func(o *oneFile, base string)
	}{
		{"guard mismatch", func(o *oneFile, base string) {
			// Same length, a byte changed within the 256 before the old end, and more appended.
			o.put(strings.Replace(base, "answer one", "answer 0ne", 1) + o.turn("two"))
		}},
		{"file shrank", func(o *oneFile, base string) {
			o.put(base[:strings.Index(base, "\n")+1])
		}},
		{"same size, changed mtime", func(o *oneFile, base string) {
			edit := strings.Replace(base, "prompt one", "prompt 0ne", 1)
			if len(edit) != len(base) {
				t.Fatal("test bug: length changed")
			}
			o.put(edit)
			future := time.Now().Add(time.Hour)
			if err := os.Chtimes(o.path, future, future); err != nil {
				t.Fatal(err)
			}
		}},
		{"parser version changed", func(o *oneFile, base string) {
			o.h.parserVersion = 2
			o.appendTo(o.turn("two"))
		}},
	}
	for _, c := range tests {
		t.Run(c.name, func(t *testing.T) {
			o := newOneFile(t)
			o.h.parserVersion = 1
			base := o.turn("one")
			o.put(base)
			o.build("first")
			var st IncrementalStats
			c.change(o, base)
			st = o.delta(func() { o.build("after change") })
			o.wantReads(c.name, st, 1, 0, 0)
			if st.BytesRead == 0 {
				t.Fatal("a full re-read reads bytes")
			}
		})
	}
}

func TestIncrementalNewFileIsReadWhole(t *testing.T) {
	o := newOneFile(t)
	o.put(o.turn("one"))
	o.build("first")
	agent := filepath.Join(o.cfg, "projects", "-p", o.id, "subagents", "agent-a1.jsonl")
	if err := os.MkdirAll(filepath.Dir(agent), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(agent, []byte(o.turn("sub")), 0o644); err != nil {
		t.Fatal(err)
	}
	st := o.delta(func() { o.build("with agent") })
	o.wantReads("new agent file", st, 1, 0, 1) // the agent whole, the main untouched

	// The agent grows: only its tail is read.
	extra := o.turn("sub2")
	f, _ := os.OpenFile(agent, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString(extra)
	f.Close()
	st = o.delta(func() { o.build("agent grew") })
	o.wantReads("agent grew", st, 0, 1, 1)
	if st.BytesRead != int64(len(extra)) {
		t.Fatalf("read %d bytes, want %d", st.BytesRead, len(extra))
	}

	// A vanished agent file is forgotten, not an error for the next build.
	if err := os.Remove(agent); err != nil {
		t.Fatal(err)
	}
	o.build("agent gone")
	if n := len(o.h.inc.states[o.id].files); n != 1 {
		t.Fatalf("%d files kept, want only the main file", n)
	}
}

func TestNotFollowedKeepsNothing(t *testing.T) {
	o := newOneFile(t)
	other := newTestHarness(t, o.cfg) // never told to follow
	o.put(o.turn("one"))
	for range 2 {
		buildBoth(t, other, locate(t, other, o.id), "unfollowed")
	}
	if st := other.IncrementalStats(); st != (IncrementalStats{}) {
		t.Fatalf("unfollowed builds used the cache: %+v", st)
	}
	if len(other.inc.states) != 0 || len(other.inc.tainted) != 0 {
		t.Fatal("unfollowed builds left state")
	}
}

func TestReleaseEvictsAndAsksForRebuildOnlyWhenNeeded(t *testing.T) {
	ref := func(o *oneFile) harness.SessionRef { return harness.SessionRef{ID: o.id} }

	// Only whole reads so far: the stored digest is already a full read.
	o := newOneFile(t)
	o.put(o.turn("one"))
	o.build("first")
	if o.h.Release(ref(o)) {
		t.Fatal("Release asked for a rebuild although every read was whole")
	}
	if len(o.h.inc.states) != 0 || o.h.inc.held != 0 {
		t.Fatal("Release left state behind")
	}

	// An appended read taints the digest until a build from scratch.
	o = newOneFile(t)
	o.put(o.turn("one"))
	o.build("first")
	o.appendTo(o.turn("two"))
	o.build("appended")
	if !o.h.Release(ref(o)) {
		t.Fatal("Release did not ask for a rebuild after an appended read")
	}
	if len(o.h.inc.states) != 0 || o.h.inc.held != 0 {
		t.Fatal("Release left state behind")
	}
	st := o.delta(func() { o.build("rebuild") })
	if st != (IncrementalStats{}) {
		t.Fatalf("the rebuild after Release went through the cache: %+v", st)
	}
	if o.h.Release(ref(o)) {
		t.Fatal("rebuilt from scratch, yet Release still asks for another")
	}
	// Following again starts from nothing.
	o.h.Follow(ref(o))
	o.wantReads("follow again", o.delta(func() { o.build("again") }), 1, 0, 0)
}

// The scenario that motivates the rebuild: a same-length rewrite while the file grows is
// invisible to the incremental path, and the rebuild after Release repairs the digest.
func TestRewriteWhileGrowingIsRepairedByRelease(t *testing.T) {
	o := newOneFile(t)
	base := o.turn("one")
	o.put(base)
	o.build("first")
	// Same-length edit in the first line (outside the guard window) plus an append, in
	// one step: size grew and the guard matches, so the edit goes unseen.
	edit := strings.Replace(base, "prompt one", "prompt 0ne", 1)
	o.put(edit + o.turn("two"))
	incr, err := o.h.Build(locate(t, o.h, o.id))
	if err != nil {
		t.Fatal(err)
	}
	full, err := digest.BuildSession(locate(t, o.h, o.id).Handle.(discover.Source), o.h.pricer)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(jsonOf(t, incr), jsonOf(t, full)) {
		t.Fatal("test bug: the edit should be invisible to the incremental path")
	}
	if !o.h.Release(harness.SessionRef{ID: o.id}) {
		t.Fatal("Release must ask for a rebuild")
	}
	o.build("after release") // buildBoth: equals a full build
}

func TestKeptStateIsCappedAndEvictedLeastRecentlyBuiltFirst(t *testing.T) {
	cfg := t.TempDir()
	h := newTestHarness(t, cfg)
	mk := func(id string) *oneFile {
		o := &oneFile{t: t, cfg: cfg, h: h, id: id}
		o.path = filepath.Join(cfg, "projects", "-p", id+".jsonl")
		os.MkdirAll(filepath.Dir(o.path), 0o755)
		h.Follow(harness.SessionRef{ID: id})
		o.put(o.turn("one"))
		return o
	}
	a, b := mk("aaaaaaaa-0000-4000-8000-00000000000a"), mk("bbbbbbbb-0000-4000-8000-00000000000b")
	size := int64(len(a.turn("one")))
	h.inc.maxHeld = size + size/2 // one session fits, two do not
	a.build("a")
	b.build("b")
	if _, ok := h.inc.states[a.id]; ok {
		t.Fatal("the older session was kept")
	}
	if _, ok := h.inc.states[b.id]; !ok {
		t.Fatal("the newer session was evicted")
	}
	if h.inc.held > h.inc.maxHeld {
		t.Fatalf("held %d over the cap %d", h.inc.held, h.inc.maxHeld)
	}
	// Evicting is safe: the next build of the evicted session is a full one and correct.
	a.wantReads("after eviction", a.delta(func() { a.build("a again") }), 1, 0, 0)

	// A session bigger than the whole cap is never kept.
	h.inc.maxHeld = 10
	a.appendTo(a.turn("two"))
	a.build("a big")
	if len(h.inc.states) != 0 || h.inc.held != 0 {
		t.Fatalf("kept state over the cap: %d sessions, %d bytes", len(h.inc.states), h.inc.held)
	}
}

// Builds of different sessions run in parallel in the engine; Follow and Release come from
// the daemon's goroutine. Run with -race.
func TestIncrementalConcurrentUse(t *testing.T) {
	cfg := t.TempDir()
	root := filepath.Join(fixtures.ClaudeDir(), "projects")
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(fixtures.ClaudeDir(), p)
		data, err := os.ReadFile(p)
		if err == nil {
			write(t, cfg, rel, data)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	h := newTestHarness(t, cfg)
	res, err := discover.Scan(filepath.Join(cfg, "projects"))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]byte{}
	for _, src := range res.Sessions {
		d, err := digest.BuildSession(src, h.pricer)
		if err != nil {
			t.Fatal(err)
		}
		want[src.ID] = jsonOf(t, d)
	}
	h.inc.maxHeld = 20 << 10 // small: evictions happen all the time
	var wg sync.WaitGroup
	for _, src := range res.Sessions {
		s := harness.Session{Key: src.Key(), ProjectKey: src.ProjectKey, Fingerprint: src.Fingerprint, Handle: src}
		wg.Add(2)
		go func() {
			defer wg.Done()
			for range 4 {
				h.Follow(harness.SessionRef{ID: src.ID})
				d, err := h.Build(s)
				if err != nil {
					t.Error(err)
					return
				}
				if !bytes.Equal(jsonOf(t, d), want[src.ID]) {
					t.Errorf("%s: digest differs", src.ID)
				}
			}
		}()
		go func() {
			defer wg.Done()
			for range 4 {
				h.Release(harness.SessionRef{ID: src.ID})
			}
		}()
	}
	wg.Wait()
}
