package server

import (
	"net/http"
	"sort"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/harness"
	"github.com/terek/merlin/internal/model"
)

// HarnessList is the body of GET /api/harnesses.
type HarnessList struct {
	Harnesses []harness.Info `json:"harnesses"`
}

// knownHarness reports whether name is a configured harness or has sessions in the catalog.
func (a *API) knownHarness(cat *catalog.Catalog, name string) bool {
	for _, in := range a.o.Harnesses {
		if in.Name == name {
			return true
		}
	}
	found := false
	cat.Each(func(d *model.SessionDigest) {
		if d.Harness == name {
			found = true
		}
	})
	return found
}

// handleHarnesses describes every configured harness, and every other harness that has
// sessions in the catalog by its bare name (see harness.Describe).
func (a *API) handleHarnesses(w http.ResponseWriter, r *http.Request) {
	out := append([]harness.Info{}, a.o.Harnesses...)
	if cat := a.o.Catalog(); cat != nil {
		seen := map[string]bool{}
		for _, in := range out {
			seen[in.Name] = true
		}
		var extra []string
		cat.Each(func(d *model.SessionDigest) {
			if !seen[d.Harness] {
				seen[d.Harness] = true
				extra = append(extra, d.Harness)
			}
		})
		sort.Strings(extra)
		for _, name := range extra {
			out = append(out, harness.Describe(nil, name))
		}
	}
	a.json(w, http.StatusOK, HarnessList{Harnesses: out})
}
