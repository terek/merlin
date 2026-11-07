package main

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/terek/merlin/internal/harness"
	"github.com/terek/merlin/internal/model"
)

// coverageRow is one capability of one harness: what its package claims and how many of
// its sessions populated it. Seen is nil for a capability a digest cannot show.
type coverageRow struct {
	Capability string        `json:"capability"`
	State      harness.State `json:"state"`
	Note       string        `json:"note,omitempty"`
	Seen       *int          `json:"seen,omitempty"`
	Flag       string        `json:"flag,omitempty"` // a contradiction between State and Seen
}

// harnessCoverage is the report for one harness. NoTable: the harness is not in the
// harness list, or its entry declares no table; every capability is then unknown.
type harnessCoverage struct {
	Harness  string                `json:"harness"`
	Sessions int                   `json:"sessions"`
	NoTable  bool                  `json:"noTable,omitempty"`
	States   map[harness.State]int `json:"states"`
	Rows     []coverageRow         `json:"rows"`
}

// seenCount counts the digests of one harness that populate c.
func seenCount(c harness.Capability, ds []*model.SessionDigest) int {
	n := 0
	for _, d := range ds {
		if c.Seen(d) {
			n++
		}
	}
	return n
}

// buildCoverage compares each harness's claims with what its sessions populate. Harnesses
// are the listed ones, then any other that has sessions. Seen is a count of sessions that
// filled the field: it says nothing about whether the value is right.
func buildCoverage(sessions []*model.SessionDigest) []harnessCoverage {
	by := map[string][]*model.SessionDigest{}
	for _, d := range sessions {
		by[d.Harness] = append(by[d.Harness], d)
	}
	type src struct {
		name    string
		support harness.Support
	}
	var srcs []src
	listed := map[string]bool{}
	for _, e := range harnessList {
		listed[e.Name] = true
		var s harness.Support
		if e.support != nil {
			s = e.support()
		}
		srcs = append(srcs, src{e.Name, s})
	}
	var others []string
	for h := range by {
		if !listed[h] {
			others = append(others, h)
		}
	}
	sort.Strings(others)
	for _, h := range others {
		srcs = append(srcs, src{h, nil})
	}

	out := []harnessCoverage{}
	for _, s := range srcs {
		ds := by[s.name]
		hc := harnessCoverage{Harness: s.name, Sessions: len(ds), NoTable: s.support == nil, States: map[harness.State]int{}, Rows: []coverageRow{}}
		for _, c := range harness.Capabilities() {
			cl, ok := s.support[c.ID]
			if !ok {
				cl = harness.Claim{State: harness.Unknown, Note: "not declared"}
			}
			row := coverageRow{Capability: c.ID, State: cl.State, Note: cl.Note}
			if c.Seen != nil {
				n := seenCount(c, ds)
				row.Seen = &n
				switch {
				case cl.State == harness.Parsed && n == 0 && len(ds) >= 1:
					row.Flag = "parsed but not seen"
				case (cl.State == harness.Absent || cl.State == harness.Dropped) && n > 0:
					row.Flag = string(cl.State) + " but populated"
				}
			}
			hc.States[cl.State]++
			hc.Rows = append(hc.Rows, row)
		}
		out = append(out, hc)
	}
	return out
}

// printCoverage writes the Coverage section: a line per harness, its contradictions and
// its unknown capabilities; with full, the table of every capability.
func printCoverage(out io.Writer, cov []harnessCoverage, full bool) {
	fmt.Fprintln(out, "\nCoverage  (what each harness package claims, against the sessions indexed; seen is not correct)")
	for _, h := range cov {
		fmt.Fprintf(out, "  %s: %s; %d parsed, %d dropped, %d absent, %d unknown\n", harnessTitle(h.Harness),
			plural(h.Sessions, "session", "sessions"), h.States[harness.Parsed], h.States[harness.Dropped], h.States[harness.Absent], h.States[harness.Unknown])
		if h.NoTable {
			fmt.Fprintln(out, "    no support table declared")
		}
		for _, r := range h.Rows {
			if r.Flag == "" {
				continue
			}
			note := ""
			if r.Flag == "parsed but not seen" {
				note = " (may be right for a small corpus)"
			}
			fmt.Fprintf(out, "    ! %s: %s, seen in %d of %d%s\n", r.Capability, r.Flag, *r.Seen, h.Sessions, note)
		}
		var unk []string
		for _, r := range h.Rows {
			if r.State == harness.Unknown {
				unk = append(unk, r.Capability)
			}
		}
		if len(unk) > 0 {
			fmt.Fprintf(out, "    unknown: %s\n", strings.Join(unk, ", "))
		}
		if !full {
			continue
		}
		fmt.Fprintln(out)
		var rows [][]string
		for _, r := range h.Rows {
			seen := "not measured"
			if r.Seen != nil {
				seen = fmt.Sprintf("%d of %d", *r.Seen, h.Sessions)
			}
			flag := r.Flag
			if flag != "" {
				flag = "! " + flag
			}
			rows = append(rows, []string{"    " + r.Capability, string(r.State), seen, flag, r.Note})
		}
		renderTable(out, []column{{head: "    CAPABILITY"}, {head: "STATE"}, {head: "SEEN"}, {head: "FLAG"}, {head: "NOTE", flex: true}}, rows, termWidth())
	}
	if !full {
		fmt.Fprintln(out, "\n  merlin doctor --coverage lists every capability")
	}
}
