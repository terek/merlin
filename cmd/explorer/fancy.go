package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/terek/merlin/internal/engine"
	"github.com/terek/merlin/internal/term"
)

// Shared pieces of the styled (terminal) output of serve, scan and help. None of it runs
// unless the stream is fancy; plain output stays as it was.

func thousands(n int) string {
	s := strconv.Itoa(n)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

// progressOf maps the engine's counters to the bar's.
func progressOf(pr engine.Progress) term.Progress {
	return term.Progress{Done: pr.Done, Total: max(pr.Queued, pr.Done), Failed: pr.Failed, Bytes: pr.Bytes, Elapsed: pr.Elapsed}
}

// indexSummary is the line that ends a first index, in serve and in scan.
func indexSummary(p term.Profile, s engine.Summary) string {
	tick := p.Fg(term.Green, "✔")
	if s.Processed == 0 {
		return tick + " index up to date" + p.Dim(" · "+thousands(s.Seen)+" sessions")
	}
	line := tick + " indexed " + p.Bold(thousands(s.Processed)) + " sessions" +
		p.Dim(" · "+thousands(s.Seen)+" on disk, "+thousands(s.Unchanged)+" unchanged")
	if s.Failed > 0 {
		line += p.Fg(term.Amber, fmt.Sprintf(", %s failed", thousands(s.Failed)))
	}
	el := s.Elapsed.Round(100 * time.Millisecond)
	if s.Elapsed < 100*time.Millisecond {
		el = s.Elapsed.Round(time.Millisecond) // "0s" says nothing
	}
	return line + p.Dim(" · "+el.String())
}

// failLine is "✖ merlin <cmd>: msg" with the cross in red.
func failLine(p term.Profile, cmd string, err error) string {
	return p.Fg(term.Red, "✖") + fmt.Sprintf(" merlin %s: %v", cmd, err)
}

// tilde shows the user's home directory as ~.
func tilde(path string) string {
	h, err := os.UserHomeDir()
	if err != nil || h == "" || h == "/" {
		return path
	}
	if path == h {
		return "~"
	}
	if strings.HasPrefix(path, h+"/") {
		return "~" + path[len(h):]
	}
	return path
}
