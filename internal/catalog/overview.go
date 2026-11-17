package catalog

import (
	"cmp"
	"fmt"
	"slices"
	"sort"
	"time"

	"github.com/terek/merlin/internal/model"
)

// The Overview rollup (docs/api.md, GET /api/overview): per session and per slot of a time range,
// how much context it carried and when it ran, and the work it launched. It reads owned messages
// only, so a copied message counts once, as everywhere.

// Overview limits.
const (
	OverviewDefaultSlots = 200  // the default slot is the smallest that gives at most this many
	OverviewMaxSlots     = 2000 // more is an OverviewError

	// OverviewHold is how long a main-agent call's context is held at most: until the next
	// call if that comes within it (HOLD_MS in web/src/features/spend/timeline.ts).
	OverviewHold = 5 * time.Minute
	// overviewIdleMax is how long a main-agent call's context is held as idle (the user is
	// reading or typing) when the next call comes later than OverviewHold: until that call if it
	// comes within it, else not at all.
	overviewIdleMax = time.Hour
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
// the default.
type OverviewQuery struct {
	From, To time.Time
	Slot     time.Duration
	Account  string
	Harness  string
}

// Overview is the answer: Slots slots, slot i covering [From + i·SlotMs, From + (i+1)·SlotMs),
// and one lane per session (see OverviewLane).
type Overview struct {
	From     time.Time        `json:"from"`
	To       time.Time        `json:"to"`
	Slot     string           `json:"slot"`
	SlotMs   int64            `json:"slotMs"`
	Slots    int              `json:"slots"`
	Scripted OverviewScripted `json:"scripted"`
	Lanes    []OverviewLane   `json:"lanes"`
	// Beads holds every bead on the chain (the bead, its parent, and so on up to the family root or the
	// last parent the folded databases know) of any lane's Bead, by id. Absent when no lane has one.
	Beads map[string]OverviewBead `json:"beads,omitempty"`
}

// OverviewBead is a bead on a lane's chain: what a client needs to lay the hierarchy out.
type OverviewBead struct {
	Title  string `json:"title,omitempty"`
	Parent string `json:"parent,omitempty"`
	Status string `json:"status,omitempty"`
	Type   string `json:"type,omitempty"`
}

// OverviewScripted sums the scripted (sdk) sessions with a message in the range.
type OverviewScripted struct {
	Sessions int     `json:"sessions"`
	USD      float64 `json:"usd"`
}

// OverviewLane is one session with an owned message in the range. Its arrays start at Slot0,
// the first slot where any of them is non-zero, and end at the last such slot; Turns counts the
// session's own turns that started in the range, Agents the agent spans that started in it.
// Dir, Checkout, Repo and Remote are its places, the primary value of each location key ("" when
// it has none).
type OverviewLane struct {
	Harness string `json:"harness"`
	ID      string `json:"id"`
	Title   string `json:"title,omitempty"`
	Dir     string `json:"dir,omitempty"`
	// Project is the directory the session started in (resume needs it); Dir is its folder.
	Project  string `json:"project,omitempty"`
	Checkout string `json:"checkout,omitempty"`
	Repo     string `json:"repo,omitempty"`
	Remote   string `json:"remote,omitempty"`
	// Bead is the bead holding the largest share of the session's bead-attributed cost (the `bead` key of
	// the groups); "" for a session on none.
	Bead           string    `json:"bead,omitempty"`
	StartedAt      time.Time `json:"startedAt,omitzero"`
	LastActivityAt time.Time `json:"lastActivityAt,omitzero"`
	USD            float64   `json:"usd"`
	Turns          int       `json:"turns"`
	Agents         int       `json:"agents"`
	Slot0          int       `json:"slot0"`
	// Peak is the largest context of any owned call in the range, the main agent's and every
	// agent's (Tokens.Context); PeakAt is when (the earliest on a tie). PeakAgentID is the agent
	// that made that call (a span's AgentID), omitted for the main thread; a compaction call counts
	// as the main thread. PeakAgentKind is the digest's kind of that agent (subagent, review...), set
	// only when the lane lists no span with that AgentID (a review agent), so that the UI can name it. DeepUSD is the usd of the calls whose
	// context is deep (DeepContext or more), counted as USD is.
	Peak          int64          `json:"peak,omitempty"`
	PeakAt        time.Time      `json:"peakAt,omitzero"`
	PeakAgentID   string         `json:"peakAgentId,omitempty"`
	PeakAgentKind string         `json:"peakAgentKind,omitempty"`
	DeepUSD       float64        `json:"deepUSD,omitempty"`
	Context       []int64        `json:"context"`
	Idle          []int64        `json:"idle"`
	Active        []int          `json:"active"`
	Spans         []OverviewSpan `json:"spans"`
}

// OverviewSpan is work a session launched, with its life: one agent of Kind (subagent,
// teammate, fork or workflow), or one branched session (session-fork or continuation). Start
// and End are not clipped to the range.
type OverviewSpan struct {
	Kind string `json:"kind"`
	// AgentID is the agent's id, for an agent span; Peak and DeepUSD are over that agent's owned
	// calls in the range (not clipped like Start and End).
	AgentID string     `json:"agentId,omitempty"`
	Peak    int64      `json:"peak,omitempty"`
	DeepUSD float64    `json:"deepUSD,omitempty"`
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

// ovSess is what one session did in the range.
type ovSess struct {
	s     *sess
	ctx   []int64
	held  []bool  // context held, or a message of its own, in the slot
	idle  []int64 // largest idle context held in the slot, 0 where ctx > 0
	total float64
	// Peak and deep: the lane's, over every owned call in the range; per, by agent id (real ids:
	// a compaction agent has its own entry, though the lane counts its calls as the main thread's).
	deep      float64
	peakCtx   int64
	peakAt    time.Time
	peakAgent string
	peakKind  string
	per       map[string]*agentPeak
}

// agentPeak is what one agent's owned calls in the range carried.
type agentPeak struct {
	peak int64
	deep float64
}

// Overview computes the rollup. Lanes come ordered by usd, largest first, then id.
func (c *Catalog) Overview(q OverviewQuery) (Overview, error) {
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

	out := Overview{From: from, To: to, Slot: OverviewSlotName(slot), SlotMs: slot.Milliseconds(), Slots: n, Lanes: []OverviewLane{}}
	for _, s := range v.sessions {
		if q.Harness != "" && s.key.Harness != q.Harness {
			continue
		}
		o := &ovSess{s: s}
		var main []*model.Message // the main agent's owned messages
		seen := false
		kinds := make(map[string]model.AgentKind, len(s.d.Agents))
		for k := range s.d.Agents {
			kinds[s.d.Agents[k].ID] = s.d.Agents[k].Kind
		}
		for _, m := range s.own {
			if !accountMatches(q.Account, messageAccount(s, m)) {
				continue
			}
			if m.AgentID == "" {
				main = append(main, m)
			}
			i := slotOf(m.At)
			if i < 0 {
				continue
			}
			if !seen {
				seen = true
				o.ctx, o.held, o.idle = make([]int64, n), make([]bool, n), make([]int64, n)
			}
			o.held[i] = true
			usd := m.USD
			if m.EstimatedUSD > 0 && covered(s.windows, m.At) < 0 {
				usd += m.EstimatedUSD // the output a truncated message is missing: in the session's own cost, outside a window
			}
			o.total += usd
			o.addCall(m, usd, kinds[m.AgentID])
		}
		if !seen {
			continue
		}
		if s.d.Kind == model.KindSDK {
			out.Scripted.Sessions++
			out.Scripted.USD += o.total
			continue
		}
		o.holdContext(main, from, slot)
		l := OverviewLane{Harness: s.key.Harness, ID: s.key.ID, Title: s.info.Title,
			StartedAt: s.d.StartedAt.UTC(), LastActivityAt: s.d.LastActivityAt.UTC(), USD: o.total,
			Peak: o.peakCtx, PeakAt: o.peakAt, PeakAgentID: o.peakAgent, PeakAgentKind: o.peakKind, DeepUSD: o.deep,
			Spans: sortedSpans(overviewSpans(s, from, to))}
		for _, sp := range l.Spans {
			if sp.AgentID != "" && sp.AgentID == l.PeakAgentID {
				l.PeakAgentKind = "" // the row has a span to name it
			}
		}
		for i := range l.Spans {
			if p := o.per[l.Spans[i].AgentID]; p != nil && l.Spans[i].AgentID != "" {
				l.Spans[i].Peak, l.Spans[i].DeepUSD = p.peak, p.deep
			}
		}
		l.Dir, l.Checkout, l.Repo, l.Remote, l.Bead = fv.placeValues(s)
		l.Project = s.project
		inherited := make(map[int]bool, len(s.info.InheritedTurns))
		for _, i := range s.info.InheritedTurns {
			inherited[i] = true
		}
		for _, t := range s.d.Turns {
			if !inherited[t.Index] && slotOf(t.StartedAt) >= 0 {
				l.Turns++
			}
		}
		for _, sp := range l.Spans {
			if sp.Kind != "session-fork" && sp.Kind != "continuation" && slotOf(sp.Start) >= 0 {
				l.Agents++
			}
		}
		active := make([]int, n)
		lo, hi := n, -1
		for i := range n {
			if o.held[i] {
				active[i] = 1
			}
			if o.ctx[i] != 0 || o.idle[i] != 0 || o.held[i] {
				lo = min(lo, i)
				hi = i
			}
		}
		l.Slot0, l.Context, l.Idle, l.Active = lo, o.ctx[lo:hi+1], o.idle[lo:hi+1], active[lo:hi+1]
		out.Lanes = append(out.Lanes, l)
	}
	for _, l := range out.Lanes {
		fv.addChain(&out, l.Bead)
	}
	sort.Slice(out.Lanes, func(i, j int) bool {
		a, b := out.Lanes[i], out.Lanes[j]
		if a.USD != b.USD {
			return a.USD > b.USD
		}
		if a.ID != b.ID {
			return a.ID < b.ID
		}
		return a.Harness < b.Harness
	})
	return out, nil
}

// addCall counts one owned call in the range: its context against the lane's peak and its usd
// against deep when the context is deep. A compaction agent's call is the main thread's context
// read once more: it is the main thread's for the lane, and its own agent's for a span.
func (o *ovSess) addCall(m *model.Message, usd float64, kind model.AgentKind) {
	ctx := m.Tokens.Context()
	deep := ctx >= DeepContext
	if o.per == nil {
		o.per = map[string]*agentPeak{}
	}
	if m.AgentID != "" {
		p := o.per[m.AgentID]
		if p == nil {
			p = &agentPeak{}
			o.per[m.AgentID] = p
		}
		p.peak = max(p.peak, ctx)
		if deep {
			p.deep += usd
		}
	}
	if deep {
		o.deep += usd
	}
	if ctx > o.peakCtx || ctx == o.peakCtx && ctx > 0 && m.At.Before(o.peakAt) {
		o.peakCtx, o.peakAt, o.peakAgent, o.peakKind = ctx, m.At.UTC(), m.AgentID, string(kind)
		if m.AgentID == "" || kind == model.AgentCompact {
			o.peakAgent, o.peakKind = "", ""
		}
	}
}

// holdContext fills ctx and held from the session's main-agent owned messages: a call's
// prompt tokens are held from its time until the next call if that is within OverviewHold,
// else only at the call itself. If the next call comes later than that but within
// overviewIdleMax, the context is also held as idle from the call until the next call (idle,
// zeroed afterwards where ctx > 0). A slot's value is the largest context held at any moment of it,
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
		c := m.Tokens.Context()
		for i := max(slotOf(m.At), 0); i <= min(slotOf(end), n-1); i++ {
			o.ctx[i] = max(o.ctx[i], c)
			o.held[i] = true
		}
		if k+1 < len(main) {
			if gap := main[k+1].At.Sub(m.At); gap > OverviewHold && gap <= overviewIdleMax {
				for i := max(slotOf(m.At), 0); i <= min(slotOf(main[k+1].At), n-1); i++ {
					o.idle[i] = max(o.idle[i], c)
				}
			}
		}
	}
	for i := range o.idle {
		if o.ctx[i] > 0 {
			o.idle[i] = 0
		}
	}
}

// overviewSpans lists the spans of one session whose life overlaps [from, to): its agents
// (subagent, fork, teammate, workflow; not compact or review agents, nor those of inherited
// turns), one span each, and the session itself when it is a fork or a
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
	var spans []*OverviewSpan
	for _, l := range ls {
		title := cmp.Or(l.a.Description, l.a.Name, l.a.AgentType)
		spans = append(spans, &OverviewSpan{AgentID: l.a.ID, Kind: l.kind, Start: l.start.UTC(), End: l.end.UTC(), Session: ref, Title: title})
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
		sp := OverviewSpan{Kind: kind, Start: start.UTC(), End: time.Unix(0, end).UTC(), Session: ref, Title: s.info.Title}
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

// addChain puts bead id and its ancestors, up to the family root or the last parent the folded
// databases know, into o.Beads.
func (fv *facets) addChain(o *Overview, id string) {
	for id != "" {
		if _, done := o.Beads[id]; done {
			return
		}
		b, ok := fv.bead[id]
		if !ok {
			return
		}
		if o.Beads == nil {
			o.Beads = map[string]OverviewBead{}
		}
		o.Beads[id] = OverviewBead{Title: b.Title, Parent: b.Parent, Status: b.Status, Type: b.Type}
		id = b.Parent
	}
}
