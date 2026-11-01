package moments

import (
	"cmp"
	"slices"
	"strings"
	"time"

	"github.com/terek/merlin/internal/model"
)

// Input is one session for a report: its digest and the turns it copied from a parent
// session (catalog.SessionInfo.InheritedTurns), which are skipped so that a resumed or forked
// session does not count its parent's moments again.
type Input struct {
	Digest    *model.SessionDigest
	Inherited []int
	// Project is what the session counts under in Report.Projects: its repository when the
	// caller knows it (so a repository's worktrees count once), else empty for the directory it
	// started in.
	Project string
}

// Corpus is what detectors read: every session, oldest first, with copied history removed.
type Corpus struct {
	Sessions []*Session
	Loc      *time.Location
}

// Session is one session as detectors see it.
type Session struct {
	D *model.SessionDigest
	// Turns are the session's own turns (copied ones left out), in order.
	Turns []*model.Turn
	// Agents are the agents its own turns started (copied ones left out), in digest order,
	// without the compaction pseudo-agents.
	Agents []*model.Agent
	// Project is Input.Project, or the directory the session started in.
	Project   string
	inherited map[int]bool
	firstOwn  time.Time // start of the first own turn; zero when unknown
	mainModel string
}

func newCorpus(in []Input, loc *time.Location) *Corpus {
	c := &Corpus{Loc: loc}
	for _, i := range in {
		d := i.Digest
		if d == nil || d.Error != "" {
			continue
		}
		s := &Session{D: d, Project: cmp.Or(i.Project, d.Project), inherited: map[int]bool{}}
		for _, t := range i.Inherited {
			s.inherited[t] = true
		}
		for k := range d.Turns {
			t := &d.Turns[k]
			if s.inherited[t.Index] {
				continue
			}
			s.Turns = append(s.Turns, t)
			if s.firstOwn.IsZero() {
				s.firstOwn = t.StartedAt
			}
		}
		for k := range d.Agents {
			a := &d.Agents[k]
			if a.Kind == model.AgentCompact || !s.OwnTurn(a.SpawnTurn) {
				continue
			}
			s.Agents = append(s.Agents, a)
		}
		s.mainModel = mainModel(d)
		c.Sessions = append(c.Sessions, s)
	}
	slices.SortStableFunc(c.Sessions, func(a, b *Session) int {
		return cmp.Or(a.D.StartedAt.Compare(b.D.StartedAt), cmp.Compare(a.Key().String(), b.Key().String()))
	})
	return c
}

// mainModel is the model of most of the main agent's billed messages.
func mainModel(d *model.SessionDigest) string {
	n := map[string]int{}
	best, bestN := "", 0
	for _, m := range d.Messages {
		if m.AgentID != "" || m.Model == "" || strings.HasPrefix(m.Model, "<") {
			continue
		}
		n[m.Model]++
		if k := n[m.Model]; k > bestN || (k == bestN && m.Model < best) {
			best, bestN = m.Model, k
		}
	}
	return best
}

// Key is the session's key.
func (s *Session) Key() model.SessionKey { return s.D.Key() }

// Scripted reports whether the session was run by a program (claude -p, the SDK).
func (s *Session) Scripted() bool { return s.D.Kind == model.KindSDK }

// OwnTurn reports whether a turn index belongs to this session rather than to copied
// history. A nil index (unknown) counts as own.
func (s *Session) OwnTurn(turn *int) bool { return turn == nil || !s.inherited[*turn] }

// OwnSince reports whether a time is at or after the session's first own turn.
func (s *Session) OwnSince(t time.Time) bool { return s.firstOwn.IsZero() || !t.Before(s.firstOwn) }

// MainModel is the model most of the main agent's messages were billed on.
func (s *Session) MainModel() string { return s.mainModel }

// Interactive calls f for every session a person worked in (not scripted), oldest first.
func (c *Corpus) Interactive(f func(s *Session)) {
	for _, s := range c.Sessions {
		if !s.Scripted() {
			f(s)
		}
	}
}

// HumanTurns calls f for every own turn a person typed, with the next such turn (nil for the
// last).
func (s *Session) HumanTurns(f func(t, next *model.Turn)) {
	var human []*model.Turn
	for _, t := range s.Turns {
		if t.Origin == model.OriginHuman && !t.Abandoned {
			human = append(human, t)
		}
	}
	for i, t := range human {
		var next *model.Turn
		if i+1 < len(human) {
			next = human[i+1]
		}
		f(t, next)
	}
}

// turnHit is a hit at a turn's start.
func turnHit(s *Session, t *model.Turn, note string) Hit {
	i := t.Index
	return Hit{At: t.StartedAt, Session: s.Key(), Turn: &i, Note: note}
}

// end is when a turn ended: EndedAt, else its start plus its duration, else its start.
func end(t *model.Turn) time.Time {
	if !t.EndedAt.IsZero() {
		return t.EndedAt
	}
	return t.StartedAt.Add(time.Duration(t.DurationMs) * time.Millisecond)
}

// interval is a stretch of time with an owner, for overlap sweeps.
type interval struct {
	from, to time.Time
	owner    string
	ref      Hit // where a hit found by the sweep points
}

// peak sweeps intervals and returns, for the highest number of distinct owners active at
// once, that number and the interval whose start reached it first.
func peak(iv []interval) (int, *interval) {
	type ev struct {
		at    time.Time
		start bool
		i     int
	}
	var evs []ev
	for i, x := range iv {
		if x.from.IsZero() || !x.to.After(x.from) {
			continue
		}
		evs = append(evs, ev{x.from, true, i}, ev{x.to, false, i})
	}
	slices.SortStableFunc(evs, func(a, b ev) int {
		if c := a.at.Compare(b.at); c != 0 {
			return c
		}
		// ends before starts at the same instant: touching intervals do not overlap
		if a.start != b.start {
			if a.start {
				return 1
			}
			return -1
		}
		return cmp.Compare(a.i, b.i)
	})
	active := map[string]int{}
	best := 0
	var at *interval
	for _, e := range evs {
		o := iv[e.i].owner
		if e.start {
			active[o]++
			if len(active) > best {
				best, at = len(active), &iv[e.i]
			}
		} else if active[o]--; active[o] == 0 {
			delete(active, o)
		}
	}
	return best, at
}
