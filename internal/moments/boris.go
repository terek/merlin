package moments

import (
	"fmt"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/pricing"
)

// Boris's detectors: harness features, automation, sensible parallelism.

func plansFirst(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			if countTools(t.ToolsByName, planTools) > 0 {
				emit(turnHit(s, t, "planned before editing"))
			}
		}
	})
}

func deliberateCompact(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, k := range s.D.Compactions {
			if k.Trigger != model.TriggerManual || !s.OwnSince(k.At) {
				continue
			}
			note := "compacted by hand"
			if k.PreTokens > 0 {
				note = fmt.Sprintf("compacted by hand at %dk tokens", k.PreTokens/1000)
			}
			turn := k.Turn
			emit(Hit{At: k.At, Session: s.Key(), Turn: &turn, Note: note})
		}
	})
}

func modelSwitch(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			if name := commandName(t.Command); t.Command != "" && contains(modelCommands, name) {
				emit(turnHit(s, t, "/"+name+" mid-session"))
			}
		}
	})
}

func customCommand(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			name := commandName(t.Command)
			switch {
			case t.Command != "" && name != "" && !builtinCommands[name]:
				emit(turnHit(s, t, "ran a command of your own"))
			case countTools(t.ToolsByName, skillTools) > 0:
				emit(turnHit(s, t, "the agent used a skill"))
			}
		}
	})
}

func buildsHarness(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			if countTools(t.ToolsByName, editTools) == 0 {
				continue
			}
			for _, f := range t.FilesTouched {
				if isHarnessFile(f) {
					emit(turnHit(s, t, "edited "+path.Base(f)))
					break
				}
			}
		}
	})
}

// isolationCalls is how many read-only calls make an agent's reading worth isolating.
const isolationCalls = 5

func contextIsolation(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, a := range s.Agents {
			if a.Kind != model.AgentSubagent || a.InheritsContext || a.Addressable {
				continue
			}
			reads := countTools(a.ToolsByName, readOnlyTools)
			explore := strings.EqualFold(a.AgentType, "Explore")
			if explore || (reads >= isolationCalls && countTools(a.ToolsByName, editTools) == 0) {
				emit(Hit{At: a.StartedAt, Session: s.Key(), Turn: a.SpawnTurn,
					Note: fmt.Sprintf("a subagent made %d calls in its own context", a.ToolCalls)})
			}
		}
	})
}

var prices = sync.OnceValue(pricing.Default)

// outputPrice is a model's output price, 0 when unknown.
func outputPrice(m string) float64 {
	if m == "" {
		return 0
	}
	_, p, ok := prices().Lookup(m)
	if !ok {
		return 0
	}
	return p.Output
}

func modelRouting(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		main := outputPrice(s.MainModel())
		if main == 0 {
			return
		}
		for _, a := range s.Agents {
			if a.Kind != model.AgentSubagent {
				continue
			}
			if p := outputPrice(a.Model); p > 0 && p < main {
				emit(Hit{At: a.StartedAt, Session: s.Key(), Turn: a.SpawnTurn,
					Note: fmt.Sprintf("a subagent ran at %.0f%% of the main model's price", 100*p/main)})
			}
		}
	})
}

// attendedGap: turns of one session less than this apart count as one stretch of work.
const attendedGap = 5 * time.Minute

func parallelSessions(c *Corpus, emit func(Hit)) {
	// Each session's work as stretches of turns, then one sweep per local day.
	byDay := map[string][]interval{}
	var days []string
	c.Interactive(func(s *Session) {
		var cur *interval
		flush := func() {
			if cur != nil {
				day := cur.from.In(c.Loc).Format(time.DateOnly)
				if _, ok := byDay[day]; !ok {
					days = append(days, day)
				}
				byDay[day] = append(byDay[day], *cur)
			}
		}
		for _, t := range s.Turns {
			if t.StartedAt.IsZero() {
				continue
			}
			e := end(t)
			if cur != nil && t.StartedAt.Sub(cur.to) <= attendedGap {
				if e.After(cur.to) {
					cur.to = e
				}
				continue
			}
			flush()
			cur = &interval{from: t.StartedAt, to: e, owner: s.D.Harness + "/" + s.D.ID, ref: turnHit(s, t, "")}
		}
		flush()
	})
	for _, day := range days {
		n, at := peak(byDay[day])
		if n >= 2 {
			h := at.ref
			h.At = at.from
			h.Note = fmt.Sprintf("%d sessions working at once", n)
			emit(h)
		}
	}
}

func worktrees(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			if countTools(t.ToolsByName, worktreeTools) > 0 {
				emit(turnHit(s, t, "the agent moved into a worktree"))
				return
			}
		}
		for _, d := range append([]string{s.D.Cwd}, s.D.Cwds...) {
			for _, w := range worktreeDirs {
				if strings.Contains(d, w) {
					emit(Hit{At: s.D.StartedAt, Session: s.Key(), Note: "the session ran in a worktree"})
					return
				}
			}
		}
	})
}

func backgroundAgents(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, a := range s.Agents {
			if a.Background && a.Kind == model.AgentSubagent {
				emit(Hit{At: a.StartedAt, Session: s.Key(), Turn: a.SpawnTurn, Note: "an agent ran in the background"})
			}
		}
	})
}

func automation(c *Corpus, emit func(Hit)) {
	// Scripted sessions: one hit per local day, so a script that runs a thousand times is
	// still one moment a day.
	perDay := map[string]int{}
	first := map[string]*Session{}
	var days []string
	for _, s := range c.Sessions {
		if !s.Scripted() || s.D.StartedAt.IsZero() {
			continue
		}
		day := s.D.StartedAt.In(c.Loc).Format(time.DateOnly)
		if perDay[day] == 0 {
			days = append(days, day)
			first[day] = s
		}
		perDay[day]++
	}
	for _, day := range days {
		s := first[day]
		emit(Hit{At: s.D.StartedAt, Session: s.Key(), Note: fmt.Sprintf("%d scripted run%s that day", perDay[day], plural(perDay[day]))})
	}
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			switch {
			case t.Origin == model.OriginScheduled:
				emit(turnHit(s, t, "a scheduled run"))
			case countTools(t.ToolsByName, scheduleTools) > 0:
				emit(turnHit(s, t, "scheduled a later run"))
			}
		}
	})
}

func shipsPR(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, p := range s.D.PRs {
			at := p.At
			if at.IsZero() {
				at = s.D.LastActivityAt
			}
			if !s.OwnSince(at) {
				continue
			}
			note := "linked a pull request"
			if p.Number > 0 {
				note = fmt.Sprintf("pull request #%d", p.Number)
			}
			emit(Hit{At: at, Session: s.Key(), Note: note})
		}
	})
}

func mcpTools(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			var n int64
			for k, v := range t.ToolsByName {
				if isMCP(k) {
					n += v
				}
			}
			if n > 0 {
				emit(turnHit(s, t, fmt.Sprintf("%d MCP tool call%s", n, plural(int(n)))))
			}
		}
	})
}

// Symptoms.

func autoCompactions(c *Corpus) string {
	auto, cold := 0, 0
	c.Interactive(func(s *Session) {
		for _, k := range s.D.Compactions {
			if k.Trigger == model.TriggerAuto && s.OwnSince(k.At) {
				auto++
				if k.Call != nil && k.Call.Cache == model.CacheCold {
					cold++
				}
			}
		}
	})
	switch {
	case auto == 0:
		return ""
	case cold > 0:
		return fmt.Sprintf("Auto-compaction kicked in %d time%s, %d of them on a cold cache (the whole context paid at full price).", auto, plural(auto), cold)
	default:
		return fmt.Sprintf("Auto-compaction kicked in %d time%s.", auto, plural(auto))
	}
}

const bigContext = 150_000

func bigContexts(c *Corpus) string {
	n := 0
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			if t.ContextTokens >= bigContext {
				n++
			}
		}
	})
	if n < 3 {
		return ""
	}
	return fmt.Sprintf("%d turns ran with more than 150k tokens of context.", n)
}

func unroutedAgents(c *Corpus) string {
	n := 0
	c.Interactive(func(s *Session) {
		main := s.MainModel()
		if main == "" {
			return
		}
		for _, a := range s.Agents {
			if a.Kind == model.AgentSubagent && (a.Model == "" || a.Model == main) {
				n++
			}
		}
	})
	if n < 3 {
		return ""
	}
	return fmt.Sprintf("%d subagents ran on the main session's model.", n)
}

// repeatedPrompt is how often the same prompt must be typed to suggest a command.
const repeatedPrompt = 3

func repeatedPrompts(c *Corpus) string {
	seen := map[string]int{}
	c.Interactive(func(s *Session) {
		s.HumanTurns(func(t, _ *model.Turn) {
			if p := norm(t.UserText); len(p) >= 20 {
				seen[p]++
			}
		})
	})
	most := 0
	for _, n := range seen {
		most = max(most, n)
	}
	if most < repeatedPrompt {
		return ""
	}
	return fmt.Sprintf("You typed the same prompt %d times.", most)
}
