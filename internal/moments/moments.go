package moments

import (
	"cmp"
	"slices"
	"time"

	"github.com/terek/merlin/internal/model"
)

// Persona is who cares about a moment. The personas are caricatures, named for marketing:
// Karpathy for control and context, Boris for harness mastery and automation, Yegge for the
// frontier (a bit of Yegge is good; too much is a warning sign).
type Persona string

const (
	Karpathy Persona = "karpathy"
	Boris    Persona = "boris"
	Yegge    Persona = "yegge"
)

// Status is how established a moment is.
type Status string

const (
	StatusHabit    Status = "habit"    // seen in at least HabitWeeks distinct weeks
	StatusExplored Status = "explored" // seen, but in fewer weeks
	StatusUnseen   Status = "unseen"
)

// DefaultHabitWeeks is how many distinct weeks a moment must be seen in to count as a habit.
const DefaultHabitWeeks = 3

// WindowDays is the recent window the reactions and "new" look at.
const WindowDays = 28

// Moment is one entry of the catalog.
type Moment struct {
	// ID is the moment's durable name: stable across changes of its detector, never reused
	// for another meaning. Consumers (the web UI, a shared card) ignore ids they do not know.
	ID      string
	Persona Persona
	Title   string // a few words: "Steering mid-turn"
	What    string // one sentence: what was seen
	Try     string // one or two sentences: why and how to try it, for someone who has not
	// HabitWeeks overrides DefaultHabitWeeks when non-zero.
	HabitWeeks int
	// Detect calls emit once per occurrence. It must be deterministic: the same corpus gives
	// the same hits.
	Detect func(c *Corpus, emit func(Hit))
	// Symptom, when set, looks for a sign that the moment would help someone who has not
	// shown it yet, and returns a one-sentence reason (with numbers), or "".
	Symptom func(c *Corpus) string
}

// Hit is one occurrence of a moment. Note is Merlin's own description with numbers only,
// never text from the session.
type Hit struct {
	At      time.Time        `json:"at"`
	Session model.SessionKey `json:"session"`
	Turn    *int             `json:"turn,omitempty"`
	Note    string           `json:"note,omitempty"`
}

// Report is everything the moments page shows.
type Report struct {
	Now        time.Time `json:"now"`
	WindowDays int       `json:"windowDays"`
	// Sessions is how many sessions were read, Scripted how many of them were scripted (sdk).
	Sessions int       `json:"sessions"`
	Scripted int       `json:"scripted"`
	Since    time.Time `json:"since,omitzero"` // the first session's start
	// Projects is how many projects (repositories, else directories) the interactive sessions
	// worked in.
	Projects int `json:"projects"`

	Personas    []PersonaView `json:"personas"`
	Moments     []MomentView  `json:"moments"` // registry order
	Suggestions []Suggestion  `json:"suggestions"`
	// OverYegge: lots of frontier work lately, with little steering or many killed agents.
	OverYegge bool `json:"overYegge,omitempty"`
}

// PersonaView is one persona's reaction.
type PersonaView struct {
	ID       Persona `json:"id"`
	Name     string  `json:"name"`
	Focus    string  `json:"focus"`
	Reaction string  `json:"reaction"` // one emoji
	Reason   string  `json:"reason"`   // Merlin's sentence explaining the reaction
	Habits   int     `json:"habits"`
	Explored int     `json:"explored"`
	Unseen   int     `json:"unseen"`
	New      int     `json:"new"` // moments first seen in the window
}

// MomentView is one moment with what was found of it.
type MomentView struct {
	ID       string  `json:"id"`
	Persona  Persona `json:"persona"`
	Title    string  `json:"title"`
	What     string  `json:"what"`
	Try      string  `json:"try"`
	Status   Status  `json:"status"`
	Hits     int     `json:"hits"`
	Sessions int     `json:"sessions"`
	Weeks    int     `json:"weeks"`
	// RecentHits are the hits in the window; New is set when the first hit is in the window.
	RecentHits int       `json:"recentHits"`
	New        bool      `json:"new,omitempty"`
	First      time.Time `json:"first,omitzero"`
	Last       time.Time `json:"last,omitzero"`
	// Examples are the latest hits, newest first, at most maxExamples.
	Examples []Hit `json:"examples,omitempty"`
}

// Suggestion is an unseen moment worth trying, with why.
type Suggestion struct {
	Moment string `json:"moment"`
	Reason string `json:"reason,omitempty"` // from the moment's Symptom; empty when none fired
}

const (
	maxExamples    = 3
	maxSuggestions = 3
)

// Build computes the report over the given sessions with the registry.
func Build(in []Input, now time.Time, loc *time.Location) Report {
	return BuildWith(Registry(), in, now, loc)
}

// BuildWith computes the report with the given catalog of moments (tests pass their own).
func BuildWith(catalog []Moment, in []Input, now time.Time, loc *time.Location) Report {
	if loc == nil {
		loc = time.Local
	}
	c := newCorpus(in, loc)
	windowStart := now.AddDate(0, 0, -WindowDays)
	r := Report{Now: now, WindowDays: WindowDays, Personas: []PersonaView{}, Moments: []MomentView{},
		Suggestions: []Suggestion{}}
	projects := map[string]bool{}
	for _, s := range c.Sessions {
		r.Sessions++
		if s.Scripted() {
			r.Scripted++
		} else if s.Project != "" {
			projects[s.Project] = true
		}
		if t := s.D.StartedAt; !t.IsZero() && (r.Since.IsZero() || t.Before(r.Since)) {
			r.Since = t
		}
	}
	r.Projects = len(projects)

	for _, m := range catalog {
		var hits []Hit
		if m.Detect != nil {
			m.Detect(c, func(h Hit) {
				if !h.At.IsZero() && !h.At.After(now) {
					hits = append(hits, h)
				}
			})
		}
		r.Moments = append(r.Moments, summarize(m, hits, windowStart, loc))
	}

	r.OverYegge = overYegge(c, r.Moments, windowStart)
	r.Personas = react(r.Moments, r.OverYegge)
	r.Suggestions = suggest(catalog, r.Moments, c)
	return r
}

func summarize(m Moment, hits []Hit, windowStart time.Time, loc *time.Location) MomentView {
	slices.SortStableFunc(hits, func(a, b Hit) int {
		return cmp.Or(a.At.Compare(b.At), cmp.Compare(a.Session.String(), b.Session.String()),
			cmp.Compare(turnOf(a), turnOf(b)))
	})
	v := MomentView{ID: m.ID, Persona: m.Persona, Title: m.Title, What: m.What, Try: m.Try,
		Status: StatusUnseen, Hits: len(hits)}
	if len(hits) == 0 {
		return v
	}
	weeks := map[int]bool{}
	sessions := map[model.SessionKey]bool{}
	for _, h := range hits {
		y, w := h.At.In(loc).ISOWeek()
		weeks[y*100+w] = true
		sessions[h.Session] = true
		if !h.At.Before(windowStart) {
			v.RecentHits++
		}
	}
	v.Weeks, v.Sessions = len(weeks), len(sessions)
	v.First, v.Last = hits[0].At, hits[len(hits)-1].At
	v.New = !v.First.Before(windowStart)
	need := m.HabitWeeks
	if need == 0 {
		need = DefaultHabitWeeks
	}
	v.Status = StatusExplored
	if v.Weeks >= need {
		v.Status = StatusHabit
	}
	for i := len(hits) - 1; i >= 0 && len(v.Examples) < maxExamples; i-- {
		v.Examples = append(v.Examples, hits[i])
	}
	return v
}

func turnOf(h Hit) int {
	if h.Turn == nil {
		return -1
	}
	return *h.Turn
}
