package codex

import (
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/terek/merlin/internal/model"
)

// Codex pushes nothing to the model when a command it started finishes. exec_command returns
// after its yield time; when the process is still running, the output says so and names a
// session id, and the agent reads on with write_stdin. A job is such a process: the digest
// follows it from the exec_command that started it through each write_stdin that read it
// (docs/codex-format.md).

var (
	reSessionID = regexp.MustCompile(`(?m)^Process running with session ID (\S+)`)
	reExited    = regexp.MustCompile(`(?m)^Process exited with code (-?\d+)`)
)

// execCall is an exec_command call waiting for its output.
type execCall struct {
	Cmd  string
	At   time.Time
	Turn int
}

// jobRec is a background process of a thread.
type jobRec struct {
	ID      string
	Cmd     string
	CallID  string
	At      time.Time
	Turn    int
	Ended   time.Time
	Status  string // completed, failed or open
	Exit    *int
	Returns []jobRet
}

// jobRet is one write_stdin output that came back for a job.
type jobRet struct {
	At    time.Time
	Turn  int
	Final bool
	Exit  *int
}

// jobCall notes an exec_command or write_stdin call.
func (p *parser) jobCall(name, callID, args string, at time.Time) {
	switch name {
	case "exec_command":
		var a struct {
			Cmd string `json:"cmd"`
		}
		_ = json.Unmarshal([]byte(args), &a)
		if p.execs == nil {
			p.execs = map[string]execCall{}
		}
		p.execs[callID] = execCall{Cmd: a.Cmd, At: at, Turn: p.cur}
	case "write_stdin":
		var a struct {
			Session json.RawMessage `json:"session_id"`
		}
		_ = json.Unmarshal([]byte(args), &a)
		if id := strings.Trim(string(a.Session), `"`); id != "" && id != "null" {
			if p.stdins == nil {
				p.stdins = map[string]string{}
			}
			p.stdins[callID] = id
		}
	}
}

// outputText is the text of a function_call_output: a string, or an object with an output
// string.
func outputText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var o struct {
		Output string `json:"output"`
	}
	_ = json.Unmarshal(raw, &o)
	return o.Output
}

// jobOutput handles the output of an exec_command or write_stdin call.
func (p *parser) jobOutput(callID string, raw json.RawMessage, at time.Time) {
	if c, ok := p.execs[callID]; ok {
		delete(p.execs, callID)
		out := outputText(raw)
		m := reSessionID.FindStringSubmatch(out)
		if m == nil || reExited.MatchString(out) {
			return // it finished within its yield time: not a job
		}
		p.t.Jobs = append(p.t.Jobs, jobRec{ID: m[1], Cmd: c.Cmd, CallID: callID, At: c.At, Turn: c.Turn, Status: "open"})
		if p.jobAt == nil {
			p.jobAt = map[string]int{}
		}
		p.jobAt[m[1]] = len(p.t.Jobs) - 1
		return
	}
	id, ok := p.stdins[callID]
	if !ok {
		return
	}
	delete(p.stdins, callID)
	k, ok := p.jobAt[id]
	if !ok {
		return
	}
	j := &p.t.Jobs[k]
	ret := jobRet{At: at, Turn: p.cur}
	if m := reExited.FindStringSubmatch(outputText(raw)); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			ret.Final, ret.Exit = true, &n
			j.Ended, j.Exit = at, &n
			j.Status = "completed"
			if n != 0 {
				j.Status = "failed"
			}
			delete(p.jobAt, id)
		}
	}
	j.Returns = append(j.Returns, ret)
}

// jobEnded handles a CommandExecution item: it ends the open job of its process id when no
// exit line was seen.
func (p *parser) jobEnded(processID, status string, exit *int, at time.Time) {
	k, ok := p.jobAt[processID]
	if !ok {
		return
	}
	j := &p.t.Jobs[k]
	if j.Status != "open" {
		return
	}
	// The id stays known: the agent's last read may still come, and its exit line then wins.
	j.Ended, j.Exit = at, exit
	j.Status = "completed"
	if (exit != nil && *exit != 0) || (status != "" && status != "completed") {
		j.Status = "failed"
	}
}

// jobs lists the background processes of the main thread (inherited ones first) and the
// agents, placed like their messages, ordered by start time, then id.
func (b *builder) jobs() {
	d := b.d
	add := func(t *thread, off int, agent *model.Agent) {
		for _, r := range t.Jobs {
			j := model.Job{
				ID: r.ID, Kind: model.JobCommand, Command: r.Cmd, ToolUseID: r.CallID, StartedAt: r.At,
				EndedAt: r.Ended, Status: r.Status, ExitCode: r.Exit,
			}
			place := func(turn int) (t, agentTurn *int) {
				if agent == nil {
					if turn >= 0 {
						v := off + turn
						t = &v
					}
					return t, nil
				}
				if agent.SpawnTurn != nil {
					v := *agent.SpawnTurn
					t = &v
				}
				if len(agent.Turns) > 0 {
					k := turn
					if k < 0 || k >= len(agent.Turns) {
						k = 0
					}
					agentTurn = &k
				}
				return t, agentTurn
			}
			if agent != nil {
				j.AgentID = agent.ID
			}
			j.Turn, j.AgentTurn = place(r.Turn)
			for _, x := range r.Returns {
				ret := model.JobReturn{At: x.At, How: model.ReturnFetched, AgentID: j.AgentID}
				ret.Turn, ret.AgentTurn = place(x.Turn)
				if x.Final {
					ret.Final = true
					ret.Status = r.Status
				}
				j.Returns = append(j.Returns, ret)
			}
			d.Jobs = append(d.Jobs, j)
		}
	}
	if b.copied != nil {
		add(b.copied, 0, nil)
	}
	if b.root != nil {
		add(b.root, b.mainTurn0, nil)
	}
	for i := range d.Agents {
		add(b.byID[d.Agents[i].ID], 0, &d.Agents[i])
	}
	sort.SliceStable(d.Jobs, func(i, k int) bool {
		x, y := d.Jobs[i], d.Jobs[k]
		if !x.StartedAt.Equal(y.StartedAt) {
			return earlier(x.StartedAt, y.StartedAt)
		}
		return x.ID < y.ID
	})
}
