package digest

import (
	"sort"
	"strings"

	"github.com/terek/merlin/explorer/internal/model"
)

// A workflow run is started by one Workflow tool call. Its agents are started by the
// workflow's script, not by tool calls: nothing in a transcript names them one by one. What
// ties them to the run is where Claude Code writes them, subagents/workflows/<runId>/, and
// the run id in the tool call's result (format notes §5a).

// launchRef is a workflow launch together with the file it was found in.
type launchRef struct {
	WorkflowLaunch
	owner int // index into the sorted agents; mainOwner for the main file
}

// runOf returns the workflow run an agent file belongs to, from its directory below
// subagents/; empty when it is not in a run's directory.
func runOf(dir string) string {
	rest, ok := strings.CutPrefix(dir, "workflows/")
	if !ok {
		return ""
	}
	id, _, _ := strings.Cut(rest, "/")
	return id
}

// A workflow agent's file opens with two prompts the harness writes: the user request that
// led to the run, relayed, and then the task the script computed for this agent. Both have
// a fixed first line and the text below it, every line indented by two spaces.
const (
	workflowFrame = "[Workflow harness"
	workflowTask  = "computed task]"
)

// computedTask returns the task a workflow script gave an agent, without the harness's
// frame. ok is false when text is not such a prompt.
func computedTask(text string) (task string, ok bool) {
	head, body, _ := strings.Cut(text, "\n")
	if !strings.HasPrefix(head, workflowFrame) || !strings.Contains(head, workflowTask) {
		return "", false
	}
	lines := strings.Split(body, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimPrefix(l, "  ")
	}
	return strings.TrimSpace(strings.Join(lines, "\n")), true
}

// buildWorkflows lists the session's workflow runs: every launch found in a file, and every
// run that has agent files but no launch (its tool call was not found). Runs are ordered by
// start time, then id.
func buildWorkflows(launches []launchRef, agents []model.Agent, ags []agentIn, notes []TaskNotification) []model.WorkflowRun {
	var runs []model.WorkflowRun
	at := map[string]int{}
	for _, l := range launches {
		if _, dup := at[l.RunID]; dup {
			continue
		}
		run := model.WorkflowRun{
			ID: l.RunID, Name: l.Name, Summary: l.Summary, TaskID: l.TaskID, ToolUseID: l.ToolUseID,
			StartedAt: l.At, Status: "open",
		}
		switch {
		case l.owner == mainOwner && l.Turn >= 0:
			t := l.Turn
			run.Turn = &t
		case l.owner >= 0:
			run.AgentID = ags[l.owner].id
			run.Turn = agents[l.owner].SpawnTurn
		}
		for _, n := range notes {
			mine := (l.ToolUseID != "" && n.ToolUseID == l.ToolUseID) || (l.TaskID != "" && n.TaskID == l.TaskID)
			if mine && n.Status != "" {
				run.Status = strings.ToLower(n.Status)
				if n.At.After(run.EndedAt) {
					run.EndedAt = n.At
				}
			}
		}
		at[l.RunID] = len(runs)
		runs = append(runs, run)
	}
	for i := range agents {
		a := &agents[i]
		if a.RunID == "" {
			continue
		}
		k, known := at[a.RunID]
		if !known {
			k = len(runs)
			at[a.RunID] = k
			runs = append(runs, model.WorkflowRun{ID: a.RunID, Status: "open"})
		}
		run := &runs[k]
		run.Agents++
		run.USD += a.SubtreeUSD
		if run.StartedAt.IsZero() || (!a.StartedAt.IsZero() && a.StartedAt.Before(run.StartedAt)) {
			run.StartedAt = a.StartedAt
		}
		if a.EndedAt.After(run.EndedAt) {
			run.EndedAt = a.EndedAt
		}
	}
	sort.SliceStable(runs, func(i, j int) bool {
		if !runs[i].StartedAt.Equal(runs[j].StartedAt) {
			return earlier(runs[i].StartedAt, runs[j].StartedAt)
		}
		return runs[i].ID < runs[j].ID
	})
	return runs
}
