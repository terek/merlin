package server

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
)

// scopeSearchLimit is how many full-text hits the Overview's search takes (GET /api/search's
// default limit, which the page asks with).
const scopeSearchLimit = defaultLimit

// scope reads the Overview's scope off a request into f: `place` (dir, checkout, repo, remote or
// bead; dir by default) with `in`, a path in it, and `q`, the Overview's search. With either of
// `in` and `q` the scripted runs are out, as they are on the Overview.
func (a *API) scope(cat *catalog.Catalog, q url.Values, f *catalog.Filter) error {
	place, in, term := q.Get("place"), q.Get("in"), strings.TrimSpace(q.Get("q"))
	if place != "" && !catalog.ValidPlace(place) {
		return fmt.Errorf("place=%q: use dir, checkout, repo, remote or bead", place)
	}
	if in != "" {
		if place == "" {
			place = catalog.PlaceDir
		}
		f.Place, f.In = place, in
	}
	if term != "" {
		f.Only = a.searchKeys(cat, term)
	}
	f.NoScripted = in != "" || term != ""
	return nil
}

// searchKeys are the sessions the Overview's search keeps: the term (case-insensitive) is in the
// session's name, title, id, recap, first prompt or last prompt, or, for a term of two characters or
// more, the session is among the first hits of the full-text search (laneMatches in model.ts).
func (a *API) searchKeys(cat *catalog.Catalog, raw string) map[model.SessionKey]bool {
	term := strings.ToLower(raw)
	out := map[model.SessionKey]bool{}
	var hits map[model.SessionKey]bool
	if len([]rune(term)) >= 2 {
		hits = map[model.SessionKey]bool{}
		for i, h := range cat.Search(raw, catalog.SearchOptions{Limit: scopeSearchLimit + 1}) {
			if i < scopeSearchLimit {
				hits[h.Session] = true
			}
		}
	}
	for _, in := range cat.List(catalog.Filter{}, catalog.Liveness{}).Sessions {
		l := overviewLane(cat, catalog.OverviewLane{Harness: in.Key.Harness, ID: in.Key.ID, Title: in.Title})
		hay := []string{l.Name, l.Title, l.ID}
		if l.Recap != nil {
			hay = append(hay, l.Recap.Text)
		}
		if l.FirstPrompt != nil {
			hay = append(hay, l.FirstPrompt.Text)
		}
		if l.LastPrompt != nil {
			hay = append(hay, l.LastPrompt.Text)
		}
		match := hits[in.Key]
		for _, t := range hay {
			if !match && strings.Contains(strings.ToLower(t), term) {
				match = true
			}
		}
		if match {
			out[in.Key] = true
		}
	}
	return out
}
