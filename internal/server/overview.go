package server

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
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
	out := Overview{Overview: o, Lanes: make([]OverviewLane, len(o.Lanes))}
	for i, l := range o.Lanes {
		out.Lanes[i] = overviewLane(cat, l)
	}
	a.json(w, http.StatusOK, out)
}

// overviewLane adds the session's name and previews to a catalog lane.
func overviewLane(cat *catalog.Catalog, l catalog.OverviewLane) OverviewLane {
	out := OverviewLane{OverviewLane: l}
	key := model.SessionKey{Harness: l.Harness, ID: l.ID}
	in, _ := cat.Session(key)
	out.Name = in.Name
	if d, ok := cat.Digest(key); ok {
		out.Recap = lastRecap(d)
		if p := lastPrompt(d); p != nil && p.Text != "" {
			out.LastPrompt = p // a prompt with no text says nothing to a row
		}
		out.FirstPrompt = firstPrompt(d, in.InheritedTurns)
	}
	return out
}

// firstPrompt is the session's opening ask: the first human turn with a prompt. A session
// that inherited turns (a fork) prefers its first own one.
func firstPrompt(d *model.SessionDigest, inherited []int) *PromptPreview {
	skip := make(map[int]bool, len(inherited))
	for _, i := range inherited {
		skip[i] = true
	}
	var first *model.Turn
	for i := range d.Turns {
		t := &d.Turns[i]
		if t.Origin != model.OriginHuman || strings.TrimSpace(t.UserText) == "" {
			continue
		}
		if !skip[t.Index] {
			first = t
			break
		}
		if first == nil {
			first = t
		}
	}
	if first == nil {
		return nil
	}
	text, cut := Preview(first.UserText)
	return &PromptPreview{Turn: first.Index, At: first.StartedAt, Text: text, Truncated: cut}
}
