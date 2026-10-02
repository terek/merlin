package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/model"
)

func init() {
	register("sessions", command{
		usage:   "sessions [--project P] [--kind K] [--since D]",
		summary: "list sessions, newest first",
		run:     runSessions,
	})
}

const sessionsHelp = `Usage: explorer sessions [--project P] [--kind interactive|background] [--since D] [--limit N] [--json]

One line per session, newest first: which one to resume.

  ID       shortest unique prefix of the session id (at least 8 characters);
           'explorer show' accepts it
  WHEN     last activity, local time (relative when recent)
  PROJECT  last element of the directory the session was started in
  TITLE    custom title, else Claude Code's title, else the first prompt
  TURNS    prompts in the session (turns copied from another session included)
  AGENTS   subagents and teammates it started
  COST     what the session cost, subagents included, not counting history
           that another session already paid for
             $1.20    exact: Claude Code's own figure for the whole session
             $1.20*   partial: some spend lies outside the windows Claude Code
                      reported and is recomputed from tokens
             ≈$1.20   estimated: Claude Code reported nothing, so the figure is
                      recomputed from tokens
  STATE    running (busy|idle), else how the last turn ended:
           clean, interrupted, mid-turn
  LINEAGE  ↳ fork of X / ↳ continues X: this session starts with a copy of X
           → continued in Y / → forked to Y: Y starts with a copy of this one;
           resume the newest one

Scripted runs (one-shot 'claude -p' calls) never appear individually; they are
summed per project and day in a section below the list.

Flags:
  --project P   a project path, or its last element(s): 'app' or 'acme/app'
  --kind K      interactive or background
  --since D     last activity within D: 90m, 36h, 7d, 2w, or a date 2026-09-01
  --limit N     show at most N sessions (default 40; 0 = all)
  --json        machine-readable output
`

// sessionJSON is a session as the JSON output shows it.
type sessionJSON struct {
	catalog.SessionInfo
	ID     string `json:"id"`
	Agents int    `json:"agents"`
	Resume string `json:"resume"`
}

func runSessions(args []string) int {
	fs := flag.NewFlagSet("sessions", flag.ContinueOnError)
	project := fs.String("project", "", "")
	kind := fs.String("kind", "", "")
	since := fs.String("since", "", "")
	limit := fs.Int("limit", 40, "")
	asJSON := fs.Bool("json", false, "")
	pos, help, err := parseArgs("sessions", fs, sessionsHelp, args)
	if help {
		fmt.Print(sessionsHelp)
		return 0
	}
	if err == nil && len(pos) > 0 {
		err = usageError("unexpected argument " + pos[0])
	}
	if err != nil {
		return finish("sessions", err)
	}
	return finish("sessions", doSessions(*project, *kind, *since, *limit, *asJSON))
}

func doSessions(project, kind, since string, limit int, asJSON bool) error {
	w, err := loadWorld("sessions")
	if err != nil {
		return err
	}
	f := catalog.Filter{}
	if f.Project, err = w.resolveProject(project); err != nil {
		return err
	}
	if f.Kinds, err = parseKinds(kind); err != nil {
		return usageError(err.Error())
	}
	if f.Since, err = parseSince(since, w.now); err != nil {
		return usageError(err.Error())
	}
	l := w.cat.List(f, w.live)
	total := len(l.Sessions)
	if limit > 0 && len(l.Sessions) > limit {
		l.Sessions = l.Sessions[:limit]
	}

	agents := func(k model.SessionKey) int {
		d, _ := w.cat.Digest(k)
		n := 0
		for _, a := range d.Agents {
			if a.Kind != model.AgentCompact {
				n++
			}
		}
		return n
	}

	if asJSON {
		out := struct {
			Sessions []sessionJSON          `json:"sessions"`
			Total    int                    `json:"total"`
			Scripted []catalog.ScriptedLine `json:"scripted"`
		}{Sessions: []sessionJSON{}, Total: total, Scripted: l.Scripted}
		if out.Scripted == nil {
			out.Scripted = []catalog.ScriptedLine{}
		}
		for _, in := range l.Sessions {
			out.Sessions = append(out.Sessions, sessionJSON{SessionInfo: in, ID: in.Key.ID,
				Agents: agents(in.Key), Resume: resumeCommand(in.Project, in.Key.ID)})
		}
		return writeJSON(out)
	}

	w.emptyHint("sessions")
	cols := []column{
		{head: "ID"},
		{head: "WHEN"},
		{head: "PROJECT", max: 24},
		{head: "TITLE", flex: true, max: 60},
		{head: "TURNS", right: true},
		{head: "AGENTS", right: true},
		{head: "COST", right: true},
		{head: "STATE"},
		{head: "LINEAGE", flex: true},
	}
	var rows [][]string
	var legend bool
	for _, in := range l.Sessions {
		title := snip(in.Title, 200)
		if title == "" {
			title = "(untitled)"
		}
		c := marked(in.Cost.BestUSD, in.Cost.Flag)
		legend = legend || in.Cost.Flag != catalog.CostExact
		rows = append(rows, []string{
			w.shortID(in.Key.ID), when(in.LastActivityAt, w.now), w.label(in.Project), title,
			fmt.Sprint(in.Turns), fmt.Sprint(agents(in.Key)), c, stateText(in), w.lineageMarker(in),
		})
	}
	if len(rows) > 0 {
		renderTable(os.Stdout, cols, rows, termWidth())
	} else if len(w.sessions) > 0 {
		fmt.Println("no sessions match")
	}

	if len(l.Scripted) > 0 {
		fmt.Println()
		fmt.Println("Scripted runs (summed per project and day, never listed individually)")
		lines := append([]catalog.ScriptedLine(nil), l.Scripted...)
		sort.SliceStable(lines, func(i, j int) bool {
			if lines[i].Day != lines[j].Day {
				return lines[i].Day > lines[j].Day
			}
			return lines[i].Project < lines[j].Project
		})
		var srows [][]string
		for _, s := range lines {
			legend = legend || moneyFlag(s.Money) != catalog.CostExact
			srows = append(srows, []string{s.Day, w.label(s.Project),
				plural(s.Count, "scripted run", "scripted runs"), marked(s.TotalUSD, moneyFlag(s.Money))})
		}
		renderTable(os.Stdout, []column{{head: "DAY"}, {head: "PROJECT", max: 24}, {head: "RUNS"}, {head: "COST", right: true}}, srows, termWidth())
	}

	if len(rows) > 0 {
		fmt.Println()
		fmt.Printf("%d of %d sessions", len(rows), total)
		if len(rows) < total {
			fmt.Print(" (--limit 0 for all)")
		}
		fmt.Println()
		if legend {
			fmt.Println(costLegend)
		}
	}
	return nil
}

// lineageMarker is the short note on how a session relates to others.
func (w *world) lineageMarker(in catalog.SessionInfo) string {
	var parts []string
	if p := in.Parent; p != nil {
		verb := "↳ continues "
		if p.Kind == catalog.LinkFork {
			verb = "↳ fork of "
		}
		parts = append(parts, verb+w.shortID(p.Parent.ID))
	}
	var conts, forks []string
	for _, c := range in.Children {
		if c.Kind == catalog.LinkFork {
			forks = append(forks, w.shortID(c.Child.ID))
		} else {
			conts = append(conts, w.shortID(c.Child.ID))
		}
	}
	if len(conts) > 0 {
		parts = append(parts, "→ continued in "+idList(conts))
	}
	if len(forks) > 0 {
		parts = append(parts, "→ forked to "+idList(forks))
	}
	return strings.Join(parts, "  ")
}

func idList(ids []string) string {
	if len(ids) > 2 {
		return strings.Join(ids[:2], ", ") + fmt.Sprintf(" +%d", len(ids)-2)
	}
	return strings.Join(ids, ", ")
}
