package catalog

import (
	"sort"

	"github.com/terek/merlin/explorer/internal/model"
)

// List returns the sessions selected by f, newest last activity first, plus the aggregate
// lines for scripted sessions. Scripted (sdk) sessions are never listed individually.
// lv supplies liveness: it fills SessionInfo.State and is needed for f.States.
func (c *Catalog) List(f Filter, lv Liveness) Listing {
	v := c.view()
	var l Listing
	for _, s := range v.sessions {
		if s.d.Kind == model.KindSDK {
			continue
		}
		st := lv.StateOf(s.key, s.d.LastActivityAt)
		if !f.selects(s, st) {
			continue
		}
		in := s.info
		if lv.known() {
			in.State = st
		}
		l.Sessions = append(l.Sessions, in)
	}
	sort.SliceStable(l.Sessions, func(i, j int) bool {
		a, b := l.Sessions[i], l.Sessions[j]
		if !a.LastActivityAt.Equal(b.LastActivityAt) {
			return a.LastActivityAt.After(b.LastActivityAt)
		}
		if a.Key.Harness != b.Key.Harness {
			return a.Key.Harness < b.Key.Harness
		}
		return a.Key.ID < b.Key.ID
	})
	l.Scripted = v.scripted(f)
	return l
}

// StateOf returns the liveness of one session.
func (c *Catalog) StateOf(key model.SessionKey, lv Liveness) (State, bool) {
	s, ok := c.view().byKey[key]
	if !ok {
		return "", false
	}
	return lv.StateOf(key, s.d.LastActivityAt), true
}
