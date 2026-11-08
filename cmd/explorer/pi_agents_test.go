package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A Pi session whose figures are the harness's own per-call costs, with one child recorded in
// the file and one run (bash, pi --no-session) that left no record. Text is invented.
func TestPiCostWordingAndUnrecordedAgents(t *testing.T) {
	e := newReadEnv(t)
	pi := t.TempDir()
	ms := int64(1794132000000)
	line := func(s string, a ...any) string { return fmt.Sprintf(s, a...) }
	asst := func(model string, cost float64, calls string) string {
		return line(`{"role":"assistant","provider":"acme","model":%q,"stopReason":"stop","timestamp":%d,"content":[{"type":"text","text":"ok"}%s],"usage":{"input":100,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":110,"cost":{"total":%g}}}`,
			model, ms+1000, calls, cost)
	}
	child := asst("z/child", 0.004, "")
	lines := []string{
		line(`{"type":"session","version":3,"id":"pi-agents-1","timestamp":"2026-11-08T10:00:00.000Z","cwd":"/home/dev/proj"}`),
		line(`{"type":"message","id":"aaaa0001","parentId":null,"timestamp":"2026-11-08T10:00:01.000Z","message":{"role":"user","timestamp":%d,"content":[{"type":"text","text":"delegate the docs"}]}}`, ms),
		line(`{"type":"message","id":"aaaa0002","parentId":"aaaa0001","timestamp":"2026-11-08T10:00:02.000Z","message":%s}`,
			asst("z/parent", 0.01, `,{"type":"toolCall","id":"c1","name":"subagent","arguments":{}},{"type":"toolCall","id":"c2","name":"bash","arguments":{"command":"pi -p --no-session --model z/flash \"write docs\""}}`)),
		line(`{"type":"message","id":"aaaa0003","parentId":"aaaa0002","timestamp":"2026-11-08T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"subagent","isError":false,"timestamp":%d,"content":[],"details":{"mode":"single","results":[{"agent":"scout","task":"look around","exitCode":0,"messages":[%s]}]}}}`, ms+2000, child),
		line(`{"type":"message","id":"aaaa0004","parentId":"aaaa0003","timestamp":"2026-11-08T10:00:04.000Z","message":{"role":"toolResult","toolCallId":"c2","toolName":"bash","isError":false,"timestamp":%d,"content":[{"type":"text","text":"done"}]}}`, ms+3000),
	}
	if err := os.WriteFile(filepath.Join(pi, "pi-agents-1.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	env := []string{"PI_CODING_AGENT_SESSION_DIR=" + pi}
	if out, errs, code := e.run(env, "scan", "--quiet"); code != 0 {
		t.Fatalf("scan: %d\n%s\n%s", code, out, errs)
	}
	out, errs, code := e.run(env, "show", "pi-agents-1")
	if code != 0 {
		t.Fatalf("show: %d\n%s\n%s", code, out, errs)
	}
	for _, want := range []string{
		"recorded", "Pi's own per-call figure",
		"plus 1 agent run with no record of its spend",
		"not recorded", // the bash-spawned child's cost in the agents table
	} {
		if !strings.Contains(out, want) {
			t.Errorf("show lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "attributed from tokens") {
		t.Errorf("show says an agent that billed nothing the files show is attributed from tokens:\n%s", out)
	}
	if strings.Contains(out, "recomputed from tokens, messages this session owns") {
		t.Errorf("show still says the figure is recomputed:\n%s", out)
	}
	cost, errs, code := e.run(env, "cost", "--by", "session", "--limit", "50")
	if code != 0 {
		t.Fatalf("cost: %d\n%s", code, errs)
	}
	if !strings.Contains(cost, "is the harness's own per-call figure") {
		t.Errorf("cost lacks the per-call wording:\n%s", cost)
	}
}
