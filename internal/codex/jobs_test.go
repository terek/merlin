package codex

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"github.com/terek/merlin/internal/model"
)

// The shapes follow what Codex writes for a command that outlives its yield time
// (docs/codex-format.md); the contents are made up.

func (r *rollout) call(sec int, name, callID string, args map[string]any) *rollout {
	b, _ := json.Marshal(args)
	return r.item(sec, map[string]any{"type": "function_call", "name": name, "call_id": callID, "arguments": string(b)})
}

func (r *rollout) out(sec int, callID, status string) *rollout {
	return r.item(sec, map[string]any{"type": "function_call_output", "call_id": callID,
		"output": "Chunk ID: abc123\nWall time: 1.0010 seconds\n" + status + "\nOriginal token count: 3\nOutput:\nsome text\n"})
}

func running(id int) string  { return fmt.Sprintf("Process running with session ID %d", id) }
func exited(code int) string { return fmt.Sprintf("Process exited with code %d", code) }

func (r *rollout) finished(sec int, pid string, exit int) *rollout {
	return r.event(sec, map[string]any{"type": "item_completed", "item": map[string]any{
		"type": "CommandExecution", "id": "exec-" + pid, "process_id": pid, "command": []string{"/bin/zsh", "-lc", "x"},
		"cwd": "file:///home/dev/acme", "status": "completed", "aggregated_output": "", "exit_code": exit,
		"duration": map[string]any{"secs": 30, "nanos": 0}}})
}

func jobsRollout(t *testing.T, home string) {
	newRollout(t).meta("R", "R", "cli", nil).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).
		user(2, "Run the suite.", 0).
		usage(3, "resp-1", "r1", 100, 0, 10).
		// polled twice, then exits 1
		call(4, "exec_command", "c1", map[string]any{"cmd": "make suite", "workdir": "/home/dev/acme", "yield_time_ms": 1000}).
		out(5, "c1", running(41)).
		call(6, "write_stdin", "c2", map[string]any{"session_id": 41, "chars": "", "yield_time_ms": 5000}).
		out(11, "c2", running(41)).
		done(12, "r1").
		start(20, "r2", "", "user").ctx(20, "r2", "m", nil).
		user(21, "Check on it.", 0).
		usage(22, "resp-2", "r2", 100, 0, 10).
		call(23, "write_stdin", "c3", map[string]any{"session_id": 41, "chars": "", "yield_time_ms": 5000}).
		out(24, "c3", exited(1)).
		// exits within its yield: no job
		call(25, "exec_command", "c4", map[string]any{"cmd": "true", "workdir": "/home/dev/acme", "yield_time_ms": 1000}).
		out(26, "c4", exited(0)).
		// still running and never read; the harness says how it ended
		call(27, "exec_command", "c5", map[string]any{"cmd": "sleep 60", "workdir": "/home/dev/acme", "yield_time_ms": 1000}).
		out(28, "c5", running(52)).
		finished(88, "52", 0).
		// still running, nothing more
		call(30, "exec_command", "c6", map[string]any{"cmd": "tail -f log", "workdir": "/home/dev/acme", "yield_time_ms": 1000}).
		out(31, "c6", running(63)).
		done(90, "r2").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
}

func TestBackgroundJobs(t *testing.T) {
	home := t.TempDir()
	jobsRollout(t, home)
	d := build(t, home, "R")
	if len(d.Jobs) != 3 {
		t.Fatalf("jobs = %+v", d.Jobs)
	}
	j := d.Jobs[0]
	if j.ID != "41" || j.Kind != model.JobCommand || j.Command != "make suite" || j.ToolUseID != "c1" ||
		j.Turn == nil || *j.Turn != 0 || j.AgentID != "" || !j.StartedAt.Equal(t0.Add(4e9)) ||
		j.Status != "failed" || j.ExitCode == nil || *j.ExitCode != 1 || !j.EndedAt.Equal(t0.Add(24e9)) {
		t.Errorf("polled job = %+v", j)
	}
	if len(j.Returns) != 2 {
		t.Fatalf("returns = %+v", j.Returns)
	}
	for i, want := range []struct {
		turn  int
		final bool
	}{{0, false}, {1, true}} {
		r := j.Returns[i]
		if r.How != model.ReturnFetched || r.Final != want.final || r.Turn == nil || *r.Turn != want.turn || r.AgentID != "" {
			t.Errorf("return %d = %+v", i, r)
		}
	}
	if j.Returns[1].Status != "failed" || j.Returns[0].Status != "" {
		t.Errorf("return statuses = %q, %q", j.Returns[0].Status, j.Returns[1].Status)
	}
	if e := d.Jobs[1]; e.ID != "52" || e.Status != "completed" || e.ExitCode == nil || *e.ExitCode != 0 ||
		!e.EndedAt.Equal(t0.Add(88e9)) || len(e.Returns) != 0 {
		t.Errorf("job ended by the harness's record = %+v", e)
	}
	if o := d.Jobs[2]; o.ID != "63" || o.Status != "open" || !o.EndedAt.IsZero() || o.ExitCode != nil || len(o.Returns) != 0 {
		t.Errorf("open job = %+v", o)
	}
	a, _ := json.Marshal(build(t, home, "R").Jobs)
	b, _ := json.Marshal(d.Jobs)
	if string(a) != string(b) {
		t.Error("two builds differ")
	}
}

func TestBackgroundJobOfSubagent(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "cli", nil).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).
		user(2, "Delegate.", 0).
		tool(3, "spawn_agent", map[string]any{"task_name": "worker", "model": "m", "fork_turns": "none", "message": "Serve."}).
		usage(4, "resp-r", "r1", 10, 0, 1).
		done(30, "r1").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
	newRollout(t).meta("A", "R", spawnSource("R", "/root/worker", "Ada", 1), map[string]any{"agent_nickname": "Ada", "agent_path": "/root/worker", "parent_thread_id": "R"}).
		start(10, "a1", "r1", "user").ctx(10, "a1", "m", nil).
		call(11, "exec_command", "w1", map[string]any{"cmd": "serve", "yield_time_ms": 1000}).
		out(12, "w1", running(7)).
		call(13, "write_stdin", "w2", map[string]any{"session_id": "7", "chars": "", "yield_time_ms": 1000}).
		out(14, "w2", exited(0)).
		usage(15, "resp-a", "a1", 10, 0, 1).
		done(16, "a1").
		write(home, "rollout-2026-10-01T09-00-10-A.jsonl")
	d := build(t, home, "R")
	if len(d.Jobs) != 1 {
		t.Fatalf("jobs = %+v", d.Jobs)
	}
	j := d.Jobs[0]
	if j.ID != "7" || j.AgentID == "" || j.Turn == nil || *j.Turn != 0 || j.AgentTurn == nil || *j.AgentTurn != 0 || j.Status != "completed" ||
		len(j.Returns) != 1 || j.Returns[0].AgentID != j.AgentID || !j.Returns[0].Final || j.Returns[0].Status != "completed" {
		t.Errorf("job = %+v", j)
	}
	if !reflect.DeepEqual(d.Jobs[0].Returns[0].AgentTurn, j.AgentTurn) {
		t.Errorf("return agent turn = %v", d.Jobs[0].Returns[0].AgentTurn)
	}
}
