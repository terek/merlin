package digest

import (
	"reflect"
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

func TestAgentTurnsFoldsCopiedContextAndContinuations(t *testing.T) {
	ts := func(m int) time.Time { return time.Date(2026, 9, 1, 10, m, 0, 0, time.UTC) }
	ip := func(i int) *int { return &i }
	turns := []model.Turn{
		// 0, 1: a fork's copy of its parent's conversation
		{Origin: model.OriginHuman, StartedAt: ts(0), EndedAt: ts(1), UserText: "parent prompt", ToolCalls: 1, ToolsByName: map[string]int64{"Read": 1}},
		{Origin: model.OriginContinuation, StartedAt: ts(1), EndedAt: ts(2)},
		// 2: its own task, continued once (3)
		{Origin: model.OriginHuman, StartedAt: ts(3), EndedAt: ts(4), UserText: "own task", ToolCalls: 2, ToolsByName: map[string]int64{"Bash": 2}},
		{Origin: model.OriginContinuation, StartedAt: ts(4), EndedAt: ts(5), FinalText: "first answer",
			Queued: []model.QueuedPrompt{{At: ts(4), Origin: model.OriginHuman, Text: "hurry"}}},
		// 4: a message sets it working again; interrupted
		{Origin: model.OriginPeer, StartedAt: ts(6), EndedAt: ts(7), FinalText: "second answer", Interrupted: true,
			Inbox: []model.InboxMessage{{At: ts(6), Kind: model.InboxMessageKind, From: "lead", Text: "also this"}}},
	}
	msgs := []model.Message{
		{ID: "m0", At: ts(0), Model: "x", USD: 1, Turn: ip(0)},
		{ID: "m1", At: ts(3), Model: "x", USD: 2, Turn: ip(2)},
		{ID: "m2", At: ts(4), Model: "x", USD: 4, Turn: ip(3)},
		{ID: "m3", At: ts(6), Model: "x", USD: 8, Turn: ip(4)},
		{ID: "m4", At: ts(6).Add(time.Second), Model: "free", USD: 0}, // no turn: by time
		{ID: "m5", At: ts(5), Model: "x", USD: 16, Turn: ip(9)},       // out of range: by time
	}
	got, msgTurn := agentTurns(turns, 2, "own task", false, msgs, []string{"free"})
	if !reflect.DeepEqual(msgTurn, []int{0, 0, 0, 1, 1, 0}) {
		t.Errorf("message turns = %v", msgTurn)
	}
	if len(got) != 2 {
		t.Fatalf("turns = %+v", got)
	}
	a, b := got[0], got[1]
	if a.Index != 0 || a.Origin != model.OriginSpawn || a.Prompt != "own task" || !a.StartedAt.Equal(ts(3)) ||
		!a.EndedAt.Equal(ts(5)) || a.FinalText != "first answer" || a.Interrupted || len(a.Queued) != 1 {
		t.Errorf("first turn = %+v", a)
	}
	if a.ToolCalls != 3 || a.ToolsByName["Read"] != 1 || a.ToolsByName["Bash"] != 2 {
		t.Errorf("first turn tools = %d %v (copied context's calls count)", a.ToolCalls, a.ToolsByName)
	}
	if a.AssistantMessages != 4 || a.Cost.USD != 23 {
		t.Errorf("first turn messages/usd = %d/%v", a.AssistantMessages, a.Cost.USD)
	}
	if b.Index != 1 || b.Origin != model.OriginPeer || b.Prompt != "" || len(b.Inbox) != 1 || b.Inbox[0].From != "lead" ||
		!b.Interrupted || b.FinalText != "second answer" || b.AssistantMessages != 2 || b.Cost.USD != 8 {
		t.Errorf("second turn = %+v", b)
	}
	if b.Cost.ByModel["free"].USD != 0 || len(b.Cost.ByModel) != 1 {
		t.Errorf("unpriced model must not be costed: %v", b.Cost.ByModel)
	}
}

func TestAgentTurnsWithoutPromptOrTurns(t *testing.T) {
	ts := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	// Only continuations: one turn of work covering the file.
	got, _ := agentTurns([]model.Turn{{Origin: model.OriginContinuation, StartedAt: ts, EndedAt: ts.Add(time.Minute)}},
		-1, "", false, nil, nil)
	if len(got) != 1 || got[0].Origin != model.OriginSpawn || !got[0].EndedAt.Equal(ts.Add(time.Minute)) {
		t.Errorf("continuations only = %+v", got)
	}
	// Messages but no turns: one turn spanning them.
	got, mt := agentTurns(nil, -1, "", false, []model.Message{{ID: "a", At: ts, USD: 1, Model: "x"}, {ID: "b", At: ts.Add(time.Hour), USD: 1, Model: "x"}}, nil)
	if len(got) != 1 || got[0].AssistantMessages != 2 || !got[0].EndedAt.Equal(ts.Add(time.Hour)) || !reflect.DeepEqual(mt, []int{0, 0}) {
		t.Errorf("no turns = %+v %v", got, mt)
	}
	if got, _ := agentTurns(nil, -1, "", false, nil, nil); got != nil {
		t.Errorf("nothing = %+v", got)
	}
}
