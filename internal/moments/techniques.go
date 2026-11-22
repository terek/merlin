package moments

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/terek/merlin/internal/model"
)

// A technique is a gap in a person's history that costs money, with an estimate of the saving, a
// fix to copy and, once they copied it, a follow-up. Each technique belongs to one moment (a
// practice): when that moment is unseen the technique is its row at the end of the table; when it
// is seen the technique adds no row, it decorates the practice's own.

// Fix is what to copy.
type Fix struct {
	// Kind is "claudemd" (one paragraph for CLAUDE.md or AGENTS.md) or "shell" (commands to run).
	Kind string `json:"kind"`
	Text string `json:"text"`
	// Link points at the tool's own page, when the fix installs one.
	Link string `json:"link,omitempty"`
	// Variants are the same fix worded for one harness, naming what only that harness knows (its
	// model tiers, its commands). Text is the universal wording, which every harness can follow.
	Variants []FixVariant `json:"variants,omitempty"`
}

// FixVariant is a fix worded for one harness.
type FixVariant struct {
	Harness string `json:"harness"`
	Text    string `json:"text"`
	// How, when set, is the estimate's how-line for this wording (it may name the harness's models).
	How string `json:"how,omitempty"`
}

// Estimate is the saving a technique promises, for 30 days, at API prices.
type Estimate struct {
	MonthlyUSD float64 `json:"monthlyUSD"`
	// How is one plain sentence on how the number is worked out.
	How string `json:"how"`
}

// Engaged is what the person did with a suggestion or technique, and what came of it.
type Engaged struct {
	OpenedAt time.Time `json:"openedAt,omitzero"`
	CopiedAt time.Time `json:"copiedAt,omitzero"`
	// Watching: the fix was copied in the last WindowDays, and Merlin is looking at the next sessions.
	Watching bool `json:"watching,omitempty"`
	// FollowUp compares the metric after the copy with the WindowDays before it; set once at least
	// minFollowSessions interactive sessions started after the copy. An association, not proof.
	FollowUp string `json:"followUp,omitempty"`
}

// Technique is a moment's money-saving gap.
type Technique struct {
	// Reason says what the history shows, with numbers.
	Reason string `json:"reason"`
	// Estimate is absent when the gap is gone (the technique is only still here because it is being watched).
	Estimate *Estimate `json:"estimate,omitempty"`
	Fix      Fix       `json:"fix"`
	// Days counts the days the gap showed, and Example is where it shows most.
	Days    []Day    `json:"days,omitempty"`
	Example *Hit     `json:"example,omitempty"`
	Engaged *Engaged `json:"engaged,omitempty"`
}

// Setup is what the person has set up around their harnesses, read by the harness layer.
type Setup struct {
	// ShellCompressor: a hook compresses shell output before the agent reads it (rtk, in Claude
	// Code's settings). Whether it ran is in the transcripts (Turn.ShellCompressed); this is only
	// whether it is configured.
	ShellCompressor bool
}

// Config is what a report needs besides the sessions.
type Config struct {
	Setup   Setup
	Engaged []Engagement
}

const (
	heavyContext      = 250_000 // a turn above this context carries more than it needs, mostly
	hugeContext       = 500_000
	leanContext       = 150_000 // the context a turn would do with
	heavyShare        = 0.2     // of the turns or of their cost
	heavyMinTurns     = 3
	orchCalls         = 5 // edit calls that make a turn implementation work
	orchMinTurns      = 3
	rtkTrimmed        = 0.7    // the share of a shell output rtk is taken to remove (it claims 60 to 90%)
	rtkTurnCap        = 20_000 // tokens of shell output one turn counts for
	rtkLaterCap       = 100    // calls an output is taken to be read again by
	rtkMinUSD         = 1.0    // monthly, below which the gap is not worth a word
	minFollowSessions = 3
)

// techniqueDef is the fixed part of a technique and how to measure it.
type techniqueDef struct {
	moment string
	fix    Fix
	// quiet is the reason shown when the gap is gone but the technique is still being watched.
	quiet string
	how   func() string
	// variants words the fix for single harnesses; the estimate's how-line may differ with them.
	variants func() []FixVariant
	eval     func(c *Corpus, from, to time.Time) gap
	// follow compares the time after the copy with the time before it; hits are the moment's own.
	follow func(c *Corpus, copied time.Time, hits []Hit) string
}

// gap is what eval found in a window.
type gap struct {
	fired   bool
	reason  string
	usd     float64 // the saving over the window
	hits    []Hit   // the places the gap showed, for the days
	example *Hit
}

var techniqueDefs = []techniqueDef{
	{
		moment: "clean-slate",
		fix: Fix{Kind: "claudemd", Text: "When a task is done, or the conversation has grown long, write a short handoff note (goal, " +
			"current state, next step, key files) and suggest starting a fresh session from it. Send broad exploration and " +
			"long reading to sub-agents, so that what they read stays out of this context."},
		quiet: "Fewer turns ran on a heavy context lately.",
		how: func() string {
			return fmt.Sprintf("Each turn above %dk tokens of context: the part of its price paid for context beyond a lean %dk, "+
				"over the last %d days, scaled to 30 days.", heavyContext/1000, leanContext/1000, WindowDays)
		},
		eval:   heavyGap,
		follow: heavyFollow,
	},
	{
		moment: "orchestrator",
		fix: Fix{Kind: "claudemd", Text: "Act as the orchestrator: plan, decide and review in this conversation, and hand " +
			"implementation (edits, test runs, searches) to sub-agents on a mid-tier model, each with a precise brief. " +
			"Check what they return before reporting it as done."},
		quiet: "Fewer tool-heavy turns ran on a premium model lately.",
		how: func() string {
			return fmt.Sprintf("Those turns' cost, priced again at a mid-tier model: the difference over the last %d days, "+
				"scaled to 30 days.", WindowDays)
		},
		variants: func() []FixVariant {
			return []FixVariant{{
				Harness: "claude",
				Text: "Act as the orchestrator: plan, decide and review in this conversation, and hand implementation (edits, " +
					"test runs, searches) to sub-agents on Sonnet, each with a precise brief. Check what they return before " +
					"reporting it as done.",
				How: fmt.Sprintf("Those turns' cost, priced again at Sonnet (%s): the difference over the last %d days, "+
					"scaled to 30 days.", sonnetModel(), WindowDays),
			}}
		},
		eval:   orchGap,
		follow: orchFollow,
	},
	{
		moment: "compressed-shell",
		fix:    Fix{Kind: "shell", Text: "brew install rtk\nrtk init -g", Link: "https://github.com/rtk-ai/rtk"},
		quiet:  "A shell compressor is set up.",
		how: func() string {
			return fmt.Sprintf("The tokens of shell output (a turn counts for at most %dk), times the later calls that read them "+
				"again (at most %d), at your main model's cache-read price, times %.1f, the share rtk usually trims; over the last "+
				"%d days, scaled to 30 days.", rtkTurnCap/1000, rtkLaterCap, rtkTrimmed, WindowDays)
		},
		eval:   rtkGap,
		follow: rtkFollow,
	},
}

// techniques builds the technique of every catalog moment that has one: the gap shows, or the
// person copied the fix lately and Merlin is still watching.
func (c *Corpus) techniques(catalog []Moment, cfg Config, hits map[string][]Hit) map[string]*Technique {
	out := map[string]*Technique{}
	for _, def := range techniqueDefs {
		if !slices.ContainsFunc(catalog, func(m Moment) bool { return m.ID == def.moment }) {
			continue
		}
		eng, ok := engagementOf(cfg.Engaged, def.moment)
		watching := ok && !eng.CopiedAt.IsZero() && c.Now.Sub(eng.CopiedAt) < WindowDays*24*time.Hour
		g := def.eval(c, c.WindowStart, c.Now)
		if !g.fired && !watching {
			continue
		}
		fix := def.fix
		if def.variants != nil {
			fix.Variants = def.variants()
		}
		t := &Technique{Reason: g.reason, Fix: fix}
		if g.fired {
			t.Estimate = &Estimate{MonthlyUSD: sig2(g.usd * 30 / WindowDays), How: def.how()}
			t.Days = daysOf(g.hits, c.Loc)
			t.Example = g.example
		} else {
			t.Reason = def.quiet
		}
		if ok {
			e := &Engaged{OpenedAt: eng.OpenedAt, CopiedAt: eng.CopiedAt, Watching: watching}
			if !eng.CopiedAt.IsZero() && sessionsSince(c, eng.CopiedAt) >= minFollowSessions {
				e.FollowUp = def.follow(c, eng.CopiedAt, hits[def.moment])
			}
			t.Engaged = e
		}
		out[def.moment] = t
	}
	return out
}

func engagementOf(list []Engagement, moment string) (Engagement, bool) {
	i := slices.IndexFunc(list, func(e Engagement) bool { return e.Moment == moment })
	if i < 0 {
		return Engagement{}, false
	}
	return list[i], true
}

// sig2 rounds to two significant figures, so that an estimate does not look more exact than it is.
func sig2(x float64) float64 {
	if x <= 0 {
		return 0
	}
	p := math.Pow(10, math.Floor(math.Log10(x))-1)
	return math.Round(x/p) * p
}

// daysOf counts hits per local day.
func daysOf(hits []Hit, loc *time.Location) []Day {
	h := slices.Clone(hits)
	slices.SortStableFunc(h, func(a, b Hit) int {
		if c := a.At.Compare(b.At); c != 0 {
			return c
		}
		if c := strings.Compare(a.Session.String(), b.Session.String()); c != 0 {
			return c
		}
		return turnOf(a) - turnOf(b)
	})
	return countDays(h, loc)
}

// inRange reports whether a turn started in [from, to] and counts.
func inRange(t *model.Turn, from, to time.Time) bool {
	return !t.Abandoned && !t.StartedAt.IsZero() && !t.StartedAt.Before(from) && !t.StartedAt.After(to)
}

// sessionStart is when the person began working in a session: its first own turn.
func sessionStart(s *Session) time.Time {
	if !s.firstOwn.IsZero() {
		return s.firstOwn
	}
	return s.D.StartedAt
}

// sessionsSince counts the interactive sessions that started after t, and not after the report's time.
func sessionsSince(c *Corpus, t time.Time) int {
	n := 0
	c.Interactive(func(s *Session) {
		if st := sessionStart(s); !st.IsZero() && !st.Before(t) && !st.After(c.Now) {
			n++
		}
	})
	return n
}

// activeSessions counts the interactive sessions with an own turn in [from, to].
func activeSessions(c *Corpus, from, to time.Time) int {
	n := 0
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			if inRange(t, from, to) {
				n++
				return
			}
		}
	})
	return n
}

func day(t time.Time, loc *time.Location) string { return t.In(loc).Format("2 Jan") }

func pct(a, b int) int {
	if b == 0 {
		return 0
	}
	return int(math.Round(100 * float64(a) / float64(b)))
}

func tokensWord(n int64) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1000:
		return fmt.Sprintf("%dk", n/1000)
	}
	return fmt.Sprint(n)
}

// Heavy context.

type heavyStats struct {
	turns, over, huge int
	cost, overCost    float64
	usd               float64
	hits              []Hit
	best              pick
}

func heavyIn(c *Corpus, from, to time.Time) heavyStats {
	var st heavyStats
	c.Interactive(func(s *Session) {
		k := 0
		var top *model.Turn
		for _, t := range s.Turns {
			if !inRange(t, from, to) || t.AssistantMessages == 0 || t.ContextTokens == 0 {
				continue
			}
			st.turns++
			st.cost += t.Cost.USD
			if t.ContextTokens < heavyContext {
				continue
			}
			st.over++
			st.overCost += t.Cost.USD
			if t.ContextTokens >= hugeContext {
				st.huge++
			}
			st.usd += t.Cost.USD * float64(t.ContextTokens-leanContext) / float64(t.ContextTokens)
			st.hits = append(st.hits, turnHit(s, t, fmt.Sprintf("%dk tokens of context", t.ContextTokens/1000)))
			k++
			if top == nil || t.ContextTokens > top.ContextTokens {
				top = t
			}
		}
		if top != nil {
			st.best.offer(k, turnHit(s, top, ""))
		}
	})
	return st
}

func heavyGap(c *Corpus, from, to time.Time) gap {
	st := heavyIn(c, from, to)
	turnShare := float64(st.over) / math.Max(1, float64(st.turns))
	costShare := st.overCost / math.Max(1e-9, st.cost)
	warn := st.over >= heavyMinTurns && (turnShare >= heavyShare || costShare >= heavyShare)
	if !warn && st.huge == 0 {
		return gap{}
	}
	share := fmt.Sprintf("%d%% of your turns (%d of %d), and %d%% of their cost, ran on more than %dk tokens of context.",
		pct(st.over, st.turns), st.over, st.turns, int(math.Round(100*costShare)), heavyContext/1000)
	reason := "In the last " + fmt.Sprint(WindowDays) + " days, " + share
	if st.huge > 0 {
		reason = fmt.Sprintf("%d turn%s ran on more than %dk tokens of context. In the last %d days, %s",
			st.huge, plural(st.huge), hugeContext/1000, WindowDays, share)
	}
	return gap{fired: true, reason: reason, usd: st.usd, hits: st.hits, example: st.best.example()}
}

func heavyFollow(c *Corpus, copied time.Time, _ []Hit) string {
	win := WindowDays * 24 * time.Hour
	before, after := heavyIn(c, copied.Add(-win), copied.Add(-time.Nanosecond)), heavyIn(c, copied, c.Now)
	n := sessionsSince(c, copied)
	head := "Since you copied it on " + day(copied, c.Loc) + ": "
	if before.turns == 0 {
		return fmt.Sprintf("%s%d%% of turns ran above %dk (%d sessions). A comparison, not proof.",
			head, pct(after.over, after.turns), heavyContext/1000, n)
	}
	return fmt.Sprintf("%sturns above %dk went from %d%% to %d%% (%d sessions). A comparison, not proof.",
		head, heavyContext/1000, pct(before.over, before.turns), pct(after.over, after.turns), n)
}

// Orchestrator and implementor.

type orchStats struct {
	turns   int
	calls   int64
	usd     float64 // the saving at the Sonnet tier
	cost    float64 // what those turns cost
	byModel map[string]float64
	hits    []Hit
	best    pick
}

// sonnetModel is the table's latest Sonnet, the tier the work is priced at. Empty when the table has none.
func sonnetModel() string {
	best := ""
	for name := range prices().Models() {
		if strings.Contains(name, "sonnet") && name > best {
			best = name
		}
	}
	return best
}

func orchIn(c *Corpus, from, to time.Time) orchStats {
	st := orchStats{byModel: map[string]float64{}}
	sonnet := sonnetModel()
	sp := outputPrice(sonnet)
	if sonnet == "" || sp == 0 {
		return st
	}
	c.Interactive(func(s *Session) {
		k := 0
		var top *model.Turn
		var topCalls int64
		for _, t := range s.Turns {
			if !inRange(t, from, to) {
				continue
			}
			calls := countTools(t.ToolsByName, editTools)
			if calls < orchCalls || len(t.Spawned) > 1 || countTools(t.ToolsByName, delegateTools) > 1 {
				continue
			}
			names := make([]string, 0, len(t.Cost.ByModel))
			for name := range t.Cost.ByModel {
				names = append(names, name)
			}
			slices.Sort(names)
			var save, cost float64
			for _, name := range names {
				mc := t.Cost.ByModel[name]
				if p := outputPrice(name); p <= sp {
					continue
				}
				cheap, ok := prices().Cost(sonnet, mc.Tokens, false)
				if !ok {
					continue
				}
				save += mc.USD - cheap.USD
				cost += mc.USD
				st.byModel[name] += mc.USD
			}
			if save <= 0 {
				continue
			}
			st.turns++
			st.calls += calls
			st.usd += save
			st.cost += cost
			st.hits = append(st.hits, turnHit(s, t, fmt.Sprintf("%d edits on a premium model", calls)))
			k++
			if top == nil || calls > topCalls {
				top, topCalls = t, calls
			}
		}
		if top != nil {
			st.best.offer(k, turnHit(s, top, ""))
		}
	})
	return st
}

func orchGap(c *Corpus, from, to time.Time) gap {
	st := orchIn(c, from, to)
	if st.turns < orchMinTurns || st.usd <= 0 {
		return gap{}
	}
	top, topUSD := "", 0.0
	for name, usd := range st.byModel {
		if usd > topUSD || (usd == topUSD && name < top) {
			top, topUSD = name, usd
		}
	}
	reason := fmt.Sprintf("%d turn%s on %s ran %d or more edits themselves (%d edits in all), with at most one sub-agent. "+
		"Work like that does not need the priciest model.", st.turns, plural(st.turns), top, orchCalls, st.calls)
	return gap{fired: true, reason: reason, usd: st.usd, hits: st.hits, example: st.best.example()}
}

func orchFollow(c *Corpus, copied time.Time, _ []Hit) string {
	win := WindowDays * 24 * time.Hour
	b0, b1 := copied.Add(-win), copied.Add(-time.Nanosecond)
	before, after := orchIn(c, b0, b1), orchIn(c, copied, c.Now)
	per := func(st orchStats, n int) float64 { return st.cost / math.Max(1, float64(n)) }
	head := "Since you copied it on " + day(copied, c.Loc) + ": "
	n := sessionsSince(c, copied)
	if before.turns == 0 {
		return fmt.Sprintf("%sthe cost of premium-model turns with %d or more edits is $%.2f per session (%d sessions). A comparison, not proof.",
			head, orchCalls, per(after, n), n)
	}
	return fmt.Sprintf("%sthe cost of premium-model turns with %d or more edits went from $%.2f to $%.2f per session (%d sessions). A comparison, not proof.",
		head, orchCalls, per(before, activeSessions(c, b0, b1)), per(after, n), n)
}

// Shell output compressor.

type rtkStats struct {
	tokens int64   // of shell output
	usd    float64 // the saving
	hits   []Hit
	best   pick
}

// cacheReadPrice is a model's cache-read price per token, 0 when unknown.
func cacheReadPrice(m string) float64 {
	if m == "" {
		return 0
	}
	_, p, ok := prices().Lookup(m)
	if !ok {
		return 0
	}
	return p.CacheRead / 1e6
}

// laterReads counts the calls that read turn i's output again: the rest of its own turn, then the later
// turns until the context is compacted or cleared, at most rtkLaterCap.
func laterReads(s *Session, i int) int64 {
	t := s.Turns[i]
	later := (t.AssistantMessages - 1) / 2
	for _, u := range s.Turns[i+1:] {
		if u.Epoch != t.Epoch || later >= rtkLaterCap {
			break
		}
		if !u.Abandoned {
			later += u.AssistantMessages
		}
	}
	return min(later, rtkLaterCap)
}

// rtkCut is the share of shell output rtk typically removes; a compressed output is 1 - rtkCut of the raw one.
const rtkCut = 0.7

func shellTokens(t *model.Turn) int64 { return min(t.ShellOutputBytes/4, rtkTurnCap) }

// rtkRewrites counts the shell commands a hook rewrote to run through the compressor in [from, to],
// and the sessions they ran in.
func rtkRewrites(c *Corpus, from, to time.Time) (calls int64, sessions int) {
	c.Interactive(func(s *Session) {
		if !contains(shellCompressorHarnesses, s.D.Harness) {
			return
		}
		var n int64
		for _, t := range s.Turns {
			if inRange(t, from, to) {
				n += t.ShellCompressed
			}
		}
		calls += n
		if n > 0 {
			sessions++
		}
	})
	return calls, sessions
}

// rtkNote says where the person stands: on, configured but silent, or not set up.
func (c *Corpus) rtkNote() string {
	calls, _ := rtkRewrites(c, c.WindowStart, c.Now)
	switch {
	case calls > 0:
		return fmt.Sprintf("rtk is on: it rewrote %s shell command%s in the last %d days.", thousands(calls), plural(int(calls)), WindowDays)
	case c.Setup.ShellCompressor:
		return "rtk is configured in your Claude Code settings, but no rewrites were seen lately."
	}
	return "rtk is not set up."
}

// thousands writes 1240 as "1,240".
func thousands(n int64) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// rtkIn measures the shell output that ran uncompressed.
func rtkIn(c *Corpus, from, to time.Time) rtkStats {
	var st rtkStats
	c.Interactive(func(s *Session) {
		if !contains(shellCompressorHarnesses, s.D.Harness) {
			return
		}
		price := cacheReadPrice(s.MainModel())
		if price == 0 {
			return
		}
		k := 0
		var top *model.Turn
		for i, t := range s.Turns {
			if !inRange(t, from, to) || t.ShellOutputBytes == 0 || t.ShellCompressed > 0 {
				continue
			}
			tok := shellTokens(t)
			later := laterReads(s, i)
			st.tokens += tok
			st.usd += float64(tok) * float64(later) * price * rtkTrimmed
			st.hits = append(st.hits, turnHit(s, t, fmt.Sprintf("about %s tokens of shell output, not compressed", tokensWord(tok))))
			k++
			if top == nil || t.ShellOutputBytes > top.ShellOutputBytes {
				top = t
			}
		}
		if top != nil {
			st.best.offer(k, turnHit(s, top, ""))
		}
	})
	return st
}

// rtkGap fires when the person does not use a compressor: none configured and no command rewritten in
// the window.
func rtkGap(c *Corpus, from, to time.Time) gap {
	if c.Setup.ShellCompressor {
		return gap{}
	}
	if calls, _ := rtkRewrites(c, from, to); calls > 0 {
		return gap{}
	}
	st := rtkIn(c, from, to)
	if st.usd*30/WindowDays < rtkMinUSD {
		return gap{}
	}
	reason := fmt.Sprintf("Shell commands returned about %s tokens of output in the last %d days, and the agent read each result "+
		"again on every later call.", tokensWord(st.tokens), WindowDays)
	return gap{fired: true, reason: reason, usd: st.usd, hits: st.hits, example: st.best.example()}
}

func rtkFollow(c *Corpus, copied time.Time, _ []Hit) string {
	head := "Since you copied it on " + day(copied, c.Loc) + ": "
	n := sessionsSince(c, copied)
	calls, sessions := rtkRewrites(c, copied, c.Now)
	if calls == 0 {
		if !c.Setup.ShellCompressor {
			return fmt.Sprintf("%srtk is not set up yet in your Claude Code settings (%d sessions).", head, n)
		}
		return fmt.Sprintf("%srtk is configured, but no rewrites were seen (%d sessions).", head, n)
	}
	return fmt.Sprintf("%srtk rewrote %s shell command%s in %d session%s.", head, thousands(calls), plural(int(calls)), sessions, plural(sessions))
}

// compressedShell: every turn in which a hook rewrote a shell command to run through the compressor,
// as the hook's own record in the transcript says.
func compressedShell(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		if !contains(shellCompressorHarnesses, s.D.Harness) {
			return
		}
		for _, t := range s.Turns {
			if t.ShellCompressed > 0 {
				emit(turnHit(s, t, fmt.Sprintf("%d shell command%s rewritten by rtk", t.ShellCompressed, plural(int(t.ShellCompressed)))))
			}
		}
	})
}

// Savings already made: what the person does well, in dollars. Same window, prices and rounding as the
// techniques, so the two kinds of number can stand side by side.

// savedDefs are the practices with a realized estimate.
var savedDefs = map[string]struct {
	how  string
	eval func(c *Corpus, from, to time.Time) float64
}{
	"model-routing": {
		how: "The sub-agents that ran on a cheaper model than the session's main one, priced again at the main model, " +
			"minus what they cost: the last %d days, scaled to 30 days.",
		eval: routedSaving,
	},
	"compressed-shell": {
		how: "Shell output a hook sent through rtk, assuming rtk's usual 70%% cut (the raw output is the compressed one " +
			"over 0.3), read again by the later calls at the cache-read price: the last %d days, scaled to 30 days.",
		eval: rtkSaving,
	},
}

// Saved is what a practice already saves, for 30 days, at API prices.
type Saved struct {
	MonthlyUSD float64 `json:"monthlyUSD"`
	How        string  `json:"how"`
}

// savedOf is the realized saving of a moment, nil when there is none worth showing.
func (c *Corpus) savedOf(id string) *Saved {
	def, ok := savedDefs[id]
	if !ok {
		return nil
	}
	usd := sig2(def.eval(c, c.WindowStart, c.Now) * 30 / WindowDays)
	if usd < 1 {
		return nil
	}
	return &Saved{MonthlyUSD: usd, How: fmt.Sprintf(def.how, WindowDays)}
}

// routedSaving: the tokens of sub-agents on a model cheaper than the session's main one, priced at the main
// model, minus what they cost.
func routedSaving(c *Corpus, from, to time.Time) float64 {
	var usd float64
	c.Interactive(func(s *Session) {
		main := s.MainModel()
		mp := outputPrice(main)
		if mp == 0 {
			return
		}
		for _, a := range s.Agents {
			if a.Kind != model.AgentSubagent || a.StartedAt.Before(from) || a.StartedAt.After(to) {
				continue
			}
			names := make([]string, 0, len(a.Cost.ByModel))
			for name := range a.Cost.ByModel {
				names = append(names, name)
			}
			slices.Sort(names)
			for _, name := range names {
				mc := a.Cost.ByModel[name]
				if p := outputPrice(name); p == 0 || p >= mp {
					continue
				}
				if full, ok := prices().Cost(main, mc.Tokens, false); ok && full.USD > mc.USD {
					usd += full.USD - mc.USD
				}
			}
		}
	})
	return usd
}

// rtkSaving: for turns whose shell calls a hook rewrote, the output the agent read was the compressed one;
// the raw one would have been that over (1 - rtkCut), read again by every later call.
func rtkSaving(c *Corpus, from, to time.Time) float64 {
	var usd float64
	c.Interactive(func(s *Session) {
		if !contains(shellCompressorHarnesses, s.D.Harness) {
			return
		}
		price := cacheReadPrice(s.MainModel())
		for i, t := range s.Turns {
			if price == 0 || !inRange(t, from, to) || t.ShellCompressed == 0 || t.ShellOutputBytes == 0 {
				continue
			}
			read := float64(t.ShellOutputBytes) / 4
			raw := min(read/(1-rtkCut), rtkTurnCap)
			usd += raw * rtkCut * float64(laterReads(s, i)) * price
		}
	})
	return usd
}
