package digest

import "testing"

// stoppedWith returns an assistant line with the given stop_reason (nil = JSON null).
func stoppedWith(l L, stop any) L {
	l["message"].(L)["stop_reason"] = stop
	return l
}

func TestTruncatedMessageRule(t *testing.T) {
	a := stoppedWith(assistant("a1", "p1", 2, "m1", usage(10, 3), text("cut")), nil)
	// Two lines: the first has a null stop_reason, the last is complete. Only the last counts.
	b1 := stoppedWith(assistant("a2", "a1", 3, "m2", usage(10, 5), text("part")), nil)
	b2 := stoppedWith(assistant("a3", "a2", 4, "m2", usage(10, 50), text("whole")), "end_turn")
	// Another message whose last line is null after a complete-looking first line.
	c1 := stoppedWith(assistant("a4", "a3", 5, "m3", usage(10, 20), text("x")), "tool_use")
	c2 := stoppedWith(assistant("a5", "a4", 6, "m3", usage(10, 4), text("y")), nil)
	// A synthetic message costs nothing and is never counted.
	syn := stoppedWith(assistant("a6", "a5", 7, "m4", usage(0, 0), text("err")), nil)
	syn["message"].(L)["model"] = "<synthetic>"

	res := reduce(t, prompt("p1", "", 1, "go"), a, b1, b2, c1, c2, syn)
	got := map[string]bool{}
	for _, m := range res.Messages {
		got[m.ID] = m.Truncated
	}
	want := map[string]bool{"m1": true, "m2": false, "m3": true}
	if len(got) != len(want) {
		t.Fatalf("messages = %v, want %v", got, want)
	}
	for id, w := range want {
		if got[id] != w {
			t.Errorf("message %s truncated = %v, want %v", id, got[id], w)
		}
	}
	if res.Cost.TruncatedMessages != 2 || res.Turns[0].Cost.TruncatedMessages != 2 {
		t.Errorf("truncated count: file %d, turn %d, want 2 and 2", res.Cost.TruncatedMessages, res.Turns[0].Cost.TruncatedMessages)
	}
}
