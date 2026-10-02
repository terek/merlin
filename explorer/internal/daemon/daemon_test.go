package daemon_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/claude"
	"github.com/terek/merlin/explorer/internal/claude/digest"
	"github.com/terek/merlin/explorer/internal/claude/discover"
	"github.com/terek/merlin/explorer/internal/daemon"
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
	forever   = time.Hour // an interval that never fires within a test
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

// counting counts Build calls.
type counting struct {
	*claude.Harness
	builds atomic.Int64
}

func (c *counting) Build(s harness.Session) (*model.SessionDigest, error) {
	c.builds.Add(1)
	return c.Harness.Build(s)
}

type rig struct {
	t      *testing.T
	d      *daemon.Daemon
	h      *counting
	home   string
	cfg    string
	st     *store.Store
	cancel context.CancelFunc
	done   chan error
	log    *bytes.Buffer
}

func (r *rig) main() string { return filepath.Join(r.cfg, "projects", plainProj, plainID+".jsonl") }
func (r *rig) ref() store.Ref {
	return store.Ref{Harness: "claude", ProjectKey: plainProj, SessionID: plainID}
}

// fastOpts are intervals so long that only the thing under test can fire.
func fastOpts(o *daemon.Options) {
	o.RescanInterval, o.PollInterval, o.Debounce = forever, forever, forever
	o.ShutdownTimeout = 10 * time.Second
}

// newRig prepares a daemon over a copy of the fixtures but does not start it.
func newRig(t *testing.T, home, cfg string, tune func(*daemon.Options)) *rig {
	t.Helper()
	if home == "" {
		home = t.TempDir()
	}
	if cfg == "" {
		cfg = copyClaude(t)
	}
	pricer, err := pricing.Load("")
	if err != nil {
		t.Fatal(err)
	}
	h := &counting{Harness: claude.New(cfg, pricer)}
	r := &rig{t: t, h: h, home: home, cfg: cfg, log: &bytes.Buffer{}, done: make(chan error, 1)}
	opts := daemon.Options{Home: home, Harnesses: []harness.Harness{h}, Stderr: io.Discard, Version: "test"}
	fastOpts(&opts)
	if tune != nil {
		tune(&opts)
	}
	r.d, err = daemon.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	r.st, _ = store.New(home)
	return r
}

func (r *rig) start() {
	r.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	go func() { r.done <- r.d.Run(ctx) }()
	select {
	case <-r.d.Ready():
	case err := <-r.done:
		r.t.Fatalf("daemon did not start: %v", err)
	case <-time.After(10 * time.Second):
		r.t.Fatal("daemon not ready")
	}
	r.t.Cleanup(func() { r.stop() })
}

func (r *rig) stop() error {
	if r.cancel == nil {
		return nil
	}
	r.cancel()
	r.cancel = nil
	select {
	case err := <-r.done:
		return err
	case <-time.After(15 * time.Second):
		r.t.Fatal("daemon did not stop")
		return nil
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// storedSize is the size of the main transcript as the stored digest saw it (-1: none).
func (r *rig) storedSize() int64 {
	hdr, ok, _ := r.st.ReadHeader(r.ref())
	if !ok {
		return -1
	}
	for _, f := range hdr.Source {
		if f.Path == r.main() {
			return f.Size
		}
	}
	return -1
}

func (r *rig) indexed() bool { return r.d.Catalog().Len() >= fixtureN && r.d.Engine().Pending() == 0 }

// appendLine adds one complete line to the plain session and returns the new size.
func (r *rig) appendLine(n int) int64 {
	r.t.Helper()
	f, err := os.OpenFile(r.main(), os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		r.t.Fatal(err)
	}
	defer f.Close()
	if _, err := fmt.Fprintf(f, `{"type":"x-test-line","n":%d}`+"\n", n); err != nil {
		r.t.Fatal(err)
	}
	fi, _ := f.Stat()
	return fi.Size()
}

func (r *rig) hook(body string) int {
	r.t.Helper()
	resp, err := http.Post("http://"+r.d.Addr()+"/hook", "application/json", strings.NewReader(body))
	if err != nil {
		r.t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func (r *rig) stopHook() string {
	return fmt.Sprintf(`{"session_id":%q,"transcript_path":%q,"hook_event_name":"Stop"}`, plainID, r.main())
}

func TestStartIndexesFixtures(t *testing.T) {
	r := newRig(t, "", "", func(o *daemon.Options) { o.RescanInterval = 20 * time.Millisecond })
	r.start()
	eventually(t, "initial index", r.indexed)
	if _, ok, _ := r.st.Read(r.ref()); !ok {
		t.Fatal("plain digest not stored")
	}
	if _, ok := r.d.Catalog().Digest(model.SessionKey{Harness: "claude", ID: plainID}); !ok {
		t.Fatal("catalog does not hold plain")
	}
	// A rescan of an unchanged tree builds nothing.
	n := r.h.builds.Load()
	h0 := r.d.Health().Rescans
	eventually(t, "more rescans", func() bool { return r.d.Health().Rescans >= h0+3 })
	if got := r.h.builds.Load(); got != n {
		t.Errorf("idle rescans built %d sessions", got-n)
	}

	resp, err := http.Get("http://" + r.d.Addr() + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var h daemon.Health
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		t.Fatal(err)
	}
	if !h.OK || h.Version != "test" || h.Sessions < fixtureN || h.QueueDepth != 0 || h.Rescans < 1 {
		t.Errorf("healthz = %+v", h)
	}
	if !strings.HasPrefix(r.d.Addr(), "127.0.0.1:") {
		t.Errorf("addr = %s", r.d.Addr())
	}
}

func TestAppendUpdatesWithoutHook(t *testing.T) {
	r := newRig(t, "", "", func(o *daemon.Options) {
		o.PollInterval, o.Debounce = 10*time.Millisecond, 30*time.Millisecond
	})
	r.start()
	eventually(t, "initial index", r.indexed)
	sub, unsub := r.d.Events().Subscribe(64)
	defer unsub()

	want := r.appendLine(1)
	eventually(t, "digest follows the append", func() bool { return r.storedSize() == want })
	d, _ := r.d.Catalog().Digest(model.SessionKey{Harness: "claude", ID: plainID})
	if d == nil || d.Source[0].Size != want && r.storedSize() != want {
		t.Errorf("catalog digest not updated")
	}
	var saw bool
	for len(sub) > 0 {
		if ev := <-sub; ev.Kind == engine.Written && ev.Ref == r.ref() {
			saw = true
		}
	}
	if !saw {
		t.Error("no Written event on the bus")
	}
}

func TestStopHookIsImmediate(t *testing.T) {
	// Poll, debounce and rescan never fire: only the hook can do the work.
	r := newRig(t, "", "", nil)
	r.start()
	eventually(t, "initial index", r.indexed)

	want := r.appendLine(1)
	time.Sleep(50 * time.Millisecond)
	if r.storedSize() == want {
		t.Fatal("digest updated without any trigger")
	}
	if code := r.hook(r.stopHook()); code/100 != 2 {
		t.Fatalf("hook status %d", code)
	}
	eventually(t, "digest follows Stop", func() bool { return r.storedSize() == want })

	// The entry now exists and was just enqueued; a second Stop still bypasses the debounce.
	want = r.appendLine(2)
	r.hook(r.stopHook())
	eventually(t, "second Stop", func() bool { return r.storedSize() == want })
}

func TestSubagentStopWithSessionIDOnly(t *testing.T) {
	r := newRig(t, "", "", nil)
	r.start()
	eventually(t, "initial index", r.indexed)
	want := r.appendLine(1)
	r.hook(fmt.Sprintf(`{"session_id":%q,"hook_event_name":"SubagentStop","agent_id":"a1"}`, plainID))
	// SubagentStop is not a rest point of the session: it is only checked, and the
	// check enqueues because the files differ from the digest's.
	eventually(t, "digest follows SubagentStop", func() bool { return r.storedSize() == want })
}

func TestHookAlwaysAnswers(t *testing.T) {
	r := newRig(t, "", "", nil)
	r.start()
	for _, body := range []string{
		``, `not json`, `{}`, `[]`, `null`, `{"hook_event_name":"Stop"}`,
		`{"hook_event_name":"Mystery","session_id":"nope"}`,
		`{"session_id":"../../etc","hook_event_name":"Stop"}`,
		`{"session_id":"does-not-exist","hook_event_name":"SessionStart","transcript_path":"/elsewhere/x.jsonl"}`,
		strings.Repeat("x", 3<<20),
	} {
		if code := r.hook(body); code != http.StatusAccepted {
			t.Errorf("body %.30q: status %d", body, code)
		}
	}
	resp, err := http.Get("http://" + r.d.Addr() + "/hook")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET /hook = %d", resp.StatusCode)
	}
	eventually(t, "initial index", r.indexed)
	// Garbage did not break the loop: a real hook still works.
	want := r.appendLine(1)
	r.hook(r.stopHook())
	eventually(t, "digest follows Stop", func() bool { return r.storedSize() == want })
}

func TestHookRefusesNonLoopback(t *testing.T) {
	d, err := daemon.New(daemon.Options{Home: t.TempDir(), Harnesses: []harness.Harness{claude.New(t.TempDir(), nil)}, Stderr: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	for remote, want := range map[string]int{
		"10.0.0.7:5000":   http.StatusForbidden,
		"[2001:db8::1]:1": http.StatusForbidden,
		"127.0.0.1:5000":  http.StatusAccepted,
		"[::1]:5000":      http.StatusAccepted,
	} {
		req := httptest.NewRequest(http.MethodPost, "/hook", strings.NewReader("{}"))
		req.RemoteAddr = remote
		rec := httptest.NewRecorder()
		d.Mux().ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("%s: %d, want %d", remote, rec.Code, want)
		}
	}
}

func TestDebounceCoalesces(t *testing.T) {
	r := newRig(t, "", "", func(o *daemon.Options) {
		o.PollInterval, o.Debounce = 5*time.Millisecond, 150*time.Millisecond
	})
	r.start()
	eventually(t, "initial index", r.indexed)
	before := r.h.builds.Load()

	start := time.Now()
	var want int64
	for i := 0; i < 40; i++ {
		want = r.appendLine(i)
		time.Sleep(10 * time.Millisecond)
	}
	spent := time.Since(start)
	eventually(t, "final state", func() bool { return r.storedSize() == want })
	builds := r.h.builds.Load() - before
	limit := int64(spent/(150*time.Millisecond)) + 3
	if builds > limit {
		t.Errorf("%d builds in %s with a 150ms debounce (limit %d)", builds, spent, limit)
	}
	t.Logf("%d builds for 40 appends over %s", builds, spent)
}

func TestSecondInstanceRefused(t *testing.T) {
	r := newRig(t, "", "", nil)
	r.start()
	eventually(t, "initial index", r.indexed)

	r2 := newRig(t, r.home, r.cfg, nil)
	err := r2.d.Run(context.Background())
	var locked *daemon.LockedError
	if !errors.As(err, &locked) || !strings.Contains(err.Error(), "merlin.lock") {
		t.Fatalf("second Run = %v", err)
	}
	if locked.PID != os.Getpid() {
		t.Errorf("pid = %d", locked.PID)
	}

	// The first one is unharmed, and the lock goes with it.
	if err := r.stop(); err != nil {
		t.Fatal(err)
	}
	r3 := newRig(t, r.home, r.cfg, nil)
	r3.start()
	if err := r3.stop(); err != nil {
		t.Fatal(err)
	}
}

func TestPortInUse(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	r := newRig(t, "", "", func(o *daemon.Options) { o.Port = ln.Addr().(*net.TCPAddr).Port })
	err = r.d.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "cannot listen on 127.0.0.1:") {
		t.Fatalf("Run = %v", err)
	}
	// The failed start released the lock.
	r2 := newRig(t, r.home, r.cfg, nil)
	r2.start()
}

func TestStartupOrderAndHooks(t *testing.T) {
	var calls atomic.Int32
	r := newRig(t, "", "", func(o *daemon.Options) {
		o.InstallHooks = func() (string, error) { calls.Add(1); return "installed", nil }
	})
	r.start()
	if calls.Load() != 1 {
		t.Errorf("InstallHooks called %d times", calls.Load())
	}
	// A failing hook installation does not stop the daemon.
	r2 := newRig(t, "", "", func(o *daemon.Options) {
		o.InstallHooks = func() (string, error) { return "", errors.New("settings.json is read-only") }
	})
	r2.start()
	eventually(t, "index despite hook failure", r2.indexed)
	b, _ := os.ReadFile(filepath.Join(r2.home, "merlin.log"))
	if !strings.Contains(string(b), "installing hooks failed") {
		t.Errorf("log lacks the hook failure:\n%s", b)
	}
}

func TestShutdownLeavesNoTempFiles(t *testing.T) {
	home := t.TempDir()
	stale := filepath.Join(home, "claude", "projects", plainProj, "sessions", "."+plainID+".json.123.tmp")
	fresh := filepath.Join(home, "claude", "projects", plainProj, "sessions", "."+plainID+".json.456.tmp")
	for _, p := range []string{stale, fresh} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("{"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-5 * time.Minute)
	os.Chtimes(stale, old, old)

	r := newRig(t, home, "", func(o *daemon.Options) { o.RescanInterval = 20 * time.Millisecond })
	r.start()
	if _, err := os.Stat(stale); !errors.Is(err, fs.ErrNotExist) {
		t.Error("stale temp file survived startup")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("a fresh temp file (maybe another process's) was removed")
	}
	os.Remove(fresh)

	// Stop in the middle of the initial index, with writes in flight.
	if err := r.stop(); err != nil {
		t.Fatalf("Run returned %v", err)
	}
	filepath.WalkDir(home, func(p string, d fs.DirEntry, err error) error {
		if err == nil && strings.HasSuffix(p, ".tmp") {
			t.Errorf("temp file left behind: %s", p)
		}
		return nil
	})
	if _, err := http.Get("http://" + r.d.Addr() + "/healthz"); err == nil {
		t.Error("still listening after shutdown")
	}
}

func TestRestartConverges(t *testing.T) {
	// Kill-equivalent: stop, change the world while down, start again on the same home.
	r := newRig(t, "", "", nil)
	r.start()
	eventually(t, "initial index", r.indexed)
	r.stop()

	want := r.appendLine(1)
	r2 := newRig(t, r.home, r.cfg, nil)
	r2.start()
	eventually(t, "first reconcile after restart", func() bool { return r2.storedSize() == want })
	if r2.h.builds.Load() != 1 {
		t.Errorf("restart rebuilt %d sessions, want 1", r2.h.builds.Load())
	}
}

func TestLiveSetMembership(t *testing.T) {
	cfg := copyClaude(t)
	os.RemoveAll(filepath.Join(cfg, "sessions"))
	r := newRig(t, "", cfg, func(o *daemon.Options) {
		o.PollInterval, o.LiveWindow = 5*time.Millisecond, 400*time.Millisecond
	})
	now := time.Now()
	filepath.WalkDir(cfg, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			os.Chtimes(p, now, now)
		}
		return nil
	})
	r.start()
	eventually(t, "initial index", r.indexed)
	eventually(t, "recently changed files make sessions live", func() bool { return r.d.Health().Live >= fixtureN })
	// ... and they leave the live set when the window passes.
	eventually(t, "live set drains", func() bool { return r.d.Health().Live == 0 })

	// A hook names a session.
	r.hook(fmt.Sprintf(`{"session_id":%q,"hook_event_name":"UserPromptSubmit"}`, plainID))
	eventually(t, "hook makes it live", func() bool { return r.d.Health().Live == 1 })
	eventually(t, "hook liveness expires", func() bool { return r.d.Health().Live == 0 })

	// SessionEnd ends hook liveness at once.
	r.hook(fmt.Sprintf(`{"session_id":%q,"hook_event_name":"SessionEnd"}`, plainID))
	time.Sleep(20 * time.Millisecond)
	if n := r.d.Health().Live; n != 0 {
		t.Errorf("live after SessionEnd = %d", n)
	}

	// The registry names it as long as the process is alive: this one.
	reg := filepath.Join(cfg, "sessions", "reg.json")
	os.MkdirAll(filepath.Dir(reg), 0o755)
	body := fmt.Sprintf(`{"pid":%d,"sessionId":%q,"status":"busy","updatedAt":%d}`, os.Getpid(), plainID, time.Now().UnixMilli())
	os.WriteFile(reg, []byte(body), 0o644)
	eventually(t, "registry makes it live", func() bool { return r.d.Health().Live == 1 })
	time.Sleep(500 * time.Millisecond) // longer than the live window
	if n := r.d.Health().Live; n != 1 {
		t.Errorf("registered session left the live set: %d", n)
	}
	os.Remove(reg)
	eventually(t, "registry entry gone", func() bool { return r.d.Health().Live == 0 })
}

func TestMountedRoutes(t *testing.T) {
	r := newRig(t, "", "", nil)
	r.d.Handle("GET /api/ping", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, "%d", r.d.Catalog().Len())
	}))
	r.start()
	eventually(t, "initial index", r.indexed)
	resp, err := http.Get("http://" + r.d.Addr() + "/api/ping")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(b) < "35" {
		t.Errorf("ping = %d %q", resp.StatusCode, b)
	}
}

func TestBus(t *testing.T) {
	var b daemon.Bus
	slow, unslow := b.Subscribe(1)
	fast, unfast := b.Subscribe(1000)
	done := make(chan struct{})
	go func() {
		for i := 0; i < 500; i++ {
			b.Publish(engine.Event{Kind: engine.Written})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Publish blocked on a slow subscriber")
	}
	if len(slow) != 1 || len(fast) != 500 {
		t.Errorf("slow has %d, fast has %d", len(slow), len(fast))
	}
	unslow()
	unslow() // idempotent
	if _, open := <-slow; !open {
		// drained its one buffered event first
		t.Log("closed after draining")
	}
	b.Publish(engine.Event{})
	if b.Subscribers() != 1 {
		t.Errorf("subscribers = %d", b.Subscribers())
	}
	unfast()
	if b.Subscribers() != 0 {
		t.Errorf("subscribers = %d", b.Subscribers())
	}
}

func TestSweepTemp(t *testing.T) {
	root := t.TempDir()
	mk := func(rel string, age time.Duration) string {
		p := filepath.Join(root, rel)
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, nil, 0o644)
		at := time.Now().Add(-age)
		os.Chtimes(p, at, at)
		return p
	}
	oldTmp := mk("a/sessions/.x.json.1.tmp", 2*time.Minute)
	newTmp := mk("a/sessions/.y.json.2.tmp", time.Second)
	digest := mk("a/sessions/x.json", time.Hour)
	other := mk("a/notes.tmp", time.Hour) // no leading dot: not ours
	n, err := daemon.SweepTemp(root, time.Minute, time.Now())
	if err != nil || n != 1 {
		t.Fatalf("swept %d, %v", n, err)
	}
	for p, want := range map[string]bool{oldTmp: false, newTmp: true, digest: true, other: true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s exists = %v, want %v", p, err == nil, want)
		}
	}
}

// A same-length edit of old bytes, made while the file also grows, cannot be seen by the
// incremental path. When the session leaves the live set the daemon has it rebuilt from
// scratch, and the stored digest then equals a full read of the files.
func TestLeavingTheLiveSetRebuildsFromScratch(t *testing.T) {
	r := newRig(t, "", "", func(o *daemon.Options) {
		o.PollInterval, o.Debounce, o.LiveWindow = 10*time.Millisecond, 20*time.Millisecond, 600*time.Millisecond
	})
	r.start()
	eventually(t, "initial index", r.indexed)

	// The first live build reads everything and starts the kept state.
	first := r.appendLine(1)
	eventually(t, "first live build", func() bool { return r.storedSize() == first })

	data, err := os.ReadFile(r.main())
	if err != nil {
		t.Fatal(err)
	}
	i := bytes.Index(data, []byte(`"content":"`))
	if i < 0 || i+12 > len(data)-300 {
		t.Fatal("fixture has no early content to edit")
	}
	edited := bytes.Clone(data)
	edited[i+11] ^= 0x01 // a letter becomes another letter
	edited = append(edited, []byte(`{"type":"x-test-line","n":2}`+"\n")...)
	if err := os.WriteFile(r.main(), edited, 0o644); err != nil {
		t.Fatal(err)
	}
	want := int64(len(edited))
	eventually(t, "digest follows the edit", func() bool { return r.storedSize() == want })
	if st := r.h.IncrementalStats(); st.AppendFiles == 0 {
		t.Fatalf("the live build did not read incrementally: %+v", st)
	}
	before := r.h.IncrementalStats()
	if r.fullMatches() {
		t.Fatal("test bug: the edit should be invisible to the incremental build")
	}

	// The session goes quiet; after the live window it leaves the set and is rebuilt.
	eventually(t, "full rebuild after leaving the live set", func() bool {
		return r.fullMatches()
	})
	if after := r.h.IncrementalStats(); after.AppendFiles != before.AppendFiles {
		t.Errorf("the rebuild went through the incremental path: %+v -> %+v", before, after)
	}
}

// fullMatches reports whether the stored digest of the plain session equals a from-scratch
// build of its files as they are now.
func (r *rig) fullMatches() bool {
	s, found, err := r.h.Locate(harness.SessionRef{ID: plainID})
	if err != nil || !found {
		return false
	}
	stored, ok, _ := r.st.Read(r.ref())
	if !ok {
		return false
	}
	full, err := digest.BuildSession(s.Handle.(discover.Source), pricing.Default())
	if err != nil {
		return false
	}
	a, _ := json.Marshal(stored)
	b, _ := json.Marshal(full)
	return bytes.Equal(a, b)
}
