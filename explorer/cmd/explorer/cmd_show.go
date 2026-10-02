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
	register("show", command{
		usage:   "show <session-id>",
		summary: "turns, agent tree, compactions, cost",
		run:     runShow,
	})
}

const showHelp = `Usage: merlin show <session-id-or-prefix> [--inherited] [--summaries] [--full] [--json]

One session in full: header, cost, agent tree, family, timeline, and the command
to resume it. The id may be any unique prefix; an ambiguous one lists the
candidates.

Cost block
  best        what the session cost: the figure to add up
  reported    Claude Code's own figure, summed over its reported windows (one
              window per run of the program); includes calls that leave no
              trace in the transcript
  attributed  recomputed from the transcript tokens, for the messages this
              session owns (subagents included)
  overhead    reported minus attributed inside the windows: calls not in the
              transcript. A session-level figure, never spread over turns/agents
  outside     spend outside every reported window, recomputed from tokens; it
              is added to the reported figure to give the best cost
  inherited   history copied from another session that the other session paid
              for; NOT counted here
  (cost notation as in 'merlin sessions --help': ≈ estimated, * partial)

Timeline
  Turns are numbered from 0, as in the JSON output. Each shows its start, origin
  (human, command, task-notification, ...), cost including the agents it started,
  the prompt (>) and Claude's final text (<). Turns copied from another session
  are folded into one line; abandoned turns (on a branch the session rewound
  away from) are marked. Compactions appear between the turns they separate.

Flags:
  --inherited   expand the turns copied from another session
  --summaries   print each compaction's summary
  --full        print prompts, final texts and summaries whole (default: shortened)
  --json        machine-readable output: the digest without its per-message list,
                plus the catalog's view (cost split, lineage, family) and the
                resume command
`

func runShow(args []string) int {
	fs := flag.NewFlagSet("show", flag.ContinueOnError)
	inherited := fs.Bool("inherited", false, "")
	summaries := fs.Bool("summaries", false, "")
	full := fs.Bool("full", false, "")
	asJSON := fs.Bool("json", false, "")
	pos, help, err := parseArgs("show", fs, showHelp, args)
	if help {
		fmt.Print(showHelp)
		return 0
	}
	if err == nil && len(pos) != 1 {
		err = usageError("expected exactly one session id")
	}
	if err != nil {
		return finish("show", err)
	}
	return finish("show", doShow(pos[0], showOpts{inherited: *inherited, summaries: *summaries, full: *full}, *asJSON))
}

type showOpts struct{ inherited, summaries, full bool }

// familyJSON is a family as the JSON output shows it.
type familyJSON struct {
	Root    model.SessionKey   `json:"root"`
	Members []model.SessionKey `json:"members"`
	Leaves  []model.SessionKey `json:"leaves"`
}

func doShow(arg string, opt showOpts, asJSON bool) error {
	w, err := loadWorld("show")
	if err != nil {
		return err
	}
	key, err := w.resolveSession(arg)
	if err != nil {
		return err
	}
	d, _ := w.cat.Digest(key)
	in, _ := w.cat.Session(key)
	if st, ok := w.cat.StateOf(key, w.live); ok {
		in.State = st
	}
	fam, _ := w.cat.Family(key)
	resume := resumeCommand(in.Project, key.ID)

	if asJSON {
		cp := *d
		cp.Messages = nil
		return writeJSON(struct {
			Session catalog.SessionInfo  `json:"session"`
			Family  familyJSON           `json:"family"`
			Resume  string               `json:"resume"`
			Digest  *model.SessionDigest `json:"digest"`
		}{in, familyJSON{fam.Root, fam.Members, fam.Leaves}, resume, &cp})
	}

	p := &printer{w: w, textW: 160, out: os.Stdout, opt: opt}
	if tw := termWidth(); tw > 0 {
		p.textW = max(40, tw-8)
	}
	p.header(d, in)
	p.cost(d, in)
	p.agents(d)
	p.family(key, fam)
	p.timeline(d, in)
	fmt.Println()
	fmt.Println("Resume")
	fmt.Println("  " + resume)
	var later []string
	for _, c := range in.Children {
		later = append(later, w.shortID(c.Child.ID))
	}
	if len(later) > 0 {
		fmt.Printf("  note: other sessions start with a copy of this one (%s); the newest may be the one you want\n", strings.Join(later, ", "))
	}
	return nil
}

type printer struct {
	w     *world
	textW int
	out   *os.File
	opt   showOpts
}

func (p *printer) printf(format string, a ...any) { fmt.Fprintf(p.out, format, a...) }

func (p *printer) kv(k, v string) { p.printf("  %-9s  %s\n", k, v) }

func shortModel(m string) string {
	return strings.TrimPrefix(m, "claude-")
}

func (p *printer) header(d *model.SessionDigest, in catalog.SessionInfo) {
	title := in.Title
	if title == "" {
		title = "(untitled)"
	}
	p.printf("%s\n", snip(title, p.textW))
	p.kv("id", d.ID)
	p.kv("state", stateText(in))
	proj := d.Project
	if len(d.GitBranches) > 0 {
		proj += "   branch " + strings.Join(d.GitBranches, ", ")
	}
	p.kv("project", proj)
	if d.Cwd != "" && d.Cwd != d.Project {
		p.kv("cwd", d.Cwd+"   (where it ended up)")
	}
	kind := string(d.Kind)
	if d.Name != "" {
		kind += " · name " + d.Name
	}
	if len(d.HarnessVersions) > 0 {
		kind += " · Claude Code " + strings.Join(d.HarnessVersions, ", ")
	}
	p.kv("kind", kind)
	span := stamp(d.StartedAt) + " → " + stamp(d.LastActivityAt)
	if !d.StartedAt.IsZero() && !d.LastActivityAt.IsZero() {
		span += "  (" + fmtDur(d.LastActivityAt.Sub(d.StartedAt).Milliseconds()) + ")"
	}
	p.kv("when", span)
	own := len(d.Turns) - len(in.InheritedTurns)
	turns := plural(len(d.Turns), "turn", "turns")
	if len(in.InheritedTurns) > 0 {
		turns += fmt.Sprintf(" (%d inherited, %d own)", len(in.InheritedTurns), own)
	}
	nAgents := 0
	for _, a := range d.Agents {
		if a.Kind != model.AgentCompact {
			nAgents++
		}
	}
	line := fmt.Sprintf("%s · %s · %s", turns, plural(int(d.Stats.AssistantMessages), "assistant message", "assistant messages"), plural(int(d.Stats.ToolCalls), "tool call", "tool calls"))
	if nAgents > 0 {
		line += " · " + plural(nAgents, "agent", "agents")
	}
	if n := len(d.Compactions); n > 0 {
		line += " · " + plural(n, "compaction", "compactions")
	}
	p.kv("turns", line)
	if d.Stats.LinesAdded > 0 || d.Stats.LinesRemoved > 0 {
		p.kv("lines", fmt.Sprintf("+%d −%d", d.Stats.LinesAdded, d.Stats.LinesRemoved))
	}
	if l := in.Parent; l != nil {
		verb := "continues"
		if l.Kind == catalog.LinkFork {
			verb = "fork of"
		}
		s := fmt.Sprintf("↳ %s %s%s, after its turn %d (%s shared)", verb, p.w.shortID(l.Parent.ID), p.titleOf(l.Parent), l.AtTurn, plural(l.SharedMessages, "message", "messages"))
		p.kv("lineage", s)
	}
	for _, l := range in.Children {
		verb := "continued in"
		if l.Kind == catalog.LinkFork {
			verb = "forked to"
		}
		p.kv("lineage", fmt.Sprintf("→ %s %s%s, from this session's turn %d", verb, p.w.shortID(l.Child.ID), p.titleOf(l.Child), l.AtTurn))
	}
	if n := len(d.Recaps); n > 0 {
		r := d.Recaps[n-1]
		text := snip(r.Text, p.textW-14)
		if p.opt.full {
			text = r.Text
		}
		p.kv("recap", text)
	}
}

func (p *printer) titleOf(k model.SessionKey) string {
	if d, ok := p.w.cat.Digest(k); ok && d.Title != "" {
		return " “" + snip(d.Title, 40) + "”"
	}
	return ""
}

func (p *printer) cost(d *model.SessionDigest, in catalog.SessionInfo) {
	c := in.Cost
	p.printf("\nCost    %s", marked(c.BestUSD, c.Flag))
	switch c.Flag {
	case catalog.CostExact:
		p.printf("   exact: Claude Code's own figure; nothing lies outside its windows\n")
	case catalog.CostPartial:
		p.printf("   partial: Claude Code's figure plus %s recomputed for spend outside its windows\n", usd(c.UncoveredUSD))
	default:
		p.printf("   estimated: Claude Code reported no figure; recomputed from tokens\n")
	}
	row := func(label string, v float64, note string) {
		p.printf("  %-11s %10s   %s\n", label, usd(v), note)
	}
	if len(c.Windows) > 0 {
		row("reported", c.ReportedUSD, fmt.Sprintf("Claude Code's own figure, %s", plural(len(c.Windows), "window", "windows")))
		for i, wd := range c.Windows {
			if i == 6 {
				p.printf("  %-11s %10s   … and %d more\n", "", "", len(c.Windows)-6)
				break
			}
			p.printf("  %-11s %10s     %s → %s\n", "", usd(wd.TotalUSD), stamp(wd.From), wd.To.Local().Format("Jan 2 15:04"))
		}
	}
	attributed := "recomputed from tokens, messages this session owns"
	if c.TruncatedMessages > 0 {
		attributed = fmt.Sprintf("at least; recomputed from tokens, %s cut short in the transcript", plural(c.TruncatedMessages, "message", "messages"))
	}
	row("attributed", c.OwnUSD, attributed)
	if len(c.Windows) > 0 {
		row("overhead", c.OverheadUSD, "reported but not in the transcript (inside windows)")
		row("outside", c.UncoveredUSD, "outside every window, recomputed; added to the total")
	}
	if c.InheritedUSD > 0 || c.InheritedMessages > 0 {
		var from []string
		for _, f := range c.InheritedFrom {
			from = append(from, fmt.Sprintf("%s %s", p.w.shortID(f.From.ID), usd(f.USD)))
		}
		row("inherited", c.InheritedUSD, fmt.Sprintf("NOT counted: %s paid for by %s", plural(c.InheritedMessages, "message", "messages"), strings.Join(from, ", ")))
	}

	// By model: reported per model, and the transcript's own messages per model.
	inheritedIDs := map[string]bool{}
	for _, f := range c.InheritedFrom {
		if od, ok := p.w.cat.Digest(f.From); ok {
			for _, m := range od.Messages {
				inheritedIDs[m.ID] = true
			}
		}
	}
	rep := map[string]float64{}
	for _, wd := range c.Windows {
		for m, v := range wd.ByModel {
			rep[m] += v.USD
		}
	}
	att := map[string]float64{}
	for _, m := range d.Messages {
		if !inheritedIDs[m.ID] {
			att[m.Model] += m.USD
		}
	}
	names := map[string]bool{}
	for m := range rep {
		names[m] = true
	}
	for m := range att {
		names[m] = true
	}
	var sorted []string
	for m := range names {
		sorted = append(sorted, m)
	}
	sort.Slice(sorted, func(i, j int) bool {
		a, b := rep[sorted[i]]+att[sorted[i]], rep[sorted[j]]+att[sorted[j]]
		if a != b {
			return a > b
		}
		return sorted[i] < sorted[j]
	})
	if len(sorted) > 0 {
		p.printf("\n  by model\n")
		cols := []column{{head: "  MODEL"}, {head: "ATTRIBUTED", right: true}}
		if len(c.Windows) > 0 {
			cols = []column{{head: "  MODEL"}, {head: "REPORTED", right: true}, {head: "ATTRIBUTED", right: true}}
		}
		var rows [][]string
		for _, m := range sorted {
			row := []string{"  " + shortModel(m)}
			if len(c.Windows) > 0 {
				row = append(row, usd(rep[m]))
			}
			rows = append(rows, append(row, usd(att[m])))
		}
		renderTable(p.out, cols, rows, 0)
	}
}

func (p *printer) agents(d *model.SessionDigest) {
	if len(d.Agents) == 0 {
		return
	}
	children := map[string][]*model.Agent{}
	var roots []*model.Agent
	ids := map[string]bool{}
	for i := range d.Agents {
		ids[d.Agents[i].ID] = true
	}
	for i := range d.Agents {
		a := &d.Agents[i]
		if a.ParentAgentID == nil || !ids[*a.ParentAgentID] {
			roots = append(roots, a)
		} else {
			children[*a.ParentAgentID] = append(children[*a.ParentAgentID], a)
		}
	}
	order := func(s []*model.Agent) {
		sort.SliceStable(s, func(i, j int) bool {
			if !s[i].StartedAt.Equal(s[j].StartedAt) {
				return s[i].StartedAt.Before(s[j].StartedAt)
			}
			return s[i].ID < s[j].ID
		})
	}
	order(roots)
	var rows [][]string
	var walk func(a *model.Agent, prefix, branch string)
	walk = func(a *model.Agent, prefix, branch string) {
		name := a.Name
		if name == "" {
			name = a.AgentType
		} else if a.AgentType != "" && a.AgentType != a.Name {
			name += " (" + a.AgentType + ")"
		}
		if name == "" {
			name = a.ID
		}
		if a.Description != "" {
			name += " · " + snip(a.Description, 36)
		}
		kind := string(a.Kind)
		if a.Background {
			kind += " (bg)"
		}
		sub := ""
		if len(children[a.ID]) > 0 {
			sub = usd(a.SubtreeUSD)
		}
		own := atLeast(usd(a.Cost.USD), a.Cost.TruncatedMessages > 0)
		if sub != "" {
			sub = atLeast(sub, subtreeTruncated(a, children))
		}
		rows = append(rows, []string{prefix + branch + name, kind, shortModel(a.Model), string(a.Status), own, sub})
		kids := children[a.ID]
		order(kids)
		next := prefix
		switch branch {
		case "├─ ":
			next += "│  "
		case "└─ ":
			next += "   "
		}
		for i, k := range kids {
			b := "├─ "
			if i == len(kids)-1 {
				b = "└─ "
			}
			walk(k, next, b)
		}
	}
	for i, r := range roots {
		b := "├─ "
		if i == len(roots)-1 {
			b = "└─ "
		}
		walk(r, "  ", b)
	}
	p.printf("\nAgents  (%s; own cost is attributed from tokens)\n", plural(len(d.Agents), "agent", "agents"))
	truncated := d.Cost.TruncatedMessages
	renderTable(p.out, []column{{head: "  AGENT", flex: true, max: 48}, {head: "KIND"}, {head: "MODEL"}, {head: "STATUS"}, {head: "OWN", right: true}, {head: "WITH SUBTREE", right: true}}, rows, termWidth())
	if truncated > 0 {
		p.printf("  ≥ at least: %s cut short in the transcript (output tokens partial, mostly agents)\n", plural(int(truncated), "message", "messages"))
	}
}

// atLeast marks a cost figure that is a lower bound.
func atLeast(s string, lower bool) string {
	if lower {
		return "≥ " + s
	}
	return s
}

// subtreeTruncated reports whether an agent or any descendant has messages cut short.
func subtreeTruncated(a *model.Agent, children map[string][]*model.Agent) bool {
	if a.Cost.TruncatedMessages > 0 {
		return true
	}
	for _, k := range children[a.ID] {
		if subtreeTruncated(k, children) {
			return true
		}
	}
	return false
}

func (p *printer) family(self model.SessionKey, fam catalog.Family) {
	if len(fam.Members) < 2 {
		return
	}
	newest := ""
	if len(fam.Leaves) > 0 {
		newest = fam.Leaves[0].ID
	}
	p.printf("\nFamily  (%d sessions that share history; leaves are the ones to resume, newest first: %s)\n",
		len(fam.Members), strings.Join(p.shortIDs(fam.Leaves), ", "))
	for _, m := range fam.Members {
		in, ok := p.w.cat.Session(m)
		if !ok {
			continue
		}
		depth := 0
		for l := in.Parent; l != nil; depth++ {
			pin, ok := p.w.cat.Session(l.Parent)
			if !ok {
				break
			}
			l = pin.Parent
		}
		rel := "root"
		if in.Parent != nil {
			rel = string(in.Parent.Kind) + " after turn " + fmt.Sprint(in.Parent.AtTurn)
		}
		var tags []string
		if m == self {
			tags = append(tags, "◀ this session")
		}
		if in.Leaf {
			tags = append(tags, "leaf")
		}
		if m.ID == newest {
			tags = append(tags, "newest")
		}
		title := in.Title
		if title == "" {
			title = "(untitled)"
		}
		p.printf("%s\n", strings.TrimRight(fmt.Sprintf("  %s%s  %s  %s  %s  %s  %s", strings.Repeat("  ", depth), p.w.shortID(m.ID), stamp(in.LastActivityAt),
			rel, marked(in.Cost.BestUSD, in.Cost.Flag), snip(title, 36), strings.Join(tags, ", ")), " "))
	}
}

func (p *printer) shortIDs(keys []model.SessionKey) []string {
	var out []string
	for _, k := range keys {
		out = append(out, p.w.shortID(k.ID))
	}
	return out
}

// text prints a prompt or reply under a turn, shortened unless --full.
func (p *printer) text(mark, s string) {
	if strings.TrimSpace(s) == "" {
		return
	}
	if !p.opt.full {
		p.printf("     %s %s\n", mark, snip(s, p.textW))
		return
	}
	p.block(mark, s)
}

func (p *printer) block(mark, s string) {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	for i, l := range lines {
		m := " "
		if i == 0 {
			m = mark
		}
		p.printf("     %s %s\n", m, strings.TrimRight(l, " "))
	}
}

func (p *printer) compaction(c model.Compaction, n int) {
	var bits []string
	if c.Trigger != "" {
		bits = append(bits, string(c.Trigger))
	}
	if c.PreTokens > 0 {
		t := fmtTokens(c.PreTokens)
		if c.PostTokens > 0 {
			t += " → " + fmtTokens(c.PostTokens)
		}
		bits = append(bits, t+" tokens")
	}
	if c.DurationMs > 0 {
		bits = append(bits, "took "+fmtDur(c.DurationMs))
	}
	p.printf("   ── compaction %d · %s · %s ──\n", n+1, stamp(c.At), strings.Join(bits, " · "))
	if p.opt.summaries && c.Summary != "" {
		p.block("|", c.Summary)
	}
}

func (p *printer) timeline(d *model.SessionDigest, in catalog.SessionInfo) {
	inh := map[int]bool{}
	for _, i := range in.InheritedTurns {
		inh[i] = true
	}
	after := map[int][]int{} // turn index -> compactions placed after it
	for i, c := range d.Compactions {
		after[c.Turn] = append(after[c.Turn], i)
	}
	hint := "; texts shortened, --full for all"
	if p.opt.full {
		hint = ""
	}
	p.printf("\nTimeline  (turns numbered from 0; > prompt, < final text%s)\n", hint)
	for _, ci := range after[-1] {
		p.compaction(d.Compactions[ci], ci)
	}
	if len(d.Turns) == 0 {
		p.printf("  (no turns)\n")
	}
	for i := 0; i < len(d.Turns); i++ {
		t := d.Turns[i]
		if inh[t.Index] && !p.opt.inherited {
			j := i
			for j+1 < len(d.Turns) && inh[d.Turns[j+1].Index] {
				j++
			}
			first, last := d.Turns[i].Index, d.Turns[j].Index
			span := fmt.Sprintf("turn %d", first)
			if last > first {
				span = fmt.Sprintf("turns %d–%d", first, last)
			}
			src := ""
			if in.Parent != nil {
				src = " from " + p.w.shortID(in.Parent.Parent.ID) + p.titleOf(in.Parent.Parent)
			}
			folded := 0
			for k := i; k < j; k++ {
				folded += len(after[d.Turns[k].Index])
			}
			extra := ""
			if folded > 0 {
				extra = ", " + plural(folded, "compaction", "compactions")
			}
			p.printf("  %s inherited%s  (%s, not counted here; --inherited shows them)\n", span, src, plural(j-i+1, "turn", "turns")+extra)
			for _, ci := range after[last] {
				p.compaction(d.Compactions[ci], ci)
			}
			i = j
			continue
		}
		var flags []string
		if inh[t.Index] {
			flags = append(flags, "inherited")
		}
		if t.Abandoned {
			flags = append(flags, "abandoned branch")
		}
		if t.Interrupted {
			flags = append(flags, "interrupted")
		}
		if n := len(t.Spawned); n > 0 {
			flags = append(flags, "+"+plural(n, "agent", "agents"))
		}
		cost := usd(t.CostWithAgents)
		if inh[t.Index] {
			cost = "(" + cost + " not counted)"
		}
		head := fmt.Sprintf("  #%-3d %-13s %-17s %10s", t.Index, stamp(t.StartedAt), t.Origin, cost)
		if t.DurationMs > 0 {
			head += "  " + fmtDur(t.DurationMs)
		}
		if len(flags) > 0 {
			head += "  [" + strings.Join(flags, "] [") + "]"
		}
		p.printf("%s\n", head)
		p.text(">", t.UserText)
		p.text("<", t.FinalText)
		for _, ci := range after[t.Index] {
			p.compaction(d.Compactions[ci], ci)
		}
	}
}
