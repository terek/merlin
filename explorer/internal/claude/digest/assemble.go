package digest

import (
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/terek/merlin/explorer/internal/claude/transcript"
	"github.com/terek/merlin/explorer/internal/model"
)

// AgentFile is one subagent file of a session, as the caller found it on disk.
type AgentFile struct {
	// ID is the agent id (the <id> of agent-<id>.jsonl). When empty, the first agentId seen
	// in the file is used; a file with neither is ignored.
	ID string
	// Result is what the Builder produced for the file.
	Result *FileResult
	// Meta is the content of agent-<id>.meta.json; nil when there is no such file.
	Meta *transcript.AgentMeta
}

// Assembly is the part of a session digest that depends on the agents: the main turns with
// their agent fields filled in, the agent tree, every billed message once, and the
// session's total cost. The caller (the session-level builder) adds the descriptive fields.
type Assembly struct {
	// Turns are the main file's turns with Spawned and CostWithAgents filled in; nil when
	// the session has no main file.
	Turns []model.Turn
	// Agents is the flat agent list, ordered by start time then id.
	Agents []model.Agent
	// Messages are the main file's messages followed by the agents' messages, ordered by
	// time (main first on ties). Each message id appears once; agent messages carry the
	// owning agent's id and the agent's spawn turn.
	Messages []model.Message
	// Compactions are the main file's compactions.
	Compactions []model.Compaction
	// Cost is the session total: main messages plus every agent's, each message id once.
	Cost model.Cost
	// Diagnostics merges the files' diagnostics and counts unresolved agents.
	Diagnostics model.Diagnostics
}

const mainOwner = -1

// spawnRef is an Agent tool_use together with the file it was found in.
type spawnRef struct {
	AgentSpawn
	owner int // index into the sorted agents; mainOwner for the main file
}

// resultRef is a spawn tool_result together with the file it was found in.
type resultRef struct {
	SpawnResult
	owner int
}

// link is how one agent was tied to its spawn.
type link struct {
	kind    model.Linkage
	spawn   int // index into spawns; -1 when the tool_use itself was not found
	toolUse string
	owner   int // file holding the spawn (tool_use or its result); mainOwner = main file
	turn    int // spawn turn when owner is the main file, else -1
}

// Assemble links the agent files of one session to the main file and rolls costs up.
// main may be nil (orphaned session: no main transcript). The inputs are not modified.
func Assemble(main *FileResult, files []AgentFile) *Assembly {
	ags := prepareAgents(files)
	n := len(ags)

	// Spawns and results, main file first, then agents in order.
	var spawns []spawnRef
	var results []resultRef
	if main != nil {
		for _, s := range main.AgentSpawns {
			spawns = append(spawns, spawnRef{s, mainOwner})
		}
		for _, r := range main.SpawnResults {
			results = append(results, resultRef{r, mainOwner})
		}
	}
	for i, a := range ags {
		for _, s := range a.res.AgentSpawns {
			spawns = append(spawns, spawnRef{s, i})
		}
		for _, r := range a.res.SpawnResults {
			results = append(results, resultRef{r, i})
		}
	}
	// Earliest first for the "earliest unclaimed" rungs; stable keeps main before agents.
	sort.SliceStable(spawns, func(i, j int) bool { return earlier(spawns[i].At, spawns[j].At) })
	spawnByID := make(map[string][]int, len(spawns))
	for i, s := range spawns {
		if s.ToolUseID != "" {
			spawnByID[s.ToolUseID] = append(spawnByID[s.ToolUseID], i)
		}
	}

	links := linkAgents(ags, spawns, spawnByID, results)
	parent := resolveParents(ags, links, spawns)

	asm := &Assembly{}
	if main != nil {
		asm.Compactions = slices.Clone(main.Compactions)
	}

	owned := assignMessages(main, ags)
	agents := make([]model.Agent, n)
	for i, a := range ags {
		agents[i] = buildAgent(a, links[i], parent[i], spawns, owned[i])
		if links[i].kind == model.LinkUnresolved {
			asm.Diagnostics.UnresolvedAgents++
		}
	}
	for i := range agents {
		if p := parent[i]; p >= 0 {
			id := ags[p].id
			agents[i].ParentAgentID = &id
		}
	}

	fillDepthAndSpawnTurn(agents, ags, links, parent)
	fillStatus(agents, ags, links, spawns, results, main)
	rollUp(agents, parent)

	// Who the delivered messages came from. An agent does not send to itself.
	for i := range agents {
		resolveInbox(agents[i].Inbox, agents)
		for k := range agents[i].Inbox {
			if agents[i].Inbox[k].AgentID == agents[i].ID {
				agents[i].Inbox[k].AgentID = ""
			}
		}
	}

	// Main turns.
	if main != nil {
		asm.Turns = slices.Clone(main.Turns)
		for i := range asm.Turns {
			if len(asm.Turns[i].Inbox) > 0 {
				asm.Turns[i].Inbox = slices.Clone(asm.Turns[i].Inbox)
				resolveInbox(asm.Turns[i].Inbox, agents)
			}
		}
		for i, a := range agents {
			if parent[i] >= 0 || a.SpawnTurn == nil {
				continue // nested agents are inside their top-level ancestor's subtree
			}
			t := *a.SpawnTurn
			if t >= 0 && t < len(asm.Turns) {
				asm.Turns[t].Spawned = append(slices.Clone(asm.Turns[t].Spawned), a.ID)
				asm.Turns[t].CostWithAgents += a.SubtreeUSD
			}
		}
	}

	// Messages and cost.
	if main != nil {
		asm.Messages = append(asm.Messages, main.Messages...)
		asm.Cost.Add(main.Cost)
	}
	for i, a := range ags {
		for _, m := range owned[i] {
			m.AgentID = a.id
			m.Turn = agents[i].SpawnTurn
			asm.Messages = append(asm.Messages, m)
		}
		asm.Cost.Add(agents[i].Cost)
	}
	sort.SliceStable(asm.Messages, func(i, j int) bool {
		return earlier(asm.Messages[i].At, asm.Messages[j].At)
	})
	asm.Agents = agents
	mergeDiagnostics(&asm.Diagnostics, main, ags)
	return asm
}

// agentIn is an agent file prepared for assembly.
type agentIn struct {
	id   string
	res  *FileResult
	meta *transcript.AgentMeta
}

// prepareAgents drops unusable files and duplicates and orders the rest by first
// timestamp (files without one last), then id.
func prepareAgents(files []AgentFile) []agentIn {
	var out []agentIn
	seen := make(map[string]bool)
	for _, f := range files {
		if f.Result == nil {
			continue
		}
		id := f.ID
		if id == "" && len(f.Result.AgentIDs) > 0 {
			id = f.Result.AgentIDs[0]
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, agentIn{id: id, res: f.Result, meta: f.Meta})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if !a.res.FirstTimestamp.Equal(b.res.FirstTimestamp) {
			return earlier(a.res.FirstTimestamp, b.res.FirstTimestamp)
		}
		return a.id < b.id
	})
	return out
}

// earlier orders times with the zero time last.
func earlier(a, b time.Time) bool {
	if a.IsZero() || b.IsZero() {
		return !a.IsZero() && b.IsZero()
	}
	return a.Before(b)
}

// firstPrompt is the index of the agent's first prompt turn, or -1.
func firstPrompt(turns []model.Turn) int {
	for i, t := range turns {
		if t.Origin != model.OriginContinuation {
			return i
		}
	}
	return -1
}

// linkAgents runs the linkage ladder. Each rung is applied to all agents before the next,
// so a weak match never takes a tool_use that a stronger rung would give to another agent.
// An agent's own file is never its spawner: a fork replays its parent's context, so the
// spawning tool_use can appear in the fork's file too.
func linkAgents(ags []agentIn, spawns []spawnRef, byID map[string][]int, results []resultRef) []link {
	links := make([]link, len(ags))
	for i := range links {
		links[i] = link{kind: model.LinkUnresolved, spawn: -1, owner: mainOwner, turn: -1}
	}
	idx := make(map[string]int, len(ags))
	for i, a := range ags {
		idx[a.id] = i
	}
	claimed := make(map[string]bool) // tool_use ids
	linked := func(i int) bool { return links[i].kind != model.LinkUnresolved }

	// pick chooses the occurrence of tool_use id that spawned agent i: the file of
	// meta.parentAgentId, else the main file, else the other agent that started first. When
	// only the agent's own file has it, meta.parentAgentId (an existing agent) still names
	// the spawner. It reports false when there is no usable occurrence.
	pick := func(i int, id string) (spawn, owner int, ok bool) {
		parent := -1
		if m := ags[i].meta; m != nil && m.ParentAgentID != "" {
			if p, found := idx[m.ParentAgentID]; found && p != i {
				parent = p
			}
		}
		best, own := -1, -1
		for _, si := range byID[id] {
			o := spawns[si].owner
			switch {
			case o == i:
				if own < 0 {
					own = si
				}
			case parent >= 0 && o == parent:
				return si, o, true
			case best < 0 || o < spawns[best].owner: // main (-1) first, then the earliest agent
				best = si
			}
		}
		if best >= 0 {
			return best, spawns[best].owner, true
		}
		if own >= 0 && parent >= 0 {
			return own, parent, true
		}
		return -1, mainOwner, false
	}
	set := func(i int, kind model.Linkage, id string, si, owner int) {
		claimed[id] = true
		l := link{kind: kind, spawn: si, toolUse: id, owner: owner, turn: -1}
		if owner == mainOwner && si >= 0 {
			l.turn = spawns[si].Turn
		}
		links[i] = l
	}

	// 1. meta.toolUseId
	for i, a := range ags {
		if a.meta == nil || a.meta.ToolUseID == "" || claimed[a.meta.ToolUseID] {
			continue
		}
		if si, o, ok := pick(i, a.meta.ToolUseID); ok {
			set(i, model.LinkMeta, a.meta.ToolUseID, si, o)
		}
	}
	// 2. a tool_result whose toolUseResult.agentId names the agent
	for i, a := range ags {
		if linked(i) {
			continue
		}
		for _, r := range results {
			if r.AgentID != a.id || r.ToolUseID == "" || r.owner == i || claimed[r.ToolUseID] {
				continue
			}
			if si, o, ok := pick(i, r.ToolUseID); ok {
				set(i, model.LinkToolResult, r.ToolUseID, si, o)
			} else {
				// The tool_use is not in any file; the result sits in the spawner's file.
				set(i, model.LinkToolResult, r.ToolUseID, -1, r.owner)
				if r.owner == mainOwner && r.Turn >= 0 {
					links[i].turn = r.Turn
				}
			}
			break
		}
	}
	// 3. teammate name, earliest unclaimed
	for i, a := range ags {
		if linked(i) || a.meta == nil || a.meta.Name == "" {
			continue
		}
		for _, s := range spawns {
			if s.ToolUseID == "" || claimed[s.ToolUseID] || s.owner == i || s.Name != a.meta.Name {
				continue
			}
			if si, o, ok := pick(i, s.ToolUseID); ok {
				set(i, model.LinkName, s.ToolUseID, si, o)
				break
			}
		}
	}
	// 4. identical first prompt, earliest unclaimed
	for i, a := range ags {
		if linked(i) {
			continue
		}
		p := firstPrompt(a.res.Turns)
		if p < 0 || strings.TrimSpace(promptText(&a.res.Turns[p])) == "" {
			continue
		}
		want := strings.TrimSpace(promptText(&a.res.Turns[p]))
		for _, s := range spawns {
			if s.ToolUseID == "" || claimed[s.ToolUseID] || s.owner == i || strings.TrimSpace(s.Prompt) != want {
				continue
			}
			if si, o, ok := pick(i, s.ToolUseID); ok {
				set(i, model.LinkPrompt, s.ToolUseID, si, o)
				break
			}
		}
	}
	return links
}

// resolveParents turns links into parent indexes (-1 = session root). An edge that would
// close a cycle is dropped and its agent becomes unresolved. An unresolved agent keeps the
// parent named by its meta when that agent exists.
func resolveParents(ags []agentIn, links []link, spawns []spawnRef) []int {
	idx := make(map[string]int, len(ags))
	for i, a := range ags {
		idx[a.id] = i
	}
	parent := make([]int, len(ags))
	for i := range parent {
		parent[i] = -1
	}
	reaches := func(from, target int) bool { // does the chain from `from` pass through target?
		for steps := 0; from >= 0 && steps <= len(ags); steps++ {
			if from == target {
				return true
			}
			from = parent[from]
		}
		return false
	}
	for i := range ags {
		p := -1
		if links[i].kind != model.LinkUnresolved {
			p = links[i].owner // mainOwner (-1) when spawned by the main agent
		} else if m := ags[i].meta; m != nil && m.ParentAgentID != "" {
			if pi, ok := idx[m.ParentAgentID]; ok {
				p = pi
			}
		}
		if p >= 0 && reaches(p, i) {
			p = -1
			links[i] = link{kind: model.LinkUnresolved, spawn: -1, owner: mainOwner, turn: -1}
		}
		parent[i] = p
	}
	return parent
}

// assignMessages decides which agent bills each message id: ids the main file bills belong
// to the main file; between agents the earliest first timestamp wins, then the smaller id
// (ags is already in that order). It returns, per agent, the messages it owns in file order.
func assignMessages(main *FileResult, ags []agentIn) [][]model.Message {
	taken := make(map[string]bool)
	if main != nil {
		for _, m := range main.Messages {
			taken[m.ID] = true
		}
	}
	owned := make([][]model.Message, len(ags))
	for i, a := range ags {
		for _, m := range a.res.Messages {
			if m.ID != "" {
				if taken[m.ID] {
					continue
				}
				taken[m.ID] = true
			}
			owned[i] = append(owned[i], m)
		}
	}
	return owned
}

// buildAgent fills everything about an agent except depth, spawn turn, status, parent id
// and subtree cost.
func buildAgent(a agentIn, l link, parent int, spawns []spawnRef, msgs []model.Message) model.Agent {
	ag := model.Agent{
		ID:             a.id,
		Kind:           agentKind(a),
		Linkage:        l.kind,
		SpawnToolUseID: l.toolUse,
		StartedAt:      a.res.FirstTimestamp,
		EndedAt:        a.res.LastTimestamp,
		Compactions:    slices.Clone(a.res.Compactions),
		Status:         model.StatusOpen,
	}
	if l.kind == model.LinkUnresolved {
		ag.SpawnToolUseID = ""
	}
	var sp *AgentSpawn
	if l.spawn >= 0 {
		sp = &spawns[l.spawn].AgentSpawn
		ag.Background = sp.RunInBackground
	}
	if m := a.meta; m != nil {
		ag.Name, ag.AgentType, ag.Description, ag.Model = m.Name, m.AgentType, m.Description, m.Model
	}
	if sp != nil {
		ag.Name = firstNonEmpty(ag.Name, sp.Name)
		ag.AgentType = firstNonEmpty(ag.AgentType, sp.SubagentType)
		ag.Description = firstNonEmpty(ag.Description, sp.Description)
		ag.Model = firstNonEmpty(ag.Model, sp.Model)
	}
	if ag.Model == "" && len(msgs) > 0 {
		ag.Model = msgs[0].Model
	}

	// Turn-derived fields.
	turns := a.res.Turns
	if p := firstPrompt(turns); p >= 0 {
		// A fork replays its parent's context before its own prompt: when the spawn's
		// input.prompt is a later prompt of the file, that one is the agent's prompt.
		if ag.Kind == model.AgentFork && sp != nil && sp.Prompt != "" {
			for j := p; j < len(turns); j++ {
				if turns[j].Origin != model.OriginContinuation &&
					strings.TrimSpace(promptText(&turns[j])) == strings.TrimSpace(sp.Prompt) {
					p = j
					break
				}
			}
		}
		// A prompt that was delivered as a message is that message's text; its summary
		// stands in for a missing description.
		ag.Prompt = turns[p].UserText
		if first := turns[p].Inbox; ag.Prompt == "" && len(first) > 0 {
			ag.Prompt = first[0].Text
			ag.Description = firstNonEmpty(ag.Description, first[0].Summary)
			ag.Inbox = append(ag.Inbox, first[1:]...)
		}
		for _, t := range turns[p+1:] {
			if t.Origin == model.OriginContinuation {
				continue
			}
			ag.Inbox = append(ag.Inbox, inboxMessages(t)...)
		}
	}
	if len(turns) > 0 {
		ag.FinalText = turns[len(turns)-1].FinalText
	}
	for _, t := range turns {
		ag.ToolCalls += t.ToolCalls
		for k, v := range t.ToolsByName {
			if ag.ToolsByName == nil {
				ag.ToolsByName = make(map[string]int64)
			}
			ag.ToolsByName[k] += v
		}
	}

	// Own cost: the messages this agent bills, minus models with no price.
	unpriced := a.res.Diagnostics.UnpricedModels
	for _, m := range msgs {
		ag.AssistantMessages++
		if slices.Contains(unpriced, m.Model) {
			continue
		}
		ag.Cost.AddMessage(m.Model, m.Tokens, m.USD)
		if m.Truncated {
			ag.Cost.AddTruncated()
		}
	}
	return ag
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

func agentKind(a agentIn) model.AgentKind {
	switch m := a.meta; {
	case m != nil && (m.TeamName != "" || m.TaskKind == "in_process_teammate"):
		return model.AgentTeammate
	case m != nil && (m.IsFork || m.AgentType == "fork"):
		return model.AgentFork
	case strings.HasPrefix(a.id, "acompact"):
		return model.AgentCompact
	}
	return model.AgentSubagent
}

// inboxMessages turns a later prompt of an agent into inbox entries: the messages the
// prompt delivered, and one entry with no sender for any text that is not one of them.
func inboxMessages(t model.Turn) []model.InboxMessage {
	out := slices.Clone(t.Inbox)
	if t.UserText != "" || len(out) == 0 {
		out = append(out, model.InboxMessage{At: t.StartedAt, Kind: model.InboxMessageKind, Text: t.UserText})
	}
	return out
}

// resolveInbox fills AgentID on delivered messages: the agent a task notification is about
// (its task id is the agent's id), or the agent that sent a message (by name).
func resolveInbox(msgs []model.InboxMessage, agents []model.Agent) {
	for i := range msgs {
		m := &msgs[i]
		if m.Kind == model.InboxTask {
			for j := range agents {
				if m.TaskID != "" && agents[j].ID == m.TaskID {
					m.AgentID = agents[j].ID
					break
				}
			}
			continue
		}
		if j := sender(m.From, m.At, agents); j >= 0 {
			m.AgentID = agents[j].ID
		}
	}
}

// sender is the index of the agent called name that sent a message at the given time, or
// -1. A name can be used by several agents over a session: the sender is the one started
// last before the message, else the one started first.
func sender(name string, at time.Time, agents []model.Agent) int {
	best := -1
	if name == "" {
		return best
	}
	for j := range agents {
		a := &agents[j]
		if a.Name != name {
			continue
		}
		if best < 0 {
			best = j
			continue
		}
		b := &agents[best]
		aBefore, bBefore := !a.StartedAt.After(at), !b.StartedAt.After(at)
		switch {
		case aBefore && bBefore:
			if a.StartedAt.After(b.StartedAt) {
				best = j
			}
		case aBefore:
			best = j
		case !bBefore:
			if a.StartedAt.Before(b.StartedAt) {
				best = j
			}
		}
	}
	return best
}

// fillDepthAndSpawnTurn sets Depth (meta.spawnDepth when present, else the parent chain's)
// and SpawnTurn (the main-file turn of the top-level ancestor's spawn).
func fillDepthAndSpawnTurn(agents []model.Agent, ags []agentIn, links []link, parent []int) {
	depth := make([]int, len(agents))
	done := make([]bool, len(agents))
	var calc func(i int) int
	calc = func(i int) int {
		if done[i] {
			return depth[i]
		}
		done[i] = true // parents are acyclic; this also bounds any surprise
		switch {
		case ags[i].meta != nil && ags[i].meta.SpawnDepth != nil:
			depth[i] = *ags[i].meta.SpawnDepth
		case parent[i] < 0:
			depth[i] = 1
		default:
			depth[i] = calc(parent[i]) + 1
		}
		return depth[i]
	}
	for i := range agents {
		agents[i].Depth = calc(i)
		top := i
		for parent[top] >= 0 {
			top = parent[top]
		}
		if links[top].kind != model.LinkUnresolved && links[top].owner == mainOwner && links[top].turn >= 0 {
			t := links[top].turn
			agents[i].SpawnTurn = &t
		}
	}
}

// fillStatus decides completed / killed / open from spawn results, task notifications and
// agents_killed events found in any file of the session.
func fillStatus(agents []model.Agent, ags []agentIn, links []link, spawns []spawnRef, results []resultRef, main *FileResult) {
	var notes []TaskNotification
	var kills []AgentsKilled
	if main != nil {
		notes = append(notes, main.Notifications...)
		kills = append(kills, main.AgentsKilled...)
	}
	for _, a := range ags {
		notes = append(notes, a.res.Notifications...)
		kills = append(kills, a.res.AgentsKilled...)
	}
	for i, a := range ags {
		tu := links[i].toolUse
		if links[i].kind == model.LinkUnresolved {
			tu = ""
		}
		mine := func(agentID, toolUse string) bool {
			return agentID == a.id || (tu != "" && toolUse == tu)
		}
		completed, killed := false, false
		for _, r := range results {
			if !(r.AgentID == a.id || (tu != "" && r.ToolUseID == tu)) {
				continue
			}
			switch {
			case r.Status == "async_launched":
				agents[i].Background = true
			case r.Status == "completed" && !r.IsError:
				completed = true
			}
		}
		for _, n := range notes {
			if !mine(n.TaskID, n.ToolUseID) {
				continue
			}
			switch strings.ToLower(n.Status) {
			case "completed":
				completed = true
			case "killed", "failed":
				killed = true
			}
		}
		clean := a.res.EndState == model.EndClean
		switch {
		case completed:
			agents[i].Status = model.StatusCompleted
		case killed:
			agents[i].Status = model.StatusKilled
		case clean:
			agents[i].Status = model.StatusCompleted
		default:
			last := a.res.LastTimestamp
			for _, k := range kills {
				if k.At.IsZero() || k.At.Before(last) {
					continue
				}
				if len(k.AgentIDs) == 0 || slices.Contains(k.AgentIDs, a.id) {
					agents[i].Status = model.StatusKilled
					break
				}
			}
		}
	}
}

// rollUp computes SubtreeUSD = own + all descendants. Parents form a forest, so adding
// each agent's own cost to every ancestor is exact.
func rollUp(agents []model.Agent, parent []int) {
	sub := make([]float64, len(agents))
	for i := range agents {
		sub[i] = agents[i].Cost.USD
	}
	// Children are added deepest first so each subtree total is final before it moves up.
	order := make([]int, len(agents))
	for i := range order {
		order[i] = i
	}
	level := func(i int) int {
		d := 0
		for p := parent[i]; p >= 0 && d <= len(agents); p = parent[p] {
			d++
		}
		return d
	}
	sort.SliceStable(order, func(x, y int) bool { return level(order[x]) > level(order[y]) })
	for _, i := range order {
		if p := parent[i]; p >= 0 {
			sub[p] += sub[i]
		}
	}
	for i := range agents {
		agents[i].SubtreeUSD = sub[i]
	}
}

// mergeDiagnostics adds the files' diagnostics into d (UnresolvedAgents is already set).
func mergeDiagnostics(d *model.Diagnostics, main *FileResult, ags []agentIn) {
	var unpriced uniq
	add := func(fd model.Diagnostics) {
		d.BadLines += fd.BadLines
		for k, v := range fd.UnknownTypes {
			if d.UnknownTypes == nil {
				d.UnknownTypes = make(map[string]int64)
			}
			d.UnknownTypes[k] += v
		}
		for _, m := range fd.UnpricedModels {
			unpriced.add(m)
		}
	}
	if main != nil {
		add(main.Diagnostics)
	}
	for _, a := range ags {
		add(a.res.Diagnostics)
	}
	d.UnpricedModels = unpriced.copy()
}
