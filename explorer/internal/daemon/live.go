package daemon

import (
	"context"
	"slices"
	"time"

	"github.com/terek/merlin/explorer/internal/engine"
	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/store"
)

// A session is live (followed closely) while any of three things holds:
//   - a hook named it within the live window (until its SessionEnd),
//   - the harness's own registry lists it as running,
//   - one of its files changed within the live window.
//
// The live loop owns all live state on one goroutine. Every poll it re-lists each live
// session (a stat of its files), and when the fingerprint differs from what was last handed
// to the engine it enqueues the session on the priority lane, at most once per debounce.
// A hook only makes the same check happen now, and for Stop / SessionEnd without waiting
// out the debounce. Nothing here is needed for correctness: the rescan finds the same work.

type liveKey struct{ harness, id string }

type liveEntry struct {
	h       harness.Harness
	ref     harness.SessionRef
	hookAt  time.Time // last hook naming the session; zero after SessionEnd
	regGen  uint64    // poll generation in which the registry listed it
	known   bool      // fp is meaningful
	fp      []model.SourceFile
	lastEnq time.Time
	newest  time.Time // latest file mtime seen
}

type liveSet struct {
	entries map[liveKey]*liveEntry
	gen     uint64
}

func (d *Daemon) liveLoop(ctx context.Context) {
	ls := &liveSet{entries: map[liveKey]*liveEntry{}}
	t := time.NewTicker(d.opts.PollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case body := <-d.hookCh:
			d.onHook(ls, body)
		case <-t.C:
			d.poll(ls)
		}
	}
}

func (ls *liveSet) entry(h harness.Harness, ref harness.SessionRef) *liveEntry {
	k := liveKey{h.Name(), ref.ID}
	e := ls.entries[k]
	if e == nil {
		e = &liveEntry{h: h, ref: ref}
		ls.entries[k] = e
	}
	if e.ref.ProjectKey == "" {
		e.ref.ProjectKey = ref.ProjectKey
	}
	return e
}

func (d *Daemon) onHook(ls *liveSet, body []byte) {
	for _, h := range d.opts.Harnesses {
		ev, ok := h.ParseHook(body)
		if !ok {
			continue
		}
		e := ls.entry(h, ev.Ref)
		e.hookAt = time.Now()
		d.refresh(e, ev.Final)
		if ev.Ended {
			e.hookAt = time.Time{}
		}
		d.liveCount.Store(int64(len(ls.entries)))
		return
	}
}

func (d *Daemon) poll(ls *liveSet) {
	ls.gen++
	for _, h := range d.opts.Harnesses {
		refs, err := h.LiveSessions()
		if err != nil {
			continue
		}
		for _, ref := range refs {
			ls.entry(h, ref).regGen = ls.gen
		}
	}
	// Sessions the last reconciles saw changing recently. Their fingerprint is taken as
	// already handled: the reconcile queued them if they were stale.
	for _, dc := range d.takeDiscovered() {
		k := liveKey{dc.h.Name(), dc.s.Key.ID}
		if _, ok := ls.entries[k]; ok {
			continue
		}
		ls.entries[k] = &liveEntry{
			h: dc.h, ref: harness.SessionRef{ID: dc.s.Key.ID, ProjectKey: dc.s.ProjectKey},
			known: true, fp: dc.s.Fingerprint, newest: time.Unix(0, newest(dc.s.Fingerprint)),
		}
	}
	for k, e := range ls.entries {
		d.refresh(e, false)
		if !d.isLive(e, ls.gen) {
			delete(ls.entries, k)
		}
	}
	d.liveCount.Store(int64(len(ls.entries)))
}

func (d *Daemon) isLive(e *liveEntry, gen uint64) bool {
	now := time.Now()
	w := d.opts.LiveWindow
	return (!e.hookAt.IsZero() && now.Sub(e.hookAt) < w) ||
		e.regGen == gen ||
		(!e.newest.IsZero() && now.Sub(e.newest) < w)
}

// refresh re-lists the session and enqueues it if its files are not what the engine was
// last given. immediate skips the debounce.
func (d *Daemon) refresh(e *liveEntry, immediate bool) {
	s, found, err := e.h.Locate(e.ref)
	if err != nil {
		d.logf("live: locating %s: %v", e.ref.ID, err)
		return
	}
	if !found {
		return // no files yet (SessionStart) or any more; the next poll looks again
	}
	e.ref.ProjectKey = s.ProjectKey
	e.newest = time.Unix(0, newest(s.Fingerprint))
	switch {
	case !e.known:
		e.known = true
		hdr, ok, err := d.st.ReadHeader(store.Ref{Harness: e.h.Name(), ProjectKey: s.ProjectKey, SessionID: s.Key.ID})
		if err != nil || !ok {
			hdr = nil
		}
		if engine.Stale(e.h, s, hdr) {
			d.enqueue(e, s)
		} else {
			e.fp = s.Fingerprint
		}
	case slices.Equal(e.fp, s.Fingerprint):
	case immediate || time.Since(e.lastEnq) >= d.opts.Debounce:
		d.enqueue(e, s)
	}
}

// enqueue hands a live session to the engine's priority lane.
//
// SEAM (merlin-t8s.19): the engine rebuilds the whole session from its files. Incremental
// reads belong in the harness's Build, which can keep a Builder per live file; nothing in
// the daemon needs to change for that.
func (d *Daemon) enqueue(e *liveEntry, s harness.Session) {
	e.fp = s.Fingerprint
	e.lastEnq = time.Now()
	d.eng.Load().Enqueue(e.h, s, true)
}
