package catalog

import (
	"hash/fnv"
	"slices"
	"sort"
	"strconv"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

// sess is one indexed session and the figures derived for it.
type sess struct {
	d        *model.SessionDigest
	idx      int
	key      model.SessionKey
	project  string
	explicit []int // sessions its markers name as sources (same harness, known)
	dupMsgs  bool  // the digest lists a message id twice
	ids      map[string]struct{}

	own     []*model.Message // messages this session owns, in digest order
	windows []model.ReportedWindow
	parent  int // index of the parent session, -1 for none
	kids    []int
	info    SessionInfo
}

// fact is the smallest unit of spend: one session, one local day, one model.
type fact struct {
	s          *sess
	day, model string
	reported   float64
	attributed float64
}

// view is the derived state of a catalog. It is immutable once built.
type view struct {
	loc      *time.Location
	sessions []*sess // ordered by (harness, id): the order never depends on load order
	byKey    map[model.SessionKey]*sess
	facts    []fact

	turnHolders map[string][]int32 // prompt uuid -> sessions holding the turn
	turnOwner   map[string]int32   // only for uuids held by more than one session
	compHolders map[string][]int32
	compOwner   map[string]int32

	ev map[pairKey]int8 // cache of evidence()

	diag Diagnostics
}

// older orders sessions for ownership: earliest startedAt, then earliest lastActivityAt,
// then smallest id. A missing time sorts last.
func older(a, b *sess) bool {
	if c := cmpTime(a.d.StartedAt, b.d.StartedAt); c != 0 {
		return c < 0
	}
	if c := cmpTime(a.d.LastActivityAt, b.d.LastActivityAt); c != 0 {
		return c < 0
	}
	if a.d.ID != b.d.ID {
		return a.d.ID < b.d.ID
	}
	return a.d.Harness < b.d.Harness
}

func cmpTime(a, b time.Time) int {
	switch {
	case a.IsZero() && b.IsZero():
		return 0
	case a.IsZero():
		return 1
	case b.IsZero():
		return -1
	}
	return a.Compare(b)
}

// names reports whether x's explicit markers name y as a source.
func (x *sess) names(y *sess) bool { return slices.Contains(x.explicit, y.idx) }

// idSet returns the message ids of s, built on first use.
func (s *sess) idSet() map[string]struct{} {
	if s.ids == nil {
		s.ids = make(map[string]struct{}, len(s.d.Messages))
		for i := range s.d.Messages {
			if id := s.d.Messages[i].ID; id != "" {
				s.ids[id] = struct{}{}
			}
		}
	}
	return s.ids
}

// evidence looks for proof, in the messages, of which of two sessions is the parent of the
// other. A copy is a snapshot: a child holds only messages its parent had at copy time,
// and whatever it adds comes later. So let T be the time of the latest message the two
// share; a side with own (unshared) messages earlier than T, subagent messages included,
// cannot be the copy. Returns -1 if a is the parent, +1 if b is, 0 for no signal (neither
// side or both sides have such messages, or nothing is shared).
func (v *view) evidence(a, b *sess) int {
	if a.idx > b.idx {
		return -v.evidence(b, a)
	}
	k := pairKey{int32(a.idx), int32(b.idx)}
	if r, ok := v.ev[k]; ok {
		return int(r)
	}
	ia, ib := a.idSet(), b.idSet()
	var t time.Time
	for i := range a.d.Messages {
		m := &a.d.Messages[i]
		if _, ok := ib[m.ID]; ok && m.ID != "" && m.At.After(t) {
			t = m.At
		}
	}
	early := func(x *sess, other map[string]struct{}) bool {
		for i := range x.d.Messages {
			m := &x.d.Messages[i]
			if _, shared := other[m.ID]; !shared && m.ID != "" && !m.At.IsZero() && m.At.Before(t) {
				return true
			}
		}
		return false
	}
	r := int8(0)
	if !t.IsZero() {
		ea, eb := early(a, ib), early(b, ia)
		switch {
		case ea && !eb:
			r = -1
		case eb && !ea:
			r = 1
		}
	}
	v.ev[k] = r
	return int(r)
}

// before reports whether a is the parent side of the pair: explicit markers decide, then
// the earlier startedAt, then the message evidence, then last activity, then id.
func (v *view) before(a, b *sess) bool {
	if b.names(a) {
		return true
	}
	if a.names(b) {
		return false
	}
	if c := cmpTime(a.d.StartedAt, b.d.StartedAt); c != 0 {
		return c < 0
	}
	if e := v.evidence(a, b); e != 0 {
		return e < 0
	}
	return older(a, b)
}

// pick chooses the owner among sessions holding the same thing (a message, a turn, a
// window): the one that is not a child of any other holder, by the pairwise rule in
// before. If that is not unique (inconsistent markers), the plain order decides.
func (v *view) pick(set []int32) int {
	best, n := -1, 0
	for _, i := range set {
		x := v.sessions[i]
		child := false
		for _, j := range set {
			if i != j && v.before(v.sessions[j], x) {
				child = true
				break
			}
		}
		if !child {
			best = int(i)
			n++
		}
	}
	if n == 1 {
		return best
	}
	best = -1
	for _, i := range set {
		if best < 0 || older(v.sessions[i], v.sessions[best]) {
			best = int(i)
		}
	}
	return best
}

func projectOf(d *model.SessionDigest) string {
	switch {
	case d.Project != "":
		return d.Project
	case d.Cwd != "":
		return d.Cwd
	}
	return d.ProjectKey
}

type pairKey [2]int32 // a < b

type pairCount struct{ msgs, turns int }

func build(digests map[model.SessionKey]*model.SessionDigest, loc *time.Location) *view {
	v := &view{loc: loc, byKey: make(map[model.SessionKey]*sess, len(digests)), ev: make(map[pairKey]int8)}

	for _, d := range digests {
		if d.Error != "" {
			v.diag.Stubs++
			continue
		}
		v.sessions = append(v.sessions, &sess{d: d, key: d.Key(), project: projectOf(d), parent: -1})
	}
	sort.Slice(v.sessions, func(i, j int) bool {
		a, b := v.sessions[i].key, v.sessions[j].key
		if a.Harness != b.Harness {
			return a.Harness < b.Harness
		}
		return a.ID < b.ID
	})
	for i, s := range v.sessions {
		s.idx = i
		v.byKey[s.key] = s
	}
	v.diag.Sessions = len(v.sessions)

	v.resolveMarkers()
	pairs := make(map[pairKey]*pairCount)
	v.ownMessages(pairs)
	v.holdTurns(pairs)
	v.holdCompactions()
	v.lineage(pairs)
	v.ownWindows() // needs the families
	v.costs()
	v.fill()
	return v
}

// resolveMarkers turns the explicit lineage markers of each digest into session indexes.
func (v *view) resolveMarkers() {
	for _, s := range v.sessions {
		add := func(id string) {
			if id == "" || id == s.key.ID {
				return
			}
			if p, ok := v.byKey[model.SessionKey{Harness: s.key.Harness, ID: id}]; ok && !slices.Contains(s.explicit, p.idx) {
				s.explicit = append(s.explicit, p.idx)
			}
		}
		if f := s.d.Lineage.ForkedFrom; f != nil {
			add(f.SessionID)
		}
		for _, id := range s.d.Lineage.InheritedFrom {
			add(id)
		}
	}
}

// ownMessages decides who bills each message id and fills each session's owned messages
// and inherited totals. A message id found in several sessions is billed by exactly one.
func (v *view) ownMessages(pairs map[pairKey]*pairCount) {
	holders := make(map[string][]int32)
	for _, s := range v.sessions {
		for k := range s.d.Messages {
			id := s.d.Messages[k].ID
			if id == "" {
				continue
			}
			h := holders[id]
			if n := len(h); n > 0 && h[n-1] == int32(s.idx) {
				s.dupMsgs = true
				continue
			}
			holders[id] = append(h, int32(s.idx))
		}
	}
	v.diag.Messages = len(holders)

	owner := make(map[string]int32)
	for id, h := range holders {
		if len(h) < 2 {
			continue
		}
		v.diag.SharedMessages++
		owner[id] = int32(v.pick(h))
		for a := 0; a < len(h); a++ {
			for b := a + 1; b < len(h); b++ {
				pc := pairs[pairKey{h[a], h[b]}]
				if pc == nil {
					pc = &pairCount{}
					pairs[pairKey{h[a], h[b]}] = pc
				}
				pc.msgs++
			}
		}
	}

	for _, s := range v.sessions {
		var seen map[string]struct{}
		if s.dupMsgs {
			seen = make(map[string]struct{})
		}
		inh := make(map[int32]*Inherited)
		for k := range s.d.Messages {
			m := &s.d.Messages[k]
			if m.ID != "" {
				if seen != nil {
					if _, dup := seen[m.ID]; dup {
						continue
					}
					seen[m.ID] = struct{}{}
				}
				if o, shared := owner[m.ID]; shared && int(o) != s.idx {
					in := inh[o]
					if in == nil {
						in = &Inherited{From: v.sessions[o].key}
						inh[o] = in
					}
					in.USD += m.USD
					in.Messages++
					s.info.Cost.InheritedUSD += m.USD
					s.info.Cost.InheritedMessages++
					continue
				}
			}
			s.own = append(s.own, m)
		}
		for _, in := range inh {
			s.info.Cost.InheritedFrom = append(s.info.Cost.InheritedFrom, *in)
		}
		sort.Slice(s.info.Cost.InheritedFrom, func(i, j int) bool {
			a, b := s.info.Cost.InheritedFrom[i].From, s.info.Cost.InheritedFrom[j].From
			if a.Harness != b.Harness {
				return a.Harness < b.Harness
			}
			return a.ID < b.ID
		})
	}
}

// sessionWindows returns the reported windows of a digest ordered by start, with
// duplicate starts collapsed to the larger total. A digest that carries a reported total
// but no windows is read as one window spanning the whole session.
func sessionWindows(d *model.SessionDigest) []model.ReportedWindow {
	r := d.Reported
	if r == nil {
		return nil
	}
	ws := slices.Clone(r.Windows)
	if len(ws) == 0 {
		if r.TotalUSD == 0 {
			return nil
		}
		ws = []model.ReportedWindow{{From: d.StartedAt, To: d.LastActivityAt, TotalUSD: r.TotalUSD, ByModel: r.ByModel}}
	}
	sort.SliceStable(ws, func(i, j int) bool { return ws[i].From.Before(ws[j].From) })
	out := ws[:0]
	for _, w := range ws {
		if n := len(out); n > 0 && out[n-1].From.UnixMilli() == w.From.UnixMilli() {
			if w.TotalUSD > out[n-1].TotalUSD {
				out[n-1] = w
			}
			continue
		}
		out = append(out, w)
	}
	return out
}

// ownWindows decides which session keeps each reported window. Two linked sessions (same
// family) that carry a window with the same start share one process run's counter; it
// counts once, for the owner. Unrelated sessions that happen to start a run at the same
// instant each keep their own window.
func (v *view) ownWindows() {
	type wkey struct {
		root int
		from int64
	}
	root := func(s *sess) int {
		for s.parent >= 0 {
			s = v.sessions[s.parent]
		}
		return s.idx
	}
	starts := make(map[wkey][]int32)
	all := make([][]model.ReportedWindow, len(v.sessions))
	for _, s := range v.sessions {
		all[s.idx] = sessionWindows(s.d)
		r := root(s)
		for _, w := range all[s.idx] {
			k := wkey{r, w.From.UnixMilli()}
			starts[k] = append(starts[k], int32(s.idx))
		}
	}
	owner := make(map[wkey]int)
	for k, h := range starts {
		if len(h) > 1 {
			v.diag.SharedWindows++
			owner[k] = v.pick(h)
		}
	}
	for _, s := range v.sessions {
		r := root(s)
		for _, w := range all[s.idx] {
			if o, shared := owner[wkey{r, w.From.UnixMilli()}]; shared && o != s.idx {
				continue
			}
			s.windows = append(s.windows, w)
		}
	}
}

// holdTurns records which sessions hold each prompt uuid, who owns a shared turn, and how
// many turns each pair of sessions share.
func (v *view) holdTurns(pairs map[pairKey]*pairCount) {
	v.turnHolders = make(map[string][]int32)
	for _, s := range v.sessions {
		for k := range s.d.Turns {
			id := s.d.Turns[k].UUID
			if id == "" {
				continue
			}
			h := v.turnHolders[id]
			if n := len(h); n > 0 && h[n-1] == int32(s.idx) {
				continue
			}
			v.turnHolders[id] = append(h, int32(s.idx))
		}
	}
	v.turnOwner = make(map[string]int32)
	for id, h := range v.turnHolders {
		if len(h) < 2 {
			continue
		}
		v.turnOwner[id] = int32(v.pick(h))
		for a := 0; a < len(h); a++ {
			for b := a + 1; b < len(h); b++ {
				pc := pairs[pairKey{h[a], h[b]}]
				if pc == nil {
					pc = &pairCount{}
					pairs[pairKey{h[a], h[b]}] = pc
				}
				pc.turns++
			}
		}
	}
}

// compactionKey identifies a compaction across sessions that copied it.
func compactionKey(c *model.Compaction) string {
	if c.At.IsZero() {
		return ""
	}
	h := fnv.New64a()
	h.Write([]byte(c.Summary))
	return strconv.FormatInt(c.At.UnixNano(), 36) + "/" + strconv.FormatUint(h.Sum64(), 36)
}

func (v *view) holdCompactions() {
	v.compHolders = make(map[string][]int32)
	for _, s := range v.sessions {
		for k := range s.d.Compactions {
			key := compactionKey(&s.d.Compactions[k])
			if key == "" {
				continue
			}
			h := v.compHolders[key]
			if n := len(h); n > 0 && h[n-1] == int32(s.idx) {
				continue
			}
			v.compHolders[key] = append(h, int32(s.idx))
		}
	}
	v.compOwner = make(map[string]int32)
	for key, h := range v.compHolders {
		if len(h) > 1 {
			v.compOwner[key] = int32(v.pick(h))
		}
	}
}

func (v *view) day(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.In(v.loc).Format(time.DateOnly)
}

// covered returns the index of the window that contains t, or -1.
func covered(ws []model.ReportedWindow, t time.Time) int {
	if t.IsZero() {
		return -1
	}
	for i, w := range ws {
		if !t.Before(w.From.Add(-coverSlack)) && !t.After(w.To.Add(coverSlack)) {
			return i
		}
	}
	return -1
}

type dayAmount struct {
	day string
	usd float64
}

// costs computes every session's cost figures and its facts.
//
// bestCost is the one place that defines a session's best cost: the reported total of the
// windows the session owns, plus the attributed cost of the messages it owns that lie
// outside every one of those windows. Adjust here if the definition changes; the rollups
// are built from the same numbers, so they follow.
func (v *view) costs() {
	for _, s := range v.sessions {
		c := &s.info.Cost
		c.Windows = s.windows

		type key struct {
			day, model string
			cov        bool
		}
		var order []key
		sums := make(map[key]float64)
		perWin := make([][]dayAmount, len(s.windows))
		coveredBy := make([]float64, len(s.windows))
		for _, m := range s.own {
			wi := covered(s.windows, m.At)
			k := key{v.day(m.At), m.Model, wi >= 0}
			if _, ok := sums[k]; !ok {
				order = append(order, k)
			}
			sums[k] += m.USD
			c.OwnUSD += m.USD
			if wi < 0 {
				c.UncoveredUSD += m.USD
				continue
			}
			c.CoveredUSD += m.USD
			coveredBy[wi] += m.USD
			days := perWin[wi]
			if n := len(days); n > 0 && days[n-1].day == k.day {
				days[n-1].usd += m.USD
			} else {
				j := slices.IndexFunc(days, func(a dayAmount) bool { return a.day == k.day })
				if j < 0 {
					perWin[wi] = append(days, dayAmount{k.day, m.USD})
				} else {
					days[j].usd += m.USD
				}
			}
		}
		c.OwnMessages = len(s.own)
		for _, k := range order {
			f := fact{s: s, day: k.day, model: k.model}
			if k.cov {
				f.reported = sums[k]
			} else {
				f.attributed = sums[k]
			}
			v.facts = append(v.facts, f)
		}
		for wi, w := range s.windows {
			c.ReportedUSD += w.TotalUSD
			over := w.TotalUSD - coveredBy[wi]
			switch {
			case over == 0:
			case coveredBy[wi] > 0:
				// Spread the window's overhead over its days in proportion to the covered
				// spend of each day, so the days add up to the window's total.
				for _, d := range perWin[wi] {
					v.facts = append(v.facts, fact{s: s, day: d.day, model: OverheadModel, reported: over * d.usd / coveredBy[wi]})
				}
			default:
				at := w.To
				if at.IsZero() {
					at = w.From
				}
				v.facts = append(v.facts, fact{s: s, day: v.day(at), model: OverheadModel, reported: over})
			}
		}
		over := c.ReportedUSD - c.CoveredUSD
		if over < 0 {
			if over < -1e-9 {
				v.diag.OverheadClamped++
			}
			over = 0
		}
		c.OverheadUSD = over
		c.BestUSD = bestCost(c)
		switch {
		case len(s.windows) == 0:
			c.Flag = CostEstimated
			v.diag.SessionsEstimate++
		case c.UncoveredUSD > 0:
			c.Flag = CostPartial
			v.diag.SessionsUncover++
		default:
			c.Flag = CostExact
		}
		v.diag.ReportedUSD += c.ReportedUSD
		v.diag.CoveredUSD += c.CoveredUSD
		v.diag.BestUSD += c.BestUSD
		if s.d.Kind == model.KindSDK {
			v.diag.Scripted++
		}
	}
}

// bestCost is the best cost of a session: the reported total of its windows plus the
// attributed cost of the owned messages outside every window.
func bestCost(c *SessionCost) float64 { return c.ReportedUSD + c.UncoveredUSD }
