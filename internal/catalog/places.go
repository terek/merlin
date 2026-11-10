package catalog

import (
	"maps"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/terek/merlin/internal/beads"
	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/repos"
)

// Places is what the catalog groups sessions by besides their project: the repository lookups
// (repos.json) and the bead databases (the registry). The daemon supplies them from
// internal/links; the catalog never reads the disk. Groupings are facets: a session's
// identity stays (harness, id) and its project the directory it started in.
// Design: docs/beads-and-repos.md §5.
type Places struct {
	Repos map[string]repos.Repo // directory -> repository
	Beads []beads.Database
}

// SetPlaces replaces the repository lookups and bead databases. Only the groupings are
// recomputed (on the next read); sessions and costs stay as they are.
func (c *Catalog) SetPlaces(p Places) {
	c.mu.Lock()
	c.places = p
	c.placesGen++
	c.mu.Unlock()
}

// NoBead is the key of the spend no bead accounts for, NoRepo, NoCheckout and NoRemote those of
// sessions with no primary repository, checkout or remote, and NoBranch that of turns with no
// branch.
const (
	NoBead     = ""
	NoRepo     = ""
	NoBranch   = ""
	NoCheckout = ""
	NoRemote   = ""
)

// RepoRef names a repository: Repo is its git common dir (the key), Name its display name
// (repos.Name). Gone: no entry with this repository is live.
type RepoRef struct {
	Repo   string `json:"repo"`
	Name   string `json:"name"`
	Remote string `json:"remote,omitempty"`
	Gone   bool   `json:"gone,omitempty"`
}

// BeadRef is a bead as the fold knows it (registry snapshots and the sessions' bd calls).
type BeadRef struct {
	ID       string `json:"id"`
	Title    string `json:"title,omitempty"`
	Type     string `json:"type,omitempty"`
	Status   string `json:"status,omitempty"`
	Parent   string `json:"parent,omitempty"`
	Root     string `json:"root"`             // the root of its family (itself when it has no parent)
	Database string `json:"database"`         // the folded database key: a project id, or "prefix:<p>"
	Source   string `json:"source,omitempty"` // export, sessions or implied (beads.Issue.Source)
}

// BeadShare is a bead one session worked on, with the share of the session's best cost spent
// on it and the bd operations the session ran on it, in order of first use.
type BeadShare struct {
	BeadRef
	USD float64        `json:"usd"`
	Ops []model.BeadOp `json:"ops"`
}

// BranchShare is a branch a session's turns ran on, with the share of its best cost.
type BranchShare struct {
	Name string  `json:"name"`
	USD  float64 `json:"usd"`
}

// SessionPlaces is where one session worked. Repo, Checkout and Remote are the values it counts
// under (location.go); Checkouts, Repos and Remotes list every value it touched. Beads and
// Branches split the best cost; NoBeadUSD is the part no bead accounts for.
type SessionPlaces struct {
	Repo      *RepoRef      `json:"repo,omitempty"`
	Checkout  string        `json:"checkout,omitempty"`
	Remote    string        `json:"remote,omitempty"`
	Checkouts []string      `json:"checkouts,omitempty"`
	Repos     []RepoRef     `json:"repos,omitempty"`
	Remotes   []string      `json:"remotes,omitempty"`
	Branches  []BranchShare `json:"branches,omitempty"`
	Beads     []BeadShare   `json:"beads,omitempty"`
	NoBeadUSD float64       `json:"noBeadUSD"`
}

// Places returns where a session worked.
func (c *Catalog) Places(key model.SessionKey) (SessionPlaces, bool) {
	v, fv := c.views()
	s, ok := v.byKey[key]
	if !ok {
		return SessionPlaces{}, false
	}
	return fv.sessionPlaces(s), true
}

// facets is the grouping state derived from a view and Places. It is immutable once built.
type facets struct {
	v      *view
	gen    int
	places Places
	fold   *beads.Folded
	bead   map[string]*BeadRef // id -> bead, for every bead the fold knows
	kids   map[string][]string // id -> direct children, in id order
	hint   map[string]string   // family root without a title -> title of its earliest titled member
	prefix map[string]string   // bead id prefix -> database key
	dbAt   map[string]string   // .beads directory -> database key
	repo   map[string]RepoRef  // git common dir -> ref
	ses    []sessFacets        // by sess.idx

	// What Places says is alive: a value is gone when no entry with it is live (not gone, not
	// inferred). worktree: checkouts that are linked worktrees; checkoutRepo: the repo of each
	// checkout the entries name (the first in directory order).
	liveRepo, liveCheckout, liveRemote map[string]bool
	worktree                           map[string]bool
	checkoutRepo                       map[string]string
}

// sessFacets is what the groupings know of one session.
type sessFacets struct {
	// Primary values (location.go): they never contradict, the checkout is inside the repo and
	// the remote is the repo's.
	repo, checkout, remote string
	// Every value touched: the primary and start-directory values and those of its own activity.
	checkouts, repos, remotes []string // sorted, no duplicates
	branches                  []string // in order of first use
	beads                     []string // beads worked on (any bd call but show), sorted
	ops                       map[string][]model.BeadOp
	lastOn                    map[string]time.Time // bead -> last bd call on it
	// Spend weights: the attributed cost of the owned messages, by day and then by bead or
	// branch key. all sums over days.
	beadW, branchW     map[string]map[string]float64
	beadAll, branchAll map[string]float64
}

// views returns the current view and its groupings, rebuilding the groupings when the view
// or Places changed.
func (c *Catalog) views() (*view, *facets) {
	v := c.view()
	c.mu.RLock()
	fv, gen := c.fv, c.placesGen
	c.mu.RUnlock()
	if fv != nil && fv.v == v && fv.gen == gen {
		return v, fv
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fv == nil || c.fv.v != v || c.fv.gen != c.placesGen {
		c.fv = buildFacets(v, c.places, c.placesGen)
	}
	return v, c.fv
}

// prepare returns the view and f with its grouping filters resolved; the groupings too when
// need is set or the filter uses them (nil otherwise).
func (c *Catalog) prepare(f Filter, need bool) (*view, *facets, Filter) {
	filters := f.Repo != "" || f.Checkout != "" || f.Remote != "" || f.Branch != "" || f.Bead != ""
	if !need && !filters {
		return c.view(), nil, f
	}
	v, fv := c.views()
	if filters {
		f.facet = fv.selects
	}
	return v, fv, f
}

func buildFacets(v *view, p Places, gen int) *facets {
	fv := &facets{v: v, gen: gen, places: p, bead: map[string]*BeadRef{}, prefix: map[string]string{},
		kids: map[string][]string{}, hint: map[string]string{}, repo: map[string]RepoRef{}, dbAt: map[string]string{}}
	for i := range p.Beads {
		for _, dir := range p.Beads[i].Dirs {
			fv.dbAt[dir] = p.Beads[i].Key
		}
	}
	fv.indexRepos()

	// Every owned bd call of every session (v.sessions is in (harness, id) order), in digest
	// order, goes into the fold with the database its directory resolves to.
	var events []beads.Observed
	for _, s := range v.sessions {
		name := s.key.Harness + "/" + s.key.ID
		for _, e := range ownedBeads(s) {
			events = append(events, beads.Observed{Session: name, DB: fv.hereOf(e.Cwd), Event: e})
		}
	}
	fv.fold = beads.Fold(p.Beads, events)
	fv.indexBeads()

	fv.ses = make([]sessFacets, len(v.sessions))
	for _, s := range v.sessions {
		fv.ses[s.idx] = fv.session(s)
	}
	return fv
}

// indexBeads fills the bead, prefix, children and hint lookups from the folded databases.
func (fv *facets) indexBeads() {
	parent := map[string]string{}
	issues := map[string]beads.Issue{}
	for _, db := range fv.fold.Databases {
		for _, pre := range db.Prefixes {
			if _, dup := fv.prefix[pre]; !dup {
				fv.prefix[pre] = db.Key
			}
		}
		for _, is := range db.Issues {
			parent[is.ID] = is.Parent
			issues[is.ID] = is
		}
	}
	ids := slices.Sorted(maps.Keys(issues))
	for _, db := range fv.fold.Databases {
		for _, is := range db.Issues {
			fv.bead[is.ID] = &BeadRef{ID: is.ID, Title: is.Title, Type: is.Type, Status: is.Status,
				Parent: is.Parent, Root: rootOf(is.ID, parent), Database: db.Key, Source: is.Source}
		}
	}
	slices.SortFunc(ids, func(a, b string) int {
		switch {
		case idLess(a, b):
			return -1
		case idLess(b, a):
			return 1
		}
		return 0
	})
	// The hint of a family whose root has no title: the title of its earliest member (by
	// first sighting, then id) that has one.
	earliest := map[string]beads.Issue{}
	for _, id := range ids {
		is := issues[id]
		if is.Parent != "" {
			fv.kids[is.Parent] = append(fv.kids[is.Parent], id)
		}
		root := fv.bead[id].Root
		if is.Title == "" || issues[root].Title != "" {
			continue
		}
		if cur, ok := earliest[root]; !ok || is.FirstSeen.Before(cur.FirstSeen) {
			earliest[root] = is
		}
	}
	for root, is := range earliest {
		fv.hint[root] = is.Title
	}
}

// hereOf is the registry key of the bead database at a directory: the .beads directory of its
// repository entry. It is empty for no directory, no entry or no database.
func (fv *facets) hereOf(cwd string) string {
	if cwd == "" {
		return ""
	}
	if r, ok := fv.places.Repos[filepath.Clean(cwd)]; ok && r.Beads != "" {
		return fv.dbAt[filepath.Clean(r.Beads)]
	}
	return ""
}

// ownedBeads is the session's bd calls in digest order, without those copied from the session
// it was forked from or resumed out of.
func ownedBeads(s *sess) []model.BeadEvent {
	d := s.d
	if len(d.Beads) == 0 {
		return nil
	}
	owned := make(map[string]bool, len(s.own))
	for _, m := range s.own {
		owned[m.ID] = true
	}
	held := make(map[string]bool, len(d.Messages))
	for i := range d.Messages {
		held[d.Messages[i].ID] = true
	}
	var out []model.BeadEvent
	for _, e := range d.Beads {
		if e.MessageID != "" && held[e.MessageID] && !owned[e.MessageID] {
			continue
		}
		out = append(out, e)
	}
	return out
}

// names reports whether the call names bead id for the purposes of cost and spans (§6.6). A
// call's own ids always count; so do those of a call that only a script's output names, unless
// the directory has a database and the id belongs to another one (output quoted from elsewhere).
func (fv *facets) names(e model.BeadEvent, id, here string) bool {
	return !e.OutputOnly || here == "" || fv.fold.DatabaseOf(id) == here
}

// rootOf follows parent links to the top of a bead's family; a parent the database does not
// know ends the walk.
func rootOf(id string, parent map[string]string) string {
	seen := map[string]bool{}
	for !seen[id] {
		seen[id] = true
		p, ok := parent[id]
		if !ok || p == "" {
			return id
		}
		if _, known := parent[p]; !known {
			return id
		}
		id = p
	}
	return id
}

// session derives the groupings of one session.
func (fv *facets) session(s *sess) sessFacets {
	d := s.d
	sf := sessFacets{ops: map[string][]model.BeadOp{}, lastOn: map[string]time.Time{}}

	sf.repo, sf.checkout, sf.remote, sf.checkouts, sf.repos, sf.remotes = fv.locate(s)
	for _, t := range d.Turns {
		if t.GitBranch != "" && !slices.Contains(sf.branches, t.GitBranch) {
			sf.branches = append(sf.branches, t.GitBranch)
		}
	}

	beadOf, kept := fv.beadSpans(s)
	for _, e := range kept {
		for _, id := range e.IDs {
			if _, ok := fv.bead[id]; !ok {
				continue
			}
			if !slices.Contains(sf.beads, id) {
				sf.beads = append(sf.beads, id)
			}
			if !slices.Contains(sf.ops[id], e.Op) {
				sf.ops[id] = append(sf.ops[id], e.Op)
			}
			if e.At.After(sf.lastOn[id]) {
				sf.lastOn[id] = e.At
			}
		}
	}
	slices.Sort(sf.beads)

	agentTurn := map[string]*int{}
	for i := range d.Agents {
		agentTurn[d.Agents[i].ID] = d.Agents[i].SpawnTurn
	}
	sf.beadW, sf.branchW = map[string]map[string]float64{}, map[string]map[string]float64{}
	sf.beadAll, sf.branchAll = map[string]float64{}, map[string]float64{}
	add := func(byDay map[string]map[string]float64, all map[string]float64, day, key string, usd float64) {
		w := byDay[day]
		if w == nil {
			w = map[string]float64{}
			byDay[day] = w
		}
		w[key] += usd
		all[key] += usd
	}
	for _, m := range s.own {
		usd := m.USD + m.EstimatedUSD
		day := fv.v.day(m.At)
		if bs := beadOf(m); len(bs) > 0 {
			for _, b := range bs {
				add(sf.beadW, sf.beadAll, day, b, usd/float64(len(bs)))
			}
		} else {
			add(sf.beadW, sf.beadAll, day, NoBead, usd)
		}
		turn := m.Turn
		if turn == nil && m.AgentID != "" {
			turn = agentTurn[m.AgentID]
		}
		branch := NoBranch
		if turn != nil && *turn >= 0 && *turn < len(d.Turns) {
			branch = d.Turns[*turn].GitBranch
		}
		add(sf.branchW, sf.branchAll, day, branch, usd)
	}
	return sf
}

// span is the time a thread (the main agent or one agent) spent on a bead.
type span struct {
	bead     string
	from, to time.Time
}

// beadSpans works out which beads each owned message of a session was spent on, and returns
// the bd calls that count (not failed, not copied from another session, not show) with their
// ids narrowed to the ones that count for the call (names). A bead needs no registry: the fold
// knows every id a call names.
//
// Per thread (the main agent, each agent): a bead is worked on from its claim (bd update
// --claim, or --status in_progress) to its close (or another status, or the thread's end).
// A bead closed without a claim is worked on from the thread's previous claim or close (or its
// creation in the thread, if later; or the thread's start). A message is spent on the beads
// its thread works on at its time, split evenly; an agent that worked on exactly one bead
// spends all of its messages on it. A thread working on none at a message's time takes what
// the thread that launched it worked on at that time.
func (fv *facets) beadSpans(s *sess) (func(*model.Message) []string, []model.BeadEvent) {
	d := s.d
	var kept []model.BeadEvent
	byThread := map[string][]model.BeadEvent{}
	for _, e := range ownedBeads(s) {
		if e.Outcome == model.BeadFailed || e.Op == model.BeadShow {
			continue
		}
		here := fv.hereOf(e.Cwd)
		named := e.IDs
		if e.Op == model.BeadDep && len(named) > 1 {
			named = named[:1] // the dependency target is named, not worked on
		}
		var ids []string
		for _, id := range named {
			if _, ok := fv.bead[id]; ok && fv.names(e, id, here) {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			continue
		}
		e.IDs = ids
		kept = append(kept, e)
		byThread[e.AgentID] = append(byThread[e.AgentID], e)
	}

	ends := map[string][2]time.Time{}
	for _, m := range s.own {
		r, ok := ends[m.AgentID]
		if !ok || m.At.Before(r[0]) {
			r[0] = m.At
		}
		if m.At.After(r[1]) {
			r[1] = m.At
		}
		ends[m.AgentID] = r
	}
	spans := map[string][]span{}
	for thread, evs := range byThread {
		start, end := ends[thread][0], ends[thread][1]
		open, created := map[string]time.Time{}, map[string]time.Time{}
		anchor := start
		var out []span
		closeAt := func(id string, at time.Time) {
			from, ok := open[id]
			if !ok {
				from = anchor
				if c, ok := created[id]; ok && c.After(from) {
					from = c
				}
			}
			delete(open, id)
			out = append(out, span{id, from, at})
		}
		for _, e := range evs {
			switch {
			case e.Op == model.BeadClaim || e.Op == model.BeadUpdate && e.Status == "in_progress":
				for _, id := range e.IDs {
					if _, ok := open[id]; !ok {
						open[id] = e.At
					}
				}
				anchor = e.At
			case e.Op == model.BeadClose || e.Op == model.BeadUpdate && e.Status == "closed":
				for _, id := range e.IDs {
					closeAt(id, e.At)
				}
				anchor = e.At
			case e.Op == model.BeadUpdate && e.Status != "":
				for _, id := range e.IDs {
					if _, ok := open[id]; ok {
						closeAt(id, e.At)
					}
				}
			case e.Op == model.BeadCreate:
				for _, id := range e.IDs {
					created[id] = e.At
				}
			}
		}
		for _, id := range slices.Sorted(maps.Keys(open)) {
			out = append(out, span{id, open[id], end})
		}
		spans[thread] = out
	}

	parent := map[string]string{}
	for i := range d.Agents {
		if p := d.Agents[i].ParentAgentID; p != nil {
			parent[d.Agents[i].ID] = *p
		}
	}
	single := map[string]string{} // agent -> the one bead it worked on
	for thread, ss := range spans {
		if thread == "" {
			continue
		}
		if len(ss) > 0 && !slices.ContainsFunc(ss, func(sp span) bool { return sp.bead != ss[0].bead }) {
			single[thread] = ss[0].bead
		}
	}
	var at func(thread string, t time.Time, depth int) []string
	at = func(thread string, t time.Time, depth int) []string {
		if b, ok := single[thread]; ok {
			return []string{b}
		}
		var out []string
		for _, sp := range spans[thread] {
			if !t.Before(sp.from) && !t.After(sp.to) && !slices.Contains(out, sp.bead) {
				out = append(out, sp.bead)
			}
		}
		if len(out) > 0 || thread == "" || depth > 16 {
			return out
		}
		return at(parent[thread], t, depth+1)
	}
	return func(m *model.Message) []string {
		if len(spans) == 0 || m.At.IsZero() {
			return nil
		}
		return at(m.AgentID, m.At, 0)
	}, kept
}

// selects reports whether a session passes the grouping parts of a filter.
func (fv *facets) selects(f Filter, s *sess) bool {
	sf := &fv.ses[s.idx]
	// Touched widens the most specific location filter: with a checkout set, repo and remote
	// stay primary.
	wide := f.Touched && f.Checkout == ""
	if !matches(f.Repo, sf.repo, sf.repos, wide) || !matches(f.Checkout, sf.checkout, sf.checkouts, f.Touched) ||
		!matches(f.Remote, sf.remote, sf.remotes, wide) {
		return false
	}
	if f.Branch != "" && !slices.Contains(sf.branches, f.Branch) {
		return false
	}
	if f.Bead != "" && !slices.ContainsFunc(sf.beads, func(id string) bool { return fv.within(id, f.Bead) }) {
		return false
	}
	return true
}

// matches reports whether a session passes a repo, checkout or remote filter: want is empty
// (no filter), NoneFilter (no primary value) or a value, which has to be the primary one, or
// with touched one of the listed.
func matches(want, primary string, listed []string, touched bool) bool {
	switch {
	case want == "":
		return true
	case want == NoneFilter:
		return primary == ""
	case touched:
		return slices.Contains(listed, want)
	}
	return primary == want
}

// within reports whether bead id is anc or lies below it; anc can also be a prefix, which
// holds every bead of that prefix (no bead id is a bare prefix).
func (fv *facets) within(id, anc string) bool {
	if _, ok := fv.prefix[anc]; ok {
		return beads.Prefix(id) == anc
	}
	for range 32 {
		if id == anc {
			return true
		}
		b, ok := fv.bead[id]
		if !ok || b.Parent == "" {
			return false
		}
		id = b.Parent
	}
	return false
}

// share splits amount over the keys of w in proportion; an empty w gives it all to none.
func share(w map[string]float64, amount float64, none string, f func(key string, part float64)) {
	keys := slices.Sorted(maps.Keys(w)) // in key order: a float sum depends on the order
	var sum float64
	for _, k := range keys {
		sum += w[k]
	}
	if sum <= 0 {
		f(none, amount)
		return
	}
	for _, k := range keys {
		if w[k] > 0 {
			f(k, amount*w[k]/sum)
		}
	}
}

func (fv *facets) sessionPlaces(s *sess) SessionPlaces {
	sf := &fv.ses[s.idx]
	var p SessionPlaces
	if sf.repo != "" {
		r := fv.repoRef(sf.repo)
		p.Repo = &r
	}
	p.Checkout, p.Remote, p.Checkouts, p.Remotes = sf.checkout, sf.remote, sf.checkouts, sf.remotes
	for _, k := range sf.repos {
		p.Repos = append(p.Repos, fv.repoRef(k))
	}
	best := s.info.Cost.BestUSD
	byBranch := map[string]float64{}
	share(sf.branchAll, best, NoBranch, func(k string, x float64) { byBranch[k] += x })
	for _, b := range sf.branches {
		p.Branches = append(p.Branches, BranchShare{Name: b, USD: byBranch[b]})
	}
	byBead := map[string]float64{}
	share(sf.beadAll, best, NoBead, func(k string, x float64) { byBead[k] += x })
	for _, id := range sf.beads {
		p.Beads = append(p.Beads, BeadShare{BeadRef: *fv.bead[id], USD: byBead[id], Ops: sf.ops[id]})
	}
	for k, x := range byBead {
		if !slices.Contains(sf.beads, k) {
			p.NoBeadUSD += x // NoBead, and spans of beads only shown (never: kept excludes show)
		}
	}
	sort.SliceStable(p.Beads, func(i, j int) bool { return p.Beads[i].USD > p.Beads[j].USD })
	return p
}

func (fv *facets) repoRef(k string) RepoRef {
	if r, ok := fv.repo[k]; ok {
		return r
	}
	return RepoRef{Repo: k, Name: repos.Name(k)}
}

// splitKey returns the weights a dimension splits a session's spend by on a day: the day's,
// else the whole session's (spend on a day without messages: overhead, a compaction).
func (sf *sessFacets) weights(dim Dim, day string) map[string]float64 {
	byDay, all := sf.beadW, sf.beadAll
	if dim == ByBranch {
		byDay, all = sf.branchW, sf.branchAll
	}
	if w := byDay[day]; len(w) > 0 {
		return w
	}
	return all
}

// branchKey joins a repository and a branch into one rollup key.
func branchKey(repo, branch string) string {
	if repo == NoRepo && branch == NoBranch {
		return ""
	}
	return repo + "#" + branch
}

// SplitBranchKey undoes the join of a ByBranch row key. It splits at the first #: a branch name
// may contain one, a directory rarely does.
func SplitBranchKey(k string) (repo, branch string) {
	if i := strings.IndexByte(k, '#'); i >= 0 {
		return k[:i], k[i+1:]
	}
	return "", k
}

// NoneFilter as Filter.Repo, Checkout or Remote keeps the sessions with no primary value.
const NoneFilter = "-"

// RepoGroup is one repository with the sessions that count under it (SessionPlaces.Repo).
// Money sums their best costs, scripted runs included; Sessions does not count those.
type RepoGroup struct {
	RepoRef
	Sessions       int             `json:"sessions"`
	LastActivityAt time.Time       `json:"lastActivityAt,omitzero"`
	Money          Money           `json:"cost"`
	Checkouts      []CheckoutGroup `json:"checkouts,omitempty"`
	Branches       []BranchGroup   `json:"branches,omitempty"`
}

// CheckoutGroup is a checkout of a repository and the sessions that touched it (not only
// those that count under it). Worktree marks a linked one. BestUSD sums their best costs, also
// what they spent outside the checkout.
type CheckoutGroup struct {
	Checkout       string    `json:"checkout"`
	Name           string    `json:"name"`
	Worktree       bool      `json:"worktree,omitempty"`
	Gone           bool      `json:"gone,omitempty"`
	Sessions       int       `json:"sessions"`
	BestUSD        float64   `json:"bestUSD"`
	LastActivityAt time.Time `json:"lastActivityAt,omitzero"`
}

// BranchGroup is a branch of a repository: the sessions with a turn on it and the share of
// their cost spent on it.
type BranchGroup struct {
	Name           string    `json:"name"`
	Sessions       int       `json:"sessions"`
	USD            float64   `json:"usd"`
	LastActivityAt time.Time `json:"lastActivityAt,omitzero"`
}

// Repos returns the repositories of the sessions selected by f, most recently active first;
// sessions in none come last, as the group with an empty Repo.
func (c *Catalog) Repos(f Filter) []RepoGroup {
	v, fv, f := c.prepare(f, true)
	groups := map[string]*RepoGroup{}
	wts := map[string]map[string]*CheckoutGroup{}
	brs := map[string]map[string]*BranchGroup{}
	for _, s := range v.sessions {
		if !f.selects(s, "") {
			continue
		}
		sf := &fv.ses[s.idx]
		g := groups[sf.repo]
		if g == nil {
			g = &RepoGroup{RepoRef: RepoRef{Name: "(no repository)"}}
			if sf.repo != NoRepo {
				g.RepoRef = fv.repoRef(sf.repo)
			}
			groups[sf.repo] = g
			wts[sf.repo], brs[sf.repo] = map[string]*CheckoutGroup{}, map[string]*BranchGroup{}
		}
		c := &s.info.Cost
		g.Money.add(c.ReportedUSD, c.UncoveredUSD+c.EstimatedUncoveredUSD-c.RecordedUSD, c.RecordedUSD, c.BilledUSD)
		last := s.d.LastActivityAt
		if s.d.Kind == model.KindSDK {
			continue
		}
		g.Sessions++
		g.LastActivityAt = later(g.LastActivityAt, last)
		for _, top := range fv.checkoutsOf(sf) {
			w := wts[sf.repo][top]
			if w == nil {
				w = &CheckoutGroup{Checkout: top, Name: filepath.Base(top), Worktree: fv.worktree[top]}
				w.Gone = fv.goneCheckout(top)
				wts[sf.repo][top] = w
			}
			w.Sessions++
			w.BestUSD += c.BestUSD
			w.LastActivityAt = later(w.LastActivityAt, last)
		}
		share(sf.branchAll, c.BestUSD, NoBranch, func(k string, x float64) {
			if k == NoBranch {
				return
			}
			b := brs[sf.repo][k]
			if b == nil {
				b = &BranchGroup{Name: k}
				brs[sf.repo][k] = b
			}
			b.USD += x
		})
		for _, k := range sf.branches {
			if b := brs[sf.repo][k]; b != nil {
				b.Sessions++
				b.LastActivityAt = later(b.LastActivityAt, last)
			} else {
				brs[sf.repo][k] = &BranchGroup{Name: k, Sessions: 1, LastActivityAt: last}
			}
		}
	}
	out := make([]RepoGroup, 0, len(groups))
	for k, g := range groups {
		for _, w := range wts[k] {
			g.Checkouts = append(g.Checkouts, *w)
		}
		sort.Slice(g.Checkouts, func(i, j int) bool {
			a, b := g.Checkouts[i], g.Checkouts[j]
			if !a.LastActivityAt.Equal(b.LastActivityAt) {
				return a.LastActivityAt.After(b.LastActivityAt)
			}
			return a.Checkout < b.Checkout
		})
		for _, b := range brs[k] {
			g.Branches = append(g.Branches, *b)
		}
		sort.Slice(g.Branches, func(i, j int) bool {
			if !g.Branches[i].LastActivityAt.Equal(g.Branches[j].LastActivityAt) {
				return g.Branches[i].LastActivityAt.After(g.Branches[j].LastActivityAt)
			}
			return g.Branches[i].Name < g.Branches[j].Name
		})
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.Repo == NoRepo) != (b.Repo == NoRepo) {
			return b.Repo == NoRepo
		}
		if !a.LastActivityAt.Equal(b.LastActivityAt) {
			return a.LastActivityAt.After(b.LastActivityAt)
		}
		return a.Repo < b.Repo
	})
	return out
}

func later(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

// BeadGroup is one bead with the sessions that worked on it and the share of their cost spent
// on it. LastActivityAt is the last bd call on it.
type BeadGroup struct {
	BeadRef
	Sessions       int       `json:"sessions"`
	USD            float64   `json:"usd"`
	LastActivityAt time.Time `json:"lastActivityAt,omitzero"`
}

// FamilyGroup is a bead family: a root bead and everything below it. Beads are the root and
// the members some session worked on, in id order; Sessions counts the distinct sessions that
// worked on any of them, USD sums their shares. Issues and Closed count the family as the fold
// knows it (implied parents included). Hint names a family whose root has no title: the title of
// its earliest member that has one.
type FamilyGroup struct {
	Root           BeadRef     `json:"root"`
	Hint           string      `json:"hint,omitempty"`
	Sessions       int         `json:"sessions"`
	USD            float64     `json:"usd"`
	LastActivityAt time.Time   `json:"lastActivityAt,omitzero"`
	Issues         int         `json:"issues"`
	Closed         int         `json:"closed"`
	Beads          []BeadGroup `json:"beads"`
}

// Families returns the bead families some session selected by f worked on, most recently
// worked on first.
func (c *Catalog) Families(f Filter) []FamilyGroup {
	v, fv, f := c.prepare(f, true)
	beadsOf := map[string]*BeadGroup{}
	fams := map[string]*FamilyGroup{}
	famSessions := map[string]map[int]bool{}
	for _, s := range v.sessions {
		if !f.selects(s, "") {
			continue
		}
		sf := &fv.ses[s.idx]
		if len(sf.beads) == 0 {
			continue
		}
		usd := map[string]float64{}
		share(sf.beadAll, s.info.Cost.BestUSD, NoBead, func(k string, x float64) { usd[k] += x })
		for _, id := range sf.beads {
			ref := fv.bead[id]
			b := beadsOf[id]
			if b == nil {
				b = &BeadGroup{BeadRef: *ref}
				beadsOf[id] = b
			}
			b.Sessions++
			b.USD += usd[id]
			b.LastActivityAt = later(b.LastActivityAt, sf.lastOn[id])
			fam := fams[ref.Root]
			if fam == nil {
				fam = &FamilyGroup{Root: *fv.bead[ref.Root], Hint: fv.hint[ref.Root]}
				fams[ref.Root] = fam
				famSessions[ref.Root] = map[int]bool{}
			}
			famSessions[ref.Root][s.idx] = true
			fam.USD += usd[id]
			fam.LastActivityAt = later(fam.LastActivityAt, sf.lastOn[id])
		}
	}
	for root, fam := range fams {
		fam.Sessions = len(famSessions[root])
		if _, ok := beadsOf[root]; !ok {
			fam.Beads = append(fam.Beads, BeadGroup{BeadRef: fam.Root})
		}
	}
	for _, b := range beadsOf {
		fams[b.Root].Beads = append(fams[b.Root].Beads, *b)
	}
	for _, ref := range fv.bead {
		if fam := fams[ref.Root]; fam != nil {
			fam.Issues++
			if ref.Status == "closed" {
				fam.Closed++
			}
		}
	}
	out := make([]FamilyGroup, 0, len(fams))
	for _, fam := range fams {
		sort.Slice(fam.Beads, func(i, j int) bool { return idLess(fam.Beads[i].ID, fam.Beads[j].ID) })
		out = append(out, *fam)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].LastActivityAt.Equal(out[j].LastActivityAt) {
			return out[i].LastActivityAt.After(out[j].LastActivityAt)
		}
		return out[i].Root.ID < out[j].Root.ID
	})
	return out
}

// PrefixGroup is a bead prefix (merlin for merlin-t8s.48: in practice one project's bead
// database) with the sessions that worked on a bead of it, newest first in the list. USD is the
// share of their cost spent on its beads, BestUSD their whole best cost. Issues and Closed count
// its beads in the database; Families the families some session worked on.
type PrefixGroup struct {
	Prefix         string    `json:"prefix"`
	Database       string    `json:"database"`
	Sessions       int       `json:"sessions"`
	USD            float64   `json:"usd"`
	BestUSD        float64   `json:"bestUSD"`
	LastActivityAt time.Time `json:"lastActivityAt,omitzero"`
	Issues         int       `json:"issues"`
	Closed         int       `json:"closed"`
	Families       int       `json:"families"`
}

// Prefixes returns the bead prefixes some session selected by f worked on, the one with the most
// recently active session first.
func (c *Catalog) Prefixes(f Filter) []PrefixGroup {
	v, fv, f := c.prepare(f, true)
	groups := map[string]*PrefixGroup{}
	roots := map[string]map[string]bool{}
	for _, s := range v.sessions {
		if !f.selects(s, "") {
			continue
		}
		sf := &fv.ses[s.idx]
		if len(sf.beads) == 0 {
			continue
		}
		usd := map[string]float64{}
		share(sf.beadAll, s.info.Cost.BestUSD, NoBead, func(k string, x float64) { usd[k] += x })
		seen := map[string]bool{}
		for _, id := range sf.beads {
			pre := beads.Prefix(id)
			g := groups[pre]
			if g == nil {
				g = &PrefixGroup{Prefix: pre, Database: fv.bead[id].Database}
				groups[pre] = g
				roots[pre] = map[string]bool{}
			}
			g.USD += usd[id]
			roots[pre][fv.bead[id].Root] = true
			if !seen[pre] {
				seen[pre] = true
				g.Sessions++
				g.BestUSD += s.info.Cost.BestUSD
				g.LastActivityAt = later(g.LastActivityAt, s.d.LastActivityAt)
			}
		}
	}
	for _, ref := range fv.bead {
		if g := groups[beads.Prefix(ref.ID)]; g != nil {
			g.Issues++
			if ref.Status == "closed" {
				g.Closed++
			}
		}
	}
	out := make([]PrefixGroup, 0, len(groups))
	for pre, g := range groups {
		g.Families = len(roots[pre])
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].LastActivityAt.Equal(out[j].LastActivityAt) {
			return out[i].LastActivityAt.After(out[j].LastActivityAt)
		}
		return out[i].Prefix < out[j].Prefix
	})
	return out
}

// idLess orders bead ids with their dotted numbers compared as numbers (x.2 before x.10).
func idLess(a, b string) bool {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) && i < len(bs); i++ {
		if as[i] == bs[i] {
			continue
		}
		x, errA := strconv.Atoi(as[i])
		y, errB := strconv.Atoi(bs[i])
		if errA == nil && errB == nil {
			return x < y
		}
		return as[i] < bs[i]
	}
	return len(as) < len(bs)
}

// BeadDatabases is how many bead databases the catalog knows.
func (c *Catalog) BeadDatabases() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.places.Beads)
}
