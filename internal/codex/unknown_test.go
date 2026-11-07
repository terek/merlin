package codex

import "testing"

// Unknown item types, user content parts and file change kinds are counted, not dropped.
func TestUnknownItemKindsAreCounted(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "vscode", nil).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).
		event(2, map[string]any{"type": "item_completed", "item": map[string]any{"type": "BrandNewItem"}}).
		event(3, map[string]any{"type": "item_completed", "item": map[string]any{"type": "BrandNewItem"}}).
		event(4, map[string]any{"type": "item_completed", "item": map[string]any{"type": "McpToolCall"}}).
		event(5, map[string]any{"type": "item_completed", "item": map[string]any{"type": "UserMessage", "content": []any{
			map[string]any{"type": "text", "text": "Hi."}, map[string]any{"type": "skill", "name": "x"}}}}).
		event(6, map[string]any{"type": "item_completed", "item": map[string]any{"type": "FileChange", "status": "completed", "changes": map[string]any{
			"/w/a.go": map[string]any{"type": "rename", "unified_diff": "@@ -1 +1 @@\n-a\n+b\n"},
			"/w/b.go": map[string]any{"type": "update", "unified_diff": "@@ -1 +1 @@\n-a\n+b\n"},
		}}}).
		done(7, "r1").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
	d := build(t, home, "R")
	want := map[string]int64{
		"item_completed/BrandNewItem":      2,
		"item_completed/UserMessage/skill": 1,
		"item_completed/FileChange/rename": 1,
	}
	got := d.Diagnostics.UnknownTypes
	if len(got) != len(want) {
		t.Errorf("unknown = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("unknown[%q] = %d, want %d (all: %v)", k, got[k], v, got)
		}
	}
}

// A fork whose parent or history base is not on disk says so in its diagnostics.
func TestForkWithMissingParentIsCounted(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("F", "F", "vscode", map[string]any{"forked_from_id": "gone",
		"history_base": map[string]any{"thread_id": "gone", "end_byte_offset": 100, "end_ordinal_exclusive": 3}}).
		start(10, "f1", "", "user").ctx(10, "f1", "m", nil).user(10, "Hi.", 0).done(12, "f1").
		write(home, "rollout-2026-10-01T09-00-10-F.jsonl")
	// A model fork (forked_from_id only) with its parent present is not counted.
	newRollout(t).meta("P", "P", "vscode", nil).start(1, "p1", "", "user").done(2, "p1").
		write(home, "rollout-2026-10-01T09-00-00-P.jsonl")
	newRollout(t).meta("G", "G", "vscode", map[string]any{"forked_from_id": "P"}).start(1, "g1", "", "user").done(2, "g1").
		write(home, "rollout-2026-10-01T09-00-20-G.jsonl")

	d := build(t, home, "F")
	u := d.Diagnostics.UnknownTypes
	if u["fork/parent_missing"] != 1 || u["fork/history_base_missing"] != 1 || len(u) != 2 {
		t.Errorf("unknown = %v", u)
	}
	if g := build(t, home, "G"); len(g.Diagnostics.UnknownTypes) != 0 {
		t.Errorf("a fork whose parent exists must not be counted: %v", g.Diagnostics.UnknownTypes)
	}
}

// A subagent source of a kind the parser does not know is counted.
func TestUnknownThreadSourceIsCounted(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "vscode", nil).start(1, "r1", "", "user").done(2, "r1").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
	newRollout(t).meta("X", "R", map[string]any{"subagent": map[string]any{"other": "brand_new_kind"}}, nil).
		start(3, "x1", "", "user").done(4, "x1").
		write(home, "rollout-2026-10-01T09-00-05-X.jsonl")
	d := build(t, home, "R")
	if d.Diagnostics.UnknownTypes["session_meta/source/other"] != 1 {
		t.Errorf("unknown = %v", d.Diagnostics.UnknownTypes)
	}
}

func tokenCount(last, total int) map[string]any {
	u := func(n int) map[string]any {
		return map[string]any{"input_tokens": n, "cached_input_tokens": n / 2, "output_tokens": 10, "reasoning_output_tokens": 4, "total_tokens": n + 10}
	}
	return map[string]any{"type": "token_count", "info": map[string]any{
		"last_token_usage": u(last), "total_token_usage": u(total), "model_context_window": 1000}}
}

// Codex before token_usage_record (0.116, 0.137) writes prompts, final answers and usage as
// event_msg user_message, agent_message and token_count only.
func TestOldEventForms(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "exec", map[string]any{"cli_version": "0.116.0"}).
		start(1, "r1", "", "").ctx(1, "r1", "m", nil).
		event(2, map[string]any{"type": "user_message", "message": "Hello.", "images": []any{}, "local_images": []any{"/x.png"}}).
		event(2, map[string]any{"type": "token_count", "info": nil}).
		event(3, tokenCount(100, 100)).
		event(4, tokenCount(100, 100)). // repeated: nothing billed in between
		event(5, map[string]any{"type": "agent_message", "message": "Working.", "phase": "commentary"}).
		event(6, tokenCount(50, 150)).
		event(7, map[string]any{"type": "agent_message", "message": "All done.", "phase": "final_answer"}).
		done(8, "r1").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
	d := build(t, home, "R")
	if len(d.Turns) != 1 || d.Turns[0].UserText != "Hello." || d.Turns[0].FinalText != "All done." {
		t.Errorf("turns = %+v", d.Turns)
	}
	if len(d.Messages) != 2 || d.Messages[0].ID == d.Messages[1].ID {
		t.Fatalf("messages = %+v", d.Messages)
	}
	// Per call: 100 in (50 cached), 10 out; then 50 in (25 cached), 10 out.
	in := d.Messages[0].Tokens.Input + d.Messages[1].Tokens.Input
	cr := d.Messages[0].Tokens.CacheRead + d.Messages[1].Tokens.CacheRead
	out := d.Messages[0].Tokens.Output + d.Messages[1].Tokens.Output
	if in != 75 || cr != 75 || out != 20 {
		t.Errorf("tokens in %d cacheRead %d out %d", in, cr, out)
	}
	if len(d.Diagnostics.UnknownTypes) != 0 {
		t.Errorf("unknown = %v", d.Diagnostics.UnknownTypes)
	}
	// With token_usage_record present, token_count is not billed again.
	home2 := t.TempDir()
	newRollout(t).meta("R", "R", "vscode", nil).start(1, "r1", "", "user").ctx(1, "r1", "m", nil).
		usage(2, "resp-1", "r1", 100, 0, 10).event(3, tokenCount(100, 100)).done(4, "r1").
		write(home2, "rollout-2026-10-01T09-00-00-R.jsonl")
	if d := build(t, home2, "R"); len(d.Messages) != 1 || d.Messages[0].ID != "resp-1" {
		t.Errorf("messages = %+v", d.Messages)
	}
}
