package digest

import (
	"fmt"
	"maps"
	"math"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/terek/merlin/explorer/internal/claude/discover"
	"github.com/terek/merlin/explorer/internal/claude/transcript"
	"github.com/terek/merlin/explorer/internal/model"
)

// ParserVersion identifies the output of this package. Bump it whenever a change here, in
// the Builder, in Assemble or in the transcript package would change a digest built from
// the same files: the engine rebuilds every digest whose parserVersion differs. A change of
// the embedded price table counts too, as the stored costs are not repriced otherwise.
const ParserVersion = 16

// BuildSession reads the files of one discovered session and returns its complete digest.
//
// The result is a pure function of the files' content and of src: building the same source
// twice gives identical JSON, whatever the order of src.Agents and src.Fingerprint. An error
// means a file could not be read; the engine then writes an error stub that keeps
// src.Fingerprint as its source.
func BuildSession(src discover.Source, pricer Pricer) (*model.SessionDigest, error) {
	return BuildSessionFrom(src, pricer, func(path string) (*FileResult, error) { return readFileResult(path, pricer) })
}

// FileReducer returns the reduction of one transcript file as it is now. BuildSessionFrom
// calls it once per file, sequentially; a caller that keeps Builders between calls can
// answer from them, as long as the result equals a reduction of the whole file.
type FileReducer func(path string) (*FileResult, error)

// BuildSessionFrom is BuildSession with the per-file reduction supplied by the caller.
// pricer must be the one the reductions price with.
func BuildSessionFrom(src discover.Source, pricer Pricer, reduce FileReducer) (*model.SessionDigest, error) {
	d := &model.SessionDigest{
		SchemaVersion: model.SchemaVersion,
		ParserVersion: ParserVersion,
		Source:        slices.Clone(src.Fingerprint),
		Harness:       discover.Harness,
		ID:            src.ID,
		ProjectKey:    src.ProjectKey,
	}
	sort.Slice(d.Source, func(i, j int) bool { return d.Source[i].Path < d.Source[j].Path })

	var main *FileResult
	if src.Main != "" {
		r, err := reduce(src.Main)
		if err != nil {
			return nil, err
		}
		main = r
	}
	agents := slices.Clone(src.Agents)
	sort.Slice(agents, func(i, j int) bool { return agents[i].ID < agents[j].ID })
	files := make([]AgentFile, 0, len(agents))
	for _, a := range agents {
		r, err := reduce(a.Path)
		if err != nil {
			return nil, err
		}
		af := AgentFile{ID: a.ID, Dir: a.Dir, Result: r}
		if a.MetaPath != "" {
			// A meta file that is unreadable or not JSON is treated as absent: the agent is
			// still linked by the weaker rungs of the ladder.
			if meta, found, err := transcript.ReadAgentMeta(a.MetaPath); err == nil && found {
				af.Meta = &meta
			}
		}
		files = append(files, af)
	}

	asm := Assemble(main, files)
	d.Turns, d.Agents, d.Messages, d.Workflows, d.Beads = asm.Turns, asm.Agents, asm.Messages, asm.Workflows, asm.Beads
	d.Compactions, d.Cost, d.Diagnostics = asm.Compactions, asm.Cost, asm.Diagnostics

	// The files in time order: the main file first, then the agent files.
	all := make([]*FileResult, 0, len(files)+1)
	if main != nil {
		all = append(all, main)
	}
	rest := make([]*FileResult, 0, len(files))
	for _, f := range files {
		rest = append(rest, f.Result)
	}
	sort.SliceStable(rest, func(i, j int) bool { return earlier(rest[i].FirstTimestamp, rest[j].FirstTimestamp) })
	all = append(all, rest...)

	fillDescriptive(d, main, all)
	fillTitle(d, main)
	fillLineage(d, main, all)
	d.Reported, d.Stats.LinesAdded, d.Stats.LinesRemoved = reported(main)
	rateDiffs(d, pricer)
	fillStats(d)
	return d, nil
}

// readFileResult reduces one transcript file.
func readFileResult(path string, pricer Pricer) (*FileResult, error) {
	r, err := transcript.Open(path)
	if err != nil {
		return nil, fmt.Errorf("digest: %w", err)
	}
	defer r.Close()
	b := NewBuilder(pricer)
	if err := b.Feed(r); err != nil {
		return nil, fmt.Errorf("digest: reading %s: %w", path, err)
	}
	return b.Result(), nil
}

// fillDescriptive sets the environment lists, kind, times, name, slug, end state and recaps.
func fillDescriptive(d *model.SessionDigest, main *FileResult, all []*FileResult) {
	var cwds, branches, versions, entrypoints, kinds, slugs uniq
	var first, last time.Time
	for _, f := range all {
		for _, v := range f.Cwds {
			cwds.add(v)
		}
		for _, v := range f.GitBranches {
			branches.add(v)
		}
		for _, v := range f.Versions {
			versions.add(v)
		}
		for _, v := range f.Entrypoints {
			entrypoints.add(v)
		}
		for _, v := range f.SessionKinds {
			kinds.add(v)
		}
		for _, v := range f.Slugs {
			slugs.add(v)
		}
		if !f.FirstTimestamp.IsZero() && (first.IsZero() || f.FirstTimestamp.Before(first)) {
			first = f.FirstTimestamp
		}
		if f.LastTimestamp.After(last) {
			last = f.LastTimestamp
		}
	}
	d.Cwds, d.GitBranches, d.HarnessVersions = cwds.copy(), branches.copy(), versions.copy()
	if len(d.Cwds) > 0 {
		// project is where the session started (its identity, and where it is resumed
		// from); cwd is where it was working when it stopped.
		d.Project = d.Cwds[0]
		d.Cwd = d.Cwds[0]
		if main != nil && main.LastCwd != "" {
			d.Cwd = main.LastCwd
		}
	}
	d.StartedAt, d.LastActivityAt = first, last
	if s := slugs.copy(); len(s) > 0 {
		d.Slug = s[0]
	}

	// Scripted only when every record that names an entrypoint says sdk-cli: a session that
	// mixes cli and sdk-cli records was picked up by a remote client. An orphan has no main
	// conversation to judge and counts as interactive.
	d.Kind = model.KindInteractive
	if main != nil {
		if len(entrypoints.list) == 1 && entrypoints.list[0] == "sdk-cli" {
			d.Kind = model.KindSDK
		} else if slices.Contains(kinds.list, "bg") {
			d.Kind = model.KindBackground
		}
		d.Name = main.AgentName
		d.EndState = main.EndState
		d.Recaps = slices.Clone(main.Recaps)
		sort.SliceStable(d.Recaps, func(i, j int) bool { return d.Recaps[i].At.Before(d.Recaps[j].At) })
		d.PRs = uniquePRs(main.PRs)
	} else {
		d.EndState = model.EndUnknown
	}
}

// uniquePRs keeps each PR once, at its first link, ordered by time then URL.
func uniquePRs(links []model.PRLink) []model.PRLink {
	first := map[string]int{}
	var out []model.PRLink
	for _, l := range links {
		if i, ok := first[l.URL]; ok {
			if l.At.Before(out[i].At) {
				out[i].At = l.At
			}
			continue
		}
		first[l.URL] = len(out)
		out = append(out, l)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.Before(out[j].At)
		}
		return out[i].URL < out[j].URL
	})
	return out
}

// fillTitle picks the title: the last custom title, else the last AI title, else the first
// line of the first prompt (an orphan has no prompt of its own and uses its first agent's).
func fillTitle(d *model.SessionDigest, main *FileResult) {
	if main != nil {
		switch {
		case main.CustomTitle != "":
			d.Title = main.CustomTitle
			return
		case main.AITitle != "":
			d.Title = main.AITitle
			return
		}
		d.Title = firstLine(firstPromptText(d.Turns))
		return
	}
	if len(d.Agents) > 0 {
		d.Title = firstLine(d.Agents[0].Prompt)
	}
}

// firstPromptText is the text of the first turn a person (or, failing that, a script)
// started, skipping abandoned turns.
func firstPromptText(turns []model.Turn) string {
	for _, origin := range []model.TurnOrigin{model.OriginHuman, model.OriginSDK, model.OriginCommand} {
		for _, t := range turns {
			if t.Origin == origin && !t.Abandoned && strings.TrimSpace(t.UserText) != "" {
				return t.UserText
			}
		}
	}
	return ""
}

// firstLine is the first non-empty line of s, trimmed.
func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return l
		}
	}
	return ""
}

// fillLineage copies the explicit markers: the main file's forkedFrom, and the other
// session ids found on copied records in any file.
func fillLineage(d *model.SessionDigest, main *FileResult, all []*FileResult) {
	if main != nil && main.ForkedFrom != nil {
		f := *main.ForkedFrom
		d.Lineage.ForkedFrom = &f
	}
	var inherited uniq
	for _, f := range all {
		for _, id := range f.InheritedFrom {
			if id != d.ID {
				inherited.add(id)
			}
		}
	}
	d.Lineage.InheritedFrom = inherited.copy()
}

// reported turns the main file's cost-state records into windows. It also returns the
// lines added and removed, summed over the windows' last records.
//
// A cost-state record is a running total for one process run that began at its startTime,
// so a session has one window per distinct startTime: from the start time to the last
// record before the window's last cost-state. A total that drops while the start time is
// unchanged means the counter restarted, which opens a new window.
func reported(main *FileResult) (rep *model.Reported, added, removed int64) {
	if main == nil || len(main.CostStates) == 0 {
		return nil, 0, 0
	}
	type window struct {
		model.ReportedWindow
		added, removed int64
	}
	var wins []*window
	open := map[time.Time]*window{} // distinct start -> the window still growing
	for _, c := range main.CostStates {
		w := open[c.Start]
		if w == nil || c.TotalCostUSD < w.TotalUSD {
			from := c.Start
			if from.IsZero() {
				from = c.At // no usable startTime: the best clue left
			}
			w = &window{ReportedWindow: model.ReportedWindow{From: from}}
			wins = append(wins, w)
			open[c.Start] = w
		}
		to := c.At
		if to.Before(w.From) {
			to = w.From
		}
		w.To, w.TotalUSD, w.ByModel = to, c.TotalCostUSD, c.ByModel
		w.added, w.removed = c.LinesAdded, c.LinesRemoved
	}
	sort.SliceStable(wins, func(i, j int) bool { return wins[i].From.Before(wins[j].From) })

	rep = &model.Reported{}
	for _, w := range wins {
		rep.Windows = append(rep.Windows, w.ReportedWindow)
		rep.TotalUSD += w.TotalUSD
		for name, m := range w.ByModel {
			if rep.ByModel == nil {
				rep.ByModel = make(map[string]model.ReportedModel)
			}
			t := rep.ByModel[name]
			t.InputTokens += m.InputTokens
			t.OutputTokens += m.OutputTokens
			t.ThinkingTokens += m.ThinkingTokens
			t.CacheReadTokens += m.CacheReadTokens
			t.CacheCreationTokens += m.CacheCreationTokens
			t.WebSearchRequests += m.WebSearchRequests
			t.USD += m.USD
			rep.ByModel[name] = t
		}
		added += w.added
		removed += w.removed
	}
	return rep, added, removed
}

// windowSlack widens a reported window when matching messages to it, as the catalog does.
const windowSlack = time.Second

// rateDiffs sets each reported window's RateDiffUSD: what Claude Code reported for it minus
// the tokens it reported priced with Merlin's table, over the models the table knows. A
// rate Claude Code charged differently (an old price in its own table) shows here instead
// of as calls missing from the transcript.
//
// The reported tokens do not say which cache writes were 5-minute and which 1-hour, nor
// which calls ran in fast mode: the 1-hour writes are those of the session's messages of
// the model in the window, the rest 5-minute. The priced tokens at standard rates are scaled by the messages' own cost over
// their cost at standard rates, which carries the fast-mode share over.
func rateDiffs(d *model.SessionDigest, pricer Pricer) {
	if d.Reported == nil || pricer == nil {
		return
	}
	for wi := range d.Reported.Windows {
		w := &d.Reported.Windows[wi]
		type acc struct {
			tok      model.Tokens
			usd, std float64
		}
		in := map[string]*acc{}
		for _, m := range d.Messages {
			if m.At.Before(w.From.Add(-windowSlack)) || m.At.After(w.To.Add(windowSlack)) {
				continue
			}
			a := in[m.Model]
			if a == nil {
				a = &acc{}
				in[m.Model] = a
			}
			a.tok.Add(m.Tokens)
			a.usd += m.USD
			if s, ok := pricer.Cost(m.Model, m.Tokens, false); ok {
				a.std += s.USD
			}
		}
		var diff float64
		for _, name := range slices.Sorted(maps.Keys(w.ByModel)) {
			r := w.ByModel[name]
			a := in[name]
			if a == nil {
				a = &acc{}
			}
			tok := model.Tokens{Input: r.InputTokens, Output: r.OutputTokens, CacheRead: r.CacheReadTokens}
			// 1-hour writes are the messages' own; the writes no message shows are the
			// harness's side calls, which write the 5-minute cache (on the history up to
			// 2026-10-27 this leaves every model but Sonnet 5.5 within ±$2 over all windows,
			// where splitting them as the messages do left Fable 5.1 at -$11.6)
			tok.CacheWrite1h = min(a.tok.CacheWrite1h, r.CacheCreationTokens)
			tok.CacheWrite5m = r.CacheCreationTokens - tok.CacheWrite1h
			p, ok := pricer.Cost(name, tok, false)
			if !ok {
				continue
			}
			priced := p.USD
			if a.std > 0 {
				priced *= a.usd / a.std
			}
			diff += r.USD - priced
		}
		w.RateDiffUSD = math.Round(diff*1e9) / 1e9 // float noise is no difference
	}
}

// fillStats counts turns, messages and tool calls over the main agent and every sub-agent.
func fillStats(d *model.SessionDigest) {
	s := &d.Stats
	s.Turns = int64(len(d.Turns))
	s.AssistantMessages = int64(len(d.Messages))
	tools := func(calls int64, byName map[string]int64) {
		s.ToolCalls += calls
		for name, n := range byName {
			if s.ToolsByName == nil {
				s.ToolsByName = make(map[string]int64)
			}
			s.ToolsByName[name] += n
		}
	}
	for _, t := range d.Turns {
		if (t.Origin == model.OriginHuman || t.Origin == model.OriginCommand) && !t.Abandoned {
			s.HumanTurns++
		}
		tools(t.ToolCalls, t.ToolsByName)
	}
	for _, a := range d.Agents {
		tools(a.ToolCalls, a.ToolsByName)
	}
}
