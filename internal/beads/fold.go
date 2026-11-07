package beads

import (
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/terek/merlin/internal/model"
)

// PrefixDatabase is the key of the synthetic database that holds the beads of a prefix no real
// database claims: "prefix:<p>".
const PrefixDatabase = "prefix:"

// Observed is one bead event of a session, with where it came from.
type Observed struct {
	Session string // session key, e.g. "claude/<id>"; orders events that share a time
	DB      string // registry key of the database resolved at the event's cwd; "" when none
	Event   model.BeadEvent
}

// Folded is what Merlin knows of each bead: every database with its issues folded from the
// registry snapshots and the bd calls of the sessions (docs/beads-and-repos.md §6.4).
type Folded struct {
	Databases []Database // sorted by Key; each Issues sorted by id; Prefixes filled

	issueDB  map[string]string // id -> database key, for every bead in Databases
	issueIdx map[string]int    // id -> index in its database's Issues
	dbIdx    map[string]int    // database key -> index in Databases
	prefixDB map[string]string // prefix -> database key (export, interactions, learned)
}

// Issue returns a copy of the folded bead and its database key.
func (f *Folded) Issue(id string) (Issue, string, bool) {
	key, ok := f.issueDB[id]
	if !ok {
		return Issue{}, "", false
	}
	return copyIssue(f.Databases[f.dbIdx[key]].Issues[f.issueIdx[id]]), key, true
}

// DatabaseOf answers which database an id is in: the one the fold put it in, and for an id the fold
// never saw the same rules by prefix (a known prefix gives its database, else "prefix:<p>"). It is
// "" when the id has no prefix.
func (f *Folded) DatabaseOf(id string) string {
	if key, ok := f.issueDB[id]; ok {
		return key
	}
	p := Prefix(id)
	if p == "" {
		return ""
	}
	if key, ok := f.prefixDB[p]; ok {
		return key
	}
	return PrefixDatabase + p
}

// cand is one thing that may have set a bead's status.
type cand struct {
	at     time.Time
	status string
	reason string
	kind   int // candEvent, candInteraction or candSeen
}

const (
	candEvent = iota
	candInteraction
	candSeen
)

// acc collects everything known of one bead before the fields are chosen.
type acc struct {
	id     string
	export *Issue // the snapshot's issue, nil when no export has it
	mtime  time.Time

	title, typ, status string
	prio               *int // latest seen
	createType         string
	createPrio         *int
	createdAt          time.Time
	updParent          string
	createParent       string
	depParent          string
	seenParent         string
	first, last        time.Time
	cands              []cand
}

// Fold merges the registry snapshots and the sessions' bead events into the beads Merlin knows.
// It is pure: the inputs are not changed, and the result does not depend on the order of events.
//
// Events are taken in time order, then session, then tool use id, then input position. Failed
// events carry nothing. Recall comes first: every field tolerates missing information, and a bead
// seen once in a command is a bead.
func Fold(snapshots []Database, events []Observed) *Folded {
	// Snapshots, copied and sorted by key.
	dbs := make([]Database, len(snapshots))
	for i, db := range snapshots {
		dbs[i] = copyDatabase(db)
	}
	slices.SortStableFunc(dbs, func(a, b Database) int { return strings.Compare(a.Key, b.Key) })

	// Events that count, in order.
	idx := make([]int, 0, len(events))
	for i, o := range events {
		if o.Event.Outcome != model.BeadFailed {
			idx = append(idx, i)
		}
	}
	slices.SortStableFunc(idx, func(a, b int) int {
		x, y := events[a], events[b]
		if c := x.Event.At.Compare(y.Event.At); c != 0 {
			return c
		}
		if c := strings.Compare(x.Session, y.Session); c != 0 {
			return c
		}
		return strings.Compare(x.Event.ToolUseID, y.Event.ToolUseID)
	})
	evs := make([]Observed, len(idx))
	for i, k := range idx {
		evs[i] = events[k]
	}

	f := &Folded{issueDB: map[string]string{}, issueIdx: map[string]int{}, dbIdx: map[string]int{}, prefixDB: map[string]string{}}

	// Step 1 and 2: which database owns each id and prefix.
	exportDB := map[string]string{} // id -> first database by key whose export has it
	exportOf := map[string]*Issue{}
	known := map[string]bool{} // database keys
	for i := range dbs {
		db := &dbs[i]
		known[db.Key] = true
		for j := range db.Issues {
			is := &db.Issues[j]
			if _, ok := exportDB[is.ID]; !ok {
				exportDB[is.ID] = db.Key
				exportOf[is.ID] = is
			}
		}
	}
	// An export's prefixes first, then the prefixes of interactions.jsonl, then learned ones.
	for i := range dbs {
		db := &dbs[i]
		for _, p := range db.Prefixes {
			own(f.prefixDB, p, db.Key)
		}
		for _, is := range db.Issues {
			own(f.prefixDB, Prefix(is.ID), db.Key)
		}
	}
	for i := range dbs {
		for _, s := range dbs[i].Statuses {
			own(f.prefixDB, Prefix(s.ID), dbs[i].Key)
		}
	}
	// Learned: the database with the most events (ties: smallest key) whose cwd resolved to it and
	// that name a bead of the prefix. An OutputOnly event teaches nothing: a script printing
	// lines from other histories must not move a prefix (§6.6); its ids still get a database.
	votes := map[string]map[string]int{}
	for _, o := range evs {
		if o.DB == "" || !known[o.DB] || o.Event.OutputOnly {
			continue
		}
		seen := map[string]bool{}
		for _, id := range named(o.Event) {
			p := Prefix(id)
			if p == "" || seen[p] {
				continue
			}
			seen[p] = true
			if _, ok := f.prefixDB[p]; ok {
				continue
			}
			if votes[p] == nil {
				votes[p] = map[string]int{}
			}
			votes[p][o.DB]++
		}
	}
	learned := map[string][]string{} // database key -> prefixes
	for p, byDB := range votes {
		best, n := "", 0
		for key, c := range byDB {
			if c > n || (c == n && key < best) {
				best, n = key, c
			}
		}
		f.prefixDB[p] = best
		learned[best] = append(learned[best], p)
	}
	for i := range dbs {
		db := &dbs[i]
		ps := append(slices.Clone(db.Prefixes), learned[db.Key]...)
		for _, s := range db.Statuses {
			if p := Prefix(s.ID); p != "" && f.prefixDB[p] == db.Key {
				ps = append(ps, p)
			}
		}
		slices.Sort(ps)
		db.Prefixes = slices.Compact(ps)
	}

	// Which beads there are, and what is known of each.
	accs := map[string]*acc{}
	get := func(id string) *acc {
		a := accs[id]
		if a == nil {
			a = &acc{id: id}
			accs[id] = a
		}
		return a
	}
	for id, is := range exportOf {
		if Prefix(id) == "" {
			continue
		}
		a := get(id)
		a.export = is
		a.mtime = exportMtime(dbs, exportDB[id])
	}
	// Step 1 of DatabaseOf: an exported id is in the database whose export has it, whoever owns
	// its prefix.
	for id, key := range exportDB {
		if Prefix(id) != "" {
			f.issueDB[id] = key
		}
	}
	for _, o := range evs {
		foldEvent(o.Event, get)
	}
	// interactions.jsonl statuses go to the beads of their database, ahead of the events'
	// candidates (a tie in time goes to the event). They never create a bead.
	for i := range dbs {
		for _, s := range dbs[i].Statuses {
			if a := accs[s.ID]; a != nil && f.DatabaseOf(s.ID) == dbs[i].Key {
				a.cands = append([]cand{{at: s.At, status: s.Status, reason: s.Reason, kind: candInteraction}}, a.cands...)
			}
		}
	}

	// Parents, with stubs for the ones nothing describes.
	described := map[string]bool{}
	for id := range accs {
		described[id] = true
	}
	addStub := func(id string) {
		for ; id != ""; id = dotted(id) {
			if Prefix(id) == "" {
				return
			}
			if _, ok := accs[id]; !ok {
				accs[id] = &acc{id: id}
			}
		}
	}
	for _, id := range sortedIDs(accs) {
		addStub(dotted(id))
	}
	parent := resolveParents(accs, addStub)

	// Build the issues and place them.
	out := map[string][]Issue{} // database key -> issues
	for _, id := range sortedIDs(accs) {
		is := build(accs[id], described[id])
		is.Parent = parent[id]
		key := f.DatabaseOf(id)
		f.issueDB[id] = key
		out[key] = append(out[key], is)
	}
	for i := range dbs {
		dbs[i].Issues = out[dbs[i].Key]
		if dbs[i].Issues == nil {
			dbs[i].Issues = []Issue{}
		}
		delete(out, dbs[i].Key)
	}
	for key, issues := range out { // synthetic prefix databases
		dbs = append(dbs, Database{Version: 1, Key: key, Prefixes: []string{strings.TrimPrefix(key, PrefixDatabase)}, Issues: issues})
	}
	slices.SortStableFunc(dbs, func(a, b Database) int { return strings.Compare(a.Key, b.Key) })
	f.Databases = dbs
	for i, db := range dbs {
		f.dbIdx[db.Key] = i
		for j, is := range db.Issues {
			f.issueIdx[is.ID] = j
		}
	}
	return f
}

// own records that a database owns a prefix unless an earlier one (smaller key) already does.
func own(m map[string]string, prefix, key string) {
	if prefix == "" {
		return
	}
	if _, ok := m[prefix]; !ok {
		m[prefix] = key
	}
}

// exportMtime is the time of the export of a database: the newest MtimeNs of its issues.jsonl
// sources. It is zero when there is none (every event then counts as later).
func exportMtime(dbs []Database, key string) time.Time {
	var ns int64
	for _, db := range dbs {
		if db.Key != key {
			continue
		}
		for _, s := range db.Sources {
			if filepath.Base(s.Path) == "issues.jsonl" && s.MtimeNs > ns {
				ns = s.MtimeNs
			}
		}
	}
	if ns == 0 {
		return time.Time{}
	}
	return time.Unix(0, ns)
}

// named is every bead id an event mentions, for prefix learning: its ids, parent, dependencies
// and the beads the output printed.
func named(e model.BeadEvent) []string {
	var out []string
	out = append(out, e.IDs...)
	for _, s := range e.Seen {
		out = append(out, s.ID)
	}
	out = append(out, e.Parent)
	for _, d := range e.Deps {
		out = append(out, d.ID)
	}
	return out
}

// foldEvent adds one counting event to the beads it names.
func foldEvent(e model.BeadEvent, get func(string) *acc) {
	touch := func(id string) *acc {
		if id == "" || Prefix(id) == "" {
			return nil
		}
		a := get(id)
		if a.first.IsZero() || e.At.Before(a.first) {
			a.first = e.At
		}
		if e.At.After(a.last) {
			a.last = e.At
		}
		return a
	}
	var targets []*acc
	for _, id := range e.IDs {
		if a := touch(id); a != nil {
			targets = append(targets, a)
		}
	}
	// A title is taken only when the call names one bead: for `close a b c` the ✓ lines name
	// the beads one by one and the parser keeps one title. Titles come from create (positional,
	// --title, ✓ Created line), update --title, and the ✓ Created/Updated/Closed line; comment,
	// dep and show lines carry none.
	oneID := len(e.IDs) == 1
	for _, a := range targets {
		switch e.Op {
		case model.BeadCreate:
			// Only the new bead (IDs[0]) is created; the rest are named in passing.
			if a.id != e.IDs[0] {
				continue
			}
			if a.createdAt.IsZero() {
				a.createdAt = e.At
				a.createType, a.createPrio = e.Type, copyInt(e.Priority)
				a.createParent = e.Parent
				for _, d := range e.Deps {
					if d.Type == "parent-child" && d.ID != "" {
						a.depParent = d.ID
					}
				}
			}
			a.cands = append(a.cands, cand{at: e.At, status: "open", kind: candEvent})
		case model.BeadUpdate, model.BeadClaim, model.BeadClose, model.BeadReopen:
			if e.Parent != "" {
				a.updParent = e.Parent
			}
			st := e.Status
			switch {
			case e.Op == model.BeadClaim && st == "":
				st = "in_progress"
			case e.Op == model.BeadClose && st == "":
				st = "closed"
			case e.Op == model.BeadReopen && st == "":
				st = "open"
			}
			if st != "" {
				c := cand{at: e.At, status: st, kind: candEvent}
				if st == "closed" {
					c.reason = e.Reason
				}
				a.cands = append(a.cands, c)
			}
		case model.BeadDep:
			// dep add <child> <parent> --type parent-child
			if e.DepType == "parent-child" && len(e.IDs) >= 2 && a.id == e.IDs[0] && e.IDs[1] != "" {
				a.depParent = e.IDs[1]
			}
		}
		switch e.Op {
		case model.BeadCreate:
			if a.id == e.IDs[0] && e.Title != "" {
				a.title = e.Title
			}
		case model.BeadUpdate, model.BeadClaim, model.BeadClose, model.BeadReopen:
			if oneID && e.Title != "" {
				a.title = e.Title
			}
		}
	}
	// Seen beads are named too (a dep's two ids are in IDs).
	for _, s := range e.Seen {
		a := touch(s.ID)
		if a == nil {
			continue
		}
		if s.Title != "" {
			a.title = s.Title
		}
		if s.Type != "" {
			a.typ = s.Type
		}
		if s.Priority != nil {
			a.prio = copyInt(s.Priority)
		}
		if s.Parent != "" {
			a.seenParent = s.Parent
		}
		if s.Status != "" {
			a.cands = append(a.cands, cand{at: e.At, status: s.Status, kind: candSeen})
		}
	}
}

// dotted is the parent a dotted id spells (x-abc.1.2 gives x-abc.1), "" for a root.
func dotted(id string) string {
	if i := strings.LastIndexByte(id, '.'); i > 0 {
		return id[:i]
	}
	return ""
}

func sortedIDs(m map[string]*acc) []string {
	ids := make([]string, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

// resolveParents picks one parent per bead. The sources have a fixed precedence (export, update
// --parent, create --parent, a parent-child dependency, seen output, the dotted id), applied tier
// by tier over all beads so a higher tier is never dropped for a lower one; a link that would make a
// bead its own ancestor is skipped and the next tier tried (the dotted id, else no parent). A parent
// no source describes is added as a stub through addStub.
func resolveParents(accs map[string]*acc, addStub func(string)) map[string]string {
	chosen := map[string]string{}
	cycle := func(child, p string) bool {
		for cur := p; cur != ""; cur = chosen[cur] {
			if cur == child {
				return true
			}
		}
		return false
	}
	tier := func(a *acc, t int) string {
		switch t {
		case 0:
			if a.export != nil {
				return a.export.Parent
			}
		case 1:
			return a.updParent
		case 2:
			return a.createParent
		case 3:
			return a.depParent
		case 4:
			return a.seenParent
		case 5:
			return dotted(a.id)
		}
		return ""
	}
	for t := 0; t <= 5; t++ {
		for _, id := range sortedIDs(accs) { // a snapshot: stubs added meanwhile have only the dotted tier
			if _, done := chosen[id]; done {
				continue
			}
			p := tier(accs[id], t)
			if p == "" || p == id || Prefix(p) == "" || cycle(id, p) {
				continue
			}
			chosen[id] = p
			addStub(p)
		}
	}
	return chosen
}

// build chooses the fields of one bead. described says a source other than a parent link names it.
func build(a *acc, described bool) Issue {
	var is Issue
	if a.export != nil {
		is = copyIssue(*a.export)
		is.Parent = ""
		is.Source = SourceExport
	} else if described {
		is.Source = SourceSessions
	} else {
		return Issue{ID: a.id, Source: SourceImplied}
	}
	is.ID = a.id
	is.FirstSeen, is.LastSeen = a.first, a.last

	// An export that has the bead is its truth, even for empty type and priority, except the title:
	// an export without one falls back to the sessions'.
	if is.Title == "" {
		is.Title = a.title
	}
	if a.export == nil {
		is.Type, is.Priority = a.typ, copyInt(a.prio)
		if is.Type == "" {
			is.Type = a.createType
		}
		if is.Priority == nil {
			is.Priority = copyInt(a.createPrio)
		}
	}
	if is.CreatedAt.IsZero() {
		is.CreatedAt = a.createdAt
	}

	// Status: an export that has the bead (not gone) wins; else the latest by time, among the
	// candidates after the export's mtime for a gone bead.
	if a.export != nil && !a.export.Gone && is.Status != "" {
		return is
	}
	// The candidates are not in time order (interactions.jsonl's come first): compare times. A tie
	// goes to the later candidate, so an event beats interactions.jsonl.
	var best *cand
	var closed *cand // the latest close by an event or interactions.jsonl: they carry the reason
	for i := range a.cands {
		c := &a.cands[i]
		if a.export != nil && !a.mtime.IsZero() && !c.at.After(a.mtime) {
			continue
		}
		if best == nil || !c.at.Before(best.at) {
			best = c
		}
		if c.status == "closed" && c.kind != candSeen && (closed == nil || !c.at.Before(closed.at)) {
			closed = c
		}
	}
	if best == nil {
		return is
	}
	is.Status = best.status
	if best.status != "closed" {
		if a.export == nil || a.export.Gone {
			is.ClosedAt, is.CloseReason = time.Time{}, ""
		}
		return is
	}
	// Closed, but the close we saw was undone later (a reopen, then a close nobody printed but a
	// listing showed): the time it was seen closed, no reason.
	if closed == nil || reopenedAfter(a.cands, closed.at) {
		closed = best
	}
	is.ClosedAt, is.CloseReason = closed.at, closed.reason
	return is
}

// reopenedAfter says a candidate later than at set a status other than closed.
func reopenedAfter(cands []cand, at time.Time) bool {
	for _, c := range cands {
		if c.status != "closed" && c.at.After(at) {
			return true
		}
	}
	return false
}

func copyInt(p *int) *int {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func copyIssue(is Issue) Issue {
	is.Priority = copyInt(is.Priority)
	is.Deps = slices.Clone(is.Deps)
	is.Labels = slices.Clone(is.Labels)
	return is
}

func copyDatabase(db Database) Database {
	c := clone(&db)
	for i := range c.Issues {
		c.Issues[i] = copyIssue(c.Issues[i])
	}
	return c
}
