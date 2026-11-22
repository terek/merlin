package catalog

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/store"
)

// Catalog is the in-memory view over all digests. It is safe for many concurrent readers
// and one writer (several writers are serialised).
//
// Writers only record the digest; everything derived from more than one session
// (ownership, lineage, rollups) is rebuilt in full on the next read after a change. That
// makes the result after any sequence of writes equal to a fresh load of the same
// digests, by construction. A rebuild of a few thousand sessions takes milliseconds.
//
// A digest passed to Upsert must not be modified afterwards.
type Catalog struct {
	mu      sync.RWMutex
	digests map[model.SessionKey]*model.SessionDigest
	loc     *time.Location // nil: time.Local at rebuild time
	v       *view
	vGen    uint64    // gen of the digests v was built from
	vAt     time.Time // when v was built

	gen       uint64    // bumped by every write
	lastWrite time.Time // of the latest write
	fresh     time.Duration

	places    Places
	placesGen int
	fv        *facets // the groupings of v under places (places.go)

	buildMu sync.Mutex // one build at a time; never held together with mu while building
	pin     *pinned    // set on a Snapshot: every read answers from it
}

var viewIDs atomic.Uint64

// Stamp identifies the state a Snapshot is frozen at: equal stamps (from any catalogs) mean
// equal answers, so work derived from one can be shared.
type Stamp struct {
	View   uint64
	Places int
}

// Stamp returns the stamp of a Snapshot; the zero Stamp for a catalog that is not one.
func (c *Catalog) Stamp() Stamp {
	if c.pin == nil {
		return Stamp{}
	}
	return Stamp{c.pin.v.id, c.pin.gen}
}

// pinned is the frozen state of a Snapshot.
type pinned struct {
	v      *view
	src    map[model.SessionKey]*model.SessionDigest
	places Places
	gen    int
	once   sync.Once
	fv     *facets
}

// SetFreshness bounds how old a derived view may be while writes keep coming: a reader
// rebuilds at most once per d and gets the previous view in between. Once writes have paused
// (a tenth of d), the next read is fully fresh. Zero (the default) rebuilds on every read
// that follows a write.
func (c *Catalog) SetFreshness(d time.Duration) {
	c.mu.Lock()
	c.fresh = d
	c.mu.Unlock()
}

// Snapshot returns a read-only catalog frozen at the current derived state: every query on
// it answers from one consistent view, whatever is written meanwhile and without any rebuild.
// Writing to it is a mistake.
func (c *Catalog) Snapshot() *Catalog {
	if c.pin != nil {
		return c
	}
	v, fv := c.current(false)
	c.mu.RLock()
	p := &pinned{v: v, src: v.src, places: c.places, gen: c.placesGen}
	if fv != nil && fv.v == v {
		p.fv, p.places, p.gen = fv, fv.places, fv.gen
	}
	c.mu.RUnlock()
	if p.fv != nil {
		p.once.Do(func() {})
	}
	return &Catalog{pin: p, places: p.places}
}

// New returns an empty catalog.
func New() *Catalog {
	return &Catalog{digests: make(map[model.SessionKey]*model.SessionDigest)}
}

// Load builds a catalog from every digest in the store for harness ("" = all harnesses).
// Unreadable digests are skipped (the store reports them through its Warn callback).
func Load(st *store.Store, harness string) (*Catalog, error) {
	refs, err := st.List(harness)
	if err != nil {
		return nil, err
	}
	c := New()
	for _, r := range refs {
		d, found, err := st.Read(r)
		if err != nil {
			return nil, err
		}
		if found {
			c.Upsert(d)
		}
	}
	return c, nil
}

// SetLocation fixes the time zone used for day buckets. By default time.Local is used,
// read when the derived state is rebuilt (a change of time.Local triggers a rebuild).
func (c *Catalog) SetLocation(loc *time.Location) {
	c.mu.Lock()
	c.loc = loc
	c.touch()
	c.mu.Unlock()
}

// Upsert adds or replaces a session digest. When the session is already held under another
// project key (its directory was renamed, so the store has a stale copy and a live one), the
// better digest stays: one whose source is present beats one whose source is missing, then
// the later last activity, then the greater project key, so the order of calls does not matter.
func (c *Catalog) Upsert(d *model.SessionDigest) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if old, ok := c.digests[d.Key()]; ok && old.ProjectKey != d.ProjectKey && !preferred(d, old) {
		return
	}
	c.digests[d.Key()] = d
	c.touch()
}

// touch records a write; callers hold mu.
func (c *Catalog) touch() {
	c.gen++
	c.lastWrite = time.Now()
}

// preferred reports whether a beats b, two digests of one session under different project keys.
func preferred(a, b *model.SessionDigest) bool {
	if a.SourceMissing != b.SourceMissing {
		return !a.SourceMissing
	}
	if !a.LastActivityAt.Equal(b.LastActivityAt) {
		return a.LastActivityAt.After(b.LastActivityAt)
	}
	return a.ProjectKey > b.ProjectKey
}

// MarkMissing flags the source files of a session under one project key as gone, as the
// store does on disk. It reports whether that digest was held: a digest of the same session
// under another project key is left alone.
func (c *Catalog) MarkMissing(key model.SessionKey, projectKey string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	d, ok := c.digests[key]
	if !ok || d.ProjectKey != projectKey {
		return false
	}
	if !d.SourceMissing {
		cp := *d
		cp.SourceMissing = true
		c.digests[key] = &cp
		c.touch()
	}
	return true
}

// Remove forgets a session. It reports whether the session was known.
func (c *Catalog) Remove(key model.SessionKey) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.digests[key]
	if ok {
		delete(c.digests, key)
		c.touch()
	}
	return ok
}

// Len returns the number of digests held, error stubs included.
func (c *Catalog) Len() int {
	if c.pin != nil {
		return len(c.pin.src)
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.digests)
}

// Digest returns the stored digest of a session.
func (c *Catalog) Digest(key model.SessionKey) (*model.SessionDigest, bool) {
	if c.pin != nil {
		d, ok := c.pin.src[key]
		return d, ok
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	d, ok := c.digests[key]
	return d, ok
}

// Each calls f with every stored digest, in no particular order, under the read lock: f must
// not call back into the catalog or modify the digest.
func (c *Catalog) Each(f func(*model.SessionDigest)) {
	if c.pin != nil {
		for _, d := range c.pin.src {
			f(d)
		}
		return
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, d := range c.digests {
		f(d)
	}
}

// view returns the derived state. The returned view is immutable. See current.
func (c *Catalog) view() *view {
	v, _ := c.current(false)
	return v
}

// current returns the derived state (and, when withFacets, the groupings), rebuilding what a
// write, a change of time.Local or SetPlaces made stale. Writers never wait for a build: it
// runs on a copy of the digest map, outside mu, one at a time (readers that need one wait for
// the build in flight and then reuse it). While writes keep coming, a view younger than the
// freshness bound is good enough (SetFreshness).
func (c *Catalog) current(withFacets bool) (*view, *facets) {
	if p := c.pin; p != nil {
		if withFacets {
			p.once.Do(func() { p.fv = buildFacets(p.v, p.places, p.gen) })
		}
		return p.v, p.fv
	}
	if v, fv, ok := c.cached(withFacets); ok {
		return v, fv
	}
	c.buildMu.Lock()
	defer c.buildMu.Unlock()
	if v, fv, ok := c.cached(withFacets); ok {
		return v, fv
	}
	c.mu.RLock()
	zone, gen, pgen, places := c.zone(), c.gen, c.placesGen, c.places
	v, vGen := c.v, c.vGen
	var src map[model.SessionKey]*model.SessionDigest
	if v == nil || v.loc != zone || vGen != gen {
		src = make(map[model.SessionKey]*model.SessionDigest, len(c.digests))
		for k, d := range c.digests {
			src[k] = d
		}
	}
	fv := c.fv
	c.mu.RUnlock()

	vAt := time.Now()
	if src != nil {
		v = build(src, zone)
		v.src, v.id = src, viewIDs.Add(1)
		vGen = gen
	}
	if withFacets && (fv == nil || fv.v != v || fv.gen != pgen) {
		fv = buildFacets(v, places, pgen)
	} else if fv != nil && fv.v != v {
		fv = nil
	}
	c.mu.Lock()
	if src != nil {
		c.v, c.vGen, c.vAt = v, vGen, vAt
	}
	if fv != nil {
		c.fv = fv
	}
	c.mu.Unlock()
	return v, fv
}

// cached answers from what is held when that is fresh enough.
func (c *Catalog) cached(withFacets bool) (*view, *facets, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v := c.v
	if v == nil || v.loc != c.zone() {
		return nil, nil, false
	}
	if c.vGen != c.gen {
		busy := time.Since(c.lastWrite) < c.fresh/10
		if c.fresh <= 0 || !busy || time.Since(c.vAt) >= c.fresh {
			return nil, nil, false
		}
	}
	if !withFacets {
		return v, c.fv, true
	}
	if fv := c.fv; fv != nil && fv.v == v && fv.gen == c.placesGen {
		return v, fv, true
	}
	return nil, nil, false
}

// zone is the effective location; callers hold mu.
func (c *Catalog) zone() *time.Location {
	if c.loc != nil {
		return c.loc
	}
	return time.Local
}

// Diagnostics returns the counters of the current derived state.
func (c *Catalog) Diagnostics() Diagnostics { return c.view().diag }

// Session returns the derived information about one session (scripted ones included).
func (c *Catalog) Session(key model.SessionKey) (SessionInfo, bool) {
	s, ok := c.view().byKey[key]
	if !ok {
		return SessionInfo{}, false
	}
	return s.info, true
}

// Family returns the family a session belongs to.
func (c *Catalog) Family(key model.SessionKey) (Family, bool) {
	v := c.view()
	s, ok := v.byKey[key]
	if !ok {
		return Family{}, false
	}
	return v.family(s), true
}
