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

// Trees returns the trees of linked sessions that have a member selected by f, newest last
// activity of the tree first (then root harness and id). Each tree holds all its members,
// selected or not; scripted sessions are left out.
func (c *Catalog) Trees(f Filter, lv Liveness) []Tree {
	v := c.view()
	var out []Tree
	seen := make(map[model.SessionKey]bool)
	for _, s := range v.sessions {
		if s.d.Kind == model.KindSDK || seen[s.info.Root] || !f.selects(s, lv.StateOf(s.key, s.d.LastActivityAt)) {
			continue
		}
		seen[s.info.Root] = true
		fam := v.family(s)
		t := Tree{Root: fam.Root}
		for _, k := range fam.Members {
			m := v.byKey[k]
			if m.d.Kind == model.KindSDK {
				continue
			}
			in := m.info
			if lv.known() {
				in.State = lv.StateOf(k, m.d.LastActivityAt)
			}
			t.Members = append(t.Members, in)
			t.BestUSD += in.Cost.BestUSD
			if in.LastActivityAt.After(t.LastActivityAt) {
				t.LastActivityAt = in.LastActivityAt
			}
		}
		t.Open = t.Members[0].Key
		for _, k := range fam.Leaves {
			if v.byKey[k].d.Kind != model.KindSDK {
				t.Open = k
				break
			}
		}
		out = append(out, t)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if !a.LastActivityAt.Equal(b.LastActivityAt) {
			return a.LastActivityAt.After(b.LastActivityAt)
		}
		if a.Root.Harness != b.Root.Harness {
			return a.Root.Harness < b.Root.Harness
		}
		return a.Root.ID < b.Root.ID
	})
	return out
}

// StateOf returns the liveness of one session.
func (c *Catalog) StateOf(key model.SessionKey, lv Liveness) (State, bool) {
	s, ok := c.view().byKey[key]
	if !ok {
		return "", false
	}
	return lv.StateOf(key, s.d.LastActivityAt), true
}

// States returns the liveness of every listable (not scripted) session.
func (c *Catalog) States(lv Liveness) map[model.SessionKey]State {
	v := c.view()
	out := make(map[model.SessionKey]State, len(v.sessions))
	for _, s := range v.sessions {
		if s.d.Kind != model.KindSDK {
			out[s.key] = lv.StateOf(s.key, s.d.LastActivityAt)
		}
	}
	return out
}
