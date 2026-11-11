package pi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/terek/merlin/internal/model"
)

// maxNest bounds how deep child messages are read inside child messages.
const maxNest = 8

// Conventions of subagent extensions (docs/pi-format.md, Subagents):
//
//	convA: Pi's examples/extensions/subagent: details.results[], each with the child's messages
//	       and/or an aggregate usage.
//	convC: pi-dial's Task and oracle tools: details.run, no usage, the child's session file lies
//	       outside Pi's sessions directory.
const (
	convA = 'A'
	convC = 'C'
)

// subRun is one agent run a tool result carries.
type subRun struct {
	conv  byte
	idx   int // position in details.results (A)
	agent string
	task  string
	model string // "provider/id" as the extension wrote it
	stop  string
	kind  string // C: details.kind
	desc  string // C: details.description
	text  string // C: the run's final text

	aborted bool // C: aborted or timedOut
	msgs    []rec
	hasMsgs bool
	agg     *usage // A: the aggregate usage, as one usage record
}

type wireRun struct {
	Agent      str             `json:"agent"`
	Task       str             `json:"task"`
	Model      str             `json:"model"`
	StopReason str             `json:"stopReason"`
	Messages   json.RawMessage `json:"messages"`
	Usage      json.RawMessage `json:"usage"`
}

// aggUsage is results[].usage of the example extension. cost is a number, not an object.
type aggUsage struct {
	Input      num `json:"input"`
	Output     num `json:"output"`
	CacheRead  num `json:"cacheRead"`
	CacheWrite num `json:"cacheWrite"`
	Cost       num `json:"cost"`
	Turns      num `json:"turns"`
}

func isJSON(raw json.RawMessage, first byte) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) > 0 && raw[0] == first
}

// runs reads the agent runs of a tool result's details; nil when it carries none. A is
// recognised by shape (details.results is a list of objects that carry messages and/or usage),
// not by tool name. A malformed call returns results: [], which is no agent.
func (p *parsed) runs(details json.RawMessage) []subRun {
	if p.nest >= maxNest || len(details) < 8 ||
		!(bytes.Contains(details, []byte(`"results"`)) || bytes.Contains(details, []byte(`"run"`))) {
		return nil
	}
	var d struct {
		Results json.RawMessage `json:"results"`
		Run     json.RawMessage `json:"run"`
		Kind    str             `json:"kind"`
		Descr   str             `json:"description"`
	}
	if json.Unmarshal(details, &d) != nil {
		return nil
	}
	if isJSON(d.Results, '[') {
		var items []json.RawMessage
		if json.Unmarshal(d.Results, &items) != nil {
			return nil
		}
		var out []subRun
		shaped := false
		for i, it := range items {
			var w wireRun
			if !isJSON(it, '{') || json.Unmarshal(it, &w) != nil {
				continue
			}
			rn := subRun{conv: convA, idx: i, agent: string(w.Agent), task: string(w.Task), model: string(w.Model), stop: string(w.StopReason)}
			if isJSON(w.Messages, '[') {
				shaped = true
				rn.hasMsgs = true
				var raws []json.RawMessage
				_ = json.Unmarshal(w.Messages, &raws)
				p.nest++
				for _, raw := range raws {
					m := rec{typ: "message"}
					p.message(&m, raw)
					rn.msgs = append(rn.msgs, m)
				}
				p.nest--
			}
			if isJSON(w.Usage, '{') {
				shaped = true
				var u aggUsage
				if json.Unmarshal(w.Usage, &u) == nil {
					a := &usage{Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite}
					a.Cost.Total = u.Cost
					rn.agg = a
				}
			}
			out = append(out, rn)
		}
		if shaped {
			return out
		}
		return nil
	}
	if d.Kind != "" && isJSON(d.Run, '{') {
		var r struct {
			Model    str  `json:"model"`
			Aborted  flag `json:"aborted"`
			TimedOut flag `json:"timedOut"`
			Stop     str  `json:"stopReason"`
			Text     str  `json:"text"`
		}
		if json.Unmarshal(d.Run, &r) != nil {
			return nil
		}
		return []subRun{{conv: convC, kind: string(d.Kind), desc: string(d.Descr), model: string(r.Model), stop: string(r.Stop),
			text: string(r.Text), aborted: bool(r.Aborted) || bool(r.TimedOut)}}
	}
	return nil
}

// modelName drops the provider of an extension's "provider/id" model string, and a trailing
// ":<thinking level>" (Pi's --model syntax, seen as "openai-codex/gpt-5.5:xhigh" in a public
// corpus), so the child is named as Pi names models in assistant messages (the id alone).
func modelName(s string) string {
	if _, id, ok := strings.Cut(s, "/"); ok && id != "" {
		s = id
	}
	if i := strings.LastIndexByte(s, ':'); i > 0 {
		switch s[i+1:] {
		case "off", "minimal", "low", "medium", "high", "xhigh", "max":
			s = s[:i]
		}
	}
	return s
}

// scope is where a run was spawned: the main agent's turn or an agent's.
type scope struct {
	turn    int    // turn index of the main agent; -1 outside every turn
	parent  int    // index into d.Agents of the enclosing agent; -1 for the main agent
	prefix  string // id prefix of what this scope spawns: the tool call id, or the agent's id and the call id
	msgBase string // prefix of the ids of the messages of what this scope spawns
}

// agentID joins an id prefix with a position.
func agentID(prefix string, idx int) string { return fmt.Sprintf("%s.%d", prefix, idx) }

// callPrefix is the id prefix of the agents a tool call spawns: the call id for the main agent;
// for an agent's call, the agent's id and the call id.
func (b *builder) callPrefix(sc scope, callID, fallback string) string {
	if callID == "" {
		callID = fallback
	}
	if sc.parent >= 0 {
		return b.d.Agents[sc.parent].ID + "/" + callID
	}
	return callID
}

// newAgent appends an agent spawned in scope sc and returns its index.
func (b *builder) newAgent(sc scope, id, callID string, at time.Time) int {
	a := model.Agent{
		ID:             id,
		Kind:           model.AgentSubagent,
		Linkage:        model.LinkToolResult,
		SpawnToolUseID: callID,
		Depth:          1,
		StartedAt:      at,
		Status:         model.StatusOpen,
	}
	if sc.turn >= 0 {
		v := sc.turn
		a.SpawnTurn = &v
	}
	if sc.parent >= 0 {
		pid := b.d.Agents[sc.parent].ID
		a.ParentAgentID = &pid
		a.Depth = b.d.Agents[sc.parent].Depth + 1
	}
	b.d.Agents = append(b.d.Agents, a)
	return len(b.d.Agents) - 1
}

// spawnBash records the children a bash call started with `pi --no-session`: unrecorded runs.
// The first gets the call's id, any further one in the same command line a numbered suffix.
func (b *builder) spawnBash(sc scope, callID, command string, at time.Time, fallback string) {
	prefix := b.callPrefix(sc, callID, fallback)
	b.spawnHints(sc, prefix, callID, command, at)
	for n, sp := range piSpawns(command) {
		id := prefix
		if n > 0 {
			id = agentID(prefix, n)
		}
		ai := b.newAgent(sc, id, callID, at)
		a := &b.d.Agents[ai]
		a.AgentType, a.Prompt, a.Model = "pi", command, sp.model
		b.openTurn(ai, sc)
		b.markUnrecorded(ai)
		if b.bashAgents == nil {
			b.bashAgents = map[string][]int{}
		}
		b.bashAgents[prefix] = append(b.bashAgents[prefix], ai)
	}
}

// spawnHints records the children a bash call started that keep a session file of their own.
func (b *builder) spawnHints(sc scope, prefix, callID, command string, at time.Time) {
	if !strings.Contains(command, "pi") {
		return
	}
	for _, h := range piHints(command, string(b.p.head.Cwd)) {
		sp := model.SessionSpawn{ToolUseID: callID, At: at, Dir: h.dir, Prompts: h.prompts, Harness: HarnessName}
		if sc.turn >= 0 {
			v := sc.turn
			sp.Turn = &v
		}
		if sc.parent >= 0 {
			sp.AgentID = b.d.Agents[sc.parent].ID
		}
		b.d.SpawnedSessions = append(b.d.SpawnedSessions, sp)
		if b.hintsOf == nil {
			b.hintsOf = map[string][]int{}
		}
		b.hintsOf[prefix] = append(b.hintsOf[prefix], len(b.d.SpawnedSessions)-1)
	}
}

// bashResult closes the unrecorded runs a bash call started: its result came back.
func (b *builder) bashResult(sc scope, callID, fallback string, at time.Time) {
	for _, i := range b.hintsOf[b.callPrefix(sc, callID, fallback)] {
		b.d.SpawnedSessions[i].EndedAt = at
	}
	for _, ai := range b.bashAgents[b.callPrefix(sc, callID, fallback)] {
		a := &b.d.Agents[ai]
		a.Status, a.EndedAt = model.StatusCompleted, at
		a.Turns[0].EndedAt = at
	}
}

// markUnrecorded marks an agent whose spend nothing records.
func (b *builder) markUnrecorded(ai int) {
	a := &b.d.Agents[ai]
	a.Unrecorded = true
	a.Cost.AddUnrecorded()
}

// openTurn gives an agent its one turn: the task it was started with.
func (b *builder) openTurn(ai int, sc scope) {
	a := &b.d.Agents[ai]
	t := model.AgentTurn{Index: 0, StartedAt: a.StartedAt, EndedAt: a.EndedAt, Origin: model.OriginSpawn, Prompt: a.Prompt}
	if sc.turn >= 0 {
		v := sc.turn
		t.RootTurn = &v
	}
	a.Turns = []model.AgentTurn{t}
}

// toolRuns turns the runs of a tool result into agents. callAt is when the call was made, zero
// when unknown.
func (b *builder) toolRuns(runs []subRun, sc scope, callID, fallback string, resultAt, callAt time.Time) {
	prefix := b.callPrefix(sc, callID, fallback)
	if callAt.IsZero() {
		callAt = resultAt
	}
	for k := range runs {
		rn := &runs[k]
		switch rn.conv {
		case convA:
			b.runA(rn, sc, agentID(prefix, rn.idx), callID, resultAt, callAt)
		case convC:
			// No usage at all, and the child's session file lies outside Pi's sessions directory:
			// the run is known, its spend is not.
			ai := b.newAgent(sc, prefix, callID, callAt)
			a := &b.d.Agents[ai]
			a.EndedAt, a.AgentType, a.Prompt, a.Model = resultAt, rn.kind, rn.desc, modelName(rn.model)
			a.FinalText = rn.text
			a.Status = model.StatusCompleted
			if rn.aborted {
				a.Status = model.StatusKilled
			}
			b.openTurn(ai, sc)
			a.Turns[0].FinalText, a.Turns[0].Interrupted = rn.text, rn.aborted
			b.markUnrecorded(ai)
		}
	}
}

// runA builds the agent of one results[] element of the example extension's convention.
func (b *builder) runA(rn *subRun, sc scope, id, callID string, resultAt, callAt time.Time) {
	ai := b.newAgent(sc, id, callID, callAt)
	a := &b.d.Agents[ai]
	a.AgentType, a.Prompt, a.EndedAt, a.Model = rn.agent, rn.task, resultAt, modelName(rn.model)
	a.Status = model.StatusCompleted
	if rn.stop == "aborted" {
		a.Status = model.StatusKilled
	}
	b.openTurn(ai, sc)
	a.Turns[0].Interrupted = rn.stop == "aborted"
	sub := scope{turn: sc.turn, parent: ai, msgBase: fmt.Sprintf("%s.%d", sc.msgBase, rn.idx)}

	switch {
	case len(rn.msgs) > 0:
		b.childMessages(ai, rn, sub, resultAt)
	case rn.agg != nil:
		// The extension kept only the child's totals, no messages: one Message carries them all,
		// in the model the extension names. It is not one API call, so the agent's count of
		// assistant messages is 1 when anything was billed; the call count is not known.
		if m, ok := b.price(sub.msgBase+".usage", resultAt, b.d.Agents[ai].Model, "", rn.agg); ok {
			b.addAgentMessage(ai, m)
			b.countAssistant(ai)
		}
	default:
		b.markUnrecorded(ai) // neither messages nor usage: it ran, nothing says what it spent
	}
}

func (b *builder) countAssistant(ai int) {
	a := &b.d.Agents[ai]
	a.AssistantMessages++
	a.Turns[0].AssistantMessages++
	b.assist++
}

// childMessages reads a child's own messages into its agent, priced like the parent's.
func (b *builder) childMessages(ai int, rn *subRun, sub scope, resultAt time.Time) {
	var first, last time.Time
	named := false
	writes := map[string]int64{} // content lines of each write call, by call id
	for j := range rn.msgs {
		m := &rn.msgs[j]
		at := b.start(m)
		if at.IsZero() {
			at = resultAt
		}
		if first.IsZero() || at.Before(first) {
			first = at
		}
		if at.After(last) {
			last = at
		}
		switch m.role {
		case "assistant":
			if !named && m.model != "" {
				b.d.Agents[ai].Model, named = m.model, true
			}
			if m.usage != nil {
				if msg, ok := b.price(fmt.Sprintf("%s.%d", sub.msgBase, j), at, m.model, m.provider, m.usage); ok {
					b.addAgentMessage(ai, msg)
					b.countAssistant(ai)
				}
			}
			if m.text != "" {
				b.d.Agents[ai].FinalText = m.text
			}
			for _, c := range m.calls {
				if c.Name == "write" {
					writes[c.ID] = c.Lines
				}
				a := &b.d.Agents[ai]
				a.ToolCalls++
				a.Turns[0].ToolCalls++
				if a.ToolsByName == nil {
					a.ToolsByName = map[string]int64{}
				}
				if a.Turns[0].ToolsByName == nil {
					a.Turns[0].ToolsByName = map[string]int64{}
				}
				a.ToolsByName[c.Name]++
				a.Turns[0].ToolsByName[c.Name]++
				if c.Name == "bash" && c.Command != "" {
					b.spawnBash(b.nested(sub, ai, j), c.ID, c.Command, at, fmt.Sprintf("m%d", j))
				}
			}
		case "toolResult":
			b.d.Stats.LinesAdded += m.added
			b.d.Stats.LinesRemoved += m.removed
			if m.toolName == "write" && !m.isErr {
				b.d.Stats.LinesAdded += writes[m.toolCallID]
			}
			nsc, fb := b.nested(sub, ai, j), fmt.Sprintf("m%d", j)
			if m.toolName == "bash" {
				b.bashResult(nsc, m.toolCallID, fb, at)
			}
			if len(m.runs) > 0 {
				b.toolRuns(m.runs, nsc, m.toolCallID, fb, at, b.d.Agents[ai].StartedAt)
			}
		}
	}
	a := &b.d.Agents[ai]
	if !first.IsZero() {
		a.StartedAt, a.EndedAt = first, last
		a.Turns[0].StartedAt, a.Turns[0].EndedAt = first, last
	}
	a.Turns[0].FinalText = a.FinalText
}

// nested is the scope of what child message j of agent ai spawns.
func (b *builder) nested(sub scope, ai, j int) scope {
	return scope{turn: sub.turn, parent: ai, msgBase: fmt.Sprintf("%s.%d.sub", sub.msgBase, j)}
}

// addAgentMessage lists a billed message of an agent and adds its cost to the agent, its turn
// and the session. It is not added to the main agent's turn: Turn.CostWithAgents has it.
func (b *builder) addAgentMessage(ai int, m model.Message) {
	a := &b.d.Agents[ai]
	m.AgentID = a.ID
	if a.SpawnTurn != nil {
		v := *a.SpawnTurn
		m.Turn = &v
	}
	zero := 0
	m.AgentTurn = &zero
	addCost(&a.Cost, m)
	addCost(&a.Turns[0].Cost, m)
	b.d.Messages = append(b.d.Messages, m)
	addCost(&b.d.Cost, m)
}
