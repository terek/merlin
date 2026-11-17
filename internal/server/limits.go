package server

import (
	"encoding/hex"
	"fmt"
	"net/http"
)

// handleLimits serves GET /api/limits: the usage-limit windows and refusals.
func (a *API) handleLimits(w http.ResponseWriter, r *http.Request) {
	cat := a.cat(w)
	if cat == nil {
		return
	}
	a.json(w, http.StatusOK, cat.LimitsAt(a.o.Now()))
}

func validateAccount(s string) error {
	if s == "" || s == "unknown" {
		return nil
	}
	if len(s) == 64 {
		if _, err := hex.DecodeString(s); err == nil {
			return nil
		}
	}
	return fmt.Errorf("account=%q: use an account key from /api/limits or unknown", s)
}
