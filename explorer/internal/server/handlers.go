package server

import (
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/model"
)

// summarize turns the catalog's view of a session into the summary the API shows.
func summarize(cat *catalog.Catalog, in catalog.SessionInfo, state catalog.State) SessionSummary {
	s := SessionSummary{
		Key: in.Key, Project: in.Project, ProjectKey: in.ProjectKey, Cwd: in.Cwd, Branch: in.Branch,
		Title: in.Title, Name: in.Name, Kind: in.Kind, StartedAt: in.StartedAt,
		LastActivityAt: in.LastActivityAt, EndState: in.EndState, SourceMissing: in.SourceMissing,
		State: state, Turns: in.Turns,
		Cost: CostBrief{BestUSD: in.Cost.BestUSD, Flag: in.Cost.Flag, ReportedUSD: in.Cost.ReportedUSD,
			UncoveredUSD: in.Cost.UncoveredUSD, OverheadUSD: in.Cost.OverheadUSD, InheritedUSD: in.Cost.InheritedUSD},
		Lineage: LineageBrief{Children: len(in.Children), Root: in.Root, Leaf: in.Leaf,
			InheritedTurns: len(in.InheritedTurns), FirstOwnTurn: in.FirstOwnTurn},
	}
	if in.Parent != nil {
		p := in.Parent.Parent
		s.Lineage.Parent, s.Lineage.ParentKind = &p, in.Parent.Kind
	}
	if d, ok := cat.Digest(in.Key); ok {
		s.HumanTurns = int(d.Stats.HumanTurns)
		s.LastPrompt = lastPrompt(d)
		s.Recap = lastRecap(d)
		for i := range d.Agents {
			if d.Agents[i].Kind != model.AgentCompact {
				s.Agents++
			}
		}
	}
	return s
}

func (a *API) handleProjects(w http.ResponseWriter, r *http.Request) {
	cat := a.cat(w)
	if cat == nil {
		return
	}
	out := ProjectList{Projects: []ProjectSummary{}}
	for _, pf := range cat.ProjectFiles() {
		p := ProjectSummary{Harness: pf.Harness, ProjectKey: pf.ProjectKey, Project: pf.Project, Sessions: len(pf.Sessions)}
		for _, s := range pf.Sessions {
			p.Cost.ReportedUSD += s.Cost.ReportedUSD
			p.Cost.AttributedUSD += s.Cost.UncoveredUSD
			p.Cost.TotalUSD += s.Cost.BestUSD
			if s.LastActivityAt.After(p.LastActivityAt) {
				p.LastActivityAt = s.LastActivityAt
			}
		}
		for _, l := range pf.Scripted {
			p.ScriptedRuns += l.Count
			p.Cost.ReportedUSD += l.ReportedUSD
			p.Cost.AttributedUSD += l.AttributedUSD
			p.Cost.TotalUSD += l.TotalUSD
		}
		out.Projects = append(out.Projects, p)
	}
	sort.SliceStable(out.Projects, func(i, j int) bool {
		return out.Projects[i].LastActivityAt.After(out.Projects[j].LastActivityAt)
	})
	a.json(w, http.StatusOK, out)
}

func (a *API) handleSessions(w http.ResponseWriter, r *http.Request) {
	cat := a.cat(w)
	if cat == nil {
		return
	}
	q := r.URL.Query()
	f, err := a.filter(q)
	if err == nil {
		f.States, err = parseStates(q)
	}
	var limit int
	if err == nil {
		limit, err = parseLimit(q, defaultLimit)
	}
	var cur *cursor
	if s := q.Get("cursor"); err == nil && s != "" {
		var c cursor
		if c, err = parseCursor(s); err == nil {
			cur = &c
		}
	}
	if err != nil {
		a.paramError(w, err)
		return
	}

	lv := a.liveness()
	l := cat.List(f, lv)
	out := SessionList{Sessions: []SessionSummary{}, Total: len(l.Sessions), Scripted: []catalog.ScriptedLine{}}
	rest := l.Sessions
	if cur != nil {
		i := sort.Search(len(rest), func(i int) bool { return cur.follows(rest[i].LastActivityAt, rest[i].Key) })
		rest = rest[i:]
	} else if l.Scripted != nil {
		out.Scripted = l.Scripted
	}
	if len(rest) > limit {
		rest = rest[:limit]
		last := rest[limit-1]
		out.NextCursor = cursor{at: last.LastActivityAt, key: last.Key}.encode()
	}
	for _, in := range rest {
		out.Sessions = append(out.Sessions, summarize(cat, in, in.State))
	}
	a.json(w, http.StatusOK, out)
}

// resolve finds the session a path names: an exact id, else a unique id prefix among the
// listed (non-scripted) sessions. On failure it has answered.
func (a *API) resolve(w http.ResponseWriter, cat *catalog.Catalog, harness, id string) (model.SessionKey, bool) {
	id = strings.ToLower(id)
	exact := model.SessionKey{Harness: harness, ID: id}
	if _, ok := cat.Session(exact); ok {
		return exact, true
	}
	var matches []catalog.SessionInfo
	for _, in := range cat.List(catalog.Filter{Harness: harness}, catalog.Liveness{}).Sessions {
		if strings.HasPrefix(strings.ToLower(in.Key.ID), id) {
			matches = append(matches, in)
		}
	}
	switch len(matches) {
	case 0:
		a.fail(w, http.StatusNotFound, CodeNotFound, "no session "+harness+"/"+id)
		return exact, false
	case 1:
		return matches[0].Key, true
	}
	e := ErrorInfo{Code: CodeAmbiguousID, Message: "the id prefix matches several sessions; give more characters"}
	for i, in := range matches {
		if i == 20 {
			break
		}
		e.Candidates = append(e.Candidates, Candidate{Key: in.Key, Title: in.Title, Project: in.Project, LastActivityAt: in.LastActivityAt})
	}
	a.failWith(w, http.StatusConflict, e)
	return exact, false
}

func (a *API) handleSession(w http.ResponseWriter, r *http.Request) {
	cat := a.cat(w)
	if cat == nil {
		return
	}
	withMessages := false
	switch v := r.URL.Query().Get("messages"); v {
	case "", "0", "false":
	case "1", "true":
		withMessages = true
	default:
		a.badParam(w, "messages=%q: use 1 or 0", v)
		return
	}
	key, ok := a.resolve(w, cat, r.PathValue("harness"), r.PathValue("id"))
	if !ok {
		return
	}
	in, ok := cat.Session(key)
	d, ok2 := cat.Digest(key)
	if !ok || !ok2 {
		a.fail(w, http.StatusNotFound, CodeNotFound, "no session "+key.String())
		return
	}
	lv := a.liveness()
	state := lv.StateOf(key, in.LastActivityAt)

	out := SessionDetail{
		Summary:      summarize(cat, in, state),
		Cost:         in.Cost,
		MessageCount: len(d.Messages),
		Lineage: SessionLineage{Parent: in.Parent, Children: in.Children, Root: in.Root, Leaf: in.Leaf,
			InheritedTurns: in.InheritedTurns, FirstOwnTurn: in.FirstOwnTurn},
	}
	if out.Lineage.Children == nil {
		out.Lineage.Children = []catalog.Link{}
	}
	if out.Lineage.InheritedTurns == nil {
		out.Lineage.InheritedTurns = []int{}
	}
	out.Family = a.family(cat, key, lv)
	dc := *d
	if !withMessages {
		dc.Messages = nil
	}
	out.Digest = &dc
	a.json(w, http.StatusOK, out)
}

func (a *API) family(cat *catalog.Catalog, key model.SessionKey, lv catalog.Liveness) SessionFamily {
	fam, ok := cat.Family(key)
	out := SessionFamily{Root: key, Members: []FamilyMember{}, Leaves: []model.SessionKey{}}
	if !ok {
		return out
	}
	out.Root = fam.Root
	if fam.Leaves != nil {
		out.Leaves = fam.Leaves
	}
	for _, k := range fam.Members {
		in, ok := cat.Session(k)
		if !ok {
			continue
		}
		m := FamilyMember{Key: k, Title: in.Title, Kind: in.Kind, StartedAt: in.StartedAt,
			LastActivityAt: in.LastActivityAt, State: lv.StateOf(k, in.LastActivityAt), Leaf: in.Leaf,
			Turns: in.Turns, BestUSD: in.Cost.BestUSD}
		if in.Parent != nil {
			p := in.Parent.Parent
			m.Parent = &p
		}
		out.Members = append(out.Members, m)
	}
	return out
}

func (a *API) handleSearch(w http.ResponseWriter, r *http.Request) {
	cat := a.cat(w)
	if cat == nil {
		return
	}
	q := r.URL.Query()
	query := strings.TrimSpace(q.Get("q"))
	if query == "" {
		a.badParam(w, "q is required")
		return
	}
	f, err := a.filter(q)
	var limit int
	if err == nil {
		limit, err = parseLimit(q, defaultLimit)
	}
	if err != nil {
		a.paramError(w, err)
		return
	}
	hits := cat.Search(query, catalog.SearchOptions{Filter: f, Limit: limit + 1})
	out := SearchResult{Query: query, Hits: hits}
	if len(hits) > limit {
		out.Hits, out.Truncated = hits[:limit], true
	}
	if out.Hits == nil {
		out.Hits = []catalog.Hit{}
	}
	a.json(w, http.StatusOK, out)
}

// dayOf is the local date of t.
func (a *API) dayOf(t time.Time) string { return t.In(a.loc()).Format(dayLayout) }

// rowKey is the value of a rollup row along the named dimension.
func rowKey(dim string, r catalog.Row) string {
	switch dim {
	case "project":
		return r.Project
	case "day":
		return r.Day
	case "model":
		return r.Model
	}
	return r.Kind
}

func (a *API) handleCost(w http.ResponseWriter, r *http.Request) {
	cat := a.cat(w)
	if cat == nil {
		return
	}
	q := r.URL.Query()
	by := q.Get("by")
	if by == "" {
		by = "project"
	}
	split := q.Get("split")
	dims := map[string]catalog.Dim{"project": catalog.ByProject, "day": catalog.ByDay, "model": catalog.ByModel, "kind": catalog.ByKind}
	dim, isDim := dims[by]
	if !isDim && by != "session" {
		a.badParam(w, "by=%q: use project, day, model, kind or session", by)
		return
	}
	var splitDim catalog.Dim
	if split != "" {
		sd, ok := dims[split]
		switch {
		case !ok || split == "day":
			a.badParam(w, "split=%q: use project, model or kind", split)
			return
		case by == "session":
			a.badParam(w, "split cannot be combined with by=session")
			return
		case split == by:
			a.badParam(w, "split=%q must differ from by", split)
			return
		}
		splitDim = sd
	}
	since, until, err := a.timeRange(q)
	if err != nil {
		a.paramError(w, err)
		return
	}
	defLimit := 0
	if by == "session" {
		defLimit = 100
	}
	limit := defLimit
	if q.Get("limit") != "" {
		if limit, err = parseLimit(q, 0); err != nil {
			a.paramError(w, err)
			return
		}
	}

	f := catalog.Filter{Project: q.Get("project")}
	out := CostTable{By: by, Split: split, Project: f.Project, Rows: []CostRow{}}
	if !since.IsZero() {
		out.Since = &since
	}
	if !until.IsZero() {
		out.Until = &until
	}
	if by == "session" {
		f.Since, f.Until = since, until
	} else {
		// Spend is bucketed by local day, so the range is a range of days.
		if !since.IsZero() {
			f.DayFrom = a.dayOf(since)
			f.Since = since.In(a.loc())
			y, m, d := f.Since.Date()
			f.Since = time.Date(y, m, d, 0, 0, 0, 0, a.loc())
		}
		if !until.IsZero() {
			f.DayTo = a.dayOf(until.Add(-time.Nanosecond))
		}
	}
	listing := cat.List(f, catalog.Liveness{})

	if by == "session" {
		for _, in := range listing.Sessions {
			c := in.Cost
			out.Rows = append(out.Rows, CostRow{Key: in.Key.ID, Label: in.Title, Sessions: 1, Flag: c.Flag,
				Harness: in.Key.Harness, Project: in.Project, LastActivityAt: in.LastActivityAt,
				Money: catalog.Money{TotalUSD: c.BestUSD, ReportedUSD: c.ReportedUSD, AttributedUSD: c.UncoveredUSD, Compactions: c.Compactions}})
		}
		perProject := map[string]*CostRow{}
		var order []string
		for _, s := range listing.Scripted {
			row := perProject[s.Project]
			if row == nil {
				row = &CostRow{Key: "scripted:" + s.Project, Label: "scripted runs", Project: s.Project}
				perProject[s.Project] = row
				order = append(order, s.Project)
			}
			row.Sessions += s.Count
			row.TotalUSD += s.TotalUSD
			row.ReportedUSD += s.ReportedUSD
			row.AttributedUSD += s.AttributedUSD
		}
		for _, p := range order {
			out.Rows = append(out.Rows, *perProject[p])
		}
		for _, row := range out.Rows {
			out.Total.TotalUSD += row.TotalUSD
			out.Total.ReportedUSD += row.ReportedUSD
			out.Total.AttributedUSD += row.AttributedUSD
			out.Sessions += row.Sessions
		}
	} else {
		var parts map[string][]CostPart
		if split != "" {
			parts = map[string][]CostPart{}
			for _, r := range cat.Rollup(f, dim, splitDim) {
				outer := rowKey(by, r)
				parts[outer] = append(parts[outer], CostPart{Key: rowKey(split, r), Money: r.Money})
			}
			for _, ps := range parts {
				sort.SliceStable(ps, func(i, j int) bool {
					if ps[i].TotalUSD != ps[j].TotalUSD {
						return ps[i].TotalUSD > ps[j].TotalUSD
					}
					return ps[i].Key < ps[j].Key
				})
			}
		}
		for _, r := range cat.Rollup(f, dim) {
			row := CostRow{Sessions: r.Sessions, Money: r.Money, Split: parts[rowKey(by, r)]}
			switch by {
			case "project":
				row.Key = r.Project
			case "day":
				row.Key = r.Day
			case "model":
				row.Key = r.Model
				if r.Model == catalog.OverheadModel {
					row.Label = "overhead: reported, in no transcript"
				}
			case "kind":
				row.Key = r.Kind
				if r.Kind == string(model.KindSDK) {
					row.Label = "sdk (scripted runs)"
				}
			}
			out.Rows = append(out.Rows, row)
		}
		if all := cat.Rollup(f); len(all) > 0 {
			out.Total, out.Sessions = all[0].Money, all[0].Sessions
		}
	}

	if by == "day" {
		sort.SliceStable(out.Rows, func(i, j int) bool { return out.Rows[i].Key < out.Rows[j].Key })
	} else {
		sort.SliceStable(out.Rows, func(i, j int) bool {
			if out.Rows[i].TotalUSD != out.Rows[j].TotalUSD {
				return out.Rows[i].TotalUSD > out.Rows[j].TotalUSD
			}
			return out.Rows[i].Key < out.Rows[j].Key
		})
	}
	if limit > 0 && len(out.Rows) > limit {
		out.Rows, out.Truncated = out.Rows[:limit], true
	}
	for _, in := range listing.Sessions {
		switch in.Cost.Flag {
		case catalog.CostExact:
			out.Backing.Exact++
		case catalog.CostPartial:
			out.Backing.Partial++
		default:
			out.Backing.Estimated++
		}
	}
	for _, s := range listing.Scripted {
		out.Backing.ScriptedRuns += s.Count
	}
	a.json(w, http.StatusOK, out)
}

// previewRunes is the length, in runes, of the texts a summary shows.
const previewRunes = 300

// Preview collapses runs of whitespace to one space, trims, and cuts the text to 300
// runes (at a rune boundary). It reports whether it cut.
func Preview(s string) (string, bool) {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= previewRunes {
		return s, false
	}
	n := 0
	for i := range s {
		if n == previewRunes {
			return s[:i], true
		}
		n++
	}
	return s, false
}

// lastPrompt picks the last thing a person typed: a human turn's prompt, or a message
// typed while a turn was running. Turns that were not abandoned come first; among those the
// latest wins.
func lastPrompt(d *model.SessionDigest) *PromptPreview {
	var best *PromptPreview
	bestAbandoned := true
	consider := func(t *model.Turn, at time.Time, text string) {
		if best != nil && t.Abandoned && !bestAbandoned {
			return
		}
		text, cut := Preview(text)
		best = &PromptPreview{Turn: t.Index, At: at, Text: text, Truncated: cut}
		bestAbandoned = t.Abandoned
	}
	for i := range d.Turns {
		t := &d.Turns[i]
		if t.Origin == model.OriginHuman {
			consider(t, t.StartedAt, t.UserText)
		}
		for k := range t.Queued {
			if q := &t.Queued[k]; q.Origin == model.OriginHuman && strings.TrimSpace(q.Text) != "" {
				consider(t, q.At, q.Text)
			}
		}
	}
	return best
}

func lastRecap(d *model.SessionDigest) *RecapPreview {
	if len(d.Recaps) == 0 {
		return nil
	}
	r := d.Recaps[len(d.Recaps)-1]
	text, cut := Preview(r.Text)
	return &RecapPreview{At: r.At, Text: text, Truncated: cut}
}
