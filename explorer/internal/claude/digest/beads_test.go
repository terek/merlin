package digest

import (
	"reflect"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

// in puts a record in a working directory on a branch.
func in(l L, cwd, branch string) L {
	l["cwd"], l["gitBranch"] = cwd, branch
	return l
}

func bash(id, command string) L { return tool(id, "Bash", L{"command": command}) }

func bashResult(uuid, par string, sec int, toolUseID, output string, isError bool) L {
	return L{"type": "user", "uuid": uuid, "parentUuid": parent(par), "timestamp": ts(sec),
		"message": L{"role": "user", "content": []L{{"type": "tool_result", "tool_use_id": toolUseID, "content": output, "is_error": isError}}}}
}

// beadsMain is a main file: the lead creates a bead and starts a worker, then runs a bd call
// whose result never arrives.
func beadsMain() []L {
	return []L{
		in(prompt("u1", "", 0, "plan the widget"), "/home/dev/acme", "main"),
		in(assistant("a1", "u1", 1, "msg_m1", usage(10, 5),
			bash("toolu_b1", `cd /home/dev/acme && bd create --title "Widget" --parent acme-e1 -t task`),
		), "/home/dev/acme", "main"),
		in(bashResult("r1", "a1", 2, "toolu_b1", "✓ Created issue: acme-e1.1 — Widget\n  Priority: P2\n", false), "/home/dev/acme", "main"),
		in(assistant("a2", "r1", 3, "msg_m2", usage(10, 5),
			tool("toolu_spawn", "Agent", L{"description": "build it", "prompt": "Work on acme-e1.1", "subagent_type": "general-purpose"}),
		), "/home/dev/acme", "main"),
		in(L{"type": "user", "uuid": "r2", "parentUuid": "a2", "timestamp": ts(20),
			"toolUseResult": L{"status": "completed", "agentId": "w1"},
			"message":       L{"role": "user", "content": []L{{"type": "tool_result", "tool_use_id": "toolu_spawn", "content": "done"}}}},
			"/home/dev/acme", "main"),
		in(prompt("u2", "r2", 30, "check it"), "/home/dev/acme/sub", "feature-w"),
		in(assistant("a3", "u2", 31, "msg_m3", usage(10, 5), bash("toolu_b3", "bd show acme-e1.1")), "/home/dev/acme/sub", "feature-w"),
	}
}

// beadsWorker is the worker's file: a copy of the lead's first call (as a fork carries it),
// then its own claim and close, and a refused claim of another bead.
func beadsWorker() []L {
	w := func(l L) L { l["agentId"] = "w1"; l["isSidechain"] = true; return in(l, "/home/dev/acme", "main") }
	return []L{
		w(assistant("c1", "", 4, "msg_m1", usage(10, 5), bash("toolu_b1", `bd create --title "Widget"`))),
		w(bashResult("c2", "c1", 4, "toolu_b1", "✓ Created issue: acme-e1.1 — Widget\n", false)),
		w(prompt("wu1", "c2", 5, "Work on acme-e1.1")),
		w(assistant("wa1", "wu1", 6, "msg_w1", usage(10, 5),
			bash("toolu_w1", "bd update acme-e1.1 --claim && make test && bd close acme-e1.1 -r 'Widget built'"),
		)),
		w(bashResult("wr1", "wa1", 8, "toolu_w1", "✓ Updated issue: acme-e1.1 — Widget\nPASS\n✓ Closed acme-e1.1 — Widget: Widget built\n", false)),
		w(assistant("wa2", "wr1", 9, "msg_w2", usage(10, 5), bash("toolu_w2", "bd update acme-e2 --claim"))),
		w(bashResult("wr2", "wa2", 10, "toolu_w2", "Error claiming acme-e2: already claimed\n", true)),
	}
}

func TestBeadEventsInAFile(t *testing.T) {
	res := reduce(t, beadsMain()...)
	ip := func(i int) *int { return &i }
	want := []model.BeadEvent{
		{At: tsTime(t, 2), Turn: ip(0), MessageID: "msg_m1", ToolUseID: "toolu_b1", Op: model.BeadCreate,
			IDs: []string{"acme-e1.1"}, Parent: "acme-e1", Title: "Widget", Cwd: "/home/dev/acme", Outcome: model.BeadOK},
		{At: tsTime(t, 31), Turn: ip(1), MessageID: "msg_m3", ToolUseID: "toolu_b3", Op: model.BeadShow,
			IDs: []string{"acme-e1.1"}, Cwd: "/home/dev/acme/sub", Outcome: model.BeadUnknown},
	}
	if !reflect.DeepEqual(res.Beads, want) {
		t.Errorf("beads\n got %+v\nwant %+v", res.Beads, want)
	}
	if res.Turns[0].GitBranch != "main" || res.Turns[1].GitBranch != "feature-w" {
		t.Errorf("turn branches = %q, %q", res.Turns[0].GitBranch, res.Turns[1].GitBranch)
	}
}

func TestBeadEventsIncremental(t *testing.T) {
	lines := beadsMain()
	whole := reduce(t, lines...)
	b := NewBuilder(fixturePrices())
	recs := decode(t, lines...)
	for _, r := range recs[:2] { // the bd create call, before its result
		b.Apply(r)
	}
	if mid := b.Result(); len(mid.Beads) != 1 || mid.Beads[0].Outcome != model.BeadUnknown || len(mid.Beads[0].IDs) != 0 {
		t.Errorf("pending create = %+v", mid.Beads)
	}
	for _, r := range recs[2:] {
		b.Apply(r)
	}
	if got := b.Result(); !reflect.DeepEqual(got.Beads, whole.Beads) {
		t.Errorf("fed in two parts\n got %+v\nwant %+v", got.Beads, whole.Beads)
	}
}

func TestBeadEventsAssembled(t *testing.T) {
	main := reduce(t, beadsMain()...)
	worker := reduce(t, beadsWorker()...)
	asm := Assemble(main, []AgentFile{{ID: "w1", Result: worker}})
	type row struct {
		agent     string
		turn      int
		agentTurn int
		tool      string
		op        model.BeadOp
		outcome   model.BeadOutcome
	}
	var got []row
	for _, e := range asm.Beads {
		r := row{agent: e.AgentID, turn: -1, agentTurn: -1, tool: e.ToolUseID, op: e.Op, outcome: e.Outcome}
		if e.Turn != nil {
			r.turn = *e.Turn
		}
		if e.AgentTurn != nil {
			r.agentTurn = *e.AgentTurn
		}
		got = append(got, r)
	}
	// The worker's copy of msg_m1 is the lead's call: it appears once, as the lead's.
	want := []row{
		{"", 0, -1, "toolu_b1", model.BeadCreate, model.BeadOK},
		{"w1", 0, 0, "toolu_w1", model.BeadClaim, model.BeadOK},
		{"w1", 0, 0, "toolu_w1", model.BeadClose, model.BeadOK},
		{"w1", 0, 0, "toolu_w2", model.BeadClaim, model.BeadFailed},
		{"", 1, -1, "toolu_b3", model.BeadShow, model.BeadUnknown},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("assembled beads\n got %+v\nwant %+v", got, want)
	}
	if r := asm.Beads[2].Reason; r != "Widget built" {
		t.Errorf("close reason = %q", r)
	}
}

func tsTime(t *testing.T, sec int) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, ts(sec))
	if err != nil {
		t.Fatal(err)
	}
	return v
}
