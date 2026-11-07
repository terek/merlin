package digest

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/terek/merlin/internal/model"
)

func wdMain() []L {
	const cwd = "/home/dev/acme"
	return []L{
		in(prompt("u1", "", 0, "build it"), cwd, "main"),
		in(assistant("a1", "u1", 1, "msg_m1", usage(10, 5),
			tool("t1", "Edit", L{"file_path": "/home/dev/acme/src/a.go"}),
			tool("t2", "Write", L{"file_path": "/home/dev/acme/src/b.go"}),
			tool("t3", "Edit", L{"file_path": "relative/c.go"}),
			tool("t4", "Read", L{"file_path": "/home/dev/other/r.go"}),
			tool("t5", "Grep", L{"pattern": "x", "path": "/home/dev/other"}),
			tool("t6", "NotebookEdit", L{"notebook_path": "/home/dev/acme/nb/n.ipynb"}),
		), cwd, "main"),
		in(assistant("a2", "a1", 2, "msg_m2", usage(10, 5),
			bash("t7", "cd /home/dev/acme-w/ && make test"),
			bash("t8", "git status"),
			bash("t9", "cd sub && ls"),
			bash("t10", "cd $WHERE && ls"),
			tool("t11", "Agent", L{"description": "w", "prompt": "do", "subagent_type": "general-purpose"}),
		), cwd, "main"),
		in(L{"type": "user", "uuid": "r2", "parentUuid": "a2", "timestamp": ts(5),
			"toolUseResult": L{"status": "completed", "agentId": "w1"},
			"message":       L{"role": "user", "content": []L{{"type": "tool_result", "tool_use_id": "t11", "content": "done"}}}}, cwd, "main"),
		in(prompt("u2", "r2", 10, "again"), cwd, "main"),
		in(assistant("a3", "u2", 11, "msg_m3", usage(10, 5),
			tool("t12", "Edit", L{"file_path": "/home/dev/acme/src/a.go"}), // fails below: still one edit
		), cwd, "main"),
		bashResult("r3", "a3", 12, "t12", "error", true),
	}
}

func wdWorker() []L {
	w := func(l L) L { l["agentId"] = "w1"; l["isSidechain"] = true; return in(l, "/home/dev/acme-w", "w") }
	return []L{
		// A copy of the lead's message, as a fork carries it: it belongs to the lead.
		w(assistant("c1", "", 3, "msg_m1", usage(10, 5), tool("t1", "Edit", L{"file_path": "/home/dev/acme/src/a.go"}))),
		w(prompt("wu1", "c1", 4, "do")),
		w(assistant("wa1", "wu1", 6, "msg_w1", usage(10, 5),
			tool("w1", "Edit", L{"file_path": "/home/dev/acme-w/pkg/x.go"}),
			tool("w2", "Edit", L{"file_path": "/home/dev/acme-w/pkg/y.go"}),
			bash("w3", "go test ./..."),
			bash("w4", "cd /home/dev/acme-w/pkg && go vet"),
		)),
		w(prompt("wu2", "wa1", 20, "more")),
		w(assistant("wa2", "wu2", 21, "msg_w2", usage(10, 5),
			tool("w5", "Write", L{"file_path": "/home/dev/acme-w/z.go"}),
		)),
	}
}

func TestWorkDirsMainAndAgents(t *testing.T) {
	main := reduce(t, wdMain()...)
	worker := reduce(t, wdWorker()...)
	asm := Assemble(main, []AgentFile{{ID: "w1", Result: worker}})

	wantMain := [][]model.WorkDir{
		{
			{Dir: "/home/dev/acme", Commands: 1}, // git status (cwd of the record)
			{Dir: "/home/dev/acme-w", Commands: 1},
			{Dir: "/home/dev/acme/nb", Edits: 1},
			{Dir: "/home/dev/acme/src", Edits: 2},
			{Dir: "/home/dev/acme/sub", Commands: 1},
		},
		{{Dir: "/home/dev/acme/src", Edits: 1}},
	}
	for i, want := range wantMain {
		if got := asm.Turns[i].WorkDirs; !reflect.DeepEqual(got, want) {
			t.Errorf("turn %d workDirs\n got %+v\nwant %+v", i, got, want)
		}
	}
	if len(asm.Agents) != 1 || len(asm.Agents[0].Turns) != 2 {
		t.Fatalf("agents = %+v", asm.Agents)
	}
	wantAgent := [][]model.WorkDir{
		{
			{Dir: "/home/dev/acme-w", Commands: 1},
			{Dir: "/home/dev/acme-w/pkg", Edits: 2, Commands: 1},
		},
		{{Dir: "/home/dev/acme-w", Edits: 1}},
	}
	for i, want := range wantAgent {
		if got := asm.Agents[0].Turns[i].WorkDirs; !reflect.DeepEqual(got, want) {
			t.Errorf("agent turn %d workDirs\n got %+v\nwant %+v", i, got, want)
		}
	}
}

func TestWorkDirsStableBytes(t *testing.T) {
	build := func() []byte {
		asm := Assemble(reduce(t, wdMain()...), []AgentFile{{ID: "w1", Result: reduce(t, wdWorker()...)}})
		b, err := json.Marshal(struct {
			T []model.Turn
			A []model.Agent
		}{asm.Turns, asm.Agents})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	first := build()
	for range 5 {
		if string(build()) != string(first) {
			t.Fatal("rebuilding gave different bytes")
		}
	}
}

func TestWorkDirsIncremental(t *testing.T) {
	lines := wdMain()
	whole := reduce(t, lines...)
	b := NewBuilder(fixturePrices())
	recs := decode(t, lines...)
	for _, r := range recs[:3] {
		b.Apply(r)
	}
	_ = b.Result()
	for _, r := range recs[3:] {
		b.Apply(r)
	}
	if got := b.Result(); !reflect.DeepEqual(got.Turns, whole.Turns) {
		t.Errorf("fed in two parts\n got %+v\nwant %+v", got.Turns, whole.Turns)
	}
}
