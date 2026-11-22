package moments

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strconv"
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

// Depth is how a moment sits in the user's work right now, read from the hits and the report's time. Status
// never falls back; depth does. The words are neutral: they describe, they do not judge.
type Depth string

const (
	DepthRoutine Depth = "routine" // seen in at least HabitWeeks distinct weeks, and in the last WindowDays
	DepthPaused  Depth = "paused"  // seen in at least HabitWeeks weeks, but not in the last WindowDays
	DepthNew     Depth = "new"     // fewer weeks, the first hit in the last WindowDays: too early to tell
	DepthTried   Depth = "tried"   // fewer weeks, the first hit older than WindowDays
)

// DefaultHabitWeeks is how many distinct weeks a moment must be seen in to count as a habit.
const DefaultHabitWeeks = 3

// WindowDays is the recent window the reactions and "new" look at.
const WindowDays = 28

// Moment is one entry of the catalog.
// Category is the kind of habit a moment is: what part of the work it changes.
type Category string

const (
	CategoryPrompt      Category = "prompt"      // how you write and steer prompts
	CategoryContext     Category = "context"     // how you manage what the agent knows
	CategoryHarness     Category = "harness"     // what you build around the agent
	CategoryParallelism Category = "parallelism" // how much runs at once
)

// Categories lists every category, in the order the page names them.
var Categories = []Category{CategoryPrompt, CategoryContext, CategoryHarness, CategoryParallelism}

type Moment struct {
	// ID is the moment's durable name: stable across changes of its detector, never reused
	// for another meaning. Consumers (the web UI, a shared card) ignore ids they do not know.
	ID      string
	Persona Persona
	// Category is required: every moment belongs to one.
	Category Category
	Title    string // a few words: "Steering mid-turn"
	What     string // one sentence: what was seen
	Try      string // one or two sentences: why and how to try it, for someone who has not
	// Detects says in a plain sentence what counts as one occurrence, in the user's words.
	Detects string
	// HabitWeeks overrides DefaultHabitWeeks when non-zero.
	HabitWeeks int
	// Detect calls emit once per occurrence. It must be deterministic: the same corpus gives
	// the same hits.
	Detect func(c *Corpus, emit func(Hit))
	// Symptom, when set, looks for a sign that the moment would help someone who has not
	// shown it yet, and returns a one-sentence reason (with numbers), or an empty Evidence.
	Symptom func(c *Corpus) Evidence
}

// Evidence is what a Symptom found: the reason, and where it shows most.
type Evidence struct {
	Reason string
	// Example is the session where the evidence is densest (ties: the latest), at a turn
	// where that makes sense; nil when there is no single place.
	Example *Hit
}

// pick keeps the session where a count is highest; of equal counts the one offered last
// (sessions are offered oldest first, so the latest).
type pick struct {
	n   int
	hit Hit
}

func (p *pick) offer(n int, h Hit) {
	if n > 0 && n >= p.n {
		p.n, p.hit = n, h
	}
}

func (p *pick) example() *Hit {
	if p.n == 0 {
		return nil
	}
	h := p.hit
	return &h
}

// sessionHit is a hit that points at a whole session.
func sessionHit(s *Session) Hit { return Hit{At: s.D.StartedAt, Session: s.Key()} }

func intPtr(i int) *int { return &i }

// Day is a count for one local day ("2006-01-02").
type Day struct {
	Day  string `json:"day"`
	Hits int    `json:"hits,omitempty"`
	// Example is the day's session with the most hits (ties: the latest), at the turn of its first hit that day.
	Example *Hit `json:"example,omitempty"`
}

// ActivityDay is the number of human prompts typed on one local day.
type ActivityDay struct {
	Day     string `json:"day"`
	Prompts int    `json:"prompts"`
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

	// Activity is the human prompts per local day in interactive sessions (own turns only),
	// by day; days without any are left out.
	Activity []ActivityDay `json:"activity,omitempty"`

	Personas    []PersonaView `json:"personas"`
	Moments     []MomentView  `json:"moments"` // registry order
	Suggestions []Suggestion  `json:"suggestions"`
	// OverYegge: lots of frontier work lately, with little steering or many killed agents.
	OverYegge bool `json:"overYegge,omitempty"`
	// UsualHarness is the harness most of the interactive sessions of the window ran in (ties: the
	// first by name): the wording of a fix that suits the person best.
	UsualHarness string `json:"usualHarness,omitempty"`
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
	ID      string  `json:"id"`
	Persona Persona `json:"persona"`
	// Category is the kind of habit: prompt, context, harness or parallelism.
	Category Category `json:"category"`
	Title    string   `json:"title"`
	What     string   `json:"what"`
	Try      string   `json:"try"`
	// Detects is what counts as one occurrence, in a plain sentence.
	Detects string `json:"detects"`
	Status  Status `json:"status"`
	// Depth is the usage depth (routine, paused, new, tried); empty for an unseen moment.
	Depth    Depth `json:"depth,omitempty"`
	Hits     int   `json:"hits"`
	Sessions int   `json:"sessions"`
	Weeks    int   `json:"weeks"`
	// RecentHits are the hits in the window; New is set when the first hit is in the window.
	RecentHits int       `json:"recentHits"`
	New        bool      `json:"new,omitempty"`
	First      time.Time `json:"first,omitzero"`
	// FirstHit is the hit that First is the time of.
	FirstHit *Hit `json:"firstHit,omitempty"`
	// Days counts every hit per local day, by day.
	Days []Day     `json:"days,omitempty"`
	Last time.Time `json:"last,omitzero"`
	// Examples are the latest hits, newest first, at most maxExamples.
	Examples []Hit `json:"examples,omitempty"`
	// Technique is a saving the person's history shows for this practice; set on a seen moment as the
	// tag and the open row's section (an unseen one has it on its Suggestion).
	Technique *Technique `json:"technique,omitempty"`
	// Note says where the person stands with this practice today, when the history alone does not
	// (rtk: on, configured but silent, or not set up).
	Note string `json:"note,omitempty"`
	// Saved is what the person already saves with this practice, an estimate for 30 days at API prices.
	Saved *Saved `json:"saved,omitempty"`
}

// Suggestion is an unseen moment worth trying, with why.
type Suggestion struct {
	Moment string `json:"moment"`
	Reason string `json:"reason,omitempty"` // from the moment's Symptom; empty when none fired
	// Example is where the symptom shows most: a session, at a turn where that makes sense.
	Example *Hit `json:"example,omitempty"`
	// Technique is set when the suggestion is a money-saving technique.
	Technique *Technique `json:"technique,omitempty"`
	// Engaged is what the person did with it so far; absent until they opened it.
	Engaged *Engaged `json:"engaged,omitempty"`
}

const (
	maxExamples    = 3
	maxSuggestions = 3
)

// Build computes the report over the given sessions with the registry.
func Build(in []Input, now time.Time, loc *time.Location) Report {
	return BuildConfig(Registry(), in, now, loc, Config{})
}

// BuildWith computes the report with the given catalog of moments (tests pass their own).
func BuildWith(catalog []Moment, in []Input, now time.Time, loc *time.Location) Report {
	return BuildConfig(catalog, in, now, loc, Config{})
}

// BuildConfig is BuildWith with the person's setup and their engagement with earlier suggestions.
func BuildConfig(catalog []Moment, in []Input, now time.Time, loc *time.Location, cfg Config) Report {
	if loc == nil {
		loc = time.Local
	}
	c := newCorpus(in, loc)
	windowStart := now.AddDate(0, 0, -WindowDays)
	c.Now, c.WindowStart, c.Setup = now, windowStart, cfg.Setup
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
	r.Activity = activity(c, loc)

	allHits := map[string][]Hit{}
	for _, m := range catalog {
		var hits []Hit
		if m.Detect != nil {
			m.Detect(c, func(h Hit) {
				if !h.At.IsZero() && !h.At.After(now) {
					hits = append(hits, h)
				}
			})
		}
		allHits[m.ID] = hits
		r.Moments = append(r.Moments, summarize(m, hits, windowStart, loc))
	}
	techs := c.techniques(catalog, cfg, allHits)
	r.UsualHarness = usualHarness(c)
	for i := range r.Moments {
		if r.Moments[i].ID == "compressed-shell" {
			r.Moments[i].Note = c.rtkNote()
		}
		r.Moments[i].Saved = c.savedOf(r.Moments[i].ID)
	}
	for i := range r.Moments {
		if r.Moments[i].ID == "orchestrator" {
			r.Moments[i].Note = orchestratorNote(r.Moments[i], allHits[r.Moments[i].ID], windowStart, r.Moments)
		}
	}
	for i := range r.Moments {
		if r.Moments[i].Status != StatusUnseen {
			r.Moments[i].Technique = techs[r.Moments[i].ID]
		}
	}

	r.OverYegge = overYegge(c, r.Moments, windowStart)
	r.Personas = react(r.Moments, r.OverYegge)
	r.Suggestions = suggest(catalog, r.Moments, c, techs, cfg.Engaged, allHits)
	return r
}

// usualHarness is the harness of most interactive sessions with a turn in the window.
func usualHarness(c *Corpus) string {
	n := map[string]int{}
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			if inRange(t, c.WindowStart, c.Now) {
				n[s.D.Harness]++
				return
			}
		}
	})
	best := ""
	for h, k := range n {
		if k > n[best] || (k == n[best] && h < best) {
			best = h
		}
	}
	return best
}

func summarize(m Moment, hits []Hit, windowStart time.Time, loc *time.Location) MomentView {
	slices.SortStableFunc(hits, func(a, b Hit) int {
		return cmp.Or(a.At.Compare(b.At), cmp.Compare(a.Session.String(), b.Session.String()),
			cmp.Compare(turnOf(a), turnOf(b)))
	})
	v := MomentView{ID: m.ID, Persona: m.Persona, Category: m.Category, Title: m.Title, What: m.What, Try: m.Try, Detects: m.Detects,
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
	first := hits[0]
	v.FirstHit = &first
	v.Days = countDays(hits, loc)
	v.New = !v.First.Before(windowStart)
	need := m.HabitWeeks
	if need == 0 {
		need = DefaultHabitWeeks
	}
	v.Status = StatusExplored
	if v.Weeks >= need {
		v.Status = StatusHabit
	}
	switch recent := !v.Last.Before(windowStart); {
	case v.Weeks >= need && recent:
		v.Depth = DepthRoutine
	case v.Weeks >= need:
		v.Depth = DepthPaused
	case v.New:
		v.Depth = DepthNew
	default:
		v.Depth = DepthTried
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

const dayLayout = "2006-01-02"

// countDays counts hits per local day; hits are sorted by time, so the days come out in order.
func countDays(hits []Hit, loc *time.Location) []Day {
	var out []Day
	for i := 0; i < len(hits); {
		d := hits[i].At.In(loc).Format(dayLayout)
		j := i
		for j < len(hits) && hits[j].At.In(loc).Format(dayLayout) == d {
			j++
		}
		out = append(out, Day{Day: d, Hits: j - i, Example: dayExample(hits[i:j])})
		i = j
	}
	return out
}

// dayExample picks the session with the most of a day's hits (ties: the one hit last) and returns its first hit.
func dayExample(hits []Hit) *Hit {
	count := map[model.SessionKey]int{}
	first := map[model.SessionKey]int{}
	last := map[model.SessionKey]int{}
	for i, h := range hits {
		if _, ok := first[h.Session]; !ok {
			first[h.Session] = i
		}
		count[h.Session]++
		last[h.Session] = i
	}
	best, ok := model.SessionKey{}, false
	for s, n := range count {
		if !ok || n > count[best] || (n == count[best] && last[s] > last[best]) {
			best, ok = s, true
		}
	}
	h := hits[first[best]]
	return &h
}

// activity counts the human prompts of interactive sessions per local day. Copied history is
// not in Session.Turns, so it is not counted again.
func activity(c *Corpus, loc *time.Location) []ActivityDay {
	n := map[string]int{}
	c.Interactive(func(s *Session) {
		s.HumanTurns(func(t, _ *model.Turn) {
			if !t.StartedAt.IsZero() {
				n[t.StartedAt.In(loc).Format(dayLayout)]++
			}
		})
	})
	days := make([]string, 0, len(n))
	for d := range n {
		days = append(days, d)
	}
	slices.Sort(days)
	var out []ActivityDay
	for _, d := range days {
		out = append(out, ActivityDay{Day: d, Prompts: n[d]})
	}
	return out
}

// orchestratorNote opens the row: what the person already does, and what model routing saves them.
func orchestratorNote(m MomentView, hits []Hit, windowStart time.Time, all []MomentView) string {
	if len(hits) == 0 {
		return ""
	}
	recent, ever := map[string]bool{}, map[string]bool{}
	for _, h := range hits {
		ever[h.Session.String()] = true
		if !h.At.Before(windowStart) {
			recent[h.Session.String()] = true
		}
	}
	n := len(recent)
	text := fmt.Sprintf("You already do this: in %d session%s in the last %d days, sub-agents on a cheaper model made the edits.", n, plural(n), WindowDays)
	if n == 0 {
		text = fmt.Sprintf("You have done this: in %d session%s sub-agents on a cheaper model made the edits, none in the last %d days.", len(ever), plural(len(ever)), WindowDays)
	}
	for _, o := range all {
		if o.ID == "model-routing" && o.Saved != nil {
			text += fmt.Sprintf(" (Model routing: ≈ $%s / mo saved)", commas(o.Saved.MonthlyUSD))
		}
	}
	return text
}

func commas(usd float64) string {
	s := strconv.FormatInt(int64(math.Round(usd)), 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
