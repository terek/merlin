package server

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/moments"
)

// momentInputs collects every stored digest with the turns it copied from a parent and the
// repository it counts under. cat should be a Snapshot: one view serves the whole loop. It
// stops early, returning nil, when ctx ends.
func momentInputs(ctx context.Context, cat *catalog.Catalog) []moments.Input {
	var ds []*model.SessionDigest
	cat.Each(func(d *model.SessionDigest) { ds = append(ds, d) })
	in := make([]moments.Input, 0, len(ds))
	for n, d := range ds {
		if n%256 == 0 && ctx.Err() != nil {
			return nil
		}
		i := moments.Input{Digest: d}
		if info, ok := cat.Session(d.Key()); ok {
			i.Inherited = info.InheritedTurns
		}
		if pl, ok := cat.Places(d.Key()); ok && pl.Repo != nil {
			i.Project = pl.Repo.Repo
		}
		in = append(in, i)
	}
	return in
}

// momentsMaxAge is how long a report stands for the same catalog state: the window only moves
// with the clock.
const momentsMaxAge = 30 * time.Second

// momentsCall is one computation of the report, shared by every request that arrives while
// it runs or while its result is still good. It is abandoned when its last waiter leaves.
type momentsCall struct {
	stamp   catalog.Stamp
	at      time.Time
	done    chan struct{}
	res     moments.Report
	ok      bool
	cancel  context.CancelFunc
	waiters int
}

type momentsCache struct {
	mu   sync.Mutex
	call *momentsCall
}

// report returns the Moments report for cat's current state, computing it at most once per
// state (and per momentsMaxAge) however many requests ask. A request whose context ends
// stops waiting; the computation stops when nobody waits for it.
func (a *API) report(ctx context.Context, cat *catalog.Catalog) (moments.Report, error) {
	snap := cat.Snapshot()
	stamp := snap.Stamp()
	now := a.o.Now()
	c := &a.momentsCache
	for {
		c.mu.Lock()
		call := c.call
		if call == nil || call.stamp != stamp || now.Sub(call.at) > momentsMaxAge || (call.isDone() && !call.ok) {
			cctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
			call = &momentsCall{stamp: stamp, at: now, done: make(chan struct{}), cancel: cancel}
			c.call = call
			go func() {
				defer close(call.done)
				defer cancel()
				in := momentInputs(cctx, snap)
				if in == nil || cctx.Err() != nil {
					return
				}
				call.res, call.ok = moments.Build(in, now, a.loc()), true
			}()
		}
		call.waiters++
		c.mu.Unlock()

		select {
		case <-call.done:
		case <-ctx.Done():
		}
		c.mu.Lock()
		call.waiters--
		if call.waiters == 0 && !call.isDone() {
			call.cancel()
		}
		c.mu.Unlock()
		if err := ctx.Err(); err != nil {
			return moments.Report{}, err
		}
		if call.ok {
			return call.res, nil
		}
		// The computation was abandoned by others before this request joined it: go again.
	}
}

func (c *momentsCall) isDone() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

func (a *API) handleMoments(w http.ResponseWriter, r *http.Request) {
	cat := a.cat(w)
	if cat == nil {
		return
	}
	rep, err := a.report(r.Context(), cat)
	if err != nil {
		return // the client went away
	}
	a.json(w, http.StatusOK, rep)
}
