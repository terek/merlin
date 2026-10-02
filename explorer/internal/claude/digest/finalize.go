package digest

import (
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/terek/merlin/explorer/internal/model"
)

// shortFinalText is the length in characters under which a turn's final text is
// considered too short to stand alone and the previous text message is prepended.
const shortFinalText = 80

const syntheticModel = "<synthetic>"

// Result finalises a copy of the Builder's state: it prices the messages, aggregates the
// turns and flags abandoned branches. It does not change the Builder, so it may be called
// repeatedly while records keep arriving. Feeding a file in several parts gives the same
// Result as feeding it whole.
func (b *Builder) Result() *FileResult {
	res := &FileResult{
		Compactions:     slices.Clone(b.compactions),
		AgentSpawns:     slices.Clone(b.spawns),
		SpawnResults:    slices.Clone(b.spawnRes),
		Notifications:   slices.Clone(b.notes),
		AgentsKilled:    slices.Clone(b.killed),
		CostStates:      slices.Clone(b.costStates),
		Recaps:          slices.Clone(b.recaps),
		ForkContextRefs: slices.Clone(b.forkRefs),
		AITitle:         b.aiTitle,
		CustomTitle:     b.customTitle,
		AgentName:       b.agentName,
		LastPrompt:      b.lastPrompt,
		LastPromptLeaf:  b.lastLeaf,
		Slugs:           b.slugs.copy(),
		Cwds:            b.cwds.copy(),
		LastCwd:         b.lastCwd,
		GitBranches:     b.branches.copy(),
		Versions:        b.versions.copy(),
		Entrypoints:     b.entrypoints.copy(),
		SessionKinds:    b.kinds.copy(),
		SessionIDs:      b.sessionIDs.copy(),
		AgentIDs:        b.agentIDs.copy(),
		InheritedFrom:   b.inherited.copy(),
		FirstTimestamp:  b.first,
		LastTimestamp:   b.last,
		Counters:        b.counters,
	}
	if b.forkedFrom != nil {
		f := *b.forkedFrom
		res.ForkedFrom = &f
	}
	res.Diagnostics.BadLines = b.badLines
	if len(b.unknown) > 0 {
		res.Diagnostics.UnknownTypes = make(map[string]int64, len(b.unknown))
		for k, v := range b.unknown {
			res.Diagnostics.UnknownTypes[k] = v
		}
	}

	res.EndState = b.endState()
	billed := b.priceMessages(res)
	b.buildTurns(res, billed)
	if ab := b.abandoned(); ab != nil {
		for i := range res.Turns {
			res.Turns[i].Abandoned = ab[i]
		}
	}
	return res
}

// billedMsg is a priced message, kept for turn aggregation.
type billedMsg struct {
	st   *msgState
	cost model.ModelCost
	ok   bool // priced
}

// priceMessages prices every non-synthetic message and fills res.Messages, res.Cost and
// the unpriced-model list. It returns the billed messages by index into b.msgs
// (nil entries for synthetic ones).
func (b *Builder) priceMessages(res *FileResult) []*billedMsg {
	billed := make([]*billedMsg, len(b.msgs))
	var unpriced uniq
	for i, m := range b.msgs {
		if m.synthetic {
			res.Counters.SyntheticMessages++
			continue
		}
		name := m.model
		if name == "" {
			name = "(unknown)"
		}
		tok := m.usage.Tokens()
		mc, ok := b.pricer.Cost(name, tok, m.usage.IsFast())
		if !ok {
			unpriced.add(name)
			mc = model.ModelCost{Tokens: tok}
		} else {
			res.Cost.AddMessage(name, mc.Tokens, mc.USD)
		}
		turn := m.turn
		res.Messages = append(res.Messages, model.Message{
			ID: m.id, At: m.firstTS, Model: name, Turn: &turn, USD: mc.USD, Tokens: tok,
		})
		billed[i] = &billedMsg{st: m, cost: mc, ok: ok}
	}
	res.Diagnostics.UnpricedModels = unpriced.copy()
	return billed
}

// buildTurns converts the turn states into model turns.
func (b *Builder) buildTurns(res *FileResult, billed []*billedMsg) {
	res.Turns = make([]model.Turn, len(b.turns))
	for i := range b.turns {
		ts := &b.turns[i]
		t := model.Turn{
			Index: i, Epoch: ts.epoch, UUID: ts.uuid,
			StartedAt: ts.startedAt, EndedAt: ts.endedAt,
			Origin: ts.origin, UserText: ts.userText, Images: ts.images,
			Command: ts.command, Interrupted: ts.interrupted,
		}
		switch {
		case ts.durationMs > 0:
			t.DurationMs = ts.durationMs
		case !ts.startedAt.IsZero() && ts.endedAt.After(ts.startedAt):
			t.DurationMs = ts.endedAt.Sub(ts.startedAt).Milliseconds()
		}

		var texts []string // texts of the turn's messages that have any, in order
		var files uniq
		for _, mi := range ts.msgs {
			bm := billed[mi]
			if bm == nil {
				continue // synthetic
			}
			t.AssistantMessages++
			t.ContextTokens = bm.st.usage.ContextTokens()
			if bm.ok {
				t.Cost.AddMessage(bm.st.modelOrUnknown(), bm.cost.Tokens, bm.cost.USD)
			}
			for _, tu := range bm.st.tools {
				t.ToolCalls++
				if t.ToolsByName == nil {
					t.ToolsByName = make(map[string]int64)
				}
				t.ToolsByName[tu.name]++
				files.add(tu.file)
			}
			if txt := strings.Join(bm.st.texts, "\n"); strings.TrimSpace(txt) != "" {
				texts = append(texts, txt)
			}
		}
		t.FilesTouched = files.copy()
		t.FinalText = finalText(texts)
		t.CostWithAgents = t.Cost.USD
		res.Turns[i] = t
	}
}

func (m *msgState) modelOrUnknown() string {
	if m.model == "" {
		return "(unknown)"
	}
	return m.model
}

// finalText is the last text message of a turn; when it is short and an earlier one
// exists, that one is prepended, separated by a blank line.
func finalText(texts []string) string {
	n := len(texts)
	if n == 0 {
		return ""
	}
	last := texts[n-1]
	if n > 1 && utf8.RuneCountInString(strings.TrimSpace(last)) < shortFinalText {
		return texts[n-2] + "\n\n" + last
	}
	return last
}

// abandoned flags the turns whose prompt lies on a branch the session rewound away from.
// It returns nil when there is nothing to decide.
//
// The active path is the set of ancestors of the last user/assistant record. Where the
// walk reaches a parent that is not in the file it stops, and everything positioned
// before the last record reached counts as active: a broken chain must never mark history
// as abandoned. A turn is abandoned when its prompt is not on the path and sits after the
// earliest active record.
func (b *Builder) abandoned() []bool {
	if b.lastConv == "" {
		return nil
	}
	active := make(map[string]struct{})
	earliest := -1
	for u := b.lastConv; ; {
		n, ok := b.nodes[u]
		if !ok {
			break
		}
		if _, cycle := active[u]; cycle {
			break
		}
		active[u] = struct{}{}
		if earliest < 0 || n.pos < earliest {
			earliest = n.pos
		}
		if n.parent == "" {
			break
		}
		u = n.parent
	}
	out := make([]bool, len(b.turns))
	for i := range b.turns {
		t := &b.turns[i]
		if t.promptPos < 0 || t.uuid == "" {
			continue
		}
		if _, on := active[t.uuid]; !on && t.promptPos > earliest {
			out[i] = true
		}
	}
	return out
}

// endState classifies how the file ends.
func (b *Builder) endState() model.EndState {
	if len(b.turns) == 0 {
		return model.EndUnknown
	}
	last := b.turns[len(b.turns)-1]
	if last.interrupted {
		return model.EndInterrupted
	}
	// A slash or shell command the model never answered (/model, /compact, !ls) was
	// handled by the harness itself: nothing is pending.
	if last.origin == model.OriginCommand && len(last.msgs) == 0 {
		return model.EndClean
	}
	switch b.tail {
	case tailAssistant:
		// The final line of an answer is often written before its stop_reason arrives
		// (it stays null in the file), so a last line that ends in text with no stop
		// reason is a finished answer too. A last line ending in a tool call or in
		// thinking is work in progress.
		if b.tailStop == "end_turn" || (b.tailStop == "" && b.tailText) {
			return model.EndClean
		}
		return model.EndMidTurn
	case tailPrompt, tailToolResult:
		return model.EndMidTurn
	}
	return model.EndUnknown
}
