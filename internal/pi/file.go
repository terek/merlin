package pi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// maxLine bounds one line. Tool results carry whole file contents; a line over the bound is
// skipped and counted as a bad line, never fatal.
const maxLine = 256 << 20

// Tolerant scalar types: a field of the wrong type reads as its zero value instead of
// failing the whole entry.
type str string

func (s *str) UnmarshalJSON(b []byte) error {
	var v string
	if json.Unmarshal(b, &v) == nil {
		*s = str(v)
	}
	return nil
}

type num float64

func (n *num) UnmarshalJSON(b []byte) error {
	var v float64
	if json.Unmarshal(b, &v) == nil {
		*n = num(v)
	}
	return nil
}

type flag bool

func (f *flag) UnmarshalJSON(b []byte) error {
	var v bool
	if json.Unmarshal(b, &v) == nil {
		*f = flag(v)
	}
	return nil
}

// header is the first line of a session file.
type header struct {
	Type          str `json:"type"`
	Version       num `json:"version"`
	ID            str `json:"id"`
	Timestamp     str `json:"timestamp"`
	Cwd           str `json:"cwd"`
	ParentSession str `json:"parentSession"`
}

// usage is the token and cost record Pi keeps for a model call. The buckets are disjoint:
// input excludes cache reads and writes, output includes reasoning.
type usage struct {
	Input        num `json:"input"`
	Output       num `json:"output"`
	CacheRead    num `json:"cacheRead"`
	CacheWrite   num `json:"cacheWrite"`
	CacheWrite1h num `json:"cacheWrite1h"`
	Reasoning    num `json:"reasoning"`
	TotalTokens  num `json:"totalTokens"`
	Cost         struct {
		Total num `json:"total"`
	} `json:"cost"`
}

func (u *usage) tokens() int64 {
	sum := int64(u.Input) + int64(u.Output) + int64(u.CacheRead) + int64(u.CacheWrite)
	return max(sum, int64(u.TotalTokens))
}

// wire is one line as Pi writes it. Fields of different entry types share the struct.
type wire struct {
	Type      str             `json:"type"`
	ID        str             `json:"id"`
	ParentID  str             `json:"parentId"`
	Timestamp str             `json:"timestamp"`
	Message   json.RawMessage `json:"message"`

	// compaction, branch_summary
	Summary      str    `json:"summary"`
	TokensBefore num    `json:"tokensBefore"`
	Usage        *usage `json:"usage"`

	// model_change, usage
	Provider str `json:"provider"`
	ModelID  str `json:"modelId"`
	Model    str `json:"model"`
	Kind     str `json:"kind"`

	// session_info
	Name str `json:"name"`
}

type wireMessage struct {
	Role       str             `json:"role"`
	Content    json.RawMessage `json:"content"`
	Timestamp  num             `json:"timestamp"`
	Model      str             `json:"model"`
	Provider   str             `json:"provider"`
	Usage      *usage          `json:"usage"`
	StopReason str             `json:"stopReason"`
	ToolCallID str             `json:"toolCallId"`
	ToolName   str             `json:"toolName"`
	IsError    flag            `json:"isError"`
	Details    json.RawMessage `json:"details"`
	// bashExecution
	Command  str             `json:"command"`
	Output   str             `json:"output"`
	ExitCode json.RawMessage `json:"exitCode"`
}

type block struct {
	Type      str             `json:"type"`
	Text      str             `json:"text"`
	ID        str             `json:"id"`
	Name      str             `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// callRec is one toolCall block of an assistant message.
type callRec struct {
	ID      string
	Name    string
	Path    string // arguments.path: read, edit, write, ...
	Command string // arguments.command: bash
}

// rec is one entry of the file, reduced to what the digest needs.
type rec struct {
	line   int
	typ    string
	id     string
	parent string    // "" at a root
	at     time.Time // the entry's timestamp: when it was appended

	// message
	role     string
	msgMs    int64 // message.timestamp, Unix ms; 0 when absent
	model    string
	provider string
	stop     string
	usage    *usage
	text     string
	images   int
	calls    []callRec

	// toolResult
	toolCallID string
	toolName   string
	isErr      bool
	output     string // the result text of a bash call, or a bashExecution's output
	added      int64  // lines of an edit's diff
	removed    int64
	runs       []subRun // agent runs the result carries (see subagent.go)

	// bashExecution
	command  string
	exitCode *int

	// compaction, branch_summary
	summary      string
	tokensBefore int64

	// session_info
	name string
}

// parsed is the reduction of one file.
type parsed struct {
	head    header
	hasHead bool
	recs    []rec
	bad     int64
	unknown map[string]int64
	nest    int // depth of the child messages being read; bounds the recursion
}

// knownTypes are the entry types the parser understands; used ones feed the digest, the
// others are known and deliberately unused (not counted as unknown).
var knownTypes = map[string]bool{
	"message": true, "model_change": true, "thinking_level_change": true, "compaction": true,
	"branch_summary": true, "usage": true, "context_edit": true, "custom": true,
	"custom_message": true, "label": true, "session_info": true,
}

// knownRoles are the message roles the parser understands. system, custom and hookMessage
// are known and not used.
var knownRoles = map[string]bool{
	"user": true, "assistant": true, "toolResult": true, "bashExecution": true,
	"system": true, "custom": true, "hookMessage": true,
}

// readFile reduces one session file. A line that cannot be read counts as a bad line.
func readFile(path string) (*parsed, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	p := &parsed{unknown: map[string]int64{}}
	r := bufio.NewReaderSize(f, 256<<10)
	prev := ""
	for n := 1; ; n++ {
		line, complete, err := readLine(r)
		if errors.Is(err, errLongLine) {
			p.bad++
			continue
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		if len(bytes.TrimSpace(line)) > 0 {
			prev = p.add(n, line, prev, complete)
		}
		if err != nil {
			return p, nil
		}
	}
}

var errLongLine = errors.New("line too long")

// readLine returns the next line without its newline. complete is false for a last line
// that has none (the file is being written).
func readLine(r *bufio.Reader) (line []byte, complete bool, err error) {
	var buf []byte
	for {
		chunk, err := r.ReadSlice('\n')
		if len(buf)+len(chunk) > maxLine {
			for errors.Is(err, bufio.ErrBufferFull) {
				_, err = r.ReadSlice('\n')
			}
			if err != nil {
				return nil, false, err
			}
			return nil, true, errLongLine
		}
		buf = append(buf, chunk...)
		switch {
		case err == nil:
			return buf[:len(buf)-1], true, nil
		case errors.Is(err, bufio.ErrBufferFull):
		default:
			return buf, false, err
		}
	}
}

// add parses one line and returns the id of the entry to chain a following id-less entry to.
func (p *parsed) add(n int, line []byte, prev string, complete bool) string {
	var w wire
	if err := json.Unmarshal(line, &w); err != nil {
		if complete { // a last line still being written is no fault
			p.bad++
		}
		return prev
	}
	if !p.hasHead && w.Type == "session" {
		if json.Unmarshal(line, &p.head) != nil {
			p.bad++
			return prev
		}
		p.hasHead = true
		return prev
	}
	typ := string(w.Type)
	switch {
	case typ == "":
		p.unknown["(no type)"]++
	case typ == "session":
		p.unknown["session (again)"]++
	case !knownTypes[typ]:
		p.unknown[typ]++
	}
	r := rec{line: n, typ: typ, id: string(w.ID), parent: string(w.ParentID)}
	r.at, _ = time.Parse(time.RFC3339Nano, string(w.Timestamp))
	r.at = r.at.UTC()
	if r.id == "" { // version 1 files: linear, no ids
		r.id = fmt.Sprintf("#%d", n)
		r.parent = prev
	}
	switch typ {
	case "message":
		p.message(&r, w.Message)
	case "compaction":
		r.summary, r.tokensBefore, r.usage = string(w.Summary), int64(w.TokensBefore), w.Usage
	case "branch_summary":
		r.usage = w.Usage
	case "usage":
		r.usage, r.model, r.provider = w.Usage, string(w.Model), string(w.Provider)
	case "model_change":
		r.model, r.provider = string(w.ModelID), string(w.Provider)
	case "session_info":
		r.name = string(w.Name)
	}
	p.recs = append(p.recs, r)
	return r.id
}

func (p *parsed) message(r *rec, raw json.RawMessage) {
	var m wireMessage
	if len(raw) == 0 || json.Unmarshal(raw, &m) != nil {
		p.unknown["message (unreadable)"]++
		return
	}
	r.role = string(m.Role)
	if !knownRoles[r.role] {
		p.unknown["message:"+r.role]++
	}
	if m.Timestamp > 0 {
		r.msgMs = int64(m.Timestamp)
	}
	switch r.role {
	case "user":
		blocks, s, isStr := content(m.Content)
		if isStr {
			r.text = s
		}
		var texts []string
		for _, b := range blocks {
			switch b.Type {
			case "text":
				texts = append(texts, string(b.Text))
			case "image":
				r.images++
			}
		}
		if !isStr {
			r.text = strings.Join(texts, "\n")
		}
	case "assistant":
		r.model, r.provider, r.stop, r.usage = string(m.Model), string(m.Provider), string(m.StopReason), m.Usage
		blocks, s, isStr := content(m.Content)
		var texts []string
		if isStr {
			texts = append(texts, s)
		}
		for _, b := range blocks {
			switch b.Type {
			case "text":
				texts = append(texts, string(b.Text))
			case "toolCall":
				c := callRec{ID: string(b.ID), Name: string(b.Name)}
				var args struct {
					Path    str `json:"path"`
					Command str `json:"command"`
				}
				if json.Unmarshal(b.Arguments, &args) == nil {
					c.Path, c.Command = string(args.Path), string(args.Command)
				}
				r.calls = append(r.calls, c)
			}
		}
		r.text = strings.Join(texts, "\n")
	case "toolResult":
		r.toolCallID, r.toolName, r.isErr, r.usage = string(m.ToolCallID), string(m.ToolName), bool(m.IsError), m.Usage
		r.runs = p.runs(m.Details)
		switch r.toolName {
		case "bash":
			blocks, s, isStr := content(m.Content)
			if isStr {
				r.output = s
				break
			}
			var texts []string
			for _, b := range blocks {
				if b.Type == "text" {
					texts = append(texts, string(b.Text))
				}
			}
			r.output = strings.Join(texts, "\n")
		case "edit":
			var d struct {
				Diff str `json:"diff"`
			}
			if json.Unmarshal(m.Details, &d) == nil {
				r.added, r.removed = diffLines(string(d.Diff))
			}
		}
	case "bashExecution":
		r.command, r.output = string(m.Command), string(m.Output)
		var code int
		if len(m.ExitCode) > 0 && json.Unmarshal(m.ExitCode, &code) == nil {
			r.exitCode = &code
		}
	}
}

// content reads message.content: a string or a list of blocks.
func content(raw json.RawMessage) (blocks []block, s string, isStr bool) {
	if len(raw) == 0 {
		return nil, "", false
	}
	if raw[0] == '"' {
		if json.Unmarshal(raw, &s) == nil {
			return nil, s, true
		}
		return nil, "", false
	}
	_ = json.Unmarshal(raw, &blocks)
	return blocks, "", false
}

// diffLines counts the added and removed lines of an edit's diff: Pi writes "+N text",
// "-N text" and " N text" for context.
func diffLines(d string) (added, removed int64) {
	for len(d) > 0 {
		var l string
		l, d, _ = strings.Cut(d, "\n")
		if l == "" {
			continue
		}
		switch l[0] {
		case '+':
			added++
		case '-':
			removed++
		}
	}
	return added, removed
}
