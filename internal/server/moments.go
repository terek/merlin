package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
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
	cfgKey  string // the setup facts and what the person engaged with: they change the report too
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
	cfg := a.momentsConfig()
	cfgKey := fmt.Sprintf("%+v", cfg)
	now := a.o.Now()
	c := &a.momentsCache
	for {
		c.mu.Lock()
		call := c.call
		if call == nil || call.stamp != stamp || call.cfgKey != cfgKey || now.Sub(call.at) > momentsMaxAge || (call.isDone() && !call.ok) {
			cctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
			call = &momentsCall{stamp: stamp, cfgKey: cfgKey, at: now, done: make(chan struct{}), cancel: cancel}
			c.call = call
			go func() {
				defer close(call.done)
				defer cancel()
				in := momentInputs(cctx, snap)
				if in == nil || cctx.Err() != nil {
					return
				}
				call.res, call.ok = moments.BuildConfig(moments.Registry(), in, now, a.loc(), cfg), true
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

// momentsConfig is what the report needs besides the digests: the setup facts and the
// engagement the person recorded.
func (a *API) momentsConfig() moments.Config {
	var cfg moments.Config
	if a.o.MomentsSetup != nil {
		cfg.Setup = a.o.MomentsSetup()
	}
	if a.o.MomentsHome != "" {
		cfg.Engaged = moments.LoadEngaged(a.o.MomentsHome)
	}
	return cfg
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

// handleEngage is POST /api/moments/engage: the page tells the daemon that the person opened a
// suggestion's row or copied its fix.
func (a *API) handleEngage(w http.ResponseWriter, r *http.Request) {
	var req EngageRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		a.badParam(w, "the body must be JSON like {\"moment\":\"clean-slate\",\"action\":\"open\"}")
		return
	}
	if !slices.ContainsFunc(moments.Registry(), func(m moments.Moment) bool { return m.ID == req.Moment }) {
		a.badParam(w, "unknown moment %q", req.Moment)
		return
	}
	if req.Action != moments.ActionOpen && req.Action != moments.ActionCopy {
		a.badParam(w, "action must be %q or %q", moments.ActionOpen, moments.ActionCopy)
		return
	}
	if err := moments.RecordEngagement(a.o.MomentsHome, req.Moment, req.Action, a.o.Now()); err != nil {
		a.fail(w, http.StatusInternalServerError, CodeInternal, err.Error())
		return
	}
	a.json(w, http.StatusOK, EngageResponse{Moment: req.Moment, Action: req.Action})
}
