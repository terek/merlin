package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A Pi session that starts a child Pi through bash (no --no-session): the child's own file is
// linked to it, and show prints the link on both sides. Text is invented.
func TestShowSpawnedPiSession(t *testing.T) {
	e := newReadEnv(t)
	pi := t.TempDir()
	ms := int64(1794132000000) // 2026-11-08T10:00:00Z
	line := func(s string, a ...any) string { return fmt.Sprintf(s, a...) }
	usage := `"usage":{"input":100,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":110,"cost":{"total":0.01}}`
	cmd := `pi -p --model z/flash \"Write hello.py\"`
	parent := []string{
		line(`{"type":"session","version":3,"id":"spawn-parent","timestamp":"2026-11-08T10:00:00.000Z","cwd":"/home/dev/proj"}`),
		line(`{"type":"message","id":"aaaa0001","parentId":null,"timestamp":"2026-11-08T10:00:01.000Z","message":{"role":"user","timestamp":%d,"content":[{"type":"text","text":"delegate"}]}}`, ms+1000),
		line(`{"type":"message","id":"aaaa0002","parentId":"aaaa0001","timestamp":"2026-11-08T10:00:02.000Z","message":{"role":"assistant","provider":"acme","model":"z/p","stopReason":"toolUse","timestamp":%d,"content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"%s"}}],%s}}`, ms+2000, cmd, usage),
		line(`{"type":"message","id":"aaaa0003","parentId":"aaaa0002","timestamp":"2026-11-08T10:00:05.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","isError":false,"timestamp":%d,"content":[{"type":"text","text":"done"}]}}`, ms+5000),
	}
	child := []string{
		line(`{"type":"session","version":3,"id":"spawn-child","timestamp":"2026-11-08T10:00:02.400Z","cwd":"/home/dev/proj"}`),
		line(`{"type":"message","id":"bbbb0001","parentId":null,"timestamp":"2026-11-08T10:00:02.500Z","message":{"role":"user","timestamp":%d,"content":[{"type":"text","text":"Write hello.py"}]}}`, ms+2500),
		line(`{"type":"message","id":"bbbb0002","parentId":"bbbb0001","timestamp":"2026-11-08T10:00:04.000Z","message":{"role":"assistant","provider":"acme","model":"z/flash","stopReason":"stop","timestamp":%d,"content":[{"type":"text","text":"done"}],%s}}`, ms+4000, usage),
	}
	for name, ls := range map[string][]string{"spawn-parent.jsonl": parent, "spawn-child.jsonl": child} {
		if err := os.WriteFile(filepath.Join(pi, name), []byte(strings.Join(ls, "\n")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	env := []string{"PI_CODING_AGENT_SESSION_DIR=" + pi}
	if out, errs, code := e.run(env, "scan", "--quiet"); code != 0 {
		t.Fatalf("scan: %d\n%s\n%s", code, out, errs)
	}
	out, errs, code := e.run(env, "show", "spawn-child")
	if code != 0 {
		t.Fatalf("show child: %d\n%s\n%s", code, out, errs)
	}
	if !strings.Contains(out, "spawned by ") || !strings.Contains(out, "in turn 0") {
		t.Errorf("child lacks the spawned-by line:\n%s", out)
	}
	out, errs, code = e.run(env, "show", "spawn-parent")
	if code != 0 {
		t.Fatalf("show parent: %d\n%s\n%s", code, out, errs)
	}
	if !strings.Contains(out, "→ spawned ") {
		t.Errorf("parent lacks the spawned child:\n%s", out)
	}
}
