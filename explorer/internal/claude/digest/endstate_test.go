package digest

import (
	"testing"

	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/pricing"
)

func withStop(l L, stop string) L {
	l["message"].(L)["stop_reason"] = stop
	return l
}

func endStateOf(t *testing.T, lines ...L) model.EndState {
	t.Helper()
	b := NewBuilder(pricing.Default())
	for _, r := range decode(t, lines...) {
		b.Apply(r)
	}
	return b.Result().EndState
}

func TestEndStateFixtures(t *testing.T) {
	for id, want := range map[string]model.EndState{
		"01010101-0000-4000-8000-000000000001": model.EndClean, // plain
		"04040404-0000-4000-8000-000000000001": model.EndClean, // interruptions all answered afterwards
		"06060606-0000-4000-8000-000000000001": model.EndClean,
	} {
		if got := build(t, id).EndState; got != want {
			t.Errorf("%s: endState = %q, want %q", id, got, want)
		}
	}
}

func TestEndStateSynthetic(t *testing.T) {
	p1 := prompt("u1", "", 1, "go")
	a1 := withStop(assistant("a1", "u1", 2, "m1", usage(1, 1), text("done")), "end_turn")
	if got := endStateOf(t, p1, a1); got != model.EndClean {
		t.Errorf("answered = %q", got)
	}
	// Cut after a tool_use, after a tool_result and after a prompt: mid-turn.
	use := withStop(assistant("a1", "u1", 2, "m1", usage(1, 1), tool("t1", "Bash", L{})), "tool_use")
	if got := endStateOf(t, p1, use); got != model.EndMidTurn {
		t.Errorf("after tool_use = %q", got)
	}
	if got := endStateOf(t, p1, use, toolResult("r1", "a1", 3, "t1")); got != model.EndMidTurn {
		t.Errorf("after tool_result = %q", got)
	}
	if got := endStateOf(t, p1); got != model.EndMidTurn {
		t.Errorf("after prompt = %q", got)
	}
	// A final text line whose stop reason was never written is a finished answer: real
	// files often end this way (150 of 498 real agent files do).
	if got := endStateOf(t, p1, assistant("a1", "u1", 2, "m1", usage(1, 1), text("all done"))); got != model.EndClean {
		t.Errorf("text without stop reason = %q", got)
	}
	// A tool call without a stop reason is still work in progress.
	if got := endStateOf(t, p1, assistant("a1", "u1", 2, "m1", usage(1, 1), tool("t1", "Bash", L{}))); got != model.EndMidTurn {
		t.Errorf("tool_use without stop reason = %q", got)
	}
	// Interrupted last turn.
	intr := prompt("u2", "a1", 4, "[Request interrupted by user]")
	if got := endStateOf(t, p1, a1, intr); got != model.EndInterrupted {
		t.Errorf("interrupted = %q", got)
	}
	if got := endStateOf(t); got != model.EndUnknown {
		t.Errorf("empty = %q", got)
	}
}
