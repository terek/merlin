package digest

import (
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/terek/merlin/internal/claude/transcript"
	"github.com/terek/merlin/internal/model"
)

// A background job is a Bash call with run_in_background, or a Monitor call. The call's
// result names the task the harness started (format notes §5b); the task's later reports are
// task notifications, and an agent can also read its output (TaskOutput) or stop it (TaskStop).

var (
	reBashJobID    = regexp.MustCompile(`Command running in background with ID: ([A-Za-z0-9_-]+)`)
	reMonitorJobID = regexp.MustCompile(`Monitor started \(task ([A-Za-z0-9_-]+)`)
	reExitCode     = regexp.MustCompile(`\(exit code (-?\d+)\)`)
)

// jobCall notes a tool_use that starts a job or reads or stops one.
func (b *Builder) jobCall(blk transcript.Block, m *msgState, ts time.Time) {
	if blk.ID == "" {
		return
	}
	var in struct {
		Command         string `json:"command"`
		Description     string `json:"description"`
		RunInBackground bool   `json:"run_in_background"`
		TaskID          string `json:"task_id"`
	}
	_ = json.Unmarshal(blk.Input, &in) // a mistyped input leaves the fields empty
	switch blk.Name {
	case "Bash", "Monitor":
		if blk.Name == "Bash" && !in.RunInBackground {
			return
		}
		if _, dup := b.jobPending[blk.ID]; dup {
			return
		}
		kind := model.JobCommand
		if blk.Name == "Monitor" {
			kind = model.JobMonitor
		}
		b.jobPending[blk.ID] = JobStart{
			ToolUseID: blk.ID, MessageID: m.id, Turn: m.turn, At: ts, Kind: kind,
			Description: in.Description, Command: in.Command,
		}
	case "TaskOutput", "TaskStop":
		if in.TaskID == "" {
			return
		}
		if _, dup := b.jobCallIdx[blk.ID]; dup {
			return
		}
		b.jobCallIdx[blk.ID] = len(b.jobCalls)
		b.jobCalls = append(b.jobCalls, JobCall{
			ToolUseID: blk.ID, MessageID: m.id, Turn: m.turn, At: ts, Stop: blk.Name == "TaskStop", TaskID: in.TaskID,
		})
	}
}

// jobResult handles the result of a job call.
func (b *Builder) jobResult(blk transcript.Block, ts time.Time) {
	if k, ok := b.jobCallIdx[blk.ToolUseID]; ok {
		b.jobCalls[k].ResultAt, b.jobCalls[k].Failed = ts, blk.IsError
	}
	js, ok := b.jobPending[blk.ToolUseID]
	if !ok {
		return
	}
	delete(b.jobPending, blk.ToolUseID)
	if blk.IsError {
		return
	}
	re := reBashJobID
	if js.Kind == model.JobMonitor {
		re = reMonitorJobID
	}
	if m := re.FindStringSubmatch(blk.ResultText()); m != nil {
		js.TaskID = m[1]
		b.jobStarts = append(b.jobStarts, js)
	}
}

// jobBuild is a job under construction, with where it was started for turn lookup.
type jobBuild struct {
	model.Job
	owner  int // index into the sorted agents; mainOwner for the main file
	msgID  string
	stopAt time.Time // when a TaskStop succeeded
}

// buildJobs lists the session's background jobs from the starts found in the main file and
// the agent files, matched to the reports in the turns of the main agent and the agents and
// to the TaskOutput and TaskStop calls. owned and msgTurns say which messages an agent owns
// (a fork's copy of its parent's history is not its own) and which agent turn each is in.
// Jobs are ordered by start time, then id.
func buildJobs(main *FileResult, ags []agentIn, agents []model.Agent, mainTurns []model.Turn,
	owned [][]model.Message, msgTurns [][]int) []model.Job {
	var jobs []*jobBuild
	byID := map[string]*jobBuild{}
	add := func(owner int, res *FileResult) {
		var own map[string]int // message id -> index into the agent's owned messages
		if owner >= 0 {
			own = make(map[string]int, len(owned[owner]))
			for j, m := range owned[owner] {
				own[m.ID] = j
			}
		}
		for _, s := range res.JobStarts {
			j := &jobBuild{owner: owner, msgID: s.MessageID, Job: model.Job{
				ID: s.TaskID, Kind: s.Kind, Description: s.Description, Command: s.Command,
				ToolUseID: s.ToolUseID, StartedAt: s.At, Status: "open",
			}}
			if owner == mainOwner {
				if s.Turn >= 0 {
					t := s.Turn
					j.Turn = &t
				}
			} else {
				k, ok := own[s.MessageID]
				if !ok {
					continue // a copy of the parent's call
				}
				j.AgentID, j.Turn = ags[owner].id, agents[owner].SpawnTurn
				if t := msgTurns[owner][k]; t >= 0 {
					j.AgentTurn = &t
				}
			}
			if _, dup := byID[j.ID]; dup {
				continue
			}
			byID[j.ID] = j
			jobs = append(jobs, j)
		}
	}
	if main != nil {
		add(mainOwner, main)
	}
	for i, a := range ags {
		add(i, a.res)
	}

	byTool := map[string]*jobBuild{}
	for _, j := range jobs {
		byTool[j.ToolUseID] = j
	}
	find := func(taskID, toolUseID string) *jobBuild {
		if j := byID[taskID]; j != nil && taskID != "" {
			return j
		}
		if toolUseID != "" {
			return byTool[toolUseID]
		}
		return nil
	}

	// Reports. Where a report lands says whether it woke the receiver or arrived while it
	// was working.
	seen := map[string]bool{}
	report := func(j *jobBuild, m model.InboxMessage, how model.JobReturnHow, turn *int, agentID string, agentTurn *int) {
		key := m.At.Format(time.RFC3339Nano) + "|" + j.ID + "|" + m.Status + "|" + m.Text + "|" + agentID
		if seen[key] {
			return // a copy of the same report in a fork's history
		}
		seen[key] = true
		r := model.JobReturn{At: m.At, How: how, Turn: turn, AgentID: agentID, AgentTurn: agentTurn, Summary: m.Summary}
		switch strings.ToLower(m.Status) {
		case "completed", "failed", "killed":
			r.Final, r.Status = true, strings.ToLower(m.Status)
		}
		j.Returns = append(j.Returns, r)
	}
	scan := func(msgs []model.InboxMessage, how model.JobReturnHow, turn *int, agentID string, agentTurn *int) {
		for _, m := range msgs {
			if m.Kind != model.InboxTask {
				continue
			}
			if j := find(m.TaskID, ""); j != nil {
				report(j, m, how, turn, agentID, agentTurn)
			}
		}
	}
	for i := range mainTurns {
		t := &mainTurns[i]
		idx := t.Index
		scan(t.Inbox, model.ReturnWoke, &idx, "", nil)
		for _, q := range t.Queued {
			scan(q.Inbox, model.ReturnDelivered, &idx, "", nil)
		}
	}
	for i := range agents {
		for k := range agents[i].Turns {
			t := &agents[i].Turns[k]
			turn := agents[i].SpawnTurn
			if t.RootTurn != nil {
				turn = t.RootTurn
			}
			at := t.Index
			scan(t.Inbox, model.ReturnWoke, turn, ags[i].id, &at)
			for _, q := range t.Queued {
				scan(q.Inbox, model.ReturnDelivered, turn, ags[i].id, &at)
			}
		}
	}

	// Reads and stops, from the file of the agent that made them.
	call := func(owner int, res *FileResult) {
		var own map[string]int
		if owner >= 0 {
			own = make(map[string]int, len(owned[owner]))
			for j, m := range owned[owner] {
				own[m.ID] = j
			}
		}
		for _, c := range res.JobCalls {
			j := byID[c.TaskID]
			if j == nil {
				continue
			}
			if c.Stop {
				if !c.Failed && !c.ResultAt.IsZero() {
					j.stopAt = c.ResultAt
				}
				continue
			}
			r := model.JobReturn{At: c.At, How: model.ReturnFetched}
			if owner == mainOwner {
				if c.Turn >= 0 {
					t := c.Turn
					r.Turn = &t
				}
			} else {
				k, ok := own[c.MessageID]
				if !ok {
					continue
				}
				r.AgentID, r.Turn = ags[owner].id, agents[owner].SpawnTurn
				if t := msgTurns[owner][k]; t >= 0 {
					r.AgentTurn = &t
				}
			}
			j.Returns = append(j.Returns, r)
		}
	}
	if main != nil {
		call(mainOwner, main)
	}
	for i, a := range ags {
		call(i, a.res)
	}

	out := make([]model.Job, 0, len(jobs))
	for _, j := range jobs {
		sort.SliceStable(j.Returns, func(a, b int) bool { return earlier(j.Returns[a].At, j.Returns[b].At) })
		ended := false
		for _, r := range j.Returns {
			if !r.Final {
				continue
			}
			ended = true
			j.Status, j.EndedAt = r.Status, r.At
			if m := reExitCode.FindStringSubmatch(r.Summary); m != nil && j.Kind == model.JobCommand {
				if n, err := strconv.Atoi(m[1]); err == nil {
					j.ExitCode = &n
				}
			}
		}
		if !ended && !j.stopAt.IsZero() {
			j.Status, j.EndedAt = "killed", j.stopAt
		}
		out = append(out, j.Job)
	}
	sort.SliceStable(out, func(a, b int) bool {
		if !out[a].StartedAt.Equal(out[b].StartedAt) {
			return earlier(out[a].StartedAt, out[b].StartedAt)
		}
		return out[a].ID < out[b].ID
	})
	return out
}
