package server

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/model"
)

const (
	defaultLimit = 50
	maxLimit     = 500
	dayLayout    = "2006-01-02"
)

// parseTime reads an RFC 3339 instant or a date (midnight in loc). For a date, end
// returns the start of the next day, so that "until=2026-10-02" includes that day.
func parseTime(name, s string, loc *time.Location, end bool) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	if t, err := time.ParseInLocation(dayLayout, s, loc); err == nil {
		if end {
			t = t.AddDate(0, 0, 1)
		}
		return t, nil
	}
	return time.Time{}, fmt.Errorf("%s=%q: use an RFC 3339 time (2026-10-01T09:30:00Z) or a date (2026-10-01)", name, s)
}

// timeRange reads since and until.
func (a *API) timeRange(q url.Values) (since, until time.Time, err error) {
	if s := q.Get("since"); s != "" {
		if since, err = parseTime("since", s, a.loc(), false); err != nil {
			return
		}
	}
	if s := q.Get("until"); s != "" {
		if until, err = parseTime("until", s, a.loc(), true); err != nil {
			return
		}
	}
	if !since.IsZero() && !until.IsZero() && !since.Before(until) {
		err = errors.New("since must be before until")
	}
	return
}

// listParam splits a parameter that may be repeated or comma separated.
func listParam(q url.Values, name string) []string {
	var out []string
	for _, v := range q[name] {
		for _, f := range strings.Split(v, ",") {
			if f = strings.TrimSpace(f); f != "" {
				out = append(out, f)
			}
		}
	}
	return out
}

func parseKinds(q url.Values) ([]model.SessionKind, error) {
	var out []model.SessionKind
	for _, s := range listParam(q, "kind") {
		switch k := model.SessionKind(s); k {
		case model.KindInteractive, model.KindBackground:
			out = append(out, k)
		case model.KindSDK:
			return nil, errors.New("kind=sdk: scripted runs are served only in aggregate (scripted lines, /api/cost?by=kind)")
		default:
			return nil, fmt.Errorf("kind=%q: use interactive or background", s)
		}
	}
	return out, nil
}

func parseStates(q url.Values) ([]catalog.State, error) {
	var out []catalog.State
	for _, s := range listParam(q, "state") {
		switch s {
		case "running":
			out = append(out, catalog.StateBusy, catalog.StateIdle)
		case "busy", "idle", "recent", "ended":
			out = append(out, catalog.State(s))
		default:
			return nil, fmt.Errorf("state=%q: use running, recent or ended", s)
		}
	}
	return out, nil
}

func parseLimit(q url.Values, def int) (int, error) {
	s := q.Get("limit")
	if s == "" {
		return def, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 || n > maxLimit {
		return 0, fmt.Errorf("limit=%q: use a number from 1 to %d", s, maxLimit)
	}
	return n, nil
}

// filter reads the filters the list and search endpoints share.
func (a *API) filter(q url.Values) (catalog.Filter, error) {
	var f catalog.Filter
	var err error
	f.Project = q.Get("project")
	if f.Kinds, err = parseKinds(q); err != nil {
		return f, err
	}
	f.Since, f.Until, err = a.timeRange(q)
	return f, err
}

// cursor is the position after the last session of a page, in list order (last activity,
// newest first; then harness and id ascending).
type cursor struct {
	at  time.Time
	key model.SessionKey
}

func (c cursor) encode() string {
	return b64.EncodeToString([]byte(c.at.UTC().Format(time.RFC3339Nano) + "|" + c.key.Harness + "|" + c.key.ID))
}

func parseCursor(s string) (cursor, error) {
	raw, err := b64.DecodeString(s)
	if err == nil {
		if p := strings.SplitN(string(raw), "|", 3); len(p) == 3 {
			var at time.Time
			if at, err = time.Parse(time.RFC3339Nano, p[0]); err == nil {
				return cursor{at: at, key: model.SessionKey{Harness: p[1], ID: p[2]}}, nil
			}
		}
	}
	return cursor{}, errors.New("cursor is not one this API returned")
}

// follows reports whether a session at (at, key) comes after the cursor in list order.
func (c cursor) follows(at time.Time, key model.SessionKey) bool {
	if !at.Equal(c.at) {
		return at.Before(c.at)
	}
	if key.Harness != c.key.Harness {
		return key.Harness > c.key.Harness
	}
	return key.ID > c.key.ID
}

func (a *API) paramError(w http.ResponseWriter, err error) {
	a.fail(w, http.StatusBadRequest, CodeInvalidParameter, err.Error())
}

var b64 = base64.RawURLEncoding
