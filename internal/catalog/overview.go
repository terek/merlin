package catalog

import (
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
)

// OverviewSlots are the slot lengths a query may name, shortest first.
var OverviewSlots = []time.Duration{15 * time.Minute, 30 * time.Minute, time.Hour, 2 * time.Hour,
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
	Events         []OverviewEvent `json:"events"`
}

// OverviewEvent says that N things of a kind happened in a slot. Type is "agent" (Kind
// subagent, teammate, fork or workflow), "session" (fork or continuation) or "compaction"
// (cold, warm or unknown).
type OverviewEvent struct {
	Slot int    `json:"slot"`
	Type string `json:"type"`
	Kind string `json:"kind"`
	N    int    `json:"n"`
}

// Overview types and kinds.
const (
	OverviewEventAgent      = "agent"
	OverviewEventSession    = "session"
	OverviewEventCompaction = "compaction"
)

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
	total  float64
	events evCount
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
		return Overview{}, &OverviewError{fmt.Sprintf("slot %s is not one of 15m, 30m, 1h, 2h, 3h, 6h, 12h, 1d", q.Slot)}
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
		best   *ovSess
	}
	groups := map[string]*groupAcc{}
	var lanes []*ovSess
	for _, s := range v.sessions {
		o := &ovSess{s: s}
		for _, m := range s.own {
			i := slotOf(m.At)
			if i < 0 {
				continue
			}
			if o.usd == nil {
				o.usd, o.ctx, o.seen = make([]float64, n), make([]int64, n), make([]bool, n)
			}
			o.seen[i] = true
			o.usd[i] += m.USD
			o.total += m.USD
			if m.AgentID == "" {
				o.ctx[i] = max(o.ctx[i], m.Input+m.CacheRead+m.CacheWrite5m+m.CacheWrite1h)
			}
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
		o.events = v.overviewEvents(s, slotOf)

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
			if o.seen[i] {
				g.Active[i]++
			}
		}
		for k, c := range o.events {
			a.events[k] += c
		}
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
		out.Lanes = append(out.Lanes, OverviewLane{Harness: o.s.key.Harness, ID: o.s.key.ID, Title: o.s.info.Title,
			StartedAt: d.StartedAt.UTC(), LastActivityAt: d.LastActivityAt.UTC(), USD: o.total,
			USDSlots: o.usd, Context: o.ctx, Events: o.events.list()})
	}
	return out, nil
}

// overviewEvents counts the events of a session the way its turns are owned: the agents and
// compactions of inherited turns, and compactions another session owns, are left out.
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
		kind := ""
		switch {
		case a.Kind == model.AgentWorkflow:
			kind = "workflow"
		case a.Kind != model.AgentSubagent:
			// compact, review, approval-review: not agents the user launched
		case a.InheritsContext:
			kind = "fork"
		case a.Addressable:
			kind = "teammate"
		default:
			kind = "subagent"
		}
		if kind != "" {
			add(a.StartedAt, OverviewEventAgent, kind)
		}
	}
	if p := s.info.Parent; p != nil && (p.Kind == LinkFork || p.Kind == LinkContinuation) {
		add(s.d.StartedAt, OverviewEventSession, string(p.Kind))
	}
	return ev
}
