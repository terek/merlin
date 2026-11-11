package pi

import "testing"

func TestTextLines(t *testing.T) {
	for in, want := range map[string]int64{"": 0, "a": 1, "a\n": 1, "a\nb": 2, "a\nb\n": 2, "\n": 1, "a\n\n": 2} {
		if got := textLines(in); got != want {
			t.Errorf("textLines(%q) = %d, want %d", in, got, want)
		}
	}
}

// A successful write adds its content's lines; an errored one adds nothing; an edit still
// counts its diff.
func TestWriteLines(t *testing.T) {
	dir := t.TempDir()
	f := newFile(t, "w1", "/home/dev/acme", nil)
	f.entry("model_change", "r1", "", 1, map[string]any{"provider": "acme", "modelId": "m"})
	f.user("u1", "r1", 2, "Write files.")
	f.asst("a1", "u1", 3, "m", "Writing.", "toolUse", use(100, 20, 0, 0, 0.1),
		call("w1", "write", map[string]any{"path": "a.txt", "content": "1\n2\n3\n"}),
		call("w2", "write", map[string]any{"path": "b.txt", "content": "1\n2"}),
		call("w3", "write", map[string]any{"path": "c.txt", "content": "x\ny\nz\n"}),
		call("w4", "write", map[string]any{"path": "d.txt", "content": ""}),
		call("e1", "edit", map[string]any{"path": "a.txt"}))
	f.result("t1", "a1", 4, "w1", "write", false, "ok", nil)
	f.result("t2", "t1", 5, "w2", "write", false, "ok", nil)
	f.result("t3", "t2", 6, "w3", "write", true, "denied", nil)
	f.result("t4", "t3", 7, "w4", "write", false, "ok", nil)
	f.result("t5", "t4", 8, "e1", "edit", false, "ok", map[string]any{"diff": "+1 a\n-1 b\n"})
	f.asst("a2", "t5", 9, "m", "Done.", "stop", use(10, 10, 0, 0, 0))
	f.write(dir, "--home-dev-acme--/2026-10-01T09-00-00-000Z_w1.jsonl")
	d := build(t, dir, "w1")
	if d.Stats.LinesAdded != 3+2+1 || d.Stats.LinesRemoved != 1 {
		t.Errorf("lines +%d -%d, want +6 -1", d.Stats.LinesAdded, d.Stats.LinesRemoved)
	}
}

// A child's writes count like the parent's.
func TestSubagentWriteLines(t *testing.T) {
	dir := t.TempDir()
	child := []any{
		cUser(3, "write it"),
		cAsst(4, "z/child", "writing", 0.003, call("k1", "write", map[string]any{"path": "x", "content": "a\nb\nc\n"}), call("k2", "write", map[string]any{"path": "y", "content": "q\n"})),
		cResult(5, "k1", "write", nil),
		map[string]any{"role": "toolResult", "toolCallId": "k2", "toolName": "write", "isError": true,
			"content": []any{map[string]any{"type": "text", "text": "no"}}, "timestamp": ms(6)},
		cAsst(8, "z/child", "child done", 0.002),
	}
	parentSession(t, "s", nil, "subagent", aDetails("single",
		aRes("scout", "Write x", "acme/z/child", child, map[string]any{"usage": aUsage(0.005)}))).write(dir, "s.jsonl")
	d := build(t, dir, "s")
	if d.Stats.LinesAdded != 3 {
		t.Errorf("lines added %d, want 3", d.Stats.LinesAdded)
	}
}
