package catalog

import (
	"slices"
	"sort"
	"time"

	"github.com/terek/merlin/internal/model"
)

// BeadDetail is everything the catalog knows of one bead: the folded bead, the beads around it,
// the sessions that worked on it and every bd call that named it (docs/beads-and-repos.md §6).
type BeadDetail struct {
	BeadRef
	Priority    *int      `json:"priority,omitempty"`
	CreatedAt   time.Time `json:"createdAt,omitzero"`
	ClosedAt    time.Time `json:"closedAt,omitzero"`
	CloseReason string    `json:"closeReason,omitempty"`
	FirstSeen   time.Time `json:"firstSeen,omitzero"` // the first bd call that named it
	LastSeen    time.Time `json:"lastSeen,omitzero"`
	// Ancestors is the parent chain: the parent first, the family root last.
	Ancestors []BeadRef `json:"ancestors,omitempty"`
	// Children are the direct children, in id order.
	Children []BeadRef `json:"children,omitempty"`
	// Sessions worked on it (any bd call but show), most expensive share first.
	Sessions []BeadSession `json:"sessions,omitempty"`
	// Timeline is every owned bd call that named it, in time order across sessions and agents.
	Timeline []BeadStep `json:"timeline,omitempty"`
}

// BeadSession is a session that worked on a bead, with its share of the session's best cost and
// the bd operations it ran on the bead, in order of first use.
type BeadSession struct {
	Harness string         `json:"harness"`
	ID      string         `json:"id"`
	Title   string         `json:"title,omitempty"`
	Project string         `json:"project,omitempty"`
	USD     float64        `json:"usd"`
	Ops     []model.BeadOp `json:"ops"`
}

// BeadStep is one bd call on a bead. Failed calls are history too and carry Outcome failed.
type BeadStep struct {
	At        time.Time         `json:"at"`
	Harness   string            `json:"harness"`
	SessionID string            `json:"sessionId"`
	AgentID   string            `json:"agentId,omitempty"`
	Turn      *int              `json:"turn,omitempty"`
	AgentTurn *int              `json:"agentTurn,omitempty"`
	Op        model.BeadOp      `json:"op"`
	Status    string            `json:"status,omitempty"`
	Outcome   model.BeadOutcome `json:"outcome"`
	Title     string            `json:"title,omitempty"`
	Reason    string            `json:"reason,omitempty"`
}

// Bead returns a bead the fold knows (a registry export, a bd call in some session, or a parent
// they imply), with its family, sessions and timeline.
func (c *Catalog) Bead(id string) (BeadDetail, bool) {
	v, fv := c.views()
	is, _, ok := fv.fold.Issue(id)
	if !ok {
		return BeadDetail{}, false
	}
	d := BeadDetail{BeadRef: *fv.bead[id], Priority: is.Priority, CreatedAt: is.CreatedAt, ClosedAt: is.ClosedAt,
		CloseReason: is.CloseReason, FirstSeen: is.FirstSeen, LastSeen: is.LastSeen}
	for p, seen := fv.bead[id].Parent, map[string]bool{id: true}; p != "" && !seen[p]; {
		seen[p] = true
		b, ok := fv.bead[p]
		if !ok {
			break
		}
		d.Ancestors = append(d.Ancestors, *b)
		p = b.Parent
	}
	for _, k := range fv.kids[id] {
		d.Children = append(d.Children, *fv.bead[k])
	}

	type stamped struct {
		step BeadStep
		key  string
	}
	var steps []stamped
	for _, s := range v.sessions {
		sf := &fv.ses[s.idx]
		if slices.Contains(sf.beads, id) {
			usd := map[string]float64{}
			share(sf.beadAll, s.info.Cost.BestUSD, NoBead, func(k string, x float64) { usd[k] += x })
			d.Sessions = append(d.Sessions, BeadSession{Harness: s.key.Harness, ID: s.key.ID, Title: s.d.Title,
				Project: s.project, USD: usd[id], Ops: sf.ops[id]})
		}
		for _, e := range ownedBeads(s) {
			if !fv.timelineNames(e, id) {
				continue
			}
			title := e.Title
			for _, sn := range e.Seen {
				if sn.ID == id && title == "" {
					title = sn.Title
				}
			}
			steps = append(steps, stamped{BeadStep{At: e.At, Harness: s.key.Harness, SessionID: s.key.ID, AgentID: e.AgentID,
				Turn: e.Turn, AgentTurn: e.AgentTurn, Op: e.Op, Status: e.Status, Outcome: e.Outcome, Title: title,
				Reason: e.Reason}, s.key.Harness + "/" + s.key.ID})
		}
	}
	sort.SliceStable(d.Sessions, func(i, j int) bool { return d.Sessions[i].USD > d.Sessions[j].USD })
	sort.SliceStable(steps, func(i, j int) bool {
		a, b := steps[i], steps[j]
		if !a.step.At.Equal(b.step.At) {
			return a.step.At.Before(b.step.At)
		}
		return a.key < b.key
	})
	for _, st := range steps {
		d.Timeline = append(d.Timeline, st.step)
	}
	return d, true
}

// timelineNames reports whether a call belongs on bead id's timeline: it names the id in its
// ids or in what its output printed, and the output-only guard (names) does not drop it.
func (fv *facets) timelineNames(e model.BeadEvent, id string) bool {
	named := slices.Contains(e.IDs, id)
	for _, sn := range e.Seen {
		named = named || sn.ID == id
	}
	return named && fv.names(e, id, fv.hereOf(e.Cwd))
}
