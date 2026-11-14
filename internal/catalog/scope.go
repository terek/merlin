package catalog

import (
	"slices"
	"strings"

	"github.com/terek/merlin/internal/beads"
)

// The Overview's scope (web/src/features/overview/model.ts: placeOf, underPath): a place key
// (dir, checkout, repo, remote or bead) and a path in it. GET /api/overview puts a session's
// primary value of each key on its lane; GET /api/cost takes the same `place` and `in` and keeps
// the sessions whose value sits at or under the path. Both read the values from here.

// Place keys of a scope.
const (
	PlaceDir      = "dir"
	PlaceCheckout = "checkout"
	PlaceRepo     = "repo"
	PlaceRemote   = "remote"
	PlaceBead     = "bead"
)

// NoPlace is the `in` of the sessions with no value for the key.
const NoPlace = "-"

// ValidPlace reports whether k is a place key.
func ValidPlace(k string) bool {
	switch k {
	case PlaceDir, PlaceCheckout, PlaceRepo, PlaceRemote, PlaceBead:
		return true
	}
	return false
}

func splitPlace(p string) []string {
	return strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' })
}

// UnderPath reports whether a place value sits at or under the selected path, segment-wise. sel
// "" selects everything, NoPlace the sessions with no value (key ""). A repository's trailing
// .git or .bare segment does not count. A bead's key is its path: prefix/root/.../bead (BeadPath).
func UnderPath(key, sel, place string) bool {
	if sel == "" {
		return true
	}
	if sel == NoPlace {
		return key == ""
	}
	if key == "" {
		return false
	}
	want, have := splitPlace(sel), splitPlace(key)
	if place == PlaceRepo {
		if n := len(have); n > 0 && (have[n-1] == ".git" || have[n-1] == ".bare") {
			have = have[:n-1]
		}
	}
	return len(want) <= len(have) && slices.Equal(want, have[:len(want)])
}

// BeadPath is where a bead sits in the tree: its prefix, then its family root and the ancestors
// down to the bead (the chain /api/overview's `beads` holds). "" for no bead.
func (fv *facets) BeadPath(id string) string {
	if id == "" {
		return ""
	}
	chain := []string{id}
	for b, ok := fv.bead[id]; ok && b.Parent != ""; b, ok = fv.bead[b.Parent] {
		if slices.Contains(chain, b.Parent) {
			break
		}
		chain = append(chain, b.Parent)
	}
	slices.Reverse(chain)
	if p := beads.Prefix(id); p != "" {
		chain = append([]string{p}, chain...)
	}
	return strings.Join(chain, "/")
}

// placeValues are a session's primary value of each place key, as a lane carries them: bead is
// the bead id with the largest share of its bead-attributed cost.
func (fv *facets) placeValues(s *sess) (dir, checkout, repo, remote, bead string) {
	sf := &fv.ses[s.idx]
	if b := fv.topValue(sf, GroupBead); b != NoBead {
		bead = b
	}
	return sf.dir, sf.checkout, sf.repo, sf.remote, bead
}

// inScope reports whether the session's value of the filter's place key sits under f.In.
func (fv *facets) inScope(f Filter, s *sess) bool {
	dir, checkout, repo, remote, bead := fv.placeValues(s)
	key := map[string]string{PlaceDir: dir, PlaceCheckout: checkout, PlaceRepo: repo, PlaceRemote: remote}[f.Place]
	if f.Place == PlaceBead {
		key = fv.BeadPath(bead)
	}
	return UnderPath(key, f.In, f.Place)
}
