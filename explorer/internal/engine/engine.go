// Package engine keeps the stored digests in step with the sessions on disk.
//
// Work is derived, never stored: Reconcile compares what each harness's sessions look like
// now (their fingerprints) with what the stored digests say they were built from, and queues
// the difference. The queue lives in memory only, so a process that is stopped or killed at
// any point leaves nothing to repair; the next Reconcile finds whatever is still stale.
//
// The engine drives harness.Harness values and knows nothing about any particular harness.
package engine

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/store"
)

// EventKind says what happened to a stored digest.
type EventKind int

const (
	// Written: a digest was built and stored.
	Written EventKind = iota
	// Failed: building failed and an error stub was stored.
	Failed
	// SourceMissing: the session's files are gone and the stored digest was marked.
	SourceMissing
)

func (k EventKind) String() string {
	switch k {
	case Written:
		return "written"
	case Failed:
		return "failed"
	case SourceMissing:
		return "sourceMissing"
	}
	return fmt.Sprintf("EventKind(%d)", int(k))
}

// Event is passed to Options.OnWrite after a digest file changed on disk.
type Event struct {
	Kind   EventKind
	Ref    store.Ref
	Digest *model.SessionDigest // what is stored now; nil only if it could not be re-read
}

// Progress is passed to Options.OnProgress after each session is handled.
type Progress struct {
	Queued  int           // sessions put in the queue since the counters were reset
	Done    int           // of those, finished (written or failed)
	Failed  int           // of Done, failed
	Bytes   int64         // transcript bytes of the finished sessions
	Elapsed time.Duration // since the counters were reset
}

// Rate returns the processing rate in bytes per second.
func (p Progress) Rate() float64 {
	if p.Elapsed <= 0 {
		return 0
	}
	return float64(p.Bytes) / p.Elapsed.Seconds()
}

// Summary is the outcome of a scan.
type Summary struct {
	Seen       int // sessions discovered
	Processed  int // digests built and written
	Unchanged  int // sessions whose stored digest was current
	Failed     int // sessions that failed and got an error stub
	Missing    int // stored digests whose source is gone (marked now or before)
	NewMissing int // of Missing, marked by this scan
	Elapsed    time.Duration
}

// Options configures an Engine.
type Options struct {
	Store     *store.Store
	Harnesses []harness.Harness
	// Workers is the number of concurrent builders; 0 means GOMAXPROCS.
	Workers int
	// Logf receives warnings and failures; nil discards them.
	Logf func(format string, args ...any)
	// OnWrite is called after each digest write and each sourceMissing marking. Calls are
	// serialised; the callback must not block for long.
	OnWrite func(Event)
	// OnProgress is called after each session is handled, serialised with OnWrite.
	OnProgress func(Progress)
	// OnDiscover is called by Reconcile with each harness's discovery, before any
	// session is queued. Sessions come in the harness's order and must not be modified.
	// It runs on the reconciling goroutine; keep it short.
	OnDiscover func(h harness.Harness, d harness.Discovery)
}

// Engine reconciles stored digests with sessions on disk.
type Engine struct {
	opts Options
	q    *queue

	cbMu sync.Mutex // serialises callbacks and guards the counters
	c    counters
}

type counters struct {
	start                          time.Time
	seen, unchanged                int
	queued, done, failed           int
	processed, missing, newMissing int
	bytes                          int64
}

// New returns an Engine. It does no work until Reconcile, Scan or Run.
func New(opts Options) (*Engine, error) {
	if opts.Store == nil {
		return nil, errors.New("engine: no store")
	}
	if opts.Workers <= 0 {
		opts.Workers = runtime.GOMAXPROCS(0)
	}
	seen := map[string]bool{}
	for _, h := range opts.Harnesses {
		if !store.ValidName(h.Name()) {
			return nil, fmt.Errorf("engine: invalid harness name %q", h.Name())
		}
		if seen[h.Name()] {
			return nil, fmt.Errorf("engine: duplicate harness %q", h.Name())
		}
		seen[h.Name()] = true
	}
	e := &Engine{opts: opts, q: newQueue()}
	e.c.start = time.Now()
	return e, nil
}

func (e *Engine) logf(format string, args ...any) {
	if e.opts.Logf != nil {
		e.opts.Logf(format, args...)
	}
}

// ResetCounters starts a new accounting period for Progress and Stats.
func (e *Engine) ResetCounters() {
	e.cbMu.Lock()
	e.c = counters{start: time.Now()}
	e.cbMu.Unlock()
}

// Stats returns the counters since the last reset (Scan resets them).
func (e *Engine) Stats() Summary {
	e.cbMu.Lock()
	defer e.cbMu.Unlock()
	return e.summaryLocked()
}

func (e *Engine) summaryLocked() Summary {
	c := e.c
	return Summary{Seen: c.seen, Processed: c.processed, Unchanged: c.unchanged,
		Failed: c.failed, Missing: c.missing, NewMissing: c.newMissing, Elapsed: time.Since(c.start)}
}

// Enqueue puts one session in the queue, whatever its stored digest says. live puts it in
// the priority lane. A session already queued is not queued twice; one being built is built
// again afterwards.
func (e *Engine) Enqueue(h harness.Harness, s harness.Session, live bool) {
	e.q.push(job{h: h, s: s}, live)
}

// Pending returns the number of sessions queued or being built.
func (e *Engine) Pending() int { return e.q.depth() }

// Stale reports whether the stored digest header (nil: none) no longer matches the session.
func Stale(h harness.Harness, s harness.Session, hdr *store.Header) bool {
	switch {
	case hdr == nil:
		return true
	case hdr.SchemaVersion != model.SchemaVersion, hdr.ParserVersion != h.ParserVersion():
		return true
	case hdr.SourceMissing: // the files are back
		return true
	}
	return !sameFiles(hdr.Source, s.Fingerprint)
}

// sameFiles compares two fingerprints regardless of order.
func sameFiles(a, b []model.SourceFile) bool {
	if len(a) != len(b) {
		return false
	}
	if slices.Equal(a, b) {
		return true
	}
	byPath := func(f []model.SourceFile) []model.SourceFile {
		f = slices.Clone(f)
		sort.Slice(f, func(i, j int) bool { return f[i].Path < f[j].Path })
		return f
	}
	return slices.Equal(byPath(a), byPath(b))
}

// Reconcile discovers every harness's sessions, queues those whose digest is stale and
// marks the stored digests whose source is gone. It does not wait for the queue to drain.
// A harness whose discovery fails is skipped (its stored digests are left alone) and the
// error is returned after the others have been reconciled.
func (e *Engine) Reconcile(ctx context.Context) error {
	var errs []error
	for _, h := range e.opts.Harnesses {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := e.reconcileOne(ctx, h); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", h.Name(), err))
		}
	}
	return errors.Join(errs...)
}

func (e *Engine) reconcileOne(ctx context.Context, h harness.Harness) error {
	disc, err := h.Discover()
	if err != nil {
		return fmt.Errorf("discover: %w", err)
	}
	for _, w := range disc.Warnings {
		e.logf("%s: %s", h.Name(), w)
	}
	name := h.Name()
	if e.opts.OnDiscover != nil {
		e.opts.OnDiscover(h, disc)
	}

	live := map[store.Ref]bool{}
	var queued, unchanged int
	for _, s := range disc.Sessions {
		if err := ctx.Err(); err != nil {
			return err
		}
		ref := store.Ref{Harness: name, ProjectKey: s.ProjectKey, SessionID: s.Key.ID}
		if live[ref] {
			e.logf("%s: session %s listed twice; ignoring the second", name, s.Key.ID)
			continue
		}
		live[ref] = true
		hdr, found, err := e.opts.Store.ReadHeader(ref)
		if err != nil {
			e.logf("%s: reading header of %s: %v (rebuilding)", name, ref, err)
			found = false
		}
		if !found {
			hdr = nil
		}
		if Stale(h, s, hdr) {
			e.Enqueue(h, s, false)
			queued++
		} else {
			unchanged++
		}
	}

	// Stored digests whose session has vanished: mark once, keep forever.
	refs, err := e.opts.Store.List(name)
	if err != nil {
		return fmt.Errorf("list stored digests: %w", err)
	}
	var missing, newMissing int
	for _, ref := range refs {
		if live[ref] {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		hdr, found, err := e.opts.Store.ReadHeader(ref)
		if err != nil || !found {
			continue // unreadable files are rebuilt if the session ever reappears
		}
		missing++
		if hdr.SourceMissing {
			continue
		}
		if _, err := e.opts.Store.MarkSourceMissing(ref); err != nil {
			e.logf("%s: marking %s sourceMissing: %v", name, ref, err)
			continue
		}
		newMissing++
		d, _, _ := e.opts.Store.Read(ref)
		e.emit(Event{Kind: SourceMissing, Ref: ref, Digest: d})
	}

	e.cbMu.Lock()
	e.c.seen += len(live)
	e.c.unchanged += unchanged
	e.c.queued += queued
	e.c.missing += missing
	e.c.newMissing += newMissing
	e.cbMu.Unlock()
	return nil
}

// Scan makes the stored digests match the sessions on disk, once: it reconciles, builds
// everything stale and returns when the queue is empty. Its summary covers this scan only.
// If ctx is cancelled it stops early and returns the partial summary with ctx's error;
// nothing needs cleaning up.
func (e *Engine) Scan(ctx context.Context) (Summary, error) {
	e.ResetCounters()
	stop := e.startWorkers(ctx)
	rerr := e.Reconcile(ctx)
	werr := e.q.waitIdle(ctx)
	stop()
	e.cbMu.Lock()
	sum := e.summaryLocked()
	e.cbMu.Unlock()
	return sum, errors.Join(rerr, werr)
}

// Run processes the queue until ctx is done. A long-lived caller feeds it with Reconcile
// and Enqueue.
func (e *Engine) Run(ctx context.Context) {
	stop := e.startWorkers(ctx)
	<-ctx.Done()
	stop()
}

// startWorkers launches the pool and returns a function that stops it and waits for the
// builds in flight (builds themselves are not interrupted).
func (e *Engine) startWorkers(ctx context.Context) (stop func()) {
	e.q.open()
	var wg sync.WaitGroup
	for range e.opts.Workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				j, ok := e.q.pop()
				if !ok {
					return
				}
				e.process(j)
				e.q.done(j)
			}
		}()
	}
	cancel := context.AfterFunc(ctx, e.q.close)
	return func() {
		cancel()
		e.q.close()
		wg.Wait()
	}
}

// process builds one session and stores the result. It never panics and never returns an
// error: a failure becomes an error stub carrying the fingerprint, so the session is
// retried only when its files (or the parser) change.
func (e *Engine) process(j job) {
	ref := store.Ref{Harness: j.h.Name(), ProjectKey: j.s.ProjectKey, SessionID: j.s.Key.ID}
	d, err := e.build(j)
	if err == nil {
		// The digest is stored under the identity discovery gave; make sure it says so.
		d.Harness, d.ProjectKey, d.ID = ref.Harness, ref.ProjectKey, ref.SessionID
		if err = e.opts.Store.Write(d); err == nil {
			e.finish(j, Event{Kind: Written, Ref: ref, Digest: d})
			return
		}
		err = fmt.Errorf("write digest: %w", err)
	}
	e.logf("%s: %v", ref, err)
	stub := store.ErrorStub(ref, model.SchemaVersion, j.h.ParserVersion(), j.s.Fingerprint, err.Error())
	if werr := e.opts.Store.Write(stub); werr != nil {
		e.logf("%s: writing error stub: %v", ref, werr)
		stub = nil
	}
	e.finish(j, Event{Kind: Failed, Ref: ref, Digest: stub})
}

// build runs the harness's Build, turning a panic into an error.
func (e *Engine) build(j job) (d *model.SessionDigest, err error) {
	defer func() {
		if r := recover(); r != nil {
			d, err = nil, fmt.Errorf("panic while building: %v", r)
		}
	}()
	d, err = j.h.Build(j.s)
	if err == nil && d == nil {
		err = errors.New("harness returned no digest")
	}
	return d, err
}

// finish records the outcome, then calls the callbacks. A panicking callback is contained.
func (e *Engine) finish(j job, ev Event) {
	var size int64
	for _, f := range j.s.Fingerprint {
		size += f.Size
	}
	e.cbMu.Lock()
	defer e.cbMu.Unlock()
	e.c.done++
	e.c.bytes += size
	if ev.Kind == Failed {
		e.c.failed++
	} else {
		e.c.processed++
	}
	e.callLocked(func() {
		if e.opts.OnWrite != nil && ev.Digest != nil {
			e.opts.OnWrite(ev)
		}
	})
	e.callLocked(func() {
		if e.opts.OnProgress != nil {
			e.opts.OnProgress(Progress{Queued: e.c.queued, Done: e.c.done, Failed: e.c.failed,
				Bytes: e.c.bytes, Elapsed: time.Since(e.c.start)})
		}
	})
}

func (e *Engine) emit(ev Event) {
	if e.opts.OnWrite == nil {
		return
	}
	e.cbMu.Lock()
	defer e.cbMu.Unlock()
	e.callLocked(func() { e.opts.OnWrite(ev) })
}

func (e *Engine) callLocked(f func()) {
	defer func() {
		if r := recover(); r != nil {
			e.logf("engine: callback panicked: %v", r)
		}
	}()
	f()
}
