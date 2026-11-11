package catalog

import (
	"cmp"
	"fmt"
	"slices"
	"sort"
	"time"

	"github.com/terek/merlin/internal/model"
)

// The Overview rollup (docs/api.md, GET /api/overview): per group of sessions and per slot of a
// time range, what was spent and how much context was carried, with the events that happened.
// It reads owned messages only, so a copied message counts once, as everywhere.

// Overview limits.
const (
	OverviewDefaultSlots = 200  // the default slot is the smallest that gives at most this many
	OverviewMaxSlots     = 2000 // more is an OverviewError

	// OverviewHold is how long a main-agent call's context is held at most: until the next
	// call if that comes within it (HOLD_MS in web/src/features/spend/timeline.ts).
	OverviewHold = 5 * time.Minute
	// overviewSpanGap: agents of one kind and spawn turn whose lives come within it are one span.
	overviewSpanGap = 10 * time.Second
)

// OverviewSlots are the slot lengths a query may name, shortest first.
var OverviewSlots = []time.Duration{time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute, 15 * time.Minute, 30 * time.Minute, time.Hour, 2 * time.Hour,
	3 * time.Hour, 6 * time.Hour, 12 * time.Hour, 24 * time.Hour}

// OverviewSlotName is the name of a slot length in the API ("15m", "1h", "1d"), "" for any
// length that is not in OverviewSlots.
func OverviewSlotName(d time.Duration) string {
	switch {
	case !slices.Contains(OverviewSlots, d):
		return ""
	case d == 24*time.Hour:
		return "1d"
	case d%time.Hour == 0:
		return fmt.Sprintf("%dh", d/time.Hour)
	}
	return fmt.Sprintf("%dm", d/time.Minute)
}

// OverviewError is a query the catalog cannot answer because of its parameters (a 400).
type OverviewError struct{ Msg string }

func (e *OverviewError) Error() string { return e.Msg }

// OverviewQuery is the question Overview answers. From and To are required and From must be
// before To; both are moved outward to slot boundaries in the catalog's location. Slot 0 picks
// the default. By is one of GroupDir, GroupCheckout, GroupRepo, GroupRemote ("" is GroupDir).
// Group, when not nil, adds the lanes of that group key ("" is the group with no value).
type OverviewQuery struct {
	From, To time.Time
	Slot     time.Duration
	By       GroupBy
	Group    *string
}

// Overview is the answer: dense per-slot arrays, Slots long, slot i covering
// [From + i·SlotMs, From + (i+1)·SlotMs).
type Overview struct {
	From     time.Time        `json:"from"`
	To       time.Time        `json:"to"`
	Slot     string           `json:"slot"`
	SlotMs   int64            `json:"slotMs"`
	Slots    int              `json:"slots"`
	By       GroupBy          `json:"by"`
	Groups   []OverviewGroup  `json:"groups"`
	Scripted OverviewScripted `json:"scripted"`
	Lanes    []OverviewLane   `json:"lanes,omitempty"`
}

// OverviewGroup is one value of the location key with a message in the range.
type OverviewGroup struct {
	Key            string          `json:"key"`
	Name           string          `json:"name"`
	Sessions       int             `json:"sessions"`
	USD            float64         `json:"usd"`
	LastActivityAt time.Time       `json:"lastActivityAt,omitzero"`
	Priciest       OverviewSession `json:"priciest"`
	USDSlots       []float64       `json:"usdSlots"`
	ContextPeak    []int64         `json:"contextPeak"`
	ContextSum     []int64         `json:"contextSum"`
	Active         []int           `json:"active"`
	Events         []OverviewEvent `json:"events"`
	Spans          []OverviewSpan  `json:"spans"`
}

// OverviewSession names a session and what it cost in the range.
type OverviewSession struct {
	Harness string  `json:"harness"`
	ID      string  `json:"id"`
	Title   string  `json:"title,omitempty"`
	USD     float64 `json:"usd"`
}

// OverviewScripted sums the scripted (sdk) sessions with a message in the range.
type OverviewScripted struct {
	Sessions int       `json:"sessions"`
	USD      float64   `json:"usd"`
	USDSlots []float64 `json:"usdSlots"`
}

// OverviewLane is one session of the queried group.
type OverviewLane struct {
	Harness        string          `json:"harness"`
	ID             string          `json:"id"`
	Title          string          `json:"title,omitempty"`
	StartedAt      time.Time       `json:"startedAt,omitzero"`
	LastActivityAt time.Time       `json:"lastActivityAt,omitzero"`
	USD            float64         `json:"usd"`
	USDSlots       []float64       `json:"usdSlots"`
	Context        []int64         `json:"context"`
	Active         []int           `json:"active"`
	Events         []OverviewEvent `json:"events"`
	Spans          []OverviewSpan  `json:"spans"`
}

// OverviewEvent says that N compactions of a kind (cold, warm or unknown) happened in a slot.
type OverviewEvent struct {
	Slot int    `json:"slot"`
	Type string `json:"type"`
	Kind string `json:"kind"`
	N    int    `json:"n"`
}

// OverviewEventCompaction is the only event type.
const OverviewEventCompaction = "compaction"

// OverviewSpan is work a session launched, with its life: N agents of Kind (subagent,
// teammate, fork or workflow) of one spawn turn, or one branched session (session-fork or
// continuation). Start and End are not clipped to the range.
type OverviewSpan struct {
	Kind    string     `json:"kind"`
	N       int        `json:"n"`
	Start   time.Time  `json:"start"`
	End     time.Time  `json:"end"`
	Session SessionRef `json:"session"`
	Title   string     `json:"title,omitempty"`
}

// SessionRef names a session.
type SessionRef struct {
	Harness string `json:"harness"`
	ID      string `json:"id"`
}

// overviewRange moves from down to a slot boundary in loc (a 1d slot starts at local midnight,
// a 6h one at 00, 06, 12, 18) and returns it with the number of slots that cover up to to.
func overviewRange(from, to time.Time, slot time.Duration, loc *time.Location) (time.Time, int) {
	l := from.In(loc)
	mid := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, loc)
	start := mid
	if slot < 24*time.Hour {
		off := from.Sub(mid)
		start = mid.Add(off - off%slot)
	}
	n := int((to.Sub(start) + slot - 1) / slot)
	return start.UTC(), max(n, 1)
}

type evKey struct {
	slot      int
	typ, kind string
}

type evCount map[evKey]int

// list orders events by slot, then type, then kind; never nil.
func (e evCount) list() []OverviewEvent {
	out := make([]OverviewEvent, 0, len(e))
	for k, n := range e {
		out = append(out, OverviewEvent{Slot: k.slot, Type: k.typ, Kind: k.kind, N: n})
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Slot != b.Slot {
			return a.Slot < b.Slot
		}
		if a.Type != b.Type {
			return a.Type < b.Type
		}
		return a.Kind < b.Kind
	})
	return out
}

// ovSess is what one session did in the range.
type ovSess struct {
	s      *sess
	usd    []float64
	ctx    []int64
	seen   []bool // a message of its own in the slot
	held   []bool // context held in the slot (ctx > 0 from a call before it, or inside it)
	total  float64
	events evCount
	spans  []OverviewSpan
}

// Overview computes the rollup. Groups come ordered by usd, largest first, then key.
func (c *Catalog) Overview(q OverviewQuery) (Overview, error) {
	by := q.By
	if by == "" {
		by = GroupDir
	}
	if !slices.Contains([]GroupBy{GroupDir, GroupCheckout, GroupRepo, GroupRemote}, by) {
		return Overview{}, &OverviewError{fmt.Sprintf("by=%q: use dir, checkout, repo or remote", by)}
	}
	if !q.From.Before(q.To) {
		return Overview{}, &OverviewError{"from must be before to"}
	}
	if q.Slot != 0 && !slices.Contains(OverviewSlots, q.Slot) {
		return Overview{}, &OverviewError{fmt.Sprintf("slot %s is not one of 1m, 2m, 5m, 10m, 15m, 30m, 1h, 2h, 3h, 6h, 12h, 1d", q.Slot)}
	}
	v, fv := c.views()

	slot := q.Slot
	if slot == 0 {
		slot = OverviewSlots[len(OverviewSlots)-1]
		for _, d := range OverviewSlots {
			if _, n := overviewRange(q.From, q.To, d, v.loc); n <= OverviewDefaultSlots {
				slot = d
				break
			}
		}
	}
	from, n := overviewRange(q.From, q.To, slot, v.loc)
	if n > OverviewMaxSlots {
		return Overview{}, &OverviewError{fmt.Sprintf("the range has %d slots of %s: at most %d; use a longer slot or a shorter range",
			n, OverviewSlotName(slot), OverviewMaxSlots)}
	}
	to := from.Add(time.Duration(n) * slot)
	slotOf := func(t time.Time) int {
		if t.IsZero() || t.Before(from) || !t.Before(to) {
			return -1
		}
		return int(t.Sub(from) / slot)
	}

	out := Overview{From: from, To: to, Slot: OverviewSlotName(slot), SlotMs: slot.Milliseconds(), Slots: n, By: by,
		Groups: []OverviewGroup{}, Scripted: OverviewScripted{USDSlots: make([]float64, n)}}

	type groupAcc struct {
		g      OverviewGroup
		events evCount
		spans  []OverviewSpan
		best   *ovSess
	}
	groups := map[string]*groupAcc{}
	var lanes []*ovSess
	for _, s := range v.sessions {
		o := &ovSess{s: s}
		var main []*model.Message // the main agent's owned messages
		for _, m := range s.own {
			if m.AgentID == "" {
				main = append(main, m)
			}
			i := slotOf(m.At)
			if i < 0 {
				continue
			}
			if o.usd == nil {
				o.usd, o.ctx, o.seen, o.held = make([]float64, n), make([]int64, n), make([]bool, n), make([]bool, n)
			}
			o.seen[i] = true
			o.usd[i] += m.USD
			o.total += m.USD
		}
		if o.usd == nil {
			continue
		}
		if s.d.Kind == model.KindSDK {
			out.Scripted.Sessions++
			out.Scripted.USD += o.total
			for i, x := range o.usd {
				out.Scripted.USDSlots[i] += x
			}
			continue
		}
		o.holdContext(main, from, slot)
		o.events = v.overviewEvents(s, slotOf)
		o.spans = overviewSpans(s, from, to)

		sf := &fv.ses[s.idx]
		var key string
		switch by {
		case GroupDir:
			key = s.project
		case GroupCheckout:
			key = sf.checkout
		case GroupRepo:
			key = sf.repo
		case GroupRemote:
			key = sf.remote
		}
		a := groups[key]
		if a == nil {
			a = &groupAcc{events: evCount{}, g: OverviewGroup{Key: key, Name: fv.group(by, key).Name,
				USDSlots: make([]float64, n), ContextPeak: make([]int64, n), ContextSum: make([]int64, n), Active: make([]int, n)}}
			groups[key] = a
		}
		g := &a.g
		g.Sessions++
		g.USD += o.total
		g.LastActivityAt = later(g.LastActivityAt, s.d.LastActivityAt)
		for i := range o.usd {
			g.USDSlots[i] += o.usd[i]
			g.ContextPeak[i] = max(g.ContextPeak[i], o.ctx[i])
			g.ContextSum[i] += o.ctx[i]
			if o.seen[i] || o.held[i] {
				g.Active[i]++
			}
		}
		for k, c := range o.events {
			a.events[k] += c
		}
		a.spans = append(a.spans, o.spans...)
		if a.best == nil || o.total > a.best.total {
			a.best = o
		}
		if q.Group != nil && *q.Group == key {
			lanes = append(lanes, o)
		}
	}

	for _, a := range groups {
		g := a.g
		g.Events = a.events.list()
		g.Spans = sortedSpans(a.spans)
		b := a.best.s
		g.Priciest = OverviewSession{Harness: b.key.Harness, ID: b.key.ID, Title: b.info.Title, USD: a.best.total}
		out.Groups = append(out.Groups, g)
	}
	sort.Slice(out.Groups, func(i, j int) bool {
		a, b := out.Groups[i], out.Groups[j]
		if a.USD != b.USD {
			return a.USD > b.USD
		}
		return a.Key < b.Key
	})

	sort.SliceStable(lanes, func(i, j int) bool {
		a, b := lanes[i].s, lanes[j].s
		if c := cmpTime(a.d.StartedAt, b.d.StartedAt); c != 0 {
			return c < 0
		}
		if a.key.ID != b.key.ID {
			return a.key.ID < b.key.ID
		}
		return a.key.Harness < b.key.Harness
	})
	for _, o := range lanes {
		d := o.s.d
		active := make([]int, n)
		for i := range active {
			if o.seen[i] || o.held[i] {
				active[i] = 1
			}
		}
		out.Lanes = append(out.Lanes, OverviewLane{Harness: o.s.key.Harness, ID: o.s.key.ID, Title: o.s.info.Title,
			StartedAt: d.StartedAt.UTC(), LastActivityAt: d.LastActivityAt.UTC(), USD: o.total,
			USDSlots: o.usd, Context: o.ctx, Active: active, Events: o.events.list(), Spans: sortedSpans(o.spans)})
	}
	return out, nil
}

// holdContext fills ctx and held from the session's main-agent owned messages: a call's
// prompt tokens are held from its time until the next call if that is within OverviewHold,
// else only at the call itself. A slot's value is the largest context held at any moment of it,
// so a held value spans every slot from the call to the next call, inclusive. Messages before
// the range count, for the context they still hold at its start.
func (o *ovSess) holdContext(main []*model.Message, from time.Time, slot time.Duration) {
	n := len(o.ctx)
	main = slices.Clone(main)
	sort.SliceStable(main, func(i, j int) bool { return main[i].At.Before(main[j].At) })
	slotOf := func(t time.Time) int { // may be outside 0..n-1
		d := t.Sub(from)
		i := int(d / slot)
		if d < 0 && d%slot != 0 {
			i--
		}
		return i
	}
	for k, m := range main {
		end := m.At
		if k+1 < len(main) && main[k+1].At.Sub(m.At) <= OverviewHold {
			end = main[k+1].At
		}
		c := m.Input + m.CacheRead + m.CacheWrite5m + m.CacheWrite1h
		for i := max(slotOf(m.At), 0); i <= min(slotOf(end), n-1); i++ {
			o.ctx[i] = max(o.ctx[i], c)
			o.held[i] = true
		}
	}
}

// overviewEvents counts the compactions of a session the way its turns are owned: the
// compactions of agents of inherited turns, and compactions another session owns, are left out.
func (v *view) overviewEvents(s *sess, slotOf func(time.Time) int) evCount {
	ev := evCount{}
	add := func(t time.Time, typ, kind string) {
		if i := slotOf(t); i >= 0 {
			ev[evKey{i, typ, kind}]++
		}
	}
	inherited := make(map[int]bool, len(s.info.InheritedTurns))
	for _, i := range s.info.InheritedTurns {
		inherited[i] = true
	}
	compaction := func(cp *model.Compaction) {
		kind := "unknown"
		if cp.Call != nil && (cp.Call.Cache == model.CacheCold || cp.Call.Cache == model.CacheWarm) {
			kind = string(cp.Call.Cache)
		}
		add(cp.At, OverviewEventCompaction, kind)
	}
	for k := range s.d.Compactions {
		cp := &s.d.Compactions[k]
		if key := compactionKey(s.key.Harness, cp); key != "" {
			if o, shared := v.compOwner[key]; shared && int(o) != s.idx {
				continue
			}
		}
		compaction(cp)
	}
	for k := range s.d.Agents {
		a := &s.d.Agents[k]
		if a.SpawnTurn != nil && inherited[*a.SpawnTurn] {
			continue
		}
		for j := range a.Compactions {
			compaction(&a.Compactions[j])
		}
	}
	return ev
}

// overviewSpans lists the spans of one session whose life overlaps [from, to): its agents
// (subagent, fork, teammate, workflow; not compact or review agents, nor those of inherited
// turns), merged per kind and spawn turn, and the session itself when it is a fork or a
// continuation of another.
func overviewSpans(s *sess, from, to time.Time) []OverviewSpan {
	ref := SessionRef{Harness: s.key.Harness, ID: s.key.ID}
	inherited := make(map[int]bool, len(s.info.InheritedTurns))
	for _, i := range s.info.InheritedTurns {
		inherited[i] = true
	}
	// The last message of each agent, for agents with no end time.
	var first, last map[string]time.Time
	type life struct {
		a          *model.Agent
		kind       string
		start, end time.Time
	}
	var ls []life
	for k := range s.d.Agents {
		a := &s.d.Agents[k]
		if a.SpawnTurn != nil && inherited[*a.SpawnTurn] {
			continue
		}
		kind := ""
		switch {
		case a.Kind == model.AgentWorkflow:
			kind = "workflow"
		case a.Kind != model.AgentSubagent:
			continue // compact, review, approval-review: not work the user launched
		case a.InheritsContext:
			kind = "fork"
		case a.Addressable:
			kind = "teammate"
		default:
			kind = "subagent"
		}
		if first == nil {
			first, last = map[string]time.Time{}, map[string]time.Time{}
			for i := range s.d.Messages {
				m := &s.d.Messages[i]
				if m.AgentID == "" || m.At.IsZero() {
					continue
				}
				if t, ok := first[m.AgentID]; !ok || m.At.Before(t) {
					first[m.AgentID] = m.At
				}
				if m.At.After(last[m.AgentID]) {
					last[m.AgentID] = m.At
				}
			}
		}
		start, end := a.StartedAt, a.EndedAt
		if start.IsZero() {
			start = first[a.ID]
		}
		if end.IsZero() {
			end = last[a.ID]
		}
		if start.IsZero() {
			continue // no time to place it at
		}
		if end.Before(start) {
			end = start
		}
		ls = append(ls, life{a, kind, start, end})
	}
	sort.SliceStable(ls, func(i, j int) bool {
		if !ls[i].start.Equal(ls[j].start) {
			return ls[i].start.Before(ls[j].start)
		}
		return ls[i].a.ID < ls[j].a.ID
	})
	type grp struct {
		kind string
		turn int // -1: none
	}
	open := map[grp]*OverviewSpan{}
	var spans []*OverviewSpan
	for _, l := range ls {
		g := grp{l.kind, -1}
		if l.a.SpawnTurn != nil {
			g.turn = *l.a.SpawnTurn
		}
		if sp := open[g]; sp != nil && !l.start.After(sp.End.Add(overviewSpanGap)) {
			sp.N++
			if l.end.After(sp.End) {
				sp.End = l.end
			}
			continue
		}
		title := cmp.Or(l.a.Description, l.a.Name, l.a.AgentType)
		sp := &OverviewSpan{Kind: l.kind, N: 1, Start: l.start.UTC(), End: l.end.UTC(), Session: ref, Title: title}
		open[g] = sp
		spans = append(spans, sp)
	}
	var out []OverviewSpan
	for _, sp := range spans {
		if sp.Start.Before(to) && sp.End.After(from) || sp.Start.Equal(sp.End) && !sp.Start.Before(from) && sp.Start.Before(to) {
			out = append(out, *sp)
		}
	}
	if p := s.info.Parent; p != nil && (p.Kind == LinkFork || p.Kind == LinkContinuation) && !s.d.StartedAt.IsZero() {
		start, end := s.d.StartedAt, max(s.d.LastActivityAt.UnixNano(), s.d.StartedAt.UnixNano())
		kind := "continuation"
		if p.Kind == LinkFork {
			kind = "session-fork"
		}
		sp := OverviewSpan{Kind: kind, N: 1, Start: start.UTC(), End: time.Unix(0, end).UTC(), Session: ref, Title: s.info.Title}
		if sp.Start.Before(to) && (sp.End.After(from) || sp.Start.Equal(sp.End) && !sp.Start.Before(from)) {
			out = append(out, sp)
		}
	}
	return out
}

// sortedSpans orders spans by start, then kind, then session id; never nil.
func sortedSpans(in []OverviewSpan) []OverviewSpan {
	out := slices.Clone(in)
	if out == nil {
		out = []OverviewSpan{}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if !a.Start.Equal(b.Start) {
			return a.Start.Before(b.Start)
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Session.ID != b.Session.ID {
			return a.Session.ID < b.Session.ID
		}
		return a.Session.Harness < b.Session.Harness
	})
	return out
}
