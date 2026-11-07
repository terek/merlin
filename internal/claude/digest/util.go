package digest

import (
	"encoding/json"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/terek/merlin/internal/claude/transcript"
	"github.com/terek/merlin/internal/model"
)

// uniq is an ordered set of strings: first appearance order, empty strings ignored.
type uniq struct {
	list []string
	seen map[string]struct{}
}

func (u *uniq) add(s string) {
	if s == "" {
		return
	}
	if _, ok := u.seen[s]; ok {
		return
	}
	if u.seen == nil {
		u.seen = make(map[string]struct{})
	}
	u.seen[s] = struct{}{}
	u.list = append(u.list, s)
}

// copy returns a private copy of the list (nil when empty).
func (u *uniq) copy() []string {
	if len(u.list) == 0 {
		return nil
	}
	return append([]string(nil), u.list...)
}

func itoa(n int) string { return strconv.Itoa(n) }

// touchedFile returns the file a tool_use edits: file_path of Edit / Write / NotebookEdit
// (NotebookEdit may name it notebook_path).
func touchedFile(blk transcript.Block) string {
	switch blk.Name {
	case "Edit", "Write", "NotebookEdit":
	default:
		return ""
	}
	var in struct {
		FilePath     string `json:"file_path"`
		NotebookPath string `json:"notebook_path"`
	}
	_ = json.Unmarshal(blk.Input, &in) // a mistyped input leaves the fields empty
	if in.FilePath != "" {
		return in.FilePath
	}
	return in.NotebookPath
}

// killedAgentIDs extracts agent ids from an agents_killed record, whose shape is not
// pinned down: strings or objects with an id under agentIds / agents / killedAgents.
func killedAgentIDs(raw json.RawMessage) []string {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	var out uniq
	for _, key := range []string{"agentIds", "agents", "killedAgents"} {
		var items []json.RawMessage
		if json.Unmarshal(m[key], &items) != nil {
			continue
		}
		for _, it := range items {
			var s string
			if json.Unmarshal(it, &s) == nil {
				out.add(s)
				continue
			}
			var o struct {
				ID      string `json:"id"`
				AgentID string `json:"agentId"`
			}
			if json.Unmarshal(it, &o) == nil {
				out.add(o.ID)
				out.add(o.AgentID)
			}
		}
	}
	return out.copy()
}

// bashScript returns the command of a Bash tool_use.
func bashScript(blk transcript.Block) (string, bool) {
	if blk.Name != "Bash" {
		return "", false
	}
	var in struct {
		Command string `json:"command"`
	}
	_ = json.Unmarshal(blk.Input, &in) // a mistyped input leaves it empty
	return in.Command, in.Command != ""
}

// workCall is one call of a message that edits a file (edit) or runs a shell command, and the
// directory it works in. A call in a relative or unknown directory is not counted.
type workCall struct {
	dir  string
	abs  bool
	edit bool
}

// workSet counts work calls per directory.
type workSet map[string]*model.WorkDir

func (w workSet) add(c workCall) {
	if !c.abs {
		return
	}
	dir := path.Clean(c.dir)
	e := w[dir]
	if e == nil {
		e = &model.WorkDir{Dir: dir}
		w[dir] = e
	}
	if c.edit {
		e.Edits++
	} else {
		e.Commands++
	}
}

// list is the counts sorted by directory; nil when there are none.
func (w workSet) list() []model.WorkDir {
	if len(w) == 0 {
		return nil
	}
	out := make([]model.WorkDir, 0, len(w))
	for _, e := range w {
		out = append(out, *e)
	}
	slices.SortFunc(out, func(a, b model.WorkDir) int { return strings.Compare(a.Dir, b.Dir) })
	return out
}

// merge adds the counts of ds into w.
func (w workSet) merge(ds []model.WorkDir) {
	for _, d := range ds {
		e := w[d.Dir]
		if e == nil {
			e = &model.WorkDir{Dir: d.Dir}
			w[d.Dir] = e
		}
		e.Edits += d.Edits
		e.Commands += d.Commands
	}
}
