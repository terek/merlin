package moments

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/terek/merlin/internal/model"
)

// Yegge's detectors: the frontier. Teams, swarms, workflows, beads.

func agentTeam(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		var first *model.Agent
		n := 0
		for _, a := range s.Agents {
			if a.Kind == model.AgentSubagent && a.Addressable {
				if first == nil {
					first = a
				}
				n++
			}
		}
		if first != nil {
			emit(Hit{At: first.StartedAt, Session: s.Key(), Turn: first.SpawnTurn, Note: fmt.Sprintf("%d teammate%s", n, plural(n))})
		}
	})
}

func workflowRun(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, w := range s.D.Workflows {
			if !s.OwnTurn(w.Turn) || !s.OwnSince(w.StartedAt) {
				continue
			}
			emit(Hit{At: w.StartedAt, Session: s.Key(), Turn: w.Turn, Note: fmt.Sprintf("a workflow of %d agent%s", w.Agents, plural(w.Agents))})
		}
	})
}

func nestedAgents(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		deepest, deep := 0, (*model.Agent)(nil)
		for _, a := range s.Agents {
			if a.ParentAgentID != nil && a.Depth > deepest {
				deepest, deep = a.Depth, a
			}
		}
		if deep != nil {
			emit(Hit{At: deep.StartedAt, Session: s.Key(), Turn: deep.SpawnTurn, Note: fmt.Sprintf("agents %d levels deep", deepest)})
		}
	})
}

// swarmSize is how many agents must run at once to make a swarm.
const swarmSize = 5

func swarm(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		var iv []interval
		for _, a := range s.Agents {
			if a.Kind == model.AgentSubagent || a.Kind == model.AgentWorkflow {
				iv = append(iv, interval{from: a.StartedAt, to: a.EndedAt, owner: a.ID,
					ref: Hit{Session: s.Key(), Turn: a.SpawnTurn}})
			}
		}
		if n, at := peak(iv); n >= swarmSize {
			h := at.ref
			h.At, h.Note = at.from, fmt.Sprintf("%d agents at once", n)
			emit(h)
		}
	})
}

func beadsGraph(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		created, linked, closed := 0, 0, 0
		var at time.Time
		for _, b := range s.D.Beads {
			if b.Outcome == model.BeadFailed || !s.OwnTurn(b.Turn) || !s.OwnSince(b.At) {
				continue
			}
			switch b.Op {
			case model.BeadCreate:
				created++
				if b.Parent != "" {
					linked++
				}
			case model.BeadDep:
				linked++
			case model.BeadClose:
				closed++
			default:
				continue
			}
			if at.IsZero() {
				at = b.At
			}
		}
		if created >= 3 && linked >= 1 && closed >= 1 {
			emit(Hit{At: at, Session: s.Key(), Note: fmt.Sprintf("%d beads created, %d links, %d closed", created, linked, closed)})
		}
	})
}

func forkedAgents(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, a := range s.Agents {
			if a.InheritsContext && a.Kind == model.AgentSubagent {
				emit(Hit{At: a.StartedAt, Session: s.Key(), Turn: a.SpawnTurn, Note: "a fork with the whole context"})
			}
		}
	})
}

func twoHarnesses(c *Corpus, emit func(Hit)) {
	type week struct {
		harnesses []string
		second    *Session
	}
	weeks := map[int]*week{}
	var order []int
	c.Interactive(func(s *Session) {
		if s.D.StartedAt.IsZero() {
			return
		}
		y, w := s.D.StartedAt.In(c.Loc).ISOWeek()
		k := y*100 + w
		wk := weeks[k]
		if wk == nil {
			wk = &week{}
			weeks[k] = wk
			order = append(order, k)
		}
		if !slices.Contains(wk.harnesses, s.D.Harness) {
			wk.harnesses = append(wk.harnesses, s.D.Harness)
			if len(wk.harnesses) == 2 {
				wk.second = s
			}
		}
	})
	for _, k := range order {
		if s := weeks[k].second; s != nil {
			emit(Hit{At: s.D.StartedAt, Session: s.Key(), Note: fmt.Sprintf("%d harnesses in one week", len(weeks[k].harnesses))})
		}
	}
}

const (
	awayFor      = 2 * time.Hour // a gap between two prompts at least this long
	awayMachines = 3             // with at least this many turns nobody typed in it
)

func nightShift(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		var last *model.Turn // the last human turn
		machine := 0
		for _, t := range s.Turns {
			if t.Origin != model.OriginHuman {
				if last != nil && t.Origin != model.OriginCommand {
					machine++
				}
				continue
			}
			if last != nil && machine >= awayMachines && t.StartedAt.Sub(end(last)) >= awayFor {
				h := turnHit(s, last, fmt.Sprintf("%d turns of agent work over %s while you were away", machine, hours(t.StartedAt.Sub(end(last)))))
				h.At = end(last)
				emit(h)
			}
			last, machine = t, 0
		}
	})
}

func hours(d time.Duration) string {
	return fmt.Sprintf("%.0f h", d.Hours())
}

func personas(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		var first *model.Turn
		woke, slept := false, false
		for _, t := range s.Turns {
			name := commandName(t.Command)
			hit := t.Command != "" && contains(personaCommands, name)
			for _, f := range t.FilesTouched {
				for _, d := range personaDirs {
					hit = hit || strings.Contains(f, d)
				}
			}
			if !hit {
				continue
			}
			if first == nil {
				first = t
			}
			woke = woke || name == "wake"
			slept = slept || name == "sleep" || name == "handoff"
		}
		if first == nil {
			return
		}
		note := "worked with a persistent persona"
		switch {
		case woke && slept:
			note = "a persona's whole workday: woke, worked, slept"
		case woke:
			note = "woke a persistent persona"
		case slept:
			note = "a persona ended its day with sleep"
		}
		emit(turnHit(s, first, note))
	})
}
