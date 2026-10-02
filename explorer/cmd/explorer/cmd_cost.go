package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/model"
)

func init() {
	register("cost", command{
		usage:   "cost [--by B] [--since D]",
		summary: "cost rollups",
		run:     runCost,
	})
}

const costHelp = `Usage: merlin cost [--by project|day|model|session|kind] [--since D] [--project P] [--limit N] [--json]

What did my sessions cost, subagents included? One table, grouped by --by
(default project), with a total row.

  COST       what the rows add up to: the reported figure plus the attributed one
  REPORTED   Claude Code's own cost figure, for the stretches of each session it
             reported on (its "windows"); includes calls that leave no trace in
             the transcript
  ATTRIBUTED spend outside every window, recomputed from the transcript tokens at
             list prices; the estimate used where Claude Code reported nothing

History that a forked or continued session copied from another session is paid
for once, by the session that has it first. Scripted runs (one-shot 'claude -p'
calls) are counted in every table; in --by session they are summed per project.
A row's SESSIONS counts the sessions that spent something in it, so a scripted run
that made no API call is in no row; the "scripted runs" figure under the table
counts every run.

--by model has a line "(overhead)": reported spend that belongs to no model
because no transcript message accounts for it.

Flags:
  --by B        project, day (newest first), model, session or kind
  --since D     spend since the start of the local day D ago: 7d, 2w, 36h, or a date
                2026-09-01. With --by session: sessions active since D, whole cost
  --project P   a project path, or its last element(s): 'app' or 'acme/app'
  --limit N     show the N largest rows (default: all, but 20 for --by session);
                the total row always covers everything
  --json        machine-readable output
`

// costRowJSON is one row of the cost table in the JSON output.
type costRowJSON struct {
	Key      string `json:"key"`
	Label    string `json:"label,omitempty"`
	Sessions int    `json:"sessions"`
	catalog.Money
	Flag string `json:"flag,omitempty"`
}

func runCost(args []string) int {
	fs := flag.NewFlagSet("cost", flag.ContinueOnError)
	by := fs.String("by", "project", "")
	project := fs.String("project", "", "")
	since := fs.String("since", "", "")
	limit := fs.Int("limit", -1, "")
	asJSON := fs.Bool("json", false, "")
	pos, help, err := parseArgs("cost", fs, costHelp, args)
	if help {
		fmt.Print(costHelp)
		return 0
	}
	if err == nil && len(pos) > 0 {
		err = usageError("unexpected argument " + pos[0])
	}
	switch *by {
	case "project", "day", "model", "session", "kind":
	default:
		if err == nil {
			err = usageError(fmt.Sprintf("unknown --by %q: use project, day, model, session or kind", *by))
		}
	}
	if err != nil {
		return finish("cost", err)
	}
	return finish("cost", doCost(*by, *project, *since, *limit, *asJSON))
}

func doCost(by, project, since string, limit int, asJSON bool) error {
	w, err := loadWorld("cost")
	if err != nil {
		return err
	}
	f := catalog.Filter{}
	if f.Project, err = w.resolveProject(project); err != nil {
		return err
	}
	from, err := parseSince(since, w.now)
	if err != nil {
		return usageError(err.Error())
	}
	if !from.IsZero() {
		if by == "session" {
			f.Since = from
		} else {
			// Spend is bucketed by local day, so the window starts at a day boundary.
			y, m, d := from.Local().Date()
			f.Since = time.Date(y, m, d, 0, 0, 0, 0, time.Local)
			f.DayFrom = f.Since.Format("2006-01-02")
		}
	}
	if limit < 0 {
		limit = 0
		if by == "session" {
			limit = 20
		}
	}

	var rows []costRowJSON
	var cells [][]string
	var total catalog.Money
	var nSessions int
	cols := []column{{head: "SESSIONS", right: true}, {head: "COST", right: true}, {head: "REPORTED", right: true}, {head: "ATTRIBUTED", right: true}}
	listing := w.cat.List(f, w.live)

	if by == "session" {
		for _, in := range listing.Sessions {
			c := in.Cost
			rows = append(rows, costRowJSON{Key: in.Key.ID, Label: in.Title, Sessions: 1, Flag: string(c.Flag),
				Money: catalog.Money{TotalUSD: c.BestUSD, ReportedUSD: c.ReportedUSD, AttributedUSD: c.UncoveredUSD}})
		}
		perProject := map[string]*costRowJSON{}
		var order []string
		for _, s := range listing.Scripted {
			r := perProject[s.Project]
			if r == nil {
				r = &costRowJSON{Key: "scripted:" + s.Project, Label: "scripted runs"}
				perProject[s.Project] = r
				order = append(order, s.Project)
			}
			r.Sessions += s.Count
			r.TotalUSD += s.TotalUSD
			r.ReportedUSD += s.ReportedUSD
			r.AttributedUSD += s.AttributedUSD
		}
		for _, p := range order {
			perProject[p].Flag = string(moneyFlag(perProject[p].Money))
			rows = append(rows, *perProject[p])
		}
		for _, r := range rows {
			total.TotalUSD += r.TotalUSD
			total.ReportedUSD += r.ReportedUSD
			total.AttributedUSD += r.AttributedUSD
			nSessions += r.Sessions
		}
	} else {
		dim := map[string]catalog.Dim{"project": catalog.ByProject, "day": catalog.ByDay, "model": catalog.ByModel, "kind": catalog.ByKind}[by]
		for _, r := range w.cat.Rollup(f, dim) {
			row := costRowJSON{Sessions: r.Sessions, Money: r.Money}
			switch by {
			case "project":
				row.Key, row.Label = r.Project, w.label(r.Project)
			case "day":
				row.Key = r.Day
			case "model":
				row.Key = r.Model
				if r.Model == catalog.OverheadModel {
					row.Label = "overhead: reported, in no transcript"
				}
			case "kind":
				row.Key = r.Kind
				if r.Kind == string(model.KindSDK) {
					row.Label = "sdk (scripted runs with spend)"
				}
			}
			rows = append(rows, row)
		}
		all := w.cat.Rollup(f)
		if len(all) > 0 {
			total, nSessions = all[0].Money, all[0].Sessions
		}
	}

	switch by {
	case "day":
		sort.SliceStable(rows, func(i, j int) bool { return rows[i].Key > rows[j].Key })
	default:
		sort.SliceStable(rows, func(i, j int) bool {
			if rows[i].TotalUSD != rows[j].TotalUSD {
				return rows[i].TotalUSD > rows[j].TotalUSD
			}
			return rows[i].Key < rows[j].Key
		})
	}
	shown := rows
	if limit > 0 && len(shown) > limit {
		shown = shown[:limit]
	}

	// How the figures are backed, over the sessions in the table.
	var exact, partial, estimated int
	for _, in := range listing.Sessions {
		switch in.Cost.Flag {
		case catalog.CostExact:
			exact++
		case catalog.CostPartial:
			partial++
		default:
			estimated++
		}
	}
	var scriptedRuns int
	for _, s := range listing.Scripted {
		scriptedRuns += s.Count
	}

	if asJSON {
		if rows == nil {
			rows = []costRowJSON{}
		}
		var sinceOut *time.Time
		if !f.Since.IsZero() {
			sinceOut = &f.Since
		}
		return writeJSON(struct {
			By       string        `json:"by"`
			Since    *time.Time    `json:"since,omitempty"`
			Rows     []costRowJSON `json:"rows"`
			Total    catalog.Money `json:"total"`
			Sessions int           `json:"sessions"`
			Backing  struct {
				Exact     int `json:"exact"`
				Partial   int `json:"partial"`
				Estimated int `json:"estimated"`
				Scripted  int `json:"scriptedRuns"`
			} `json:"backing"`
		}{By: by, Since: sinceOut, Rows: rows, Total: total, Sessions: nSessions,
			Backing: struct {
				Exact     int `json:"exact"`
				Partial   int `json:"partial"`
				Estimated int `json:"estimated"`
				Scripted  int `json:"scriptedRuns"`
			}{exact, partial, estimated, scriptedRuns}})
	}

	w.emptyHint("cost")
	money := func(m catalog.Money) []string {
		return []string{usd(m.TotalUSD), usd(m.ReportedUSD), usd(m.AttributedUSD)}
	}
	switch by {
	case "session":
		cols = append([]column{{head: "ID"}, {head: "WHEN"}, {head: "PROJECT", max: 24}, {head: "TITLE", flex: true, max: 50}, {head: "COST", right: true}}, cols[2:]...)
		for _, r := range shown {
			if strings.HasPrefix(r.Key, "scripted:") {
				cells = append(cells, append([]string{"", "", w.label(strings.TrimPrefix(r.Key, "scripted:")), plural(r.Sessions, "scripted run", "scripted runs"),
					marked(r.TotalUSD, catalog.CostFlag(r.Flag))}, money(r.Money)[1:]...))
				continue
			}
			in, _ := w.cat.Session(model.SessionKey{Harness: claudeHarness, ID: r.Key})
			title := snip(in.Title, 50)
			if title == "" {
				title = "(untitled)"
			}
			cells = append(cells, append([]string{w.shortID(r.Key), when(in.LastActivityAt, w.now), w.label(in.Project), title,
				marked(r.TotalUSD, catalog.CostFlag(r.Flag))}, money(r.Money)[1:]...))
		}
		cells = append(cells, append([]string{"TOTAL", "", "", plural(nSessions, "session", "sessions"), usd(total.TotalUSD)}, money(total)[1:]...))
	default:
		head := strings.ToUpper(by)
		cols = append([]column{{head: head, flex: true, max: 50}}, cols...)
		for _, r := range shown {
			key := r.Key
			if r.Label != "" {
				key = r.Label
			}
			cells = append(cells, append([]string{key, fmt.Sprint(r.Sessions)}, money(r.Money)...))
		}
		cells = append(cells, append([]string{"TOTAL", fmt.Sprint(nSessions)}, money(total)...))
	}
	if len(shown) < len(rows) {
		// A line for what the limit cut off, before the total.
		var rest catalog.Money
		for _, r := range rows[len(shown):] {
			rest.TotalUSD += r.TotalUSD
			rest.ReportedUSD += r.ReportedUSD
			rest.AttributedUSD += r.AttributedUSD
		}
		more := fmt.Sprintf("… %d more rows", len(rows)-len(shown))
		var line []string
		if by == "session" {
			line = append([]string{"", "", "", more, usd(rest.TotalUSD)}, money(rest)[1:]...)
		} else {
			line = append([]string{more, ""}, money(rest)...)
		}
		cells = append(cells[:len(cells)-1], line, cells[len(cells)-1])
	}

	scope := "all time"
	if !f.Since.IsZero() {
		scope = "since " + f.Since.Format("Jan 2")
		if by == "session" {
			scope = "sessions active since " + f.Since.Format("Jan 2 15:04")
		}
	}
	if f.Project != "" {
		scope += ", project " + w.label(f.Project)
	}
	fmt.Printf("Cost by %s  (%s)\n", by, scope)
	renderTable(os.Stdout, cols, cells, termWidth())

	fmt.Println()
	if total.TotalUSD > 0 {
		fmt.Printf("Of %s: %s (%.0f%%) is Claude Code's own reported figure; %s (%.0f%%) is recomputed from tokens where it reported nothing.\n",
			usd(total.TotalUSD), usd(total.ReportedUSD), 100*total.ReportedUSD/total.TotalUSD, usd(total.AttributedUSD), 100*total.AttributedUSD/total.TotalUSD)
	}
	parts := []string{fmt.Sprintf("%d exact", exact), fmt.Sprintf("%d partial", partial), fmt.Sprintf("%d estimated", estimated)}
	line := "Sessions: " + strings.Join(parts, ", ")
	if scriptedRuns > 0 {
		line += fmt.Sprintf("; plus %s, counting any that made no API call", plural(scriptedRuns, "scripted run", "scripted runs"))
	}
	fmt.Println(line + "  (exact: fully reported; partial: some spend outside the reported windows; estimated: nothing reported)")
	return nil
}
