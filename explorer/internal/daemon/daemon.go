package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/engine"
	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/store"
)

// Defaults for the intervals in Options.
const (
	DefaultRescanInterval  = 10 * time.Second
	DefaultPollInterval    = time.Second
	DefaultDebounce        = 3 * time.Second
	DefaultLiveWindow      = 5 * time.Minute
	DefaultShutdownTimeout = 10 * time.Second
	tmpMaxAge              = time.Minute
)

// Options configures a Daemon. Every interval can be shortened for tests.
type Options struct {
	Home      string // EXPLORER_HOME; holds explorer.lock, explorer.log and the store
	Harnesses []harness.Harness

	// Port is the TCP port on 127.0.0.1; 0 picks a free one (see Daemon.Addr).
	Port int

	// InstallHooks, if set, is called at startup after the lock is taken. Its message is
	// logged; an error is logged and does not stop the daemon (hooks are only hints).
	InstallHooks func() (string, error)

	Workers         int           // concurrent builders; 0 = GOMAXPROCS
	RescanInterval  time.Duration // full reconcile; default 10 s
	PollInterval    time.Duration // stat-poll of the live set; default 1 s
	Debounce        time.Duration // at most one build per live session per this; default 3 s
	LiveWindow      time.Duration // how long a hook or a file change keeps a session live; default 5 min
	ShutdownTimeout time.Duration // how long in-flight builds may take on shutdown; default 10 s

	Version string    // reported by /healthz
	Stderr  io.Writer // log copy; nil = os.Stderr
}

// Daemon is one running (or about to run) explorer serve.
type Daemon struct {
	opts Options
	mux  *http.ServeMux
	bus  Bus

	// set by Run before it signals ready
	cat   atomic.Pointer[catalog.Catalog]
	eng   atomic.Pointer[engine.Engine]
	st    *store.Store
	addr  atomic.Pointer[string]
	ready chan struct{}
	start time.Time

	logMu sync.Mutex
	logW  io.Writer // file + stderr once the log is open

	hookCh chan []byte // /hook bodies for the live loop; a full channel drops (hints only)

	discMu     sync.Mutex
	discovered []discovered // sessions seen by the last reconciles, for the live loop

	liveCount    atomic.Int64
	hooksSeen    atomic.Int64
	hooksDropped atomic.Int64
	rescans      atomic.Int64
	lastRescan   atomic.Int64 // unix nanoseconds
}

type discovered struct {
	h harness.Harness
	s harness.Session
}

// New validates opts and returns a Daemon that does nothing until Run. The mux is usable
// at once: the API registers its routes with Handle before Run.
func New(opts Options) (*Daemon, error) {
	if opts.Home == "" {
		return nil, errors.New("daemon: no home directory")
	}
	if len(opts.Harnesses) == 0 {
		return nil, errors.New("daemon: no harnesses")
	}
	def := func(p *time.Duration, v time.Duration) {
		if *p <= 0 {
			*p = v
		}
	}
	def(&opts.RescanInterval, DefaultRescanInterval)
	def(&opts.PollInterval, DefaultPollInterval)
	def(&opts.Debounce, DefaultDebounce)
	def(&opts.LiveWindow, DefaultLiveWindow)
	def(&opts.ShutdownTimeout, DefaultShutdownTimeout)
	if opts.Stderr == nil {
		opts.Stderr = os.Stderr
	}
	d := &Daemon{
		opts:   opts,
		mux:    http.NewServeMux(),
		ready:  make(chan struct{}),
		hookCh: make(chan []byte, 256),
		logW:   opts.Stderr,
	}
	d.mux.HandleFunc("/hook", d.handleHook)
	d.mux.HandleFunc("/healthz", d.handleHealth)
	return d, nil
}

// Mux is the HTTP mux served on the listener. Other packages register their routes on it
// (before or after Run starts); /hook and /healthz are taken.
func (d *Daemon) Mux() *http.ServeMux { return d.mux }

// Handle registers a route on Mux.
func (d *Daemon) Handle(pattern string, h http.Handler) { d.mux.Handle(pattern, h) }

// Events is the bus the engine's write events are published on, after the catalog has
// been updated: a subscriber that reads the catalog on an event sees at least that state.
func (d *Daemon) Events() *Bus { return &d.bus }

// Catalog returns the in-memory catalog. It is nil until Run has loaded it, which is
// before the listener starts: handlers served from Mux always see it.
func (d *Daemon) Catalog() *catalog.Catalog { return d.cat.Load() }

// Engine returns the engine (nil until Run has created it, before the listener starts).
func (d *Daemon) Engine() *engine.Engine { return d.eng.Load() }

// Store returns the digest store (nil until Run has opened it).
func (d *Daemon) Store() *store.Store { return d.st }

// Ready is closed once the listener is up. Run may still be doing its first reconcile.
func (d *Daemon) Ready() <-chan struct{} { return d.ready }

// Addr returns the listen address, e.g. "127.0.0.1:7433"; empty before Ready.
func (d *Daemon) Addr() string {
	if p := d.addr.Load(); p != nil {
		return *p
	}
	return ""
}

func (d *Daemon) logf(format string, args ...any) {
	line := time.Now().Format(time.RFC3339) + " " + fmt.Sprintf(format, args...) + "\n"
	d.logMu.Lock()
	defer d.logMu.Unlock()
	io.WriteString(d.logW, line)
}

// Run serves until ctx is done, then shuts down cleanly and returns nil. A startup failure
// (another instance holds the lock, the port cannot be bound, ...) is returned at once.
//
// Startup order: lock, sweep stale temp files, install hooks, load the catalog, listen,
// first reconcile. The listener is up before the first reconcile finishes so that hooks
// arriving meanwhile are not lost.
func (d *Daemon) Run(ctx context.Context) error {
	home := d.opts.Home
	if err := os.MkdirAll(home, 0o755); err != nil {
		return err
	}
	lock, err := acquireLock(filepath.Join(home, "explorer.lock"))
	if err != nil {
		return err
	}
	defer lock.Close() // the OS would release it anyway

	if f, err := os.OpenFile(filepath.Join(home, "explorer.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		defer f.Close()
		d.logMu.Lock()
		d.logW = io.MultiWriter(f, d.opts.Stderr)
		d.logMu.Unlock()
	} else {
		d.logf("cannot open log file: %v (logging to stderr only)", err)
	}
	d.start = time.Now()
	d.logf("merlin serve %s starting (pid %d, home %s)", d.opts.Version, os.Getpid(), home)

	if n, err := SweepTemp(home, tmpMaxAge, time.Now()); err != nil {
		d.logf("sweeping temp files: %v", err)
	} else if n > 0 {
		d.logf("removed %d stale temp files", n)
	}

	if d.opts.InstallHooks != nil {
		if msg, err := d.opts.InstallHooks(); err != nil {
			d.logf("installing hooks failed (continuing without): %v", err)
		} else if msg != "" {
			d.logf("%s", msg)
		}
	}

	st, err := store.New(home)
	if err != nil {
		return err
	}
	st.Warn = func(msg string) { d.logf("store: %s", msg) }
	d.st = st
	cat, err := catalog.Load(st, "")
	if err != nil {
		return fmt.Errorf("loading catalog: %w", err)
	}
	d.cat.Store(cat)
	d.logf("catalog loaded: %d sessions", cat.Len())

	eng, err := engine.New(engine.Options{
		Store:      st,
		Harnesses:  d.opts.Harnesses,
		Workers:    d.opts.Workers,
		Logf:       func(format string, a ...any) { d.logf(format, a...) },
		OnWrite:    d.onWrite,
		OnDiscover: d.onDiscover,
	})
	if err != nil {
		return err
	}
	d.eng.Store(eng)

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", d.opts.Port))
	if err != nil {
		return fmt.Errorf("cannot listen on 127.0.0.1:%d: %w", d.opts.Port, err)
	}
	addr := ln.Addr().String()
	d.addr.Store(&addr)
	srv := &http.Server{Handler: d.mux, ReadHeaderTimeout: 5 * time.Second}
	srvDone := make(chan struct{})
	go func() {
		defer close(srvDone)
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			d.logf("http: %v", err)
		}
	}()
	d.logf("listening on %s", addr)
	close(d.ready)

	loopCtx, stopLoops := context.WithCancel(ctx)
	engCtx, stopEngine := context.WithCancel(context.Background())
	engDone := make(chan struct{})
	go func() { defer close(engDone); eng.Run(engCtx) }()
	var loops sync.WaitGroup
	loops.Add(2)
	go func() { defer loops.Done(); d.rescanLoop(loopCtx) }()
	go func() { defer loops.Done(); d.liveLoop(loopCtx) }()

	<-ctx.Done()
	d.logf("shutting down")
	shCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	if err := srv.Shutdown(shCtx); err != nil {
		srv.Close()
	}
	cancel()
	<-srvDone
	stopLoops()
	loops.Wait()
	stopEngine()
	select {
	case <-engDone:
	case <-time.After(d.opts.ShutdownTimeout):
		d.logf("abandoning %d unfinished builds (their writes are atomic; the next start redoes them)", eng.Pending())
	}
	d.logf("stopped")
	return nil
}

// onWrite is the engine's OnWrite: the catalog first, then the bus.
func (d *Daemon) onWrite(ev engine.Event) {
	cat := d.cat.Load()
	switch ev.Kind {
	case engine.SourceMissing:
		cat.MarkMissing(model.SessionKey{Harness: ev.Ref.Harness, ID: ev.Ref.SessionID})
	default:
		if ev.Digest != nil {
			cat.Upsert(ev.Digest)
		}
	}
	d.bus.Publish(ev)
}

func (d *Daemon) onDiscover(h harness.Harness, disc harness.Discovery) {
	cutoff := time.Now().Add(-d.opts.LiveWindow).UnixNano()
	var recent []discovered
	for _, s := range disc.Sessions {
		if newest(s.Fingerprint) >= cutoff {
			recent = append(recent, discovered{h, s})
		}
	}
	d.discMu.Lock()
	d.discovered = append(d.discovered, recent...)
	d.discMu.Unlock()
}

func (d *Daemon) takeDiscovered() []discovered {
	d.discMu.Lock()
	defer d.discMu.Unlock()
	out := d.discovered
	d.discovered = nil
	return out
}

// newest returns the latest mtime (unix nanoseconds) in a fingerprint.
func newest(fp []model.SourceFile) int64 {
	var m int64
	for _, f := range fp {
		m = max(m, f.MtimeNs)
	}
	return m
}

func (d *Daemon) rescanLoop(ctx context.Context) {
	d.rescan(ctx)
	t := time.NewTicker(d.opts.RescanInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.rescan(ctx)
		}
	}
}

// rescan is the correctness backstop: it needs nothing but the filesystem and the store.
func (d *Daemon) rescan(ctx context.Context) {
	eng := d.eng.Load()
	eng.ResetCounters()
	err := eng.Reconcile(ctx)
	if err != nil && ctx.Err() == nil {
		d.logf("rescan: %v", err)
	}
	if ctx.Err() != nil {
		return
	}
	first := d.rescans.Add(1) == 1
	d.lastRescan.Store(time.Now().UnixNano())
	if s := eng.Stats(); first || s.Seen != s.Unchanged || s.NewMissing > 0 {
		d.logf("rescan: %d sessions, %d queued, %d newly missing", s.Seen, s.Seen-s.Unchanged, s.NewMissing)
	}
}
