package catalog

import (
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"sort"
	"time"

	"github.com/terek/merlin/internal/beads"
	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/repos"
)

// A session's primary location: docs/location.md §7. It is a pure function of the session's
// digest, which the catalog keeps whole (Upsert stores the digest as given), and of Places; a
// Places update runs it again for every session but touches no cost.

// doing is what a session did in one place: edits and commands.
type doing struct{ edits, commands int64 }

func (t *doing) add(o doing) { t.edits += o.edits; t.commands += o.commands }

// indexRepos works out from Places which repositories, checkouts and remotes are alive. A
// value is gone when no entry with it is live; an inferred entry is always gone and proves
// nothing. Entries are read in directory order, so the answer never depends on map order.
func (fv *facets) indexRepos() {
	fv.liveRepo, fv.liveCheckout, fv.liveRemote = map[string]bool{}, map[string]bool{}, map[string]bool{}
	fv.worktree, fv.checkoutRepo = map[string]bool{}, map[string]string{}
	liveRemote, anyRemote := map[string]string{}, map[string]string{} // repo -> its remote
	for _, dir := range slices.Sorted(maps.Keys(fv.places.Repos)) {
		r := fv.places.Repos[dir]
		live := !r.Gone && !r.Inferred
		if k := r.GitCommonDir; k != "" {
			if _, ok := fv.repo[k]; !ok {
				fv.repo[k] = RepoRef{Repo: k, Name: repos.Name(k)}
			}
			if live {
				fv.liveRepo[k] = true
			}
			if r.Remote != "" {
				if anyRemote[k] == "" {
					anyRemote[k] = r.Remote
				}
				if live && liveRemote[k] == "" {
					liveRemote[k] = r.Remote
				}
			}
		}
		if c := r.Checkout; c != "" {
			if _, ok := fv.checkoutRepo[c]; !ok {
				fv.checkoutRepo[c] = r.GitCommonDir
			}
			if live {
				fv.liveCheckout[c] = true
			}
			if r.Worktree {
				fv.worktree[c] = true
			}
		}
		if live && r.Remote != "" {
			fv.liveRemote[r.Remote] = true
		}
	}
	for k, ref := range fv.repo {
		ref.Remote = liveRemote[k]
		if ref.Remote == "" {
			ref.Remote = anyRemote[k]
		}
		ref.Gone = !fv.liveRepo[k]
		fv.repo[k] = ref
	}
}

// goneCheckout reports whether a checkout the entries name has no live entry.
func (fv *facets) goneCheckout(c string) bool {
	_, known := fv.checkoutRepo[c]
	return known && !fv.liveCheckout[c]
}

// checkoutsOf lists the checkouts of a session's repository among those it touched.
func (fv *facets) checkoutsOf(sf *sessFacets) []string {
	var out []string
	for _, c := range sf.checkouts {
		if fv.checkoutRepo[c] == sf.repo {
			out = append(out, c)
		}
	}
	return out
}

// look resolves a directory to its repository entry; a directory in no repository, or with no
// entry, is not found.
func (fv *facets) look(dir string) (repos.Repo, bool) {
	if dir == "" {
		return repos.Repo{}, false
	}
	r, ok := fv.places.Repos[filepath.Clean(dir)]
	return r, ok && r.GitCommonDir != ""
}

// activity sums what a session did per directory, leaving out inherited turns and the agents
// spawned in them (everything, when the session is nothing but a copy). A digest with no
// workDirs on any turn or agent turn, inherited ones included, is an old one: its non-inherited
// turns' filesTouched count as edits in the file's directory, and cwds and bd calls as commands.
func (fv *facets) activity(s *sess) map[string]*doing {
	d := s.d
	inherited := make(map[int]bool, len(s.info.InheritedTurns))
	for _, i := range s.info.InheritedTurns {
		inherited[i] = true
	}
	whole := len(d.Turns) > 0
	for _, t := range d.Turns {
		whole = whole && inherited[t.Index]
	}
	out := map[string]*doing{}
	add := func(dir string, t doing) {
		if dir == "" || !filepath.IsAbs(dir) {
			return
		}
		dir = filepath.Clean(dir)
		if out[dir] == nil {
			out[dir] = &doing{}
		}
		out[dir].add(t)
	}
	has := false
	for _, t := range d.Turns {
		has = has || len(t.WorkDirs) > 0
		if !inherited[t.Index] {
			for _, w := range t.WorkDirs {
				add(w.Dir, doing{w.Edits, w.Commands})
			}
		}
	}
	for i := range d.Agents {
		a := &d.Agents[i]
		skip := whole || a.SpawnTurn != nil && inherited[*a.SpawnTurn]
		for _, t := range a.Turns {
			has = has || len(t.WorkDirs) > 0
			if !skip {
				for _, w := range t.WorkDirs {
					add(w.Dir, doing{w.Edits, w.Commands})
				}
			}
		}
	}
	if has {
		return out
	}
	for _, t := range d.Turns {
		if inherited[t.Index] {
			continue
		}
		for _, f := range t.FilesTouched {
			if filepath.IsAbs(f) {
				add(filepath.Dir(f), doing{edits: 1})
			}
		}
	}
	if whole {
		return out
	}
	for _, c := range d.Cwds {
		add(c, doing{commands: 1})
	}
	owned := make(map[string]bool, len(s.own))
	for _, m := range s.own {
		owned[m.ID] = true
	}
	held := make(map[string]bool, len(d.Messages))
	for i := range d.Messages {
		held[d.Messages[i].ID] = true
	}
	for _, e := range d.Beads {
		if e.MessageID != "" && held[e.MessageID] && !owned[e.MessageID] {
			continue // copied from the session that made the call
		}
		add(e.Cwd, doing{commands: 1})
	}
	return out
}

// pick chooses among sorted candidates: the most edits; if none has any, the most commands; if
// none has either, nothing. Edits outrank commands strictly. Ties go to start, then to the
// first in order.
func pick(cands []string, of func(string) doing, start string) string {
	var maxE, maxC int64
	for _, c := range cands {
		t := of(c)
		maxE, maxC = max(maxE, t.edits), max(maxC, t.commands)
	}
	score := func(t doing) int64 { return t.edits }
	best := maxE
	if maxE == 0 {
		score, best = func(t doing) int64 { return t.commands }, maxC
	}
	if best == 0 {
		return ""
	}
	if start != "" && slices.Contains(cands, start) && score(of(start)) == best {
		return start
	}
	for _, c := range cands {
		if score(of(c)) == best {
			return c
		}
	}
	return ""
}

// locate works out the primary repo, checkout and remote of a session and the lists of every
// value it touched.
func (fv *facets) locate(s *sess) (repo, checkout, remote string, checkouts, repoList, remotes []string) {
	d := s.d
	start, ok := fv.look(d.Project)
	if !ok {
		start, ok = fv.look(d.Cwd)
	}
	var startRepo, startCheckout string
	if ok {
		startRepo, startCheckout = start.GitCommonDir, start.Checkout
	}

	byRepo := map[string]*doing{}
	byCheckout := map[string]map[string]*doing{} // repo -> checkout -> what was done there
	touchedC, touchedR := map[string]bool{}, map[string]bool{}
	for dir, t := range fv.activity(s) {
		r, ok := fv.look(dir)
		if !ok {
			continue // no repository: it contributes to nothing
		}
		k := r.GitCommonDir
		touchedR[k] = true
		if byRepo[k] == nil {
			byRepo[k] = &doing{}
		}
		byRepo[k].add(*t)
		if r.Checkout != "" {
			touchedC[r.Checkout] = true
			if byCheckout[k] == nil {
				byCheckout[k] = map[string]*doing{}
			}
			if byCheckout[k][r.Checkout] == nil {
				byCheckout[k][r.Checkout] = &doing{}
			}
			byCheckout[k][r.Checkout].add(*t)
		}
	}

	repo = pick(slices.Sorted(maps.Keys(byRepo)), func(k string) doing { return *byRepo[k] }, startRepo)
	if repo == "" {
		repo = startRepo
	}
	if repo != "" {
		startHere := ""
		if startRepo == repo {
			startHere = startCheckout
		}
		cs := byCheckout[repo]
		checkout = pick(slices.Sorted(maps.Keys(cs)), func(c string) doing { return *cs[c] }, startHere)
		if checkout == "" {
			checkout = startHere
		}
		remote = fv.repo[repo].Remote
	}

	for _, k := range []string{repo, startRepo} {
		if k != "" {
			touchedR[k] = true
		}
	}
	for _, c := range []string{checkout, startCheckout} {
		if c != "" {
			touchedC[c] = true
		}
	}
	touchedM := map[string]bool{}
	for k := range touchedR {
		if m := fv.repo[k].Remote; m != "" {
			touchedM[m] = true
		}
	}
	return repo, checkout, remote, slices.Sorted(maps.Keys(touchedC)), slices.Sorted(maps.Keys(touchedR)),
		slices.Sorted(maps.Keys(touchedM))
}

// GroupBy names a location key a listing groups sessions by.
type GroupBy string

const (
	GroupDir      GroupBy = "dir"      // the directory a session started in
	GroupCheckout GroupBy = "checkout" // its primary checkout
	GroupRepo     GroupBy = "repo"     // its primary repository (git common dir)
	GroupRemote   GroupBy = "remote"   // its primary remote

	// The bead keys (docs/beads-and-repos.md §6.8): a session counts under the one value that
	// holds the largest share of its cost; sessions on no bead count under NoBead.
	GroupBeadDatabase GroupBy = "beadDatabase" // the folded database of the bead
	GroupPrefix       GroupBy = "prefix"       // the id prefix of the bead
	GroupFamily       GroupBy = "family"       // the root of the bead's family
	GroupBead         GroupBy = "bead"         // the bead itself
)

// Group is one value of a location key with the sessions that count under it. Sessions does
// not count scripted runs; Money sums their cost too, as RepoGroup does. Key is empty for the
// sessions with no value.
type Group struct {
	Key            string    `json:"key"`
	Name           string    `json:"name"`
	Remote         string    `json:"remote,omitempty"`
	Gone           bool      `json:"gone,omitempty"`
	Sessions       int       `json:"sessions"`
	LastActivityAt time.Time `json:"lastActivityAt,omitzero"`
	Money          Money     `json:"cost"`
}

// Groups lists the values of a location key among the sessions selected by f, most recently
// active first; the group with the empty key comes last.
func (c *Catalog) Groups(by GroupBy, f Filter) ([]Group, error) {
	if !slices.Contains([]GroupBy{GroupDir, GroupCheckout, GroupRepo, GroupRemote, GroupBeadDatabase,
		GroupPrefix, GroupFamily, GroupBead}, by) {
		return nil, fmt.Errorf("catalog: cannot group by %q", by)
	}
	v, fv, f := c.prepare(f, true)
	groups := map[string]*Group{}
	for _, s := range v.sessions {
		if !f.selects(s, "") {
			continue
		}
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
		default:
			key = fv.topValue(sf, by)
		}
		g := groups[key]
		if g == nil {
			g = fv.group(by, key)
			groups[key] = g
		}
		cost := &s.info.Cost
		g.Money.add(cost.ReportedUSD, cost.UncoveredUSD+cost.EstimatedUncoveredUSD)
		if s.d.Kind == model.KindSDK {
			continue
		}
		g.Sessions++
		g.LastActivityAt = later(g.LastActivityAt, s.d.LastActivityAt)
	}
	out := make([]Group, 0, len(groups))
	for _, g := range groups {
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.Key == "") != (b.Key == "") {
			return b.Key == ""
		}
		if !a.LastActivityAt.Equal(b.LastActivityAt) {
			return a.LastActivityAt.After(b.LastActivityAt)
		}
		return a.Key < b.Key
	})
	return out, nil
}

// group names a value of a location key.
func (fv *facets) group(by GroupBy, key string) *Group {
	g := &Group{Key: key}
	if key == "" {
		g.Name = map[GroupBy]string{GroupDir: "(no directory)", GroupCheckout: "(no checkout)",
			GroupRepo: "(no repository)", GroupRemote: "(no remote)", GroupBeadDatabase: "(no bead)",
			GroupPrefix: "(no bead)", GroupFamily: "(no bead)", GroupBead: "(no bead)"}[by]
		return g
	}
	switch by {
	case GroupDir:
		g.Name = filepath.Base(key)
		if r, ok := fv.places.Repos[filepath.Clean(key)]; ok {
			g.Gone = r.Gone || r.Inferred
			g.Remote = r.Remote
			if ref, ok := fv.repo[r.GitCommonDir]; ok {
				g.Remote = ref.Remote
			}
		}
	case GroupCheckout:
		g.Name = filepath.Base(key)
		g.Gone = fv.goneCheckout(key)
		g.Remote = fv.repo[fv.checkoutRepo[key]].Remote
	case GroupRepo:
		ref := fv.repoRef(key)
		g.Name, g.Remote, g.Gone = ref.Name, ref.Remote, ref.Gone
	case GroupRemote:
		g.Name, g.Remote = key, key
		g.Gone = !fv.liveRemote[key]
	case GroupBeadDatabase, GroupPrefix:
		g.Name = key // the database key or the prefix: there is no nicer name
	case GroupFamily:
		g.Name = key
		if b, ok := fv.bead[key]; ok && b.Title != "" {
			g.Name = b.Title
		} else if h := fv.hint[key]; h != "" {
			g.Name = h
		}
	case GroupBead:
		g.Name = key
		if b, ok := fv.bead[key]; ok && b.Title != "" {
			g.Name = b.Title
		}
	}
	return g
}

// topValue is the value of a bead key (GroupBeadDatabase, GroupPrefix, GroupFamily or GroupBead)
// a session counts under: the one with the largest share of its attributed cost, the first in
// sort order on a tie. The cost no bead accounts for does not compete: a session that worked on
// any bead counts under one; a session that worked on none, or whose beads cost nothing, under
// NoBead.
func (fv *facets) topValue(sf *sessFacets, by GroupBy) string {
	w := map[string]float64{}
	for id, x := range sf.beadAll {
		b, ok := fv.bead[id]
		if !ok {
			continue // NoBead
		}
		switch by {
		case GroupBeadDatabase:
			w[b.Database] += x
		case GroupPrefix:
			w[beads.Prefix(id)] += x
		case GroupFamily:
			w[b.Root] += x
		default:
			w[id] += x
		}
	}
	best, top := NoBead, 0.0
	for _, k := range slices.Sorted(maps.Keys(w)) {
		if w[k] > top {
			best, top = k, w[k]
		}
	}
	return best
}
