package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/internal/engine"
	"github.com/terek/merlin/internal/term"
)

var ansiRE = regexp.MustCompile("\x1b\\[[0-9;]*[A-Za-z]|\x1b\\]8;;[^\x1b]*\x1b\\\\")

func strip(s string) string { return ansiRE.ReplaceAllString(s, "") }

var fancyProfile = term.Profile{TTY: true, Color: term.TrueColor, Width: 100}

func TestFancyHelpListsEveryCommandOnce(t *testing.T) {
	var buf bytes.Buffer
	printUsageFancy(&buf, fancyProfile)
	out := strip(buf.String())
	for n, c := range commands {
		re := regexp.MustCompile(`(?m)^  ` + regexp.QuoteMeta(n) + `( |$)`)
		if got := len(re.FindAllString(out, -1)); got != 1 {
			t.Errorf("command %q appears %d times in fancy help, want 1", n, got)
		}
		if !strings.Contains(out, strings.Fields(c.summary)[0]) {
			t.Errorf("summary of %q missing", n)
		}
	}
	for _, l := range strings.Split(out, "\n") {
		if n := len([]rune(l)); n > fancyProfile.Width-1 {
			t.Errorf("line of %d columns: %q", n, l)
		}
	}
}

func TestFancyHelpUngroupedAndWrapping(t *testing.T) {
	cmds := map[string]command{
		"show":   {usage: "show <session-id>", summary: "one session"},
		"zebra":  {usage: "zebra", summary: "new and ungrouped"},
		"longer": {usage: "longer --aaaa AAAA --bbbb BBBB --cccc CCCC --dddd DDDD", summary: strings.Repeat("word ", 40)},
	}
	var buf bytes.Buffer
	p := fancyProfile
	p.Width = 80
	printHelp(&buf, p, cmds)
	out := strip(buf.String())
	if !strings.Contains(out, "Other") || !strings.Contains(out, "\n  zebra ") {
		t.Errorf("ungrouped command missing:\n%s", out)
	}
	lines := strings.Split(out, "\n")
	for i, l := range lines {
		if strings.HasPrefix(l, "  longer ") {
			if strings.Contains(l, "word") {
				t.Errorf("summary should start on the next line: %q", l)
			}
			if !strings.HasPrefix(lines[i+1], strings.Repeat(" ", 2+helpColCap)+"word") {
				t.Errorf("summary not indented to the column: %q", lines[i+1])
			}
			if len(lines[i+2]) == 0 || len(lines[i+2]) > 79 {
				t.Errorf("summary not wrapped: %q", lines[i+2])
			}
		}
		if len([]rune(l)) > 79 && !strings.HasPrefix(l, "  longer ") && !strings.Contains(l, "explorer v") && !strings.HasPrefix(l, "Bare ") {
			t.Errorf("line too wide: %q", l)
		}
	}
}

// printUsage into a file that is not a terminal is the plain text it always was.
func TestPlainUsageUnchanged(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "usage")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	printUsage(f)
	got, _ := os.ReadFile(f.Name())

	var want bytes.Buffer
	fmt.Fprintln(&want, "Usage: merlin [serve-flags]")
	fmt.Fprintln(&want, "       merlin <command> [arguments]")
	fmt.Fprintln(&want)
	fmt.Fprintln(&want, "Bare `merlin` runs `merlin serve`; flags alone (merlin --port 8080) go to serve.")
	fmt.Fprintln(&want)
	fmt.Fprintln(&want, "Commands:")
	var names []string
	for n := range commands {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Fprintf(&want, "  %-34s %s\n", commands[n].usage, commands[n].summary)
	}
	if string(got) != want.String() {
		t.Errorf("plain usage changed:\n%s", got)
	}
	if strings.Contains(string(got), "\x1b") {
		t.Error("escape in plain usage")
	}
}

func TestIndexSummary(t *testing.T) {
	p := fancyProfile
	s := engine.Summary{Seen: 1500, Processed: 1200, Unchanged: 300, Elapsed: 2345 * time.Millisecond}
	if got, want := strip(indexSummary(p, s)), "✔ indexed 1,200 sessions · 1,500 on disk, 300 unchanged · 2.3s"; got != want {
		t.Errorf("got %q want %q", got, want)
	}
	s.Failed = 3
	if got, want := strip(indexSummary(p, s)), "✔ indexed 1,200 sessions · 1,500 on disk, 300 unchanged, 3 failed · 2.3s"; got != want {
		t.Errorf("got %q want %q", got, want)
	}
	if !strings.Contains(indexSummary(p, s), "\x1b[38;2;240;180;60m, 3 failed") {
		t.Error("failed count not amber")
	}
	s = engine.Summary{Seen: 42, Unchanged: 42}
	if got, want := strip(indexSummary(p, s)), "✔ index up to date · 42 sessions"; got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestFailLineAndTilde(t *testing.T) {
	if got := strip(failLine(fancyProfile, "scan", errors.New("boom"))); got != "✖ merlin scan: boom" {
		t.Errorf("got %q", got)
	}
	t.Setenv("HOME", "/Users/x")
	if got := tilde("/Users/x/.merlin/merlin.log"); got != "~/.merlin/merlin.log" {
		t.Errorf("got %q", got)
	}
	if got := tilde("/srv/merlin"); got != "/srv/merlin" {
		t.Errorf("got %q", got)
	}
}

// The wizard banner is serve's alone: help shows only the commands.
func TestFancyHelpHasNoBanner(t *testing.T) {
	var buf bytes.Buffer
	printHelp(&buf, term.Profile{TTY: true, Color: term.TrueColor, Width: 100}, commands)
	if s := buf.String(); strings.Contains(s, "█") || strings.Contains(s, "▀") || !strings.Contains(s, "\x1b[") {
		t.Errorf("help should be styled without the banner:\n%s", s)
	}
}
