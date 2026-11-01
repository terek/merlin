package moments

import (
	"fmt"
	"strings"
	"time"

	"github.com/terek/merlin/internal/model"
)

// personaInfo is the fixed part of each persona, in display order.
var personaInfo = []struct {
	id          Persona
	name, focus string
}{
	{Karpathy, "Andrej Karpathy", "Context"},
	{Boris, "Boris Cherny", "Harness"},
	{Yegge, "Steve Yegge", "Frontier"},
}

// steeringMoments are the Karpathy moments that show a person steering, the counterweight to
// a lot of frontier work.
var steeringMoments = []string{"steer-mid-turn", "interrupt-redirect", "rewind"}

const (
	overYeggeHits   = 5   // recent frontier hits that start to worry the others
	killedShare     = 0.3 // share of recent agents killed that worries them
	killedMinAgents = 5   // ... once there are at least this many
)

// overYegge reports a lot of frontier work in the window with no steering, or with many
// killed agents.
func overYegge(c *Corpus, ms []MomentView, windowStart time.Time) bool {
	frontier, steering := 0, 0
	for _, m := range ms {
		if m.Persona == Yegge {
			frontier += m.RecentHits
		}
		if contains(steeringMoments, m.ID) {
			steering += m.RecentHits
		}
	}
	if frontier < overYeggeHits {
		return false
	}
	agents, killed := recentAgents(c, windowStart)
	return steering == 0 || (agents >= killedMinAgents && float64(killed) >= killedShare*float64(agents))
}

func recentAgents(c *Corpus, windowStart time.Time) (agents, killed int) {
	c.Interactive(func(s *Session) {
		for _, a := range s.Agents {
			if a.Kind == model.AgentCompact || a.StartedAt.Before(windowStart) {
				continue
			}
			agents++
			if a.Status == model.StatusKilled {
				killed++
			}
		}
	})
	return agents, killed
}

func react(ms []MomentView, over bool) []PersonaView {
	out := make([]PersonaView, 0, len(personaInfo))
	for _, p := range personaInfo {
		v := PersonaView{ID: p.id, Name: p.name, Focus: p.focus}
		var fresh, active, recent []string
		for _, m := range ms {
			if m.Persona != p.id {
				continue
			}
			switch m.Status {
			case StatusHabit:
				v.Habits++
			case StatusExplored:
				v.Explored++
			default:
				v.Unseen++
			}
			if m.New {
				v.New++
				fresh = append(fresh, m.Title)
			}
			if m.RecentHits > 0 {
				recent = append(recent, m.Title)
				if m.Status == StatusHabit {
					active = append(active, m.Title)
				}
			}
		}
		v.Reaction, v.Reason = reaction(p.id, over, fresh, active, recent)
		out = append(out, v)
	}
	return out
}

func reaction(p Persona, over bool, fresh, active, recent []string) (string, string) {
	list := func(xs []string) string {
		if len(xs) > 3 {
			return strings.Join(xs[:3], ", ") + fmt.Sprintf(" and %d more", len(xs)-3)
		}
		return strings.Join(xs, ", ")
	}
	if p == Yegge {
		switch {
		case over:
			return "🤯", "A lot of frontier work lately. He loves it; the other two are less sure."
		case len(fresh) > 0:
			return "🤘", "Tried something new: " + list(fresh) + "."
		case len(active) >= 2:
			return "🫡", "Already routine for you: " + list(active) + ". He has moved on to the next thing."
		case len(recent) > 0:
			return "🧪", "Some frontier work lately: " + list(recent) + "."
		default:
			return "👀", "Waiting for you to try something new."
		}
	}
	switch {
	case over && p == Karpathy:
		return "😬", "Lots of agents lately, and not much steering of them."
	case over:
		return "🫠", "Lots of agents lately, and many of them did not finish."
	case len(fresh) > 0:
		return "🚀", "New lately: " + list(fresh) + "."
	case len(active) > 0:
		return "👏", fmt.Sprintf("Keeping up %d habit%s: %s.", len(active), plural(len(active)), list(active))
	case len(recent) > 0:
		return "👍", "Seen lately: " + list(recent) + "."
	default:
		return "👀", fmt.Sprintf("Nothing from this list in the last %d days.", WindowDays)
	}
}

// suggest picks moments to try, among those not yet a habit: unseen ones before explored ones;
// within each, those whose symptom fired first, then at most one per persona, Yegge last.
func suggest(catalog []Moment, ms []MomentView, c *Corpus) []Suggestion {
	status := map[string]Status{}
	for _, m := range ms {
		status[m.ID] = m.Status
	}
	out := []Suggestion{}
	picked := map[string]bool{}
	byPersona := map[Persona]int{}
	add := func(m Moment, reason string) {
		out = append(out, Suggestion{Moment: m.ID, Reason: reason})
		picked[m.ID] = true
		byPersona[m.Persona]++
	}
	for _, want := range []Status{StatusUnseen, StatusExplored} {
		for _, m := range catalog {
			if len(out) == maxSuggestions {
				return out
			}
			if status[m.ID] == want && m.Symptom != nil {
				if r := m.Symptom(c); r != "" {
					add(m, r)
				}
			}
		}
		for _, p := range []Persona{Karpathy, Boris, Yegge} {
			for _, m := range catalog {
				if len(out) == maxSuggestions {
					return out
				}
				if m.Persona == p && status[m.ID] == want && !picked[m.ID] && byPersona[p] == 0 {
					add(m, "")
				}
			}
		}
	}
	return out
}
