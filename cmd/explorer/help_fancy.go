package main

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/terek/merlin/internal/term"
)

var helpGroups = []struct {
	title string
	names []string
}{
	{"Explore", []string{"sessions", "show", "search", "cost"}},
	{"Run", []string{"serve", "scan"}},
	{"Set up", []string{"hooks", "autoupgrade", "upgrade", "doctor", "version", "help"}},
	{"Plumbing", []string{"hook", "shape"}},
}

const helpColCap = 36

func printUsageFancy(w io.Writer, p term.Profile) { printHelp(w, p, commands) }

func printHelp(w io.Writer, p term.Profile, cmds map[string]command) {
	// The wizard banner belongs to serve alone; help is just the commands.
	heading := func(s string) { fmt.Fprintln(w, p.Bold(p.Fg(term.Lavender, s))) }
	heading("Usage")
	fmt.Fprintln(w, "  merlin [serve-flags]")
	fmt.Fprintln(w, "  merlin "+p.Fg(term.Green, "<command>")+" [arguments]")
	fmt.Fprintln(w, p.Dim("Bare `merlin` runs `merlin serve`; flags alone (merlin --port 8080) go to serve."))
	fmt.Fprintln(w)

	grouped := map[string]bool{}
	type grp struct {
		title string
		names []string
	}
	var groups []grp
	for _, g := range helpGroups {
		var ns []string
		for _, n := range g.names {
			if _, ok := cmds[n]; ok {
				ns = append(ns, n)
				grouped[n] = true
			}
		}
		groups = append(groups, grp{g.title, ns})
	}
	var other []string
	for n := range cmds {
		if !grouped[n] {
			other = append(other, n)
		}
	}
	sort.Strings(other)
	groups = append(groups, grp{"Other", other})

	col := 0
	for _, c := range cmds {
		col = max(col, len([]rune(c.usage))+2)
	}
	col = min(col, helpColCap)

	for _, g := range groups {
		if len(g.names) == 0 {
			continue
		}
		heading(g.title)
		for _, n := range g.names {
			helpRow(w, p, cmds[n], col)
		}
		fmt.Fprintln(w)
	}
}

func helpRow(w io.Writer, p term.Profile, c command, col int) {
	name, args, _ := strings.Cut(c.usage, " ")
	usage := "  " + p.Bold(p.Fg(term.Green, name))
	if args != "" {
		usage += " " + p.Fg(term.Grey, args)
	}
	ulen := 2 + len([]rune(c.usage))
	indent := strings.Repeat(" ", 2+col)
	room := 0 // columns for the summary; 0 = no limit
	if p.Width > 0 {
		room = max(p.Width-1-len(indent), 20)
	}
	lines := wrapWords(c.summary, room)
	if ulen+2 > 2+col { // usage too long for its column: the summary starts below it
		fmt.Fprintln(w, usage)
		for _, l := range lines {
			fmt.Fprintln(w, indent+l)
		}
		return
	}
	for i, l := range lines {
		if i == 0 {
			fmt.Fprintln(w, usage+strings.Repeat(" ", 2+col-ulen)+l)
		} else {
			fmt.Fprintln(w, indent+l)
		}
	}
	if len(lines) == 0 {
		fmt.Fprintln(w, usage)
	}
}

// wrapWords breaks s at spaces into lines of at most width runes (0 = one line).
func wrapWords(s string, width int) []string {
	words := strings.Fields(s)
	if len(words) == 0 {
		return nil
	}
	if width <= 0 {
		return []string{strings.Join(words, " ")}
	}
	var lines []string
	cur := words[0]
	for _, wd := range words[1:] {
		if len([]rune(cur))+1+len([]rune(wd)) > width {
			lines = append(lines, cur)
			cur = wd
		} else {
			cur += " " + wd
		}
	}
	return append(lines, cur)
}
