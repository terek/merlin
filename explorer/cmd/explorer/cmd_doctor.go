package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/paths"
)

func init() {
	register("doctor", command{
		usage:   "doctor",
		summary: "format drift, unpriced models, attributed vs reported",
		run:     runDoctor,
	})
}

const doctorHelp = `Usage: merlin doctor [--json] [--all-versions]

Health of the index, read from the digests and the catalog; nothing is changed.

  Index          what is indexed; error stubs (sessions whose digest failed to
                 build) and sessions whose source files are gone
  Format drift   per version of Claude Code: record types the parser does not
                 know and lines it could not read. Growth here after a Claude
                 Code upgrade means the transcript format changed. Only versions
                 with a finding are listed; --all-versions lists every version
  Pricing        models seen in transcripts that have no price (their cost is 0)
  Agents         subagents that could not be tied to the call that started them;
                 messages cut short in the transcript (output tokens partial,
                 so attributed cost is a lower bound)
  Cost           how much of what Claude Code reported the transcripts explain
                 (covered / reported): overall, its distribution over sessions,
                 the ten largest gaps in both directions, and sessions with spend
                 outside every reported window. A ratio above 1.0 means a wrong
                 price or a bug

doctor prints findings and exits 0; it exits 1 only when it cannot read the index.
`

type driftRow struct {
	Version      string           `json:"version"`
	Sessions     int              `json:"sessions"`
	BadLines     int64            `json:"badLines"`
	UnknownTypes map[string]int64 `json:"unknownTypes,omitempty"`
}

// gapNoise is how far below zero a gap must be to count: smaller ones are float noise
// that prints as -$0.0000.
const gapNoise = 0.005

// coveredAbove picks the sessions whose transcripts add up to more than was reported:
// the n most negative gaps (gaps is sorted descending), noise excluded.
func coveredAbove(gaps []gapRow, n int) []gapRow {
	out := []gapRow{}
	for i := len(gaps) - 1; i >= 0 && len(out) < n; i-- {
		if gaps[i].GapUSD < -gapNoise {
			out = append(out, gaps[i])
		}
	}
	return out
}

type gapRow struct {
	ID         string  `json:"id"`
	Title      string  `json:"title,omitempty"`
	Project    string  `json:"project"`
	ReportedBy float64 `json:"reportedUSD"`
	CoveredUSD float64 `json:"coveredUSD"`
	GapUSD     float64 `json:"gapUSD"` // reported - covered
	Ratio      float64 `json:"ratio"`  // covered / reported
}

type stubRow struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	Error   string `json:"error"`
}

type outsideRow struct {
	ID      string  `json:"id"`
	Title   string  `json:"title,omitempty"`
	Project string  `json:"project"`
	USD     float64 `json:"uncoveredUSD"`
}

type doctorReport struct {
	Home string `json:"home"`

	Digests       int `json:"digests"`
	Sessions      int `json:"sessions"`
	Interactive   int `json:"interactive"`
	Background    int `json:"background"`
	Scripted      int `json:"scripted"`
	SourceMissing []struct {
		ID      string `json:"id"`
		Project string `json:"project"`
	} `json:"sourceMissing"`
	Stubs []stubRow `json:"errorStubs"`

	Drift            []driftRow     `json:"drift"`
	UnpricedModels   map[string]int `json:"unpricedModels"` // model -> sessions
	UnresolvedAgents int64          `json:"unresolvedAgents"`
	UnresolvedIn     []string       `json:"unresolvedAgentsIn,omitempty"`
	// TruncatedMessages counts the messages cut short in the transcript, in TruncatedIn
	// sessions (see model.Message.Truncated); AgentTruncated is the part inside agent files.
	TruncatedMessages int64 `json:"truncatedMessages"`
	TruncatedIn       int   `json:"truncatedSessions"`
	AgentTruncated    int64 `json:"truncatedAgentMessages"`

	Catalog catalog.Diagnostics `json:"catalog"`

	WithWindows  int     `json:"sessionsWithWindows"`
	ReportedUSD  float64 `json:"reportedUSD"`
	CoveredUSD   float64 `json:"coveredUSD"`
	CoveredRatio float64 `json:"coveredRatio"`
	Ratio        struct {
		Min    float64 `json:"min"`
		P10    float64 `json:"p10"`
		Median float64 `json:"median"`
		P90    float64 `json:"p90"`
		Max    float64 `json:"max"`
	} `json:"ratioDistribution"`
	ReportedAbove []gapRow     `json:"largestGapsReportedAbove"`
	CoveredAbove  []gapRow     `json:"largestGapsTranscriptAbove"`
	UncoveredUSD  float64      `json:"uncoveredUSD"` // outside the windows of sessions that have windows
	EstimatedUSD  float64      `json:"estimatedUSD"` // sessions without any reported window
	Uncovered     []outsideRow `json:"largestSpendOutsideWindows"`
}

func runDoctor(args []string) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	allVersions := fs.Bool("all-versions", false, "")
	pos, help, err := parseArgs("doctor", fs, doctorHelp, args)
	if help {
		fmt.Print(doctorHelp)
		return 0
	}
	if err == nil && len(pos) > 0 {
		err = usageError("unexpected argument " + pos[0])
	}
	if err != nil {
		return finish("doctor", err)
	}
	return finish("doctor", doDoctor(*asJSON, *allVersions))
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(p*float64(len(sorted))+0.999999) - 1
	return sorted[max(0, min(len(sorted)-1, i))]
}

func buildDoctor(w *world) doctorReport {
	var r doctorReport
	r.Home, _ = paths.Home()
	r.Digests = len(w.digests)
	r.Sessions = len(w.sessions)
	r.UnpricedModels = map[string]int{}
	r.Catalog = w.cat.Diagnostics()
	r.SourceMissing = []struct {
		ID      string `json:"id"`
		Project string `json:"project"`
	}{}
	r.Stubs = []stubRow{}

	for _, d := range w.digests {
		if d.Error != "" {
			r.Stubs = append(r.Stubs, stubRow{ID: d.ID, Project: d.Project, Error: d.Error})
		}
	}
	drift := map[string]*driftRow{}
	for _, d := range w.sessions {
		switch d.Kind {
		case model.KindSDK:
			r.Scripted++
		case model.KindBackground:
			r.Background++
		default:
			r.Interactive++
		}
		if d.SourceMissing {
			r.SourceMissing = append(r.SourceMissing, struct {
				ID      string `json:"id"`
				Project string `json:"project"`
			}{d.ID, d.Project})
		}
		versions := d.HarnessVersions
		if len(versions) == 0 {
			versions = []string{"(unknown)"}
		}
		for _, v := range versions {
			row := drift[v]
			if row == nil {
				row = &driftRow{Version: v}
				drift[v] = row
			}
			row.Sessions++
			row.BadLines += d.Diagnostics.BadLines
			for t, n := range d.Diagnostics.UnknownTypes {
				if row.UnknownTypes == nil {
					row.UnknownTypes = map[string]int64{}
				}
				row.UnknownTypes[t] += n
			}
		}
		for _, m := range d.Diagnostics.UnpricedModels {
			r.UnpricedModels[m]++
		}
		if n := d.Cost.TruncatedMessages; n > 0 {
			r.TruncatedMessages += n
			r.TruncatedIn++
			for _, m := range d.Messages {
				if m.Truncated && m.AgentID != "" {
					r.AgentTruncated++
				}
			}
		}
		if n := d.Diagnostics.UnresolvedAgents; n > 0 {
			r.UnresolvedAgents += n
			r.UnresolvedIn = append(r.UnresolvedIn, d.ID)
		}
	}
	r.Drift = []driftRow{}
	for _, row := range drift {
		r.Drift = append(r.Drift, *row)
	}
	sort.Slice(r.Drift, func(i, j int) bool { return versionLess(r.Drift[i].Version, r.Drift[j].Version) })

	// Cost: covered against reported, per session.
	var ratios []float64
	var gaps []gapRow
	var outside []outsideRow
	for _, d := range w.sessions {
		in, ok := w.cat.Session(d.Key())
		if !ok {
			continue
		}
		c := in.Cost
		if c.Flag == catalog.CostEstimated {
			r.EstimatedUSD += c.BestUSD
		}
		if c.Flag == catalog.CostPartial {
			r.UncoveredUSD += c.UncoveredUSD
			outside = append(outside, outsideRow{ID: d.ID, Title: in.Title, Project: in.Project, USD: c.UncoveredUSD})
		}
		if len(c.Windows) == 0 || c.ReportedUSD <= 0 {
			continue
		}
		r.WithWindows++
		r.ReportedUSD += c.ReportedUSD
		r.CoveredUSD += c.CoveredUSD
		g := gapRow{ID: d.ID, Title: in.Title, Project: in.Project, ReportedBy: c.ReportedUSD, CoveredUSD: c.CoveredUSD,
			GapUSD: c.ReportedUSD - c.CoveredUSD, Ratio: c.CoveredUSD / c.ReportedUSD}
		gaps = append(gaps, g)
		ratios = append(ratios, g.Ratio)
	}
	if r.ReportedUSD > 0 {
		r.CoveredRatio = r.CoveredUSD / r.ReportedUSD
	}
	sort.Float64s(ratios)
	if len(ratios) > 0 {
		r.Ratio.Min, r.Ratio.Max = ratios[0], ratios[len(ratios)-1]
		r.Ratio.P10, r.Ratio.Median, r.Ratio.P90 = percentile(ratios, 0.10), percentile(ratios, 0.50), percentile(ratios, 0.90)
	}
	r.ReportedAbove, r.CoveredAbove = []gapRow{}, []gapRow{}
	sort.SliceStable(gaps, func(i, j int) bool {
		if gaps[i].GapUSD != gaps[j].GapUSD {
			return gaps[i].GapUSD > gaps[j].GapUSD
		}
		return gaps[i].ID < gaps[j].ID
	})
	for _, g := range gaps {
		if g.GapUSD > 0 && len(r.ReportedAbove) < 10 {
			r.ReportedAbove = append(r.ReportedAbove, g)
		}
	}
	r.CoveredAbove = coveredAbove(gaps, 10)
	sort.SliceStable(outside, func(i, j int) bool {
		if outside[i].USD != outside[j].USD {
			return outside[i].USD > outside[j].USD
		}
		return outside[i].ID < outside[j].ID
	})
	if len(outside) > 10 {
		outside = outside[:10]
	}
	r.Uncovered = outside
	if r.Uncovered == nil {
		r.Uncovered = []outsideRow{}
	}
	return r
}

// versionLess orders dotted versions numerically, "(unknown)" last.
func versionLess(a, b string) bool {
	if a == "(unknown)" || b == "(unknown)" {
		return b == "(unknown)" && a != b
	}
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		var x, y int
		fmt.Sscanf(pa[i], "%d", &x)
		fmt.Sscanf(pb[i], "%d", &y)
		if x != y {
			return x < y
		}
	}
	return a < b
}

func doDoctor(asJSON, allVersions bool) error {
	w, err := loadWorld("doctor")
	if err != nil {
		return err
	}
	r := buildDoctor(w)
	if asJSON {
		return writeJSON(r)
	}
	w.emptyHint("doctor")
	out := os.Stdout
	section := func(title string) { fmt.Fprintf(out, "\n%s\n", title) }

	fmt.Fprintf(out, "Explorer doctor  (%s)\n", r.Home)
	section("Index")
	fmt.Fprintf(out, "  %s indexed: %d interactive, %d background, %d scripted\n", plural(r.Sessions, "session", "sessions"), r.Interactive, r.Background, r.Scripted)
	if len(r.Stubs) == 0 {
		fmt.Fprintln(out, "  error stubs: none")
	} else {
		fmt.Fprintf(out, "  error stubs: %d (digest failed to build; retried when the files change)\n", len(r.Stubs))
		for _, s := range r.Stubs {
			fmt.Fprintf(out, "    %s  %s  %s\n", w.shortID(s.ID), w.label(s.Project), cut(snip(s.Error, 200), 100))
		}
	}
	if len(r.SourceMissing) == 0 {
		fmt.Fprintln(out, "  missing sources: none")
	} else {
		fmt.Fprintf(out, "  missing sources: %d (their files were deleted; digests are kept)\n", len(r.SourceMissing))
		for _, s := range r.SourceMissing {
			fmt.Fprintf(out, "    %s  %s\n", w.shortID(s.ID), w.label(s.Project))
		}
	}
	cd := r.Catalog
	fmt.Fprintf(out, "  catalog: %d distinct messages (%d shared between sessions), %d lineage links", cd.Messages, cd.SharedMessages, cd.Links)
	if cd.CycleBreaks > 0 {
		fmt.Fprintf(out, ", %d links dropped to break cycles", cd.CycleBreaks)
	}
	fmt.Fprintln(out)

	section("Format drift  (by Claude Code version that wrote the files; a session spanning versions counts under each)")
	var rows [][]string
	clean := 0
	for _, d := range r.Drift {
		if !allVersions && d.BadLines == 0 && len(d.UnknownTypes) == 0 {
			clean++
			continue
		}
		var types []string
		var names []string
		for t := range d.UnknownTypes {
			names = append(names, t)
		}
		sort.Strings(names)
		for _, t := range names {
			types = append(types, fmt.Sprintf("%s×%d", t, d.UnknownTypes[t]))
		}
		ut := strings.Join(types, " ")
		if ut == "" {
			ut = "-"
		}
		rows = append(rows, []string{d.Version, fmt.Sprint(d.Sessions), fmt.Sprint(d.BadLines), ut})
	}
	switch {
	case len(r.Drift) == 0:
		fmt.Fprintln(out, "  (no sessions)")
	case len(rows) == 0:
		fmt.Fprintf(out, "  %s, no bad lines, no unknown record types\n", plural(len(r.Drift), "version", "versions"))
	default:
		renderTable(out, []column{{head: "  VERSION"}, {head: "SESSIONS", right: true}, {head: "BAD LINES", right: true}, {head: "UNKNOWN RECORD TYPES", flex: true}},
			indentFirst(rows), termWidth())
		if clean > 0 {
			fmt.Fprintf(out, "  and %s with no bad lines and no unknown record types\n", plural(clean, "other version", "other versions"))
		}
	}

	section("Pricing")
	if len(r.UnpricedModels) == 0 {
		fmt.Fprintln(out, "  unpriced models: none")
	} else {
		var ms []string
		for m := range r.UnpricedModels {
			ms = append(ms, m)
		}
		sort.Strings(ms)
		fmt.Fprintln(out, "  unpriced models (their messages cost $0 until a price is added to config.json):")
		for _, m := range ms {
			fmt.Fprintf(out, "    %s  in %s\n", m, plural(r.UnpricedModels[m], "session", "sessions"))
		}
	}

	section("Agents")
	if r.UnresolvedAgents == 0 {
		fmt.Fprintln(out, "  unresolved agents: none")
	} else {
		var ids []string
		for _, id := range r.UnresolvedIn {
			ids = append(ids, w.shortID(id))
		}
		fmt.Fprintf(out, "  unresolved agents: %d in %s (%s); attached to the session root\n", r.UnresolvedAgents, plural(len(ids), "session", "sessions"), idList(ids))
	}

	if r.TruncatedMessages == 0 {
		fmt.Fprintln(out, "  messages cut short in the transcript: none")
	} else {
		fmt.Fprintf(out, "  messages cut short in the transcript: %d in %s (%d in agent files); their output tokens are partial, so attributed cost is a lower bound\n",
			r.TruncatedMessages, plural(r.TruncatedIn, "session", "sessions"), r.AgentTruncated)
	}

	section("Cost: reported vs recomputed from the transcripts")
	if r.WithWindows == 0 {
		fmt.Fprintln(out, "  no session has a reported cost; every figure is recomputed from tokens")
	} else {
		fmt.Fprintf(out, "  %s carry Claude Code's reported cost: %s reported, %s of it explained by transcript messages (covered)\n",
			plural(r.WithWindows, "session", "sessions"), usd(r.ReportedUSD), usd(r.CoveredUSD))
		fmt.Fprintf(out, "  covered / reported = %.3f overall; the rest (%s) is calls that are in no transcript\n", r.CoveredRatio, usd(r.ReportedUSD-r.CoveredUSD))
		fmt.Fprintf(out, "  per session: min %.3f   p10 %.3f   median %.3f   p90 %.3f   max %.3f\n", r.Ratio.Min, r.Ratio.P10, r.Ratio.Median, r.Ratio.P90, r.Ratio.Max)
	}
	fmt.Fprintf(out, "  outside the windows: %s recomputed in %s that have windows; %s have none at all (%s, all recomputed)\n",
		usd(r.UncoveredUSD), plural(cd.SessionsUncover, "session", "sessions"), plural(cd.SessionsEstimate, "session", "sessions"), usd(r.EstimatedUSD))
	if cd.OverheadClamped > 0 || cd.SharedWindows > 0 {
		fmt.Fprintf(out, "  bookkeeping: %d overhead clamped at 0 (transcripts above reported), %d windows shared between linked sessions\n", cd.OverheadClamped, cd.SharedWindows)
	}
	gapTable := func(title string, g []gapRow) {
		if len(g) == 0 {
			fmt.Fprintf(out, "\n  %s none\n", title)
			return
		}
		fmt.Fprintf(out, "\n  %s\n", title)
		var rows [][]string
		for _, x := range g {
			t := x.Title
			if t == "" {
				t = "(untitled)"
			}
			rows = append(rows, []string{"    " + w.shortID(x.ID), w.label(x.Project), snip(t, 40), usd(x.ReportedBy), usd(x.CoveredUSD), usd(x.GapUSD), fmt.Sprintf("%.3f", x.Ratio)})
		}
		renderTable(out, []column{{head: "    ID"}, {head: "PROJECT", max: 20}, {head: "TITLE", flex: true}, {head: "REPORTED", right: true}, {head: "COVERED", right: true}, {head: "GAP", right: true}, {head: "RATIO", right: true}}, rows, termWidth())
	}
	gapTable("Largest gaps, reported above the transcripts (calls missing from them):", r.ReportedAbove)
	gapTable("Largest gaps, transcripts above reported (should be none: a wrong price or a bug):", r.CoveredAbove)
	if len(r.Uncovered) == 0 {
		fmt.Fprintf(out, "\n  Spend outside every reported window: none\n")
	} else {
		fmt.Fprintf(out, "\n  Largest spend outside every reported window (recomputed, counted in best cost)\n")
		var rows [][]string
		for _, x := range r.Uncovered {
			t := x.Title
			if t == "" {
				t = "(untitled)"
			}
			rows = append(rows, []string{"    " + w.shortID(x.ID), w.label(x.Project), snip(t, 40), usd(x.USD)})
		}
		renderTable(out, []column{{head: "    ID"}, {head: "PROJECT", max: 20}, {head: "TITLE", flex: true}, {head: "OUTSIDE", right: true}}, rows, termWidth())
	}
	return nil
}

func indentFirst(rows [][]string) [][]string {
	for _, r := range rows {
		r[0] = "  " + r[0]
	}
	return rows
}
