package digest

import (
	"reflect"
	"testing"
	"time"

	"github.com/terek/merlin/internal/claude/transcript"
	"github.com/terek/merlin/internal/model"
)

// The shapes follow what Claude Code writes for background commands and monitors (format
// notes §5b); the contents are made up.

func resultText(uuid, par string, sec int, toolUseID, body string, isErr bool) L {
	return L{"type": "user", "uuid": uuid, "parentUuid": parent(par), "timestamp": ts(sec),
		"message": L{"role": "user", "content": []L{{"type": "tool_result", "tool_use_id": toolUseID, "content": body, "is_error": isErr}}}}
}

func taskNote(id, status, summary, event string) string {
	s := "<task-notification>\n<task-id>" + id + "</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n"
	if status != "" {
		s += "<status>" + status + "</status>\n"
	}
	s += "<summary>" + summary + "</summary>\n"
	if event != "" {
		s += "<event>" + event + "</event>\n"
	}
	return s + "</task-notification>"
}

func noteTurn(uuid, par string, sec int, body string) L {
	p := prompt(uuid, par, sec, body)
	p["origin"] = L{"kind": "task-notification"}
	return p
}

func bgBash(id string, in L) L {
	in["run_in_background"] = true
	return tool(id, "Bash", in)
}

func jobByID(jobs []model.Job, id string) model.Job {
	for _, j := range jobs {
		if j.ID == id {
			return j
		}
	}
	return model.Job{}
}

func parseT(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func mainJobLines() []L {
	return []L{
		prompt("u1", "", 0, "run the build in the background"),
		assistant("a1", "u1", 1, "msg_1", usage(10, 1),
			bgBash("toolu_b1", L{"command": "make build", "description": "Build it"}),
			tool("toolu_mon", "Monitor", L{"command": "tail -f log", "description": "Watch the log", "persistent": true, "timeout_ms": 3600000}),
			bgBash("toolu_err", L{"command": "rm -rf nothing"})),
		resultText("r1", "a1", 2, "toolu_b1", "Command running in background with ID: bg1. Output is being written to: /tmp/x/bg1.output", false),
		resultText("r2", "r1", 2, "toolu_mon", "Monitor started (task mon1, timeout 3600000ms). You will be notified on each event.", false),
		resultText("r3", "r2", 2, "toolu_err", "Permission denied", true),
		assistant("a2", "r3", 3, "msg_2", usage(10, 1), text("Waiting.")),
		// the build finishes while the agent is idle: it wakes
		noteTurn("u2", "a2", 60, taskNote("bg1", "completed", `Background command "Build it" completed (exit code 3)`, "")),
		assistant("a3", "u2", 61, "msg_3", usage(10, 1),
			bgBash("toolu_b2", L{"command": "sleep 100", "description": "Slow"}),
			bgBash("toolu_b3", L{"command": "sleep 200", "description": "Stopped"})),
		resultText("r4", "a3", 62, "toolu_b2", "Command running in background with ID: bg2. Output is being written to: /tmp/x/bg2.output", false),
		resultText("r5", "r4", 62, "toolu_b3", "Command running in background with ID: bg3. Output is being written to: /tmp/x/bg3.output", false),
		// the second one reports in the middle of the turn, with a monitor event
		queuedCommand("q1", "r5", 70, "task-notification", "", taskNote("bg2", "completed", `Background command "Slow" completed (exit code 0)`, "")),
		queuedCommand("q2", "q1", 71, "task-notification", "", taskNote("mon1", "", "Monitor event: Watch the log", "line one")),
		assistant("a4", "q2", 72, "msg_4", usage(10, 1),
			tool("toolu_out", "TaskOutput", L{"task_id": "bg3", "block": false, "timeout": 5000}),
			tool("toolu_stop", "TaskStop", L{"task_id": "bg3"})),
		resultText("r6", "a4", 73, "toolu_out", "output so far", false),
		resultText("r7", "r6", 74, "toolu_stop", "Successfully stopped task: bg3 (sleep 200)", false),
		assistant("a5", "r7", 75, "msg_5", usage(10, 1), text("Stopped.")),
		noteTurn("u3", "a5", 90, taskNote("mon1", "", "Monitor event: Watch the log", "line two")),
		assistant("a6", "u3", 91, "msg_6", usage(10, 1), text("ok")),
		noteTurn("u4", "a6", 100, taskNote("mon1", "", "Monitor event: Watch the log", "line three")),
		assistant("a7", "u4", 101, "msg_7", usage(10, 1), text("ok")),
		// a background sub-agent's own notification matches no job
		noteTurn("u5", "a7", 110, taskNote("agentxyz", "completed", "Agent done", "")),
	}
}

func TestJobsMainAgent(t *testing.T) {
	asm := Assemble(reduce(t, mainJobLines()...), nil)
	jobs := asm.Jobs
	if len(jobs) != 4 {
		t.Fatalf("jobs = %+v", jobs)
	}
	for i, id := range []string{"bg1", "mon1", "bg2", "bg3"} {
		if jobs[i].ID != id {
			t.Fatalf("order: job %d = %s, want %s", i, jobs[i].ID, id)
		}
	}

	b := jobs[0]
	if b.Kind != model.JobCommand || b.Command != "make build" || b.Description != "Build it" || b.ToolUseID != "toolu_b1" ||
		b.Turn == nil || *b.Turn != 0 || b.AgentID != "" || b.Status != "completed" ||
		b.ExitCode == nil || *b.ExitCode != 3 || !b.EndedAt.Equal(b.Returns[0].At) || !b.StartedAt.Equal(parseT(t, ts(1))) {
		t.Errorf("woken job = %+v", b)
	}
	if len(b.Returns) != 1 || b.Returns[0].How != model.ReturnWoke || !b.Returns[0].Final || b.Returns[0].Status != "completed" ||
		b.Returns[0].Turn == nil || *b.Returns[0].Turn != 1 {
		t.Errorf("woken job returns = %+v", b.Returns)
	}

	d := jobs[2]
	if d.Status != "completed" || d.ExitCode == nil || *d.ExitCode != 0 || len(d.Returns) != 1 ||
		d.Returns[0].How != model.ReturnDelivered || !d.Returns[0].Final || *d.Returns[0].Turn != 1 {
		t.Errorf("delivered job = %+v", d)
	}

	m := jobs[1]
	if m.Kind != model.JobMonitor || m.Status != "open" || !m.EndedAt.IsZero() || m.ExitCode != nil || len(m.Returns) != 3 {
		t.Fatalf("monitor = %+v", m)
	}
	var hows []model.JobReturnHow
	for _, r := range m.Returns {
		if r.Final || r.Status != "" {
			t.Errorf("monitor event is final: %+v", r)
		}
		hows = append(hows, r.How)
	}
	if !reflect.DeepEqual(hows, []model.JobReturnHow{model.ReturnDelivered, model.ReturnWoke, model.ReturnWoke}) {
		t.Errorf("monitor hows = %v", hows)
	}

	k := jobs[3]
	if k.Status != "killed" || !k.EndedAt.Equal(parseT(t, ts(74))) || len(k.Returns) != 1 ||
		k.Returns[0].How != model.ReturnFetched || !k.Returns[0].At.Equal(parseT(t, ts(72))) || k.Returns[0].Final {
		t.Errorf("stopped job = %+v", k)
	}
	// Stability: the same input gives the same list.
	again := Assemble(reduce(t, mainJobLines()...), nil).Jobs
	if !reflect.DeepEqual(jobs, again) {
		t.Errorf("jobs differ between builds")
	}
}

func TestJobsFromAgent(t *testing.T) {
	main := reduce(t,
		prompt("u1", "", 0, "delegate"),
		assistant("a1", "u1", 1, "msg_1", usage(10, 1), tool("toolu_ag", "Agent", L{"description": "helper", "prompt": "start a server"})),
		resultText("r1", "a1", 30, "toolu_ag", "done", false),
		assistant("a2", "r1", 31, "msg_2", usage(10, 1), text("ok")))
	lines := []L{
		prompt("g1", "", 5, "start a server"),
		assistant("g2", "g1", 6, "msg_g1", usage(10, 1), bgBash("toolu_s", L{"command": "serve", "description": "Server"})),
		resultText("g3", "g2", 7, "toolu_s", "Command running in background with ID: sv1. Output is being written to: /tmp/x/sv1.output", false),
		assistant("g4", "g3", 8, "msg_g2", usage(10, 1), text("Started.")),
		noteTurn("g5", "g4", 20, taskNote("sv1", "failed", `Background command "Server" failed (exit code 1)`, "")),
		assistant("g6", "g5", 21, "msg_g3", usage(10, 1), text("It failed.")),
	}
	for _, l := range lines {
		l["agentId"], l["isSidechain"] = "ag1", true
		delete(l, "promptSource")
	}
	asm := Assemble(main, []AgentFile{{ID: "ag1", Result: reduce(t, lines...), Meta: &transcript.AgentMeta{ToolUseID: "toolu_ag"}}})
	if len(asm.Jobs) != 1 {
		t.Fatalf("jobs = %+v", asm.Jobs)
	}
	j := asm.Jobs[0]
	if j.ID != "sv1" || j.AgentID != "ag1" || j.Turn == nil || *j.Turn != 0 || j.AgentTurn == nil || *j.AgentTurn != 0 ||
		j.Status != "failed" || j.ExitCode == nil || *j.ExitCode != 1 || len(j.Returns) != 1 {
		t.Fatalf("job = %+v", j)
	}
	r := j.Returns[0]
	if r.How != model.ReturnWoke || r.AgentID != "ag1" || r.AgentTurn == nil || *r.AgentTurn != 1 || !r.Final || r.Status != "failed" {
		t.Errorf("return = %+v", r)
	}
	if len(asm.Agents) != 1 {
		t.Errorf("agents = %+v", asm.Agents)
	}
}
