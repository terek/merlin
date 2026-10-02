package catalog

import (
	"slices"
	"sort"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

// lineage links sessions that share history into parent -> child trees.
//
// Two sessions that share a message id or a prompt uuid are related; the one that
// "comes before" (explicit markers, then the ownership order) is the parent side. A
// session may be related to several earlier ones (a continuation of a continuation shares
// history with both); its parent is the one named by its own markers, else the one it
// shares the most with, else the oldest.
func (v *view) lineage(pairs map[pairKey]*pairCount) {
	type cand struct {
		p  *sess
		pc *pairCount
	}
	cands := make([][]cand, len(v.sessions))
	for k, pc := range pairs {
		a, b := v.sessions[k[0]], v.sessions[k[1]]
		p, c := a, b
		if !v.before(a, b) {
			p, c = b, a
		}
		cands[c.idx] = append(cands[c.idx], cand{p, pc})
	}

	best := make([]*pairCount, len(v.sessions))
	for _, c := range v.sessions {
		var chosen *cand
		for i := range cands[c.idx] {
			x := &cands[c.idx][i]
			if chosen == nil || v.betterParent(c, x.p, x.pc, chosen.p, chosen.pc) {
				chosen = x
			}
		}
		if chosen != nil {
			c.parent = chosen.p.idx
			best[c.idx] = chosen.pc
		}
	}
	v.breakCycles(best)

	for _, c := range v.sessions {
		if c.parent < 0 {
			continue
		}
		p := v.sessions[c.parent]
		l := v.link(p, c, best[c.idx])
		c.info.Parent = &l
		p.kids = append(p.kids, c.idx)
		v.diag.Links++
	}
	for _, p := range v.sessions {
		sort.Slice(p.kids, func(i, j int) bool { return older(v.sessions[p.kids[i]], v.sessions[p.kids[j]]) })
		for _, k := range p.kids {
			p.info.Children = append(p.info.Children, *v.sessions[k].info.Parent)
		}
	}
}

// betterParent reports whether candidate x is a better parent of c than y.
func (v *view) betterParent(c, x *sess, xc *pairCount, y *sess, yc *pairCount) bool {
	if xe, ye := c.names(x), c.names(y); xe != ye {
		return xe
	}
	if xc.msgs != yc.msgs {
		return xc.msgs > yc.msgs
	}
	if xc.turns != yc.turns {
		return xc.turns > yc.turns
	}
	return v.before(x, y)
}

// breakCycles removes parent links until the parent pointers form a forest. Cycles can
// only come from inconsistent markers; the link of the session with the largest index in
// each cycle is dropped.
func (v *view) breakCycles(best []*pairCount) {
	for {
		state := make([]int8, len(v.sessions)) // 0 new, 1 on the current path, 2 done
		found := false
		for _, s := range v.sessions {
			if state[s.idx] != 0 {
				continue
			}
			var path []int
			i := s.idx
			for i >= 0 && state[i] == 0 {
				state[i] = 1
				path = append(path, i)
				i = v.sessions[i].parent
			}
			if i >= 0 && state[i] == 1 {
				cut := slices.Max(path[slices.Index(path, i):])
				v.sessions[cut].parent = -1
				best[cut] = nil
				v.diag.CycleBreaks++
				found = true
				break
			}
			for _, p := range path {
				state[p] = 2
			}
		}
		if !found {
			return
		}
	}
}

// link describes how child c continues or forks from parent p.
func (v *view) link(p, c *sess, pc *pairCount) Link {
	l := Link{
		Parent:         p.key,
		Child:          c.key,
		SharedMessages: pc.msgs,
		SharedTurns:    pc.turns,
		AtTurn:         -1,
		Explicit:       c.names(p),
	}

	// The copy ends at the last parent turn the child holds, found by prompt uuid and,
	// for copies without whole turns, by the turn of the last shared message.
	parentTurn := make(map[string]int, len(p.d.Turns))
	for _, t := range p.d.Turns {
		if t.UUID != "" {
			parentTurn[t.UUID] = t.Index
		}
	}
	for _, t := range c.d.Turns {
		if i, ok := parentTurn[t.UUID]; ok && t.UUID != "" {
			c.info.InheritedTurns = append(c.info.InheritedTurns, t.Index)
			l.AtTurn = max(l.AtTurn, i)
		}
	}
	childMsgs := make(map[string]struct{}, len(c.d.Messages))
	for _, m := range c.d.Messages {
		childMsgs[m.ID] = struct{}{}
	}
	for _, m := range p.d.Messages {
		if _, shared := childMsgs[m.ID]; shared && m.Turn != nil {
			l.AtTurn = max(l.AtTurn, *m.Turn)
		}
	}

	marked := c.d.Lineage.ForkedFrom != nil && c.d.Lineage.ForkedFrom.SessionID == p.key.ID
	// The parent has gone on by itself if it has a turn after the copy point, or a message
	// of its own later than the last message it shares with the child (it can have carried
	// on inside the last copied turn).
	var lastShared time.Time
	for _, m := range p.d.Messages {
		if _, shared := childMsgs[m.ID]; shared && m.At.After(lastShared) {
			lastShared = m.At
		}
	}
	own := false
	for _, t := range p.d.Turns {
		if t.Index > l.AtTurn {
			own = true
			break
		}
	}
	if !own {
		for _, m := range p.d.Messages {
			if _, shared := childMsgs[m.ID]; !shared && (!lastShared.IsZero() && m.At.After(lastShared) || m.Turn != nil && *m.Turn > l.AtTurn) {
				own = true
				break
			}
		}
	}
	if marked || own {
		l.Kind = LinkFork
	} else {
		l.Kind = LinkContinuation
	}
	return l
}

// fill completes every session's SessionInfo once ownership and lineage are known.
func (v *view) fill() {
	for _, s := range v.sessions {
		d := s.d
		in := &s.info
		in.Key = s.key
		in.Project = s.project
		in.ProjectKey = d.ProjectKey
		in.Cwd = d.Cwd
		if n := len(d.GitBranches); n > 0 {
			in.Branch = d.GitBranches[n-1]
		}
		in.Title = d.Title
		in.Name = d.Name
		in.Kind = d.Kind
		in.StartedAt = d.StartedAt
		in.LastActivityAt = d.LastActivityAt
		in.EndState = d.EndState
		in.SourceMissing = d.SourceMissing
		in.Turns = len(d.Turns)

		in.FirstOwnTurn = -1
		inherited := make(map[int]struct{}, len(in.InheritedTurns))
		for _, i := range in.InheritedTurns {
			inherited[i] = struct{}{}
		}
		for _, t := range d.Turns {
			if _, ok := inherited[t.Index]; !ok {
				in.FirstOwnTurn = t.Index
				break
			}
		}

		root := s
		for root.parent >= 0 {
			root = v.sessions[root.parent]
		}
		in.Root = root.key
		in.Leaf = true
		for _, k := range s.kids {
			if v.sessions[k].info.Parent.Kind == LinkContinuation {
				in.Leaf = false
				break
			}
		}
	}
}

// family returns the family of s.
func (v *view) family(s *sess) Family {
	root := v.byKey[s.info.Root]
	f := Family{Root: root.key}
	var walk func(*sess)
	walk = func(x *sess) {
		f.Members = append(f.Members, x.key)
		if x.info.Leaf {
			f.Leaves = append(f.Leaves, x.key)
		}
		for _, k := range x.kids {
			walk(v.sessions[k])
		}
	}
	walk(root)
	sort.SliceStable(f.Leaves, func(i, j int) bool {
		a, b := v.byKey[f.Leaves[i]], v.byKey[f.Leaves[j]]
		if c := a.d.LastActivityAt.Compare(b.d.LastActivityAt); c != 0 {
			return c > 0
		}
		return older(a, b)
	})
	return f
}

// leavesFirst orders sessions for a hit's continuedIn list: leaves of the family first,
// then the others, each newest first by last activity.
func (v *view) leavesFirst(set []*sess) []model.SessionKey {
	sort.SliceStable(set, func(i, j int) bool {
		a, b := set[i], set[j]
		if a.info.Leaf != b.info.Leaf {
			return a.info.Leaf
		}
		if c := a.d.LastActivityAt.Compare(b.d.LastActivityAt); c != 0 {
			return c > 0
		}
		return older(a, b)
	})
	out := make([]model.SessionKey, len(set))
	for i, s := range set {
		out[i] = s.key
	}
	return out
}
