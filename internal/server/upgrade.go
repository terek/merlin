package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// handleUpgrade is POST /api/upgrade: install the release the update event announced. The
// response is written before the daemon restarts; the caller of Install does that.
func (a *API) handleUpgrade(w http.ResponseWriter, r *http.Request) {
	var req UpgradeRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	if err := dec.Decode(&req); err != nil {
		a.badParam(w, "the body must be JSON like {\"version\":\"1.2.3\"}")
		return
	}
	req.Version = strings.TrimPrefix(strings.TrimSpace(req.Version), "v")
	if req.Version == "" {
		a.badParam(w, "version is required")
		return
	}
	if err := a.o.Install(r.Context(), req.Version); err != nil {
		if errors.Is(err, ErrConflict) {
			a.fail(w, http.StatusConflict, CodeConflict, err.Error())
		} else {
			a.fail(w, http.StatusInternalServerError, CodeInternal, err.Error())
		}
		return
	}
	a.json(w, http.StatusOK, UpgradeResponse{Version: req.Version, Restarting: true})
}
