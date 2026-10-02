package catalog

import (
	"slices"
	"sort"
	"strings"

	"github.com/terek/merlin/explorer/internal/model"
)

// selects reports whether the session passes the session-level parts of the filter.
// state is the session's liveness, used only when f.States is set.
func (f Filter) selects(s *sess, state State) bool {
	if f.Harness != "" && s.key.Harness != f.Harness {
		return false
	}
	if f.Project != "" && s.project != f.Project && s.d.ProjectKey != f.Project {
		return false
	}
	if len(f.Kinds) > 0 && !slices.Contains(f.Kinds, s.d.Kind) {
		return false
	}
	if !f.Since.IsZero() && s.d.LastActivityAt.Before(f.Since) {
		return false
	}
	if !f.Until.IsZero() && !s.d.LastActivityAt.Before(f.Until) {
		return false
	}
	if len(f.States) > 0 && !slices.Contains(f.States, state) {
		return false
	}
	return true
}

// dayIn reports whether a fact's day is inside the filter's day range. Facts without a
// day (messages with no timestamp) only pass an unbounded range.
func (f Filter) dayIn(day string) bool {
	if f.DayFrom == "" && f.DayTo == "" {
		return true
	}
	if day == "" {
		return false
	}
	return (f.DayFrom == "" || day >= f.DayFrom) && (f.DayTo == "" || day <= f.DayTo)
}

// selected returns the facts of the sessions passing f, in fact order. Liveness is not
// consulted: rollups ignore f.States.
func (v *view) selected(f Filter) []fact {
	f.States = nil
	var out []fact
	var last *sess
	var ok bool
	for _, x := range v.facts {
		if x.s != last {
			last, ok = x.s, f.selects(x.s, "")
		}
		if ok && f.dayIn(x.day) {
			out = append(out, x)
		}
	}
	return out
}

// Rollup sums spend over the sessions selected by f, grouped by dims (none = one total
// row). Every scripted session is counted. Overhead has no model: it shows up as the
// row with Model == OverheadModel when ByModel is requested, so that the rows add up to
// the same total as any other grouping. Rows are ordered by their keys.
//
// For the whole fixture set (and any filter) the totals of Rollup(f, ByDay),
// Rollup(f, ByModel), Rollup(f, ByProject) and Rollup(f, ByKind) are equal, and equal to
// the sum of the selected sessions' best costs when no DayFrom/DayTo is set.
func (c *Catalog) Rollup(f Filter, dims ...Dim) []Row {
	v := c.view()
	type key struct{ project, day, model, kind string }
	type acc struct {
		row  Row
		last *sess
	}
	rows := make(map[key]*acc)
	var keys []key
	for _, x := range v.selected(f) {
		var k key
		for _, d := range dims {
			switch d {
			case ByProject:
				k.project = x.s.project
			case ByDay:
				k.day = x.day
			case ByModel:
				k.model = x.model
			case ByKind:
				k.kind = string(x.s.d.Kind)
			}
		}
		a := rows[k]
		if a == nil {
			a = &acc{row: Row{Project: k.project, Day: k.day, Model: k.model, Kind: k.kind}}
			rows[k] = a
			keys = append(keys, k)
		}
		a.row.add(x.reported, x.attributed)
		if a.last != x.s {
			a.last = x.s
			a.row.Sessions++
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		for _, d := range dims {
			var x, y string
			switch d {
			case ByProject:
				x, y = a.project, b.project
			case ByDay:
				x, y = a.day, b.day
			case ByModel:
				x, y = a.model, b.model
			case ByKind:
				x, y = a.kind, b.kind
			}
			if x != y {
				return x < y
			}
		}
		return false
	})
	out := make([]Row, len(keys))
	for i, k := range keys {
		out[i] = rows[k].row
	}
	return out
}

// Total returns the spend of the sessions selected by f: the sum of their best costs
// (restricted to the days in f when DayFrom/DayTo are set).
func (c *Catalog) Total(f Filter) Money {
	var m Money
	for _, x := range c.view().selected(f) {
		m.add(x.reported, x.attributed)
	}
	return m
}

// Scripted returns the aggregate lines for scripted (sdk) sessions: one per project and
// local day, ordered by project then day. When f.Kinds is set and lacks sdk, there are
// none.
func (c *Catalog) Scripted(f Filter) []ScriptedLine { return c.view().scripted(f) }

func (v *view) scripted(f Filter) []ScriptedLine {
	if len(f.Kinds) > 0 && !slices.Contains(f.Kinds, model.KindSDK) {
		return nil
	}
	f.States = nil
	type key struct{ project, day string }
	lines := make(map[key]*ScriptedLine)
	line := func(k key) *ScriptedLine {
		l := lines[k]
		if l == nil {
			l = &ScriptedLine{Project: k.project, Day: k.day}
			lines[k] = l
		}
		return l
	}
	for _, s := range v.sessions {
		if s.d.Kind == model.KindSDK && f.selects(s, "") && f.dayIn(v.day(s.d.StartedAt)) {
			line(key{s.project, v.day(s.d.StartedAt)}).Count++
		}
	}
	for _, x := range v.selected(f) {
		if x.s.d.Kind == model.KindSDK {
			line(key{x.s.project, x.day}).add(x.reported, x.attributed)
		}
	}
	out := make([]ScriptedLine, 0, len(lines))
	for _, l := range lines {
		out = append(out, *l)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Project != out[j].Project {
			return out[i].Project < out[j].Project
		}
		return strings.Compare(out[i].Day, out[j].Day) < 0
	})
	return out
}
