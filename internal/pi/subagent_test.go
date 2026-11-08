package pi

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
)

// ---- builders for the shapes of docs/pi-format.md, Subagents (all text invented) ------------------

// cAsst is an assistant message of a child, in the shape of the parent's own.
func cAsst(sec int, mdl, text string, cost float64, calls ...map[string]any) map[string]any {
	content := []any{}
	if text != "" {
		content = append(content, map[string]any{"type": "text", "text": text})
	}
	for _, c := range calls {
		content = append(content, map[string]any{"type": "toolCall", "id": c["id"], "name": c["name"], "arguments": c["args"]})
	}
	return map[string]any{"role": "assistant", "content": content, "provider": "acme", "model": mdl,
		"stopReason": "stop", "usage": use(100, 10, 0, 0, cost), "timestamp": ms(sec), "responseId": fmt.Sprintf("resp-%d", sec)}
}

func cUser(sec int, text string) map[string]any {
	return map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": text}}, "timestamp": ms(sec)}
}

func cResult(sec int, callID, tool string, details map[string]any) map[string]any {
	return map[string]any{"role": "toolResult", "toolCallId": callID, "toolName": tool, "isError": false,
		"content": []any{map[string]any{"type": "text", "text": "ok"}}, "details": details, "timestamp": ms(sec)}
}

// aRes is one element of details.results of the example extension.
func aRes(agent, task, mdl string, msgs []any, extra map[string]any) map[string]any {
	r := map[string]any{"agent": agent, "agentSource": "user", "task": task, "exitCode": 0, "stderr": "", "model": mdl}
	if msgs != nil {
		r["messages"] = msgs
	}
	for k, v := range extra {
		r[k] = v
	}
	return r
}

func aUsage(cost float64) map[string]any {
	return map[string]any{"input": 300, "output": 30, "cacheRead": 0, "cacheWrite": 0, "cost": cost, "contextTokens": 0, "turns": 2}
}

func aDetails(mode string, results ...map[string]any) map[string]any {
	rs := []any{}
	for _, r := range results {
		rs = append(rs, r)
	}
	return map[string]any{"mode": mode, "agentScope": "user", "results": rs}
}

// parentSession writes a parent session: a prompt, an assistant message ($0.01) that calls tool
// "subagent" as c1, its result with the given details, and a closing message ($0.002).
func parentSession(t *testing.T, id string, extra map[string]any, tool string, details map[string]any) *file {
	f := newFile(t, id, "/home/dev/proj", extra)
	f.user("u0000001", "", 1, "split the work")
	f.asst("a0000001", "u0000001", 2, "z/parent", "on it", "toolUse", use(100, 10, 0, 0, 0.01),
		call("c1", tool, map[string]any{"agent": "scout", "task": "look"}))
	f.result("r0000001", "a0000001", 10, "c1", tool, false, "done", details)
	f.asst("a0000002", "r0000001", 12, "z/parent", "all done", "stop", use(100, 10, 0, 0, 0.002))
	return f
}

func agentByID(t *testing.T, d *model.SessionDigest, id string) *model.Agent {
	t.Helper()
	for i := range d.Agents {
		if d.Agents[i].ID == id {
			return &d.Agents[i]
		}
	}
	t.Fatalf("no agent %q among %d", id, len(d.Agents))
	return nil
}

func messagesOf(d *model.SessionDigest, agent string) []model.Message {
	var out []model.Message
	for _, m := range d.Messages {
		if m.AgentID == agent {
			out = append(out, m)
		}
	}
	return out
}

// childOf is a child with a user prompt, two assistant messages and an edit.
func childOf(m1, m2 string, c1, c2 float64) []any {
	return []any{
		cUser(3, "look at hello.py"),
		cAsst(4, m1, "reading", c1, call("k1", "read", map[string]any{"path": "hello.py"}), call("k2", "edit", map[string]any{"path": "hello.py"})),
		cResult(5, "k2", "edit", map[string]any{"diff": "+1 a\n+2 b\n-3 c\n 4 d"}),
		cAsst(8, m2, "child done", c2),
	}
}

// parentWriteSingle writes the standard session with one child and returns its digest.
func buildSingle(t *testing.T) *model.SessionDigest {
	dir := t.TempDir()
	parentSession(t, "s", nil, "subagent", aDetails("single",
		aRes("scout", "Add a docstring to hello.py", "acme/z/child", childOf("z/child", "z/child", 0.003, 0.002),
			map[string]any{"usage": aUsage(0.005)}))).write(dir, "s.jsonl")
	return build(t, dir, "s")
}

func TestSubagentSingle(t *testing.T) {
	d := buildSingle(t)
	if len(d.Agents) != 1 {
		t.Fatalf("agents %+v", d.Agents)
	}
	a := d.Agents[0]
	if a.ID != "c1.0" || a.Kind != model.AgentSubagent || a.Linkage != model.LinkToolResult || a.SpawnToolUseID != "c1" ||
		a.ParentAgentID != nil || a.Depth != 1 || a.SpawnTurn == nil || *a.SpawnTurn != 0 {
		t.Errorf("agent %+v", a)
	}
	if a.AgentType != "scout" || a.Prompt != "Add a docstring to hello.py" || a.Model != "z/child" || a.FinalText != "child done" ||
		a.Status != model.StatusCompleted || a.Unrecorded {
		t.Errorf("agent fields %+v", a)
	}
	if !a.StartedAt.Equal(t0.Add(3*time.Second)) || !a.EndedAt.Equal(t0.Add(8*time.Second)) {
		t.Errorf("times %v %v", a.StartedAt, a.EndedAt)
	}
	if a.AssistantMessages != 2 || a.ToolCalls != 2 || a.ToolsByName["read"] != 1 || a.ToolsByName["edit"] != 1 {
		t.Errorf("counts %+v", a)
	}
	if len(a.Turns) != 1 || a.Turns[0].Origin != model.OriginSpawn || a.Turns[0].Prompt != a.Prompt || a.Turns[0].RootTurn == nil ||
		*a.Turns[0].RootTurn != 0 || a.Turns[0].AssistantMessages != 2 || !near(a.Turns[0].Cost.USD, 0.005) {
		t.Errorf("agent turn %+v", a.Turns)
	}
	if !near(a.Cost.USD, 0.005) || !near(a.SubtreeUSD, 0.005) {
		t.Errorf("agent cost %+v subtree %v", a.Cost, a.SubtreeUSD)
	}
	// priced like the parent's own: Pi's figure, flagged Recorded
	msgs := messagesOf(d, "c1.0")
	if len(msgs) != 2 {
		t.Fatalf("child messages %+v", msgs)
	}
	base := fmt.Sprintf("r0000001.%d.sub.0.", ms(10))
	if msgs[0].ID != base+"1" || msgs[1].ID != base+"3" || !msgs[0].Recorded || msgs[0].Model != "z/child" ||
		msgs[0].AgentTurn == nil || *msgs[0].AgentTurn != 0 || msgs[0].Turn == nil || *msgs[0].Turn != 0 {
		t.Errorf("child messages %+v", msgs)
	}
	// totals
	if !near(d.Cost.USD, 0.017) || d.Cost.ByModel["z/child"].USD < 0.0049 || d.Cost.ByModel["z/parent"].Tokens.Input != 200 {
		t.Errorf("session cost %+v", d.Cost)
	}
	tr := d.Turns[0]
	if !near(tr.Cost.USD, 0.012) || !near(tr.CostWithAgents, 0.017) || len(tr.Spawned) != 1 || tr.Spawned[0] != "c1.0" {
		t.Errorf("turn %+v", tr)
	}
	// the agent's tool calls count in the session's too (as Codex counts its agents'), and its edit's lines
	if d.Stats.ToolCalls != 3 || d.Stats.ToolsByName["subagent"] != 1 || d.Stats.ToolsByName["read"] != 1 ||
		d.Stats.AssistantMessages != 4 || d.Stats.LinesAdded != 2 || d.Stats.LinesRemoved != 1 {
		t.Errorf("stats %+v", d.Stats)
	}
	if d.Cost.UnrecordedAgents != 0 {
		t.Errorf("unrecorded %d", d.Cost.UnrecordedAgents)
	}
}

func TestSubagentParallelTwoModels(t *testing.T) {
	dir := t.TempDir()
	parentSession(t, "s", nil, "subagent", aDetails("parallel",
		aRes("scout", "task one", "acme/z/child-a", childOf("z/child-a", "z/child-a", 0.001, 0.001), nil),
		aRes("worker", "task two", "acme/m", childOf("m", "m", 0, 0), nil))).write(dir, "s.jsonl")
	d := build(t, dir, "s")
	if len(d.Agents) != 2 {
		t.Fatalf("agents %+v", d.Agents)
	}
	a, b := agentByID(t, d, "c1.0"), agentByID(t, d, "c1.1")
	if a.Model != "z/child-a" || b.Model != "m" || a.AgentType != "scout" || b.AgentType != "worker" {
		t.Errorf("agents %+v %+v", a, b)
	}
	// the second child's messages carry no cost: the price table prices them, flagged not Recorded
	for _, m := range messagesOf(d, "c1.1") {
		if m.Recorded || m.Unpriced || m.USD <= 0 {
			t.Errorf("table-priced message %+v", m)
		}
	}
	if !near(a.Cost.USD, 0.002) || d.Cost.ByModel["z/child-a"].USD < 0.0019 || d.Cost.ByModel["m"].USD <= 0 {
		t.Errorf("by model %+v", d.Cost.ByModel)
	}
	want := 0.012 + a.Cost.USD + b.Cost.USD
	if !near(d.Cost.USD, want) || !near(d.Turns[0].CostWithAgents, want) || len(d.Turns[0].Spawned) != 2 {
		t.Errorf("cost %v turn %+v want %v", d.Cost.USD, d.Turns[0], want)
	}
	// ids of messages of the two results differ
	if messagesOf(d, "c1.0")[0].ID == messagesOf(d, "c1.1")[0].ID {
		t.Error("message ids collide")
	}
}

func TestSubagentChain(t *testing.T) {
	dir := t.TempDir()
	parentSession(t, "s", nil, "subagent", aDetails("chain",
		aRes("scout", "step one", "acme/z/child", childOf("z/child", "z/child", 0.001, 0.001), map[string]any{"step": 1}),
		aRes("worker", "step two: use {previous}", "acme/z/child", childOf("z/child", "z/child", 0.002, 0.002), map[string]any{"step": 2}))).write(dir, "s.jsonl")
	d := build(t, dir, "s")
	if len(d.Agents) != 2 || d.Agents[0].ID != "c1.0" || d.Agents[1].ID != "c1.1" || d.Agents[1].Prompt != "step two: use {previous}" {
		t.Fatalf("agents %+v", d.Agents)
	}
	if !near(d.Cost.USD, 0.012+0.002+0.004) || !near(d.Turns[0].CostWithAgents, 0.018) {
		t.Errorf("cost %v %v", d.Cost.USD, d.Turns[0].CostWithAgents)
	}
}

func TestSubagentNested(t *testing.T) {
	dir := t.TempDir()
	inner := aDetails("single", aRes("inner", "inner task", "acme/z/leaf", []any{cUser(5, "go"), cAsst(6, "z/leaf", "leaf done", 0.0007)}, nil))
	outer := []any{
		cUser(3, "outer task"),
		cAsst(4, "z/child", "delegating", 0.003, call("n1", "subagent", map[string]any{"agent": "inner"})),
		cResult(7, "n1", "subagent", inner),
		cAsst(8, "z/child", "child done", 0.002),
	}
	parentSession(t, "s", nil, "subagent", aDetails("single", aRes("outer", "outer task", "acme/z/child", outer, nil))).write(dir, "s.jsonl")
	d := build(t, dir, "s")
	if len(d.Agents) != 2 {
		t.Fatalf("agents %+v", d.Agents)
	}
	o, in := agentByID(t, d, "c1.0"), agentByID(t, d, "c1.0/n1.0")
	if in.ParentAgentID == nil || *in.ParentAgentID != "c1.0" || in.Depth != 2 || o.Depth != 1 || o.ParentAgentID != nil ||
		in.SpawnToolUseID != "n1" || in.SpawnTurn == nil || *in.SpawnTurn != 0 || in.Model != "z/leaf" {
		t.Errorf("nesting %+v / %+v", o, in)
	}
	if !near(o.Cost.USD, 0.005) || !near(in.Cost.USD, 0.0007) || !near(o.SubtreeUSD, 0.0057) {
		t.Errorf("costs %v %v %v", o.Cost.USD, in.Cost.USD, o.SubtreeUSD)
	}
	m := messagesOf(d, "c1.0/n1.0")
	if len(m) != 1 || m[0].ID != fmt.Sprintf("r0000001.%d.sub.0.2.sub.0.1", ms(10)) {
		t.Errorf("nested message %+v", m)
	}
	// only the main agent's spawns are listed on the turn; the subtree is in CostWithAgents
	tr := d.Turns[0]
	if len(tr.Spawned) != 1 || tr.Spawned[0] != "c1.0" || !near(tr.CostWithAgents, 0.012+0.0057) || !near(d.Cost.USD, 0.0177) {
		t.Errorf("turn %+v session %v", tr, d.Cost.USD)
	}
}

func TestSubagentUsageOnly(t *testing.T) {
	dir := t.TempDir()
	parentSession(t, "s", nil, "delegate", aDetails("single", aRes("scout", "count lines", "acme/z/child", nil, map[string]any{"usage": aUsage(0.004)}))).write(dir, "s.jsonl")
	d := build(t, dir, "s")
	a := agentByID(t, d, "c1.0")
	ms := messagesOf(d, "c1.0")
	if a.Unrecorded || len(ms) != 1 || !ms[0].Recorded || !near(ms[0].USD, 0.004) || ms[0].Model != "z/child" ||
		ms[0].Input != 300 || ms[0].Output != 30 || a.Prompt != "count lines" {
		t.Errorf("agent %+v messages %+v", a, ms)
	}
	if !near(d.Cost.USD, 0.016) || d.Cost.ByModel["z/child"].Tokens.Input != 300 || d.Cost.UnrecordedAgents != 0 || !near(d.Turns[0].CostWithAgents, 0.016) {
		t.Errorf("cost %+v turn %+v", d.Cost, d.Turns[0])
	}
}

func TestSubagentNeitherIsUnrecorded(t *testing.T) {
	dir := t.TempDir()
	// the second result has neither messages nor usage; the first makes the shape recognisable
	parentSession(t, "s", nil, "subagent", aDetails("parallel",
		aRes("scout", "one", "acme/z/child", childOf("z/child", "z/child", 0.001, 0.001), nil),
		aRes("worker", "two", "acme/z/other", nil, map[string]any{"exitCode": 1}))).write(dir, "s.jsonl")
	d := build(t, dir, "s")
	u := agentByID(t, d, "c1.1")
	if !u.Unrecorded || u.Cost.UnrecordedAgents != 1 || len(messagesOf(d, "c1.1")) != 0 || u.Model != "other" && u.Model != "z/other" || u.Prompt != "two" || u.Cost.USD != 0 {
		t.Errorf("unrecorded agent %+v", u)
	}
	if agentByID(t, d, "c1.0").Unrecorded {
		t.Error("recorded child flagged")
	}
	if d.Cost.UnrecordedAgents != 1 || d.Turns[0].Cost.UnrecordedAgents != 1 || !near(d.Cost.USD, 0.014) {
		t.Errorf("cost %+v turn %+v", d.Cost, d.Turns[0].Cost)
	}
}

func TestSubagentMalformedCallIsNoAgent(t *testing.T) {
	dir := t.TempDir()
	parentSession(t, "s", nil, "subagent", aDetails("single")).write(dir, "s.jsonl")
	d := build(t, dir, "s")
	if len(d.Agents) != 0 || len(d.Turns[0].Spawned) != 0 || d.Cost.UnrecordedAgents != 0 || !near(d.Cost.USD, 0.012) {
		t.Errorf("agents %+v cost %+v", d.Agents, d.Cost)
	}
	// results that are not agent runs at all (no messages, no usage anywhere)
	parentSession(t, "s2", nil, "search", map[string]any{"results": []any{map[string]any{"title": "x", "url": "y"}}}).write(dir, "s2.jsonl")
	if d := build(t, dir, "s2"); len(d.Agents) != 0 {
		t.Errorf("search results read as agents: %+v", d.Agents)
	}
}

// ---- bash calls that start pi ----------------------------------------------------------------

func TestPiSpawnDetection(t *testing.T) {
	cases := []struct {
		cmd   string
		n     int
		model string
	}{
		{`pi -p --no-session --model z/flash "Add a docstring to hello.py"`, 1, "z/flash"},
		{`cd x && pi -p --no-session "go"`, 1, ""},
		{`FOO=1 BAR="a b" /usr/local/bin/pi --no-session --model=acme/m -p hi`, 1, "acme/m"},
		{`./node_modules/.bin/pi --no-session -p hi | tee out.txt`, 1, ""},
		{"echo start; pi --no-session -p 'a; b'\npi --no-session -p two", 2, ""},
		{`pi -p "plan the work"`, 0, ""},
		{`echo pi --no-session`, 0, ""},
		{`pip install x --no-session`, 0, ""},
		{`grep pi file --no-session`, 0, ""},
		{`cat notes.txt # pi --no-session`, 0, ""},
		{`echo "pi --no-session" && ls`, 0, ""},
		{`python pi.py --no-session`, 0, ""},
		{`spi --no-session -p x`, 0, ""},
	}
	for _, c := range cases {
		got := piSpawns(c.cmd)
		if len(got) != c.n || (c.n == 1 && got[0].model != c.model) {
			t.Errorf("%q: %+v, want %d spawns model %q", c.cmd, got, c.n, c.model)
		}
	}
}

func bashSession(t *testing.T, dir, id, command string) *model.SessionDigest {
	f := newFile(t, id, "/home/dev/proj", nil)
	f.user("u0000001", "", 1, "delegate it")
	f.asst("a0000001", "u0000001", 2, "z/parent", "running", "toolUse", use(100, 10, 0, 0, 0.01),
		call("b1", "bash", map[string]any{"command": command, "timeout": 300}))
	f.result("r0000001", "a0000001", 20, "b1", "bash", false, "output", nil)
	f.asst("a0000002", "r0000001", 22, "z/parent", "done", "stop", use(100, 10, 0, 0, 0.002))
	f.write(dir, id+".jsonl")
	return build(t, dir, id)
}

func TestBashSpawnNoSessionIsUnrecorded(t *testing.T) {
	dir := t.TempDir()
	cmd := `pi -p --no-session --model z-ai/glm-5.3-flash "Add a docstring to hello.py"`
	d := bashSession(t, dir, "s", cmd)
	if len(d.Agents) != 1 {
		t.Fatalf("agents %+v", d.Agents)
	}
	a := d.Agents[0]
	if a.ID != "b1" || !a.Unrecorded || a.AgentType != "pi" || a.Prompt != cmd || a.Model != "z-ai/glm-5.3-flash" ||
		a.Kind != model.AgentSubagent || a.Linkage != model.LinkToolResult || a.SpawnToolUseID != "b1" ||
		a.SpawnTurn == nil || *a.SpawnTurn != 0 || a.ParentAgentID != nil || a.Status != model.StatusCompleted ||
		a.Cost.UnrecordedAgents != 1 || a.Cost.USD != 0 {
		t.Errorf("agent %+v", a)
	}
	if !a.StartedAt.Equal(t0.Add(2*time.Second)) || !a.EndedAt.Equal(t0.Add(20*time.Second)) {
		t.Errorf("times %v %v", a.StartedAt, a.EndedAt)
	}
	if d.Cost.UnrecordedAgents != 1 || d.Turns[0].Cost.UnrecordedAgents != 1 || !near(d.Cost.USD, 0.012) ||
		len(d.Turns[0].Spawned) != 1 || !near(d.Turns[0].CostWithAgents, 0.012) {
		t.Errorf("cost %+v turn %+v", d.Cost, d.Turns[0])
	}
	// the bash call itself stays one tool call, and the child adds none
	if d.Stats.ToolCalls != 1 {
		t.Errorf("tool calls %d", d.Stats.ToolCalls)
	}
}

func TestBashSpawnVariants(t *testing.T) {
	dir := t.TempDir()
	if d := bashSession(t, dir, "x1", `cd work && pi -p --no-session "rename it"`); len(d.Agents) != 1 || d.Agents[0].Model != "" {
		t.Errorf("cd && pi: %+v", d.Agents)
	}
	for i, cmd := range []string{`pi -p "this one writes its own session file"`, `echo pi --no-session`, `pip install x`, `grep pi file`} {
		if d := bashSession(t, dir, fmt.Sprintf("n%d", i), cmd); len(d.Agents) != 0 || d.Cost.UnrecordedAgents != 0 {
			t.Errorf("%q made agents %+v", cmd, d.Agents)
		}
	}
}

// ---- pi-dial's Task and oracle -------------------------------------------------------------------

func TestPiDialRunIsUnrecorded(t *testing.T) {
	dir := t.TempDir()
	details := map[string]any{"kind": "oracle", "mode": "single", "model": "acme/z/big", "description": "Review the plan",
		"run": map[string]any{"kind": "oracle", "mode": "single", "model": "acme/z/big", "ok": false, "exitCode": 1, "aborted": false,
			"timedOut": true, "durationMs": 1200, "stopReason": "error", "text": "partial answer", "thinking": "", "stderr": "",
			"artifacts": map[string]any{"dir": "/nowhere/run", "sessionPath": "/nowhere/run/session.jsonl"}}}
	parentSession(t, "s", nil, "oracle", details).write(dir, "s.jsonl")
	d := build(t, dir, "s")
	if len(d.Agents) != 1 {
		t.Fatalf("agents %+v", d.Agents)
	}
	a := d.Agents[0]
	if a.ID != "c1" || !a.Unrecorded || a.AgentType != "oracle" || a.Prompt != "Review the plan" || a.Model != "z/big" ||
		a.Status != model.StatusKilled || a.FinalText != "partial answer" || a.SpawnToolUseID != "c1" {
		t.Errorf("agent %+v", a)
	}
	if d.Cost.UnrecordedAgents != 1 || d.Turns[0].Cost.UnrecordedAgents != 1 || !near(d.Cost.USD, 0.012) {
		t.Errorf("cost %+v", d.Cost)
	}
	if _, ok := d.Cost.ByModel["z/big"]; ok {
		t.Error("an unrecorded run has no by-model entry")
	}
}

// ---- forks ------------------------------------------------------------------------------------------

// A fork copies the entries of its parent, tool results included: the children's messages keep
// their ids, so the catalog bills them once.
func TestSubagentForkDedupesChildren(t *testing.T) {
	dir := t.TempDir()
	details := aDetails("single", aRes("scout", "Add a docstring", "acme/z/child", childOf("z/child", "z/child", 0.003, 0.002), nil))
	parentSession(t, "one", nil, "subagent", details).write(dir, "one.jsonl")
	fk := parentSession(t, "fork", map[string]any{
		"parentSession": "/home/dev/.pi/agent/sessions/--home-dev-proj--/2026-10-01T09-00-00-000Z_one.jsonl"}, "subagent", details)
	fk.user("11111111", "a0000002", 50, "more")
	fk.asst("22222222", "11111111", 51, "z/parent", "ok", "stop", use(10, 10, 0, 0, 0.4))
	fk.write(dir, "fork.jsonl")

	a, b := build(t, dir, "one"), build(t, dir, "fork")
	ids := func(d *model.SessionDigest) []string {
		var out []string
		for _, m := range messagesOf(d, "c1.0") {
			out = append(out, m.ID)
		}
		return out
	}
	if x, y := ids(a), ids(b); len(x) != 2 || strings.Join(x, ",") != strings.Join(y, ",") {
		t.Errorf("child ids differ: %v vs %v", x, y)
	}
	c := catalogOf(t, dir)
	in, _ := c.Session(model.SessionKey{Harness: "pi", ID: "fork"})
	if !near(in.Cost.BestUSD, 0.4) || !near(in.Cost.InheritedUSD, 0.012+0.005) {
		t.Errorf("fork cost %+v", in.Cost)
	}
	if total := c.Total(catalog.Filter{}); !near(total.TotalUSD, 0.017+0.4) {
		t.Errorf("total %v, want the children billed once", total.TotalUSD)
	}
}

func TestSubagentDigestIsPure(t *testing.T) {
	a, b := buildSingle(t), buildSingle(t)
	ja, _ := json.Marshal([]any{a.Agents, a.Messages, a.Turns, a.Cost, a.Stats})
	jb, _ := json.Marshal([]any{b.Agents, b.Messages, b.Turns, b.Cost, b.Stats})
	if string(ja) != string(jb) {
		t.Error("two builds differ")
	}
}

// An extension's model string names the provider and may carry Pi's thinking-level suffix;
// the child's model is the bare id, as in Pi's assistant messages. A colon that is part of
// the id (OpenRouter's ":batch") stays.
func TestSubagentModelName(t *testing.T) {
	for in, want := range map[string]string{
		"openai-codex/gpt-5.5:xhigh":    "gpt-5.5",
		"openrouter/z-ai/glm-5.3-flash": "z-ai/glm-5.3-flash",
		"openrouter/z-ai/glm-5.3:batch": "z-ai/glm-5.3:batch",
		"anthropic/claude-fable-5:high": "claude-fable-5",
		"gpt-5.5":                       "gpt-5.5",
		"gpt-5.5:off":                   "gpt-5.5",
	} {
		if got := modelName(in); got != want {
			t.Errorf("modelName(%q) = %q, want %q", in, got, want)
		}
	}
}
