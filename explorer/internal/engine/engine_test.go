package engine_test

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/claude"
	"github.com/terek/merlin/explorer/internal/engine"
	"github.com/terek/merlin/explorer/internal/fixtures"
	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/pricing"
	"github.com/terek/merlin/explorer/internal/store"
)

const (
	plainID   = "01010101-0000-4000-8000-000000000001"
	plainProj = "-home-dev-acme-plain"
	fixtureN  = 35
)

// copyClaude copies the fixture tree into a temp dir and returns it as a config dir.
func copyClaude(t *testing.T) string {
	t.Helper()
	src := fixtures.ClaudeDir()
	dst := t.TempDir()
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, rel), b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

// wrapped lets a test change the Claude harness's behaviour.
type wrapped struct {
	*claude.Harness
	parser  int
	builds  atomic.Int64
	buildFn func(s harness.Session) error // nil: succeed; may panic
}

func (w *wrapped) ParserVersion() int {
	if w.parser != 0 {
		return w.parser
	}
	return w.Harness.ParserVersion()
}

func (w *wrapped) Build(s harness.Session) (*model.SessionDigest, error) {
	w.builds.Add(1)
	if w.buildFn != nil {
		if err := w.buildFn(s); err != nil {
			return nil, err
		}
	}
	d, err := w.Harness.Build(s)
	if d != nil {
		d.ParserVersion = w.ParserVersion()
	}
	return d, err
}

type rig struct {
	t      *testing.T
	home   string
	cfg    string
	st     *store.Store
	h      *wrapped
	events []engine.Event
	mu     sync.Mutex
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{t: t, home: t.TempDir(), cfg: copyClaude(t)}
	t.Setenv("MERLIN_HOME", r.home)
	t.Setenv("CLAUDE_CONFIG_DIR", r.cfg)
	st, err := store.New(r.home)
	if err != nil {
		t.Fatal(err)
	}
	r.st = st
	pr, err := pricing.Load("")
	if err != nil {
		t.Fatal(err)
	}
	r.h = &wrapped{Harness: claude.New(r.cfg, pr)}
	return r
}

func (r *rig) scan() engine.Summary {
	r.t.Helper()
	e, err := engine.New(engine.Options{
		Store: r.st, Harnesses: []harness.Harness{r.h}, Workers: 4,
		Logf: func(f string, a ...any) { r.t.Logf(f, a...) },
		OnWrite: func(ev engine.Event) {
			r.mu.Lock()
			r.events = append(r.events, ev)
			r.mu.Unlock()
		},
	})
	if err != nil {
		r.t.Fatal(err)
	}
	sum, err := e.Scan(context.Background())
	if err != nil {
		r.t.Fatal(err)
	}
	return sum
}

func (r *rig) plainPath() string {
	return filepath.Join(r.cfg, "projects", plainProj, plainID+".jsonl")
}

func (r *rig) plainRef() store.Ref {
	return store.Ref{Harness: "claude", ProjectKey: plainProj, SessionID: plainID}
}

func (r *rig) take() []engine.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	ev := r.events
	r.events = nil
	return ev
}

func TestFirstScanThenNothing(t *testing.T) {
	r := newRig(t)
	sum := r.scan()
	if sum.Seen != fixtureN || sum.Processed != fixtureN || sum.Failed != 0 || sum.Unchanged != 0 {
		t.Fatalf("first scan: %+v", sum)
	}
	refs, err := r.st.List("claude")
	if err != nil || len(refs) != fixtureN {
		t.Fatalf("stored %d digests (%v), want %d", len(refs), err, fixtureN)
	}
	if ev := r.take(); len(ev) != fixtureN || ev[0].Kind != engine.Written || ev[0].Digest == nil {
		t.Fatalf("events after first scan: %d", len(ev))
	}
	before := r.h.builds.Load()
	sum = r.scan()
	if sum.Processed != 0 || sum.Unchanged != fixtureN || sum.Seen != fixtureN {
		t.Fatalf("second scan: %+v", sum)
	}
	if r.h.builds.Load() != before || len(r.take()) != 0 {
		t.Fatal("second scan built something")
	}
}

func TestAppendReprocessesOnlyThatSession(t *testing.T) {
	r := newRig(t)
	r.scan()
	f, err := os.OpenFile(r.plainPath(), os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString("\n")
	f.Close()
	r.take()
	sum := r.scan()
	if sum.Processed != 1 || sum.Unchanged != fixtureN-1 {
		t.Fatalf("scan: %+v", sum)
	}
	if ev := r.take(); len(ev) != 1 || ev[0].Ref != r.plainRef() {
		t.Fatalf("events: %+v", ev)
	}
}

func TestDeletedSourceMarkedOnceAndKept(t *testing.T) {
	r := newRig(t)
	r.scan()
	r.take()
	orig, _, _ := r.st.Read(r.plainRef())
	if err := os.Remove(r.plainPath()); err != nil {
		t.Fatal(err)
	}
	sum := r.scan()
	if sum.Seen != fixtureN-1 || sum.Missing != 1 || sum.NewMissing != 1 || sum.Processed != 0 {
		t.Fatalf("scan: %+v", sum)
	}
	d, found, _ := r.st.Read(r.plainRef())
	if !found || !d.SourceMissing || len(d.Turns) != len(orig.Turns) || d.Title != orig.Title {
		t.Fatalf("digest not kept intact: found=%v %+v", found, d)
	}
	if ev := r.take(); len(ev) != 1 || ev[0].Kind != engine.SourceMissing || ev[0].Digest == nil {
		t.Fatalf("events: %+v", ev)
	}
	p, _ := r.st.Path(r.plainRef())
	fi1, _ := os.Stat(p)
	sum = r.scan() // marked once: no second rewrite
	fi2, _ := os.Stat(p)
	if sum.Missing != 1 || sum.NewMissing != 0 || !fi1.ModTime().Equal(fi2.ModTime()) || len(r.take()) != 0 {
		t.Fatalf("second scan: %+v", sum)
	}

	// The file comes back: the digest is rebuilt and the mark cleared.
	if err := os.WriteFile(r.plainPath(), []byte(`{"type":"user","uuid":"u","message":{"role":"user","content":"hi"}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sum = r.scan()
	d, _, _ = r.st.Read(r.plainRef())
	if sum.Processed != 1 || d.SourceMissing {
		t.Fatalf("after restore: %+v missing=%v", sum, d.SourceMissing)
	}
}

func TestParserVersionBumpReprocessesAll(t *testing.T) {
	r := newRig(t)
	r.scan()
	r.h.parser = r.h.Harness.ParserVersion() + 1
	sum := r.scan()
	if sum.Processed != fixtureN {
		t.Fatalf("scan: %+v", sum)
	}
	if sum = r.scan(); sum.Processed != 0 {
		t.Fatalf("after bump: %+v", sum)
	}
}

func TestFailureYieldsStubAndIsNotRetried(t *testing.T) {
	r := newRig(t)
	const panicID = "02020202-0000-4000-8000-000000000001"
	r.h.buildFn = func(s harness.Session) error {
		switch s.Key.ID {
		case plainID:
			return errors.New("boom")
		case panicID:
			panic("kaboom")
		}
		return nil
	}
	sum := r.scan()
	if sum.Failed != 2 || sum.Processed != fixtureN-2 {
		t.Fatalf("scan: %+v", sum)
	}
	d, found, _ := r.st.Read(r.plainRef())
	if !found || !strings.Contains(d.Error, "boom") || len(d.Source) == 0 {
		t.Fatalf("stub: found=%v %+v", found, d)
	}
	var kinds int
	for _, ev := range r.take() {
		if ev.Kind == engine.Failed {
			kinds++
		}
	}
	if kinds != 2 {
		t.Fatalf("failed events: %d", kinds)
	}
	pd, _, _ := r.st.Read(store.Ref{Harness: "claude", ProjectKey: "-home-dev-acme-multi-line", SessionID: panicID})
	if pd == nil || !strings.Contains(pd.Error, "kaboom") {
		t.Fatalf("panic stub: %+v", pd)
	}

	before := r.h.builds.Load()
	sum = r.scan()
	if sum.Failed != 0 || sum.Processed != 0 || sum.Unchanged != fixtureN || r.h.builds.Load() != before {
		t.Fatalf("retry loop: %+v", sum)
	}

	// Changing the file makes it eligible again; the builder now succeeds.
	r.h.buildFn = nil
	f, _ := os.OpenFile(r.plainPath(), os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("\n")
	f.Close()
	sum = r.scan()
	d, _, _ = r.st.Read(r.plainRef())
	if sum.Processed != 1 || d.Error != "" {
		t.Fatalf("after change: %+v err=%q", sum, d.Error)
	}
}

func TestCrashConverges(t *testing.T) {
	r := newRig(t)
	r.scan()
	refs, _ := r.st.List("claude")

	// Some digests lost, one half-written (garbage), and temp files left behind.
	for _, ref := range refs[:3] {
		p, _ := r.st.Path(ref)
		os.Remove(p)
	}
	p, _ := r.st.Path(refs[5])
	os.WriteFile(p, []byte(`{"schemaVersion":1,"parserVers`), 0o644)
	os.WriteFile(filepath.Join(filepath.Dir(p), ".x.json.123.tmp"), []byte("{"), 0o644)

	sum := r.scan()
	if sum.Processed != 4 {
		t.Fatalf("scan: %+v", sum)
	}
	for _, ref := range refs {
		if _, found, _ := r.st.Read(ref); !found {
			t.Errorf("%s missing after scan", ref)
		}
	}
	r.scan()
	if sum = r.scan(); sum.Processed != 0 {
		t.Fatalf("not converged: %+v", sum)
	}
	for _, ref := range refs {
		if d, found, _ := r.st.Read(ref); !found || d.Error != "" {
			t.Errorf("%s: not whole after convergence", ref)
		}
	}
}

// brokenHarness fails to discover.
type brokenHarness struct{ *wrapped }

func (brokenHarness) Discover() (harness.Discovery, error) {
	return harness.Discovery{}, errors.New("disk gone")
}

func TestDiscoverFailureLeavesDigestsAlone(t *testing.T) {
	r := newRig(t)
	r.scan()
	e, _ := engine.New(engine.Options{Store: r.st, Harnesses: []harness.Harness{brokenHarness{r.h}}})
	sum, err := e.Scan(context.Background())
	if err == nil || sum.Missing != 0 {
		t.Fatalf("err=%v sum=%+v", err, sum)
	}
	if d, _, _ := r.st.Read(r.plainRef()); d == nil || d.SourceMissing {
		t.Fatal("digest touched after failed discovery")
	}
}

func TestDuplicateSessionIDKeepsOneWithMain(t *testing.T) {
	r := newRig(t)
	proj := filepath.Join(r.cfg, "projects")
	// Same id in a project that sorts first, but without a main transcript.
	dup := filepath.Join(proj, "-a-dup", plainID, "subagents")
	os.MkdirAll(dup, 0o755)
	os.WriteFile(filepath.Join(dup, "agent-aaa.jsonl"), []byte("{}\n"), 0o644)
	disc, err := r.h.Discover()
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, s := range disc.Sessions {
		if s.Key.ID == plainID {
			n++
			if s.ProjectKey != plainProj {
				t.Errorf("kept %s, want the one with a main transcript", s.ProjectKey)
			}
		}
	}
	if n != 1 || len(disc.Sessions) != fixtureN || len(disc.Warnings) != 1 {
		t.Fatalf("n=%d sessions=%d warnings=%v", n, len(disc.Sessions), disc.Warnings)
	}
}

// fake is a second harness with in-memory "sessions".
type fake struct {
	mu       sync.Mutex
	sessions map[string]int64 // id -> size
	builds   int
}

func (f *fake) Name() string       { return "fakeagent" }
func (f *fake) ParserVersion() int { return 7 }
func (f *fake) Discover() (harness.Discovery, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var d harness.Discovery
	for id, size := range f.sessions {
		d.Sessions = append(d.Sessions, harness.Session{
			Key: model.SessionKey{Harness: "fakeagent", ID: id}, ProjectKey: "proj",
			Fingerprint: []model.SourceFile{{Path: "/virtual/" + id, Size: size, MtimeNs: 1}},
			Handle:      size,
		})
	}
	return d, nil
}
func (f *fake) Build(s harness.Session) (*model.SessionDigest, error) {
	f.mu.Lock()
	f.builds++
	f.mu.Unlock()
	return &model.SessionDigest{
		SchemaVersion: model.SchemaVersion, ParserVersion: 7, Source: s.Fingerprint,
		Harness: "fakeagent", ID: s.Key.ID, ProjectKey: s.ProjectKey, Title: "fake",
	}, nil
}

func TestSecondHarness(t *testing.T) {
	home := t.TempDir()
	st, _ := store.New(home)
	f := &fake{sessions: map[string]int64{"s1": 10, "s2": 20}}
	r := newRig(t) // a Claude harness alongside, to show they coexist
	e, _ := engine.New(engine.Options{Store: st, Harnesses: []harness.Harness{f, r.h}, Workers: 2})
	sum, err := e.Scan(context.Background())
	if err != nil || sum.Processed != fixtureN+2 {
		t.Fatalf("sum=%+v err=%v", sum, err)
	}
	for _, id := range []string{"s1", "s2"} {
		if _, err := os.Stat(filepath.Join(home, "fakeagent", "projects", "proj", "sessions", id+".json")); err != nil {
			t.Error(err)
		}
	}
	if sum, _ = e.Scan(context.Background()); sum.Processed != 0 {
		t.Fatalf("rescan: %+v", sum)
	}
	f.mu.Lock()
	f.sessions["s1"] = 11
	delete(f.sessions, "s2")
	f.mu.Unlock()
	sum, _ = e.Scan(context.Background())
	if sum.Processed != 1 || sum.Missing != 1 {
		t.Fatalf("after change: %+v", sum)
	}
	if d, _, _ := st.Read(store.Ref{Harness: "fakeagent", ProjectKey: "proj", SessionID: "s2"}); d == nil || !d.SourceMissing {
		t.Fatal("s2 not marked missing")
	}
}

func TestEngineDoesNotImportClaudeInternals(t *testing.T) {
	for _, pkg := range []string{"./internal/engine", "./internal/harness"} {
		out, err := exec.Command("go", "list", "-deps", pkg).CombinedOutput()
		if err != nil {
			t.Skipf("go list unavailable: %v: %s", err, out)
		}
		for _, dep := range strings.Fields(string(out)) {
			if strings.Contains(dep, "explorer/internal/claude") {
				t.Errorf("%s depends on %s", pkg, dep)
			}
		}
	}
}

func TestConcurrentEnqueueNeverParallelPerSession(t *testing.T) {
	var inflight, maxIn sync.Map // id -> *atomic.Int32
	var builds atomic.Int64
	slow := &slowHarness{inflight: &inflight, maxIn: &maxIn, builds: &builds}
	st, _ := store.New(t.TempDir())
	e, _ := engine.New(engine.Options{Store: st, Harnesses: []harness.Harness{slow}, Workers: 8})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.Run(ctx); close(done) }()

	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				for _, id := range []string{"a", "b", "c"} {
					s := harness.Session{Key: model.SessionKey{Harness: "slow", ID: id}, ProjectKey: "p",
						Fingerprint: []model.SourceFile{{Path: id, Size: int64(g*100 + i)}}}
					e.Enqueue(slow, s, i%7 == 0)
				}
			}
		}()
	}
	wg.Wait()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok, _ := st.ReadHeader(store.Ref{Harness: "slow", ProjectKey: "p", SessionID: "a"}); ok {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
	cancel()
	<-done
	for _, id := range []string{"a", "b", "c"} {
		v, _ := maxIn.Load(id)
		if m := v.(*atomic.Int32).Load(); m != 1 {
			t.Errorf("%s: max concurrent builds %d", id, m)
		}
	}
	if b := builds.Load(); b < 3 || b > 16*50*3 {
		t.Errorf("builds = %d", b)
	}
	t.Logf("%d builds for %d enqueues", builds.Load(), 16*50*3)
}

type slowHarness struct {
	inflight, maxIn *sync.Map
	builds          *atomic.Int64
}

func (*slowHarness) Name() string                         { return "slow" }
func (*slowHarness) ParserVersion() int                   { return 1 }
func (*slowHarness) Discover() (harness.Discovery, error) { return harness.Discovery{}, nil }
func (s *slowHarness) Build(sess harness.Session) (*model.SessionDigest, error) {
	cur, _ := s.inflight.LoadOrStore(sess.Key.ID, new(atomic.Int32))
	mx, _ := s.maxIn.LoadOrStore(sess.Key.ID, new(atomic.Int32))
	n := cur.(*atomic.Int32).Add(1)
	for {
		m := mx.(*atomic.Int32).Load()
		if n <= m || mx.(*atomic.Int32).CompareAndSwap(m, n) {
			break
		}
	}
	time.Sleep(2 * time.Millisecond)
	s.builds.Add(1)
	cur.(*atomic.Int32).Add(-1)
	return &model.SessionDigest{SchemaVersion: model.SchemaVersion, ParserVersion: 1,
		Source: sess.Fingerprint, Harness: "slow", ID: sess.Key.ID, ProjectKey: sess.ProjectKey}, nil
}
