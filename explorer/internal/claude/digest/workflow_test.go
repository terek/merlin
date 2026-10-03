package digest

import (
	"testing"

	"github.com/terek/merlin/explorer/internal/claude/transcript"
	"github.com/terek/merlin/explorer/internal/model"
)

// The shapes below follow what Claude Code writes for a workflow run (format notes §5a) and
// for prompts that arrive in the middle of a turn (§4b); the contents are made up.

func queuedCommand(uuid, par string, sec int, mode, originKind, text string) L {
	att := L{"type": "queued_command", "prompt": text, "commandMode": mode, "timestamp": ts(sec)}
	if originKind != "" {
		att["origin"] = L{"kind": originKind}
	}
	return L{"type": "attachment", "uuid": uuid, "parentUuid": parent(par), "timestamp": ts(sec), "attachment": att}
}

func workflowAgentLines(agent, task string, sec int) []L {
	relay := prompt(agent+"-u1", "", sec, "[Workflow harness — user request] The harness relays the user request:\n  please count things")
	computed := prompt(agent+"-u2", agent+"-u1", sec, "[Workflow harness — computed task] The computed task text follows:\n  "+task)
	answer := assistant(agent+"-a1", agent+"-u2", sec+2, "msg_"+agent, usage(100, 20), text("done: "+agent))
	for _, l := range []L{relay, computed, answer} {
		l["agentId"], l["isSidechain"] = agent, true
		delete(l, "origin")
		delete(l, "promptSource")
	}
	return []L{relay, computed, answer}
}

func TestComputedTask(t *testing.T) {
	task, ok := computedTask("[Workflow harness — computed task] Fixed words. The computed task text follows:\n  Count the files.\n    indented more\n  Report.")
	if !ok || task != "Count the files.\n  indented more\nReport." {
		t.Errorf("task = %q, %v", task, ok)
	}
	for _, s := range []string{
		"[Workflow harness — user request] relayed:\n  hello",
		"Count the files.",
		"",
	} {
		if _, ok := computedTask(s); ok {
			t.Errorf("computedTask(%q) reported a task", s)
		}
	}
}

func TestRunOf(t *testing.T) {
	for dir, want := range map[string]string{
		"":                         "",
		"workflows":                "",
		"workflows/wf_1":           "wf_1",
		"workflows/wf_1/nested":    "wf_1",
		"something/else":           "",
		"remote-agents/workflows/": "",
	} {
		if got := runOf(dir); got != want {
			t.Errorf("runOf(%q) = %q, want %q", dir, got, want)
		}
	}
}

// One turn launches a workflow run of two agents. The run's closing notification and a
// message the user typed both arrive while the next turn is running.
func TestWorkflowRun(t *testing.T) {
	launch := toolResult("r1", "a1", 3, "toolu_wf")
	launch["toolUseResult"] = L{"status": "async_launched", "taskId": "task9", "taskType": "local_workflow",
		"workflowName": "count-things", "runId": "wf_abc", "summary": "Count things"}
	note := "<task-notification>\n<task-id>task9</task-id>\n<tool-use-id>toolu_wf</tool-use-id>\n<status>completed</status>\n" +
		"<summary>Dynamic workflow \"Count things\" completed</summary>\n<result>{\"n\":2}</result>\n</task-notification>"
	main := reduce(t,
		prompt("u1", "", 0, "count things with a workflow"),
		assistant("a1", "u1", 1, "msg_1", usage(100, 10), tool("toolu_wf", "Workflow", L{"script": "…"})),
		launch,
		assistant("a2", "r1", 4, "msg_2", usage(100, 10), text("Launched.")),
		prompt("u2", "a2", 20, "and now wait"),
		assistant("a3", "u2", 21, "msg_3", usage(100, 10), tool("toolu_x", "Bash", L{"command": "true"})),
		queuedCommand("q1", "a3", 22, "task-notification", "", note),
		queuedCommand("q2", "q1", 23, "prompt", "human", "also check the docs"),
		toolResult("r2", "a3", 24, "toolu_x"),
		assistant("a4", "r2", 25, "msg_4", usage(100, 10), text("Both done.")),
	)
	if len(main.Workflows) != 1 || main.Workflows[0].RunID != "wf_abc" || main.Workflows[0].Turn != 0 {
		t.Fatalf("launches = %+v", main.Workflows)
	}
	if len(main.Turns) != 2 {
		t.Fatalf("a queued prompt started a turn: %+v", main.Turns)
	}
	q := main.Turns[1].Queued
	if len(q) != 2 || q[0].Origin != model.OriginTaskNotification || q[0].Text != "" || len(q[0].Inbox) != 1 ||
		q[0].Inbox[0].Status != "completed" || q[1].Origin != model.OriginHuman || q[1].Text != "also check the docs" {
		t.Errorf("queued = %+v", q)
	}

	phase := func(p string) *transcript.AgentMeta {
		depth := 1
		return &transcript.AgentMeta{AgentType: "workflow-subagent", Description: "count:" + p, WorkflowPhase: p, SpawnDepth: &depth, Model: "sonnet"}
	}
	asm := Assemble(main, []AgentFile{
		{ID: "wa1", Dir: "workflows/wf_abc", Result: reduce(t, workflowAgentLines("wa1", "Count the files.", 5)...), Meta: phase("Count")},
		{ID: "wa2", Dir: "workflows/wf_abc", Result: reduce(t, workflowAgentLines("wa2", "Check the count.", 8)...), Meta: phase("Check")},
	})
	if len(asm.Agents) != 2 {
		t.Fatalf("agents = %+v", asm.Agents)
	}
	for i, want := range []struct{ id, prompt, phase string }{{"wa1", "Count the files.", "Count"}, {"wa2", "Check the count.", "Check"}} {
		a := asm.Agents[i]
		if a.ID != want.id || a.Kind != model.AgentWorkflow || a.Linkage != model.LinkRun || a.RunID != "wf_abc" ||
			a.Phase != want.phase || a.Prompt != want.prompt || a.SpawnToolUseID != "toolu_wf" ||
			a.SpawnTurn == nil || *a.SpawnTurn != 0 || a.ParentAgentID != nil || a.Status != model.StatusCompleted ||
			!a.Background || len(a.Inbox) != 0 || a.FinalText != "done: "+want.id {
			t.Errorf("agent %d = %+v", i, a)
		}
	}
	if asm.Diagnostics.UnresolvedAgents != 0 {
		t.Errorf("unresolved = %d", asm.Diagnostics.UnresolvedAgents)
	}
	if len(asm.Workflows) != 1 {
		t.Fatalf("workflows = %+v", asm.Workflows)
	}
	w := asm.Workflows[0]
	if w.ID != "wf_abc" || w.Name != "count-things" || w.Summary != "Count things" || w.TaskID != "task9" ||
		w.ToolUseID != "toolu_wf" || w.Turn == nil || *w.Turn != 0 || w.AgentID != "" || w.Status != "completed" || w.Agents != 2 {
		t.Errorf("run = %+v", w)
	}
	near(t, "run usd", w.USD, asm.Agents[0].Cost.USD+asm.Agents[1].Cost.USD)
	if got := asm.Turns[0].Spawned; len(got) != 2 {
		t.Errorf("launch turn spawned %v", got)
	}
	near(t, "launch turn with agents", asm.Turns[0].CostWithAgents, asm.Turns[0].Cost.USD+w.USD)
}

// Agent files of a run whose launch is not in any transcript still belong to the run.
func TestWorkflowRunWithoutLaunch(t *testing.T) {
	main := reduce(t,
		prompt("u1", "", 0, "hello"),
		assistant("a1", "u1", 1, "msg_1", usage(100, 10), text("Hi.")))
	asm := Assemble(main, []AgentFile{
		{ID: "wa1", Dir: "workflows/wf_lost", Result: reduce(t, workflowAgentLines("wa1", "Count the files.", 5)...)},
	})
	a := asm.Agents[0]
	if a.Kind != model.AgentWorkflow || a.RunID != "wf_lost" || a.Linkage != model.LinkUnresolved || a.Prompt != "Count the files." {
		t.Errorf("agent = %+v", a)
	}
	if len(asm.Workflows) != 1 || asm.Workflows[0].ID != "wf_lost" || asm.Workflows[0].Status != "open" ||
		asm.Workflows[0].Agents != 1 || asm.Workflows[0].Turn != nil {
		t.Errorf("workflows = %+v", asm.Workflows)
	}
}
