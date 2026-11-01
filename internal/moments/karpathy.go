package moments

import (
	"fmt"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/terek/merlin/internal/model"
)

// Karpathy's detectors: control of the session and the context given to the agent.

func steerMidTurn(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			for _, q := range t.Queued {
				if q.Origin == model.OriginHuman {
					h := turnHit(s, t, "sent while the agent was working")
					h.At = q.At
					emit(h)
				}
			}
		}
	})
}

// redirectWithin is how soon after an interrupted turn the next prompt must come.
const redirectWithin = 2 * time.Minute

func interruptRedirect(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		s.HumanTurns(func(t, next *model.Turn) {
			if !t.Interrupted || next == nil {
				return
			}
			gap := next.StartedAt.Sub(end(t))
			if gap < 0 || gap > redirectWithin || norm(next.UserText) == norm(t.UserText) || norm(next.UserText) == "" {
				return
			}
			emit(turnHit(s, next, fmt.Sprintf("redirected %d s after stopping the agent", int(gap.Seconds()))))
		})
	})
}

func rewind(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			if t.Abandoned && t.Origin == model.OriginHuman && !t.StartedAt.IsZero() {
				emit(turnHit(s, t, "rewound past this prompt"))
			}
		}
		if s.D.Lineage.ForkedFrom != nil {
			emit(Hit{At: s.D.StartedAt, Session: s.Key(), Note: "forked from an earlier point of another session"})
		}
	})
}

// pathToken matches what looks like a file name or path in a prompt: a name with an extension.
var pathToken = regexp.MustCompile(`[\w./@-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,5}\b`)

func groundedPrompt(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		s.HumanTurns(func(t, _ *model.Turn) {
			if len(t.FilesTouched) == 0 {
				return
			}
			touched := map[string]bool{}
			for _, f := range t.FilesTouched {
				touched[path.Base(f)] = true
			}
			named := map[string]bool{}
			for _, tok := range pathToken.FindAllString(t.UserText, -1) {
				b := path.Base(tok)
				if len(b) >= 4 && touched[b] {
					named[b] = true
				}
			}
			if n := len(named); n > 0 {
				emit(turnHit(s, t, fmt.Sprintf("named %d file%s the agent then opened", n, plural(n))))
			}
		})
	})
}

// traceLine matches a line of an error message or a stack trace.
var traceLine = regexp.MustCompile(`(?m)^\s*(Traceback \(most recent call last\)|panic: |goroutine \d+ \[|at [\w.$<>]+ ?\(.*:\d+|[\w./-]+\.(go|ts|tsx|js|jsx|py|rs|java|kt|rb|swift|c|cc|cpp|h):\d+|(\w+)?Error\b|error(\[\w+\])?: |FAIL\b|--- FAIL|E\d{4}\b|Exception\b)`)

func pastedEvidence(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		s.HumanTurns(func(t, _ *model.Turn) {
			switch {
			case t.Images > 0:
				emit(turnHit(s, t, fmt.Sprintf("attached %d image%s", t.Images, plural(t.Images))))
			case len(traceLine.FindAllStringIndex(t.UserText, -1)) >= 2:
				emit(turnHit(s, t, "pasted an error trace"))
			}
		})
	})
}

var (
	listItem     = regexp.MustCompile(`(?m)^\s*([-*•]|\d{1,2}[.)])\s+\S`)
	criteriaWord = regexp.MustCompile(`(?i)\b(must|should|never|don'?t|do not|only|acceptance|done when|make sure|ensure|verify|tests?|constraints?|requirements?)\b`)
)

func acceptanceCriteria(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		s.HumanTurns(func(t, _ *model.Turn) {
			if len(t.UserText) < 300 {
				return
			}
			items := len(listItem.FindAllStringIndex(t.UserText, -1))
			if items >= 3 && criteriaWord.MatchString(t.UserText) {
				emit(turnHit(s, t, fmt.Sprintf("%d-point spec", items)))
			}
		})
	})
}

const (
	specWords     = 120 // a prompt at least this long is a spec
	vibeWords     = 25  // a prompt at most this long is a vibe prompt
	realWorkCalls = 10  // tool calls that make a turn real work
	vibeEdits     = 3   // edits that make a vibe prompt count
)

func oneShotSpec(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		s.HumanTurns(func(t, next *model.Turn) {
			w := words(t.UserText)
			if w < specWords || t.Interrupted || t.ToolCalls < realWorkCalls || isCorrection(t, next) {
				return
			}
			emit(turnHit(s, t, fmt.Sprintf("%d-word prompt, %d tool calls, no correction", w, t.ToolCalls)))
		})
	})
}

// approval matches a prompt that only approves what the agent proposed: the work was specified
// earlier, so it is no vibe prompt.
var approval = regexp.MustCompile(`(?i)^\W*(yes|yep|yeah|ok(ay)?|sure|go( ahead| for it)?|do it|proceed|continue|sounds good|lgtm|ship it|approved?|please do|let'?s (go|do it))\b`)

func vibeOneShot(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		s.HumanTurns(func(t, next *model.Turn) {
			w := words(t.UserText)
			edits := countTools(t.ToolsByName, editTools)
			if w < 2 || w > vibeWords || t.Interrupted || edits < vibeEdits || approval.MatchString(t.UserText) || isCorrection(t, next) {
				return
			}
			emit(turnHit(s, t, fmt.Sprintf("%d words, %d edits, no correction", w, edits)))
		})
	})
}

func cleanSlate(c *Corpus, emit func(Hit)) {
	c.Interactive(func(s *Session) {
		for _, t := range s.Turns {
			if t.Command != "" && contains(clearCommands, commandName(t.Command)) {
				emit(turnHit(s, t, "cleared the context"))
			}
		}
	})
}

// Symptoms.

const longTurn = 10 * time.Minute

func longTurns(c *Corpus) string {
	n := 0
	c.Interactive(func(s *Session) {
		s.HumanTurns(func(t, _ *model.Turn) {
			if end(t).Sub(t.StartedAt) >= longTurn {
				n++
			}
		})
	})
	if n < 3 {
		return ""
	}
	return fmt.Sprintf("%d of your turns ran longer than 10 minutes: plenty of time to steer.", n)
}

const longSession = 40

func longSessions(c *Corpus) string {
	n := 0
	c.Interactive(func(s *Session) {
		k := 0
		s.HumanTurns(func(*model.Turn, *model.Turn) { k++ })
		if k >= longSession {
			n++
		}
	})
	if n == 0 {
		return ""
	}
	return fmt.Sprintf("%d session%s went past %d prompts in one context.", n, plural(n), longSession)
}

// Helpers.

// correctionCue matches the start of a prompt that corrects the previous answer.
var correctionCue = regexp.MustCompile(`(?i)^\W*(no\b|nope|wrong|wait\b|hmm|actually|that'?s not|that is not|not what|still\b|it doesn'?t|it does not|doesn'?t work|didn'?t work|does not work|revert|undo|you broke|broken|again\b|why did you)`)

// isCorrection reports whether next, the following prompt, corrects t's result: it came within
// half an hour and starts like a correction.
func isCorrection(t, next *model.Turn) bool {
	if next == nil || next.StartedAt.Sub(end(t)) > 30*time.Minute {
		return false
	}
	return words(next.UserText) <= 60 && correctionCue.MatchString(next.UserText)
}

func words(s string) int { return len(strings.Fields(s)) }

func norm(s string) string { return strings.Join(strings.Fields(strings.ToLower(s)), " ") }

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
