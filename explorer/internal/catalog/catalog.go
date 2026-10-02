package catalog

import (
	"sync"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/store"
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
	dirty   bool
}

// New returns an empty catalog.
func New() *Catalog {
	return &Catalog{digests: make(map[model.SessionKey]*model.SessionDigest), dirty: true}
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
			c.digests[d.Key()] = d
		}
	}
	return c, nil
}

// SetLocation fixes the time zone used for day buckets. By default time.Local is used,
// read when the derived state is rebuilt (a change of time.Local triggers a rebuild).
func (c *Catalog) SetLocation(loc *time.Location) {
	c.mu.Lock()
	c.loc = loc
	c.dirty = true
	c.mu.Unlock()
}

// Upsert adds or replaces a session digest.
func (c *Catalog) Upsert(d *model.SessionDigest) {
	c.mu.Lock()
	c.digests[d.Key()] = d
	c.dirty = true
	c.mu.Unlock()
}

// MarkMissing flags a session's source files as gone, as the store does on disk. It
// reports whether the session was known.
func (c *Catalog) MarkMissing(key model.SessionKey) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	d, ok := c.digests[key]
	if !ok {
		return false
	}
	if !d.SourceMissing {
		cp := *d
		cp.SourceMissing = true
		c.digests[key] = &cp
		c.dirty = true
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
		c.dirty = true
	}
	return ok
}

// Len returns the number of digests held, error stubs included.
func (c *Catalog) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.digests)
}

// Digest returns the stored digest of a session.
func (c *Catalog) Digest(key model.SessionKey) (*model.SessionDigest, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	d, ok := c.digests[key]
	return d, ok
}

// view returns the derived state, rebuilding it first when a write or a change of
// time.Local made it stale. The returned view is immutable.
func (c *Catalog) view() *view {
	c.mu.RLock()
	if v := c.v; v != nil && !c.dirty && c.v.loc == c.zone() {
		c.mu.RUnlock()
		return v
	}
	c.mu.RUnlock()

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.v == nil || c.dirty || c.v.loc != c.zone() {
		c.v = build(c.digests, c.zone())
		c.dirty = false
	}
	return c.v
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
