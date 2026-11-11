package server

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/terek/merlin/internal/catalog"
)

// overviewDefaultRange is the span of GET /api/overview when from is not given.
const overviewDefaultRange = 7 * 24 * time.Hour

// parseInstant reads an RFC 3339 time or Unix milliseconds.
func parseInstant(name, s string) (time.Time, error) {
	if ms, err := strconv.ParseInt(s, 10, 64); err == nil {
		return time.UnixMilli(ms).UTC(), nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), nil
	}
	return time.Time{}, errors.New(name + "=" + strconv.Quote(s) + ": use an RFC 3339 time (2026-11-04T00:00:00Z) or Unix milliseconds")
}

func (a *API) handleOverview(w http.ResponseWriter, r *http.Request) {
	cat := a.cat(w)
	if cat == nil {
		return
	}
	q := r.URL.Query()
	var (
		qq  catalog.OverviewQuery
		err error
	)
	switch by := q.Get("by"); by {
	case "", "dir", "project":
		qq.By = catalog.GroupDir
	case "checkout", "repo", "remote":
		qq.By = catalog.GroupBy(by)
	default:
		a.badParam(w, "by=%q: use dir (or project), checkout, repo or remote", by)
		return
	}
	if s := q.Get("slot"); s != "" {
		for _, d := range catalog.OverviewSlots {
			if catalog.OverviewSlotName(d) == s {
				qq.Slot = d
			}
		}
		if qq.Slot == 0 {
			a.badParam(w, "slot=%q: use 1m, 2m, 5m, 10m, 15m, 30m, 1h, 2h, 3h, 6h, 12h or 1d", s)
			return
		}
	}
	qq.To = a.o.Now().UTC()
	if s := q.Get("to"); s != "" {
		if qq.To, err = parseInstant("to", s); err != nil {
			a.paramError(w, err)
			return
		}
	}
	qq.From = qq.To.Add(-overviewDefaultRange)
	if s := q.Get("from"); s != "" {
		if qq.From, err = parseInstant("from", s); err != nil {
			a.paramError(w, err)
			return
		}
	}
	if q.Has("group") {
		g := q.Get("group")
		qq.Group = &g
	}
	o, err := cat.Overview(qq)
	var oe *catalog.OverviewError
	if errors.As(err, &oe) {
		a.paramError(w, err)
		return
	}
	if err != nil {
		a.fail(w, http.StatusInternalServerError, CodeInternal, err.Error())
		return
	}
	a.json(w, http.StatusOK, Overview(o))
}
