package server

import (
	"net/http"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/moments"
)

// momentInputs collects every stored digest with the turns it copied from a parent and the
// repository it counts under.
func momentInputs(cat *catalog.Catalog) []moments.Input {
	var ds []*model.SessionDigest
	cat.Each(func(d *model.SessionDigest) { ds = append(ds, d) })
	in := make([]moments.Input, 0, len(ds))
	for _, d := range ds {
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

func (a *API) handleMoments(w http.ResponseWriter, r *http.Request) {
	cat := a.cat(w)
	if cat == nil {
		return
	}
	a.json(w, http.StatusOK, moments.Build(momentInputs(cat), a.o.Now(), a.loc()))
}
