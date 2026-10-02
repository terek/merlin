package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/model"
)

func init() {
	register("search", command{
		usage:   "search <terms...>",
		summary: "matching turns with the resume command",
		run:     runSearch,
	})
}

const searchHelp = `Usage: explorer search <terms...> [--project P] [--since D] [--limit N] [--json]

Where was the session in which I asked X, and which one do I resume?

All terms must occur (case-insensitive) in the same text: a title, a prompt, a
final text, a compaction summary, or a project path, working directory or branch.
Prompts and titles come first, then final texts, then compaction summaries, then
the rest; newer first within each. Scripted runs are never searched.

Each hit shows when and where it happened, the session title, which field matched
and in which turn (turns are numbered from 0, as in 'explorer show'), the snippet,
the sessions that start with a copy of that turn (a copied turn is reported once,
in the session that owns it), and the command to resume the session.

Flags:
  --project P   a project path, or its last element(s): 'app' or 'acme/app'
  --since D     only sessions with activity within D: 90m, 36h, 7d, 2w, or 2026-09-01
  --limit N     at most N hits (default 20; 0 = all)
  --json        machine-readable output
`

type hitJSON struct {
	catalog.Hit
	ID          string   `json:"id"`
	Resume      string   `json:"resume"`
	ContinuedID []string `json:"continuedInIds,omitempty"`
}

func runSearch(args []string) int {
	fs := flag.NewFlagSet("search", flag.ContinueOnError)
	project := fs.String("project", "", "")
	since := fs.String("since", "", "")
	limit := fs.Int("limit", 20, "")
	asJSON := fs.Bool("json", false, "")
	pos, help, err := parseArgs("search", fs, searchHelp, args)
	if help {
		fmt.Print(searchHelp)
		return 0
	}
	if err == nil && len(pos) == 0 {
		err = usageError("give at least one search term")
	}
	if err != nil {
		return finish("search", err)
	}
	return finish("search", doSearch(strings.Join(pos, " "), *project, *since, *limit, *asJSON))
}

func fieldLabel(h catalog.Hit) string {
	switch h.Field {
	case catalog.FieldPrompt:
		return fmt.Sprintf("prompt, turn %d", h.Turn)
	case catalog.FieldFinal:
		return fmt.Sprintf("final text, turn %d", h.Turn)
	case catalog.FieldCompaction:
		return fmt.Sprintf("compaction summary %d", h.Turn+1)
	case catalog.FieldTitle:
		return "title"
	case catalog.FieldProject:
		return "project path"
	case catalog.FieldCwd:
		return "working directory"
	case catalog.FieldBranch:
		return "branch"
	}
	return string(h.Field)
}

func doSearch(query, project, since string, limit int, asJSON bool) error {
	w, err := loadWorld("search")
	if err != nil {
		return err
	}
	f := catalog.Filter{}
	if f.Project, err = w.resolveProject(project); err != nil {
		return err
	}
	if f.Since, err = parseSince(since, w.now); err != nil {
		return usageError(err.Error())
	}
	hits := tidyHits(w.cat.Search(query, catalog.SearchOptions{Filter: f}))
	total := len(hits)
	if limit > 0 && len(hits) > limit {
		hits = hits[:limit]
	}
	projectOf := func(k model.SessionKey) string {
		in, _ := w.cat.Session(k)
		return in.Project
	}

	if asJSON {
		out := struct {
			Query string    `json:"query"`
			Total int       `json:"total"`
			Hits  []hitJSON `json:"hits"`
		}{Query: query, Total: total, Hits: []hitJSON{}}
		for _, h := range hits {
			hj := hitJSON{Hit: h, ID: h.Session.ID, Resume: resumeCommand(projectOf(h.Session), h.Session.ID)}
			for _, c := range h.ContinuedIn {
				hj.ContinuedID = append(hj.ContinuedID, c.ID)
			}
			out.Hits = append(out.Hits, hj)
		}
		return writeJSON(out)
	}

	w.emptyHint("search")
	tw := termWidth()
	textW := 150
	if tw > 0 {
		textW = max(40, tw-6)
	}
	for i, h := range hits {
		title := h.Title
		if title == "" {
			title = "(untitled)"
		}
		head := fmt.Sprintf("%s · %s · %s", stamp(h.At), w.label(h.Project), snip(title, 60))
		fmt.Printf("%s   [%s%s]\n", head, fieldLabel(h), map[bool]string{true: ", abandoned branch", false: ""}[h.Abandoned])
		fmt.Printf("    %s\n", cut(h.Snippet, textW))
		if len(h.ContinuedIn) > 0 {
			var parts []string
			for _, c := range h.ContinuedIn {
				in, _ := w.cat.Session(c)
				s := w.shortID(c.ID)
				if in.Title != "" {
					s += " “" + snip(in.Title, 30) + "”"
				}
				s += " " + stamp(in.LastActivityAt)
				parts = append(parts, s)
				if len(parts) == 3 && len(h.ContinuedIn) > 3 {
					parts = append(parts, fmt.Sprintf("+%d more", len(h.ContinuedIn)-3))
					break
				}
			}
			fmt.Printf("    continued in: %s\n", strings.Join(parts, "; "))
		}
		fmt.Printf("    %s\n", resumeCommand(projectOf(h.Session), h.Session.ID))
		if i < len(hits)-1 {
			fmt.Println()
		}
	}
	if total == 0 {
		fmt.Fprintf(os.Stdout, "no matches for %q\n", query)
		return nil
	}
	fmt.Println()
	fmt.Printf("%d of %d matches", len(hits), total)
	if len(hits) < total {
		fmt.Print(" (--limit 0 for all)")
	}
	fmt.Println()
	return nil
}

// tidyHits drops what only repeats another hit: a title hit whose text is also the
// matching prompt of the same session (a title defaults to the first prompt), and all but
// the first of a session's project/working directory/branch hits.
func tidyHits(hits []catalog.Hit) []catalog.Hit {
	type key struct {
		s       string
		snippet string
	}
	prompts := map[key]bool{}
	for _, h := range hits {
		if h.Field == catalog.FieldPrompt {
			prompts[key{h.Session.ID, h.Snippet}] = true
		}
	}
	sessionLevel := map[string]bool{}
	var out []catalog.Hit
	for _, h := range hits {
		switch h.Field {
		case catalog.FieldTitle:
			if prompts[key{h.Session.ID, h.Snippet}] {
				continue
			}
		case catalog.FieldProject, catalog.FieldCwd, catalog.FieldBranch:
			if sessionLevel[h.Session.ID] {
				continue
			}
			sessionLevel[h.Session.ID] = true
		}
		out = append(out, h)
	}
	return out
}
