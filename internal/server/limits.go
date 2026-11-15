package server

import "net/http"

// handleLimits serves GET /api/limits: the usage-limit windows and refusals.
func (a *API) handleLimits(w http.ResponseWriter, r *http.Request) {
	cat := a.cat(w)
	if cat == nil {
		return
	}
	a.json(w, http.StatusOK, cat.Limits())
}
