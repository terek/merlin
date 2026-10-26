package codex

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// maxLine bounds one rollout line. Lines carry whole command outputs and instructions;
// anything longer is counted as a bad line and skipped.
const maxLine = 256 << 20

// envelope is one line of a rollout file.
type envelope struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Ordinal   *int64          `json:"ordinal"`
	Payload   json.RawMessage `json:"payload"`
}

// sessionMeta is the payload of a session_meta record: the first line of every rollout.
type sessionMeta struct {
	ID             string          `json:"id"`
	SessionID      string          `json:"session_id"`
	ParentThreadID string          `json:"parent_thread_id"`
	Timestamp      string          `json:"timestamp"`
	Cwd            string          `json:"cwd"`
	Originator     string          `json:"originator"`
	CLIVersion     string          `json:"cli_version"`
	Source         json.RawMessage `json:"source"`
	AgentNickname  string          `json:"agent_nickname"`
	AgentPath      string          `json:"agent_path"`
	Git            *struct {
		Branch string `json:"branch"`
	} `json:"git"`
	ForkedFromID string `json:"forked_from_id"`
	HistoryBase  *struct {
		ThreadID            string `json:"thread_id"`
		EndByteOffset       int64  `json:"end_byte_offset"`
		EndOrdinalExclusive int64  `json:"end_ordinal_exclusive"`
	} `json:"history_base"`
	SubagentHistoryStartOrdinal *int64 `json:"subagent_history_start_ordinal"`
}

// Thread kinds, from session_meta.source.
const (
	sourceRoot     = "root"     // a conversation the user started (source is a string: vscode, cli, exec)
	sourceSpawn    = "spawn"    // a subagent started by spawn_agent
	sourceReview   = "review"   // a /review run
	sourceGuardian = "guardian" // an automatic approval reviewer
	sourceOther    = "other"    // a subagent of a kind this parser does not know
)

// threadSource is session_meta.source decoded.
type threadSource struct {
	Kind      string
	Name      string // the string source of a root thread (vscode, cli, exec)
	Parent    string
	Depth     int
	Nickname  string
	AgentPath string
	Role      string
}

func parseSource(raw json.RawMessage) threadSource {
	var name string
	if json.Unmarshal(raw, &name) == nil {
		return threadSource{Kind: sourceRoot, Name: name}
	}
	var obj struct {
		Subagent json.RawMessage `json:"subagent"`
	}
	if json.Unmarshal(raw, &obj) != nil || len(obj.Subagent) == 0 {
		return threadSource{Kind: sourceRoot}
	}
	if json.Unmarshal(obj.Subagent, &name) == nil {
		if name == "review" {
			return threadSource{Kind: sourceReview}
		}
		return threadSource{Kind: sourceOther, Name: name}
	}
	var sub struct {
		ThreadSpawn *struct {
			ParentThreadID string  `json:"parent_thread_id"`
			Depth          int     `json:"depth"`
			AgentNickname  string  `json:"agent_nickname"`
			AgentPath      string  `json:"agent_path"`
			AgentRole      *string `json:"agent_role"`
		} `json:"thread_spawn"`
		Other string `json:"other"`
	}
	if json.Unmarshal(obj.Subagent, &sub) != nil {
		return threadSource{Kind: sourceOther}
	}
	switch {
	case sub.ThreadSpawn != nil:
		s := sub.ThreadSpawn
		ts := threadSource{Kind: sourceSpawn, Parent: s.ParentThreadID, Depth: s.Depth, Nickname: s.AgentNickname, AgentPath: s.AgentPath}
		if s.AgentRole != nil {
			ts.Role = *s.AgentRole
		}
		return ts
	case sub.Other == "guardian":
		return threadSource{Kind: sourceGuardian}
	}
	return threadSource{Kind: sourceOther, Name: sub.Other}
}

// usage is a token count as Codex writes it: input includes cached input, output includes
// reasoning.
type usage struct {
	Input      int64 `json:"input_tokens"`
	Cached     int64 `json:"cached_input_tokens"`
	CacheWrite int64 `json:"cache_write_input_tokens"`
	Output     int64 `json:"output_tokens"`
	Reasoning  int64 `json:"reasoning_output_tokens"`
}

// usageRec is one token_usage_record: one billed API call.
type usageRec struct {
	ResponseID string
	At         time.Time
	Turn       int // index into thread.turns; -1 when before every turn
	Model      string
	Effort     string
	Tier       string // service tier in force (default, priority)
	Usage      usage
}

// userMsg is a prompt the user typed (an item_completed UserMessage).
type userMsg struct {
	At     time.Time
	Text   string
	Images int
}

// turnRec is one turn of a thread: task_started to task_complete or turn_aborted.
type turnRec struct {
	ID           string
	ParentTurnID string // the turn of the parent thread that set this one off
	Trigger      string
	StartedAt    time.Time
	EndedAt      time.Time // end record, else the turn's last record
	Ended        bool
	DurationMs   int64
	ErrorInfo    string // task_complete.error.codex_error_info
	AbortReason  string // turn_aborted.reason
	Model        string // turn_context
	Effort       string
	Cwd          string
	Users        []userMsg
	FinalText    string
	ToolCalls    int64
	ToolsByName  map[string]int64
	Files        []string
	LinesAdded   int64
	LinesRemoved int64
	Review       bool // entered review mode
	Compactions  int  // compacted records in it
}

// callRec is a collaboration tool call: spawn_agent, followup_task, send_message,
// interrupt_agent.
type callRec struct {
	Name     string
	CallID   string
	At       time.Time
	Turn     int
	TaskName string
	Model    string
	Effort   string
	Fork     string // fork_turns
	Message  string
	// Encrypted: the message is a Fernet token (Codex encrypts what agents send each other),
	// and Message is empty.
	Encrypted bool
	Target    string
}

// reportRec is a plain-text agent_message from another thread: a subagent's final answer.
type reportRec struct {
	At     time.Time
	Author string // agent path
	Text   string
	Turn   int
}

// compactRec is a compacted record.
type compactRec struct {
	At         time.Time
	Turn       int
	ResponseID string
}

// thread is one rollout file reduced.
type thread struct {
	Path      string
	Meta      sessionMeta
	Source    threadSource
	Turns     []turnRec
	Usage     []usageRec
	Calls     []callRec
	Reports   []reportRec
	Compacts  []compactRec
	Cwds      []string
	FirstAt   time.Time
	LastAt    time.Time
	BadLines  int64
	Unknown   map[string]int64
	Truncated bool // stopped at a byte or ordinal limit (an inherited prefix)
}

// limit bounds how much of a file is read: for a fork's inherited history, the part of
// the parent's file before the fork point.
type limit struct {
	bytes   int64 // 0 = no limit
	ordinal int64 // records with this ordinal or later are not read; 0 = no limit
}

// readMeta reads the session_meta of a rollout: its first line.
func readMeta(path string) (sessionMeta, error) {
	f, err := os.Open(path)
	if err != nil {
		return sessionMeta{}, err
	}
	defer f.Close()
	line, err := readLine(bufio.NewReaderSize(f, 64<<10))
	if err != nil && !errors.Is(err, io.EOF) {
		return sessionMeta{}, err
	}
	var env envelope
	if json.Unmarshal(line, &env) != nil || env.Type != "session_meta" {
		return sessionMeta{}, fmt.Errorf("%s: no session_meta on the first line", path)
	}
	var m sessionMeta
	if err := json.Unmarshal(env.Payload, &m); err != nil || m.ID == "" {
		return sessionMeta{}, fmt.Errorf("%s: session_meta without an id", path)
	}
	return m, nil
}

// readLine returns the next complete line without its newline. A last line without a
// newline (the file is being written) is returned with io.EOF and must be ignored.
func readLine(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := r.ReadSlice('\n')
		buf = append(buf, chunk...)
		if err == nil {
			return buf[:len(buf)-1], nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return buf, err
		}
		if len(buf) > maxLine {
			// Skip the rest of the line.
			for errors.Is(err, bufio.ErrBufferFull) {
				_, err = r.ReadSlice('\n')
			}
			if err != nil {
				return nil, err
			}
			return nil, errLongLine
		}
	}
}

var errLongLine = errors.New("line too long")

// readThread reduces one rollout file.
func readThread(path string, lim limit) (*thread, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var src io.Reader = f
	if lim.bytes > 0 {
		src = io.LimitReader(f, lim.bytes)
	}
	t := &thread{Path: path, Unknown: map[string]int64{}}
	p := newParser(t)
	r := bufio.NewReaderSize(src, 256<<10)
	for {
		line, err := readLine(r)
		if errors.Is(err, errLongLine) {
			t.BadLines++
			continue
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break // a partial last line is still being written
			}
			return nil, fmt.Errorf("codex: reading %s: %w", path, err)
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var env envelope
		if json.Unmarshal(line, &env) != nil {
			t.BadLines++
			continue
		}
		if lim.ordinal > 0 && env.Ordinal != nil && *env.Ordinal >= lim.ordinal {
			t.Truncated = true
			break
		}
		p.apply(env)
	}
	if lim.bytes > 0 {
		t.Truncated = true
	}
	p.finish()
	return t, nil
}

// parser holds the state of one pass over a rollout.
type parser struct {
	t        *thread
	byID     map[string]int // turn id -> index
	cur      int            // the turn records belong to; -1 before the first
	model    string         // latest model from settings or turn context
	effort   string
	tier     string
	skipTo   int64 // records with a smaller ordinal are a copy of the parent's history
	haveMeta bool
	cwds     map[string]bool
	// review is set by EnteredReviewMode, which Codex writes between the turn that asked for
	// a review and the turn that runs it.
	review bool
}

func newParser(t *thread) *parser {
	return &parser{t: t, byID: map[string]int{}, cur: -1, cwds: map[string]bool{}}
}

func (p *parser) addCwd(c string) {
	if c != "" && !p.cwds[c] {
		p.cwds[c] = true
		p.t.Cwds = append(p.t.Cwds, c)
	}
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}

func (p *parser) apply(env envelope) {
	t := p.t
	at := parseTime(env.Timestamp)
	if env.Type == "session_meta" {
		if p.haveMeta {
			return // a copied parent's meta inside a subagent's history
		}
		p.haveMeta = true
		if json.Unmarshal(env.Payload, &t.Meta) != nil {
			t.BadLines++
			return
		}
		t.Source = parseSource(t.Meta.Source)
		if t.Source.Parent == "" {
			t.Source.Parent = t.Meta.ParentThreadID
		}
		if t.Source.AgentPath == "" {
			t.Source.AgentPath = t.Meta.AgentPath
		}
		if t.Source.Nickname == "" {
			t.Source.Nickname = t.Meta.AgentNickname
		}
		if s := t.Meta.SubagentHistoryStartOrdinal; s != nil {
			p.skipTo = *s
		}
		p.addCwd(t.Meta.Cwd)
		if t.FirstAt.IsZero() {
			t.FirstAt = parseTime(t.Meta.Timestamp)
		}
		return
	}
	if env.Ordinal != nil && *env.Ordinal < p.skipTo {
		return
	}
	if !at.IsZero() {
		if t.FirstAt.IsZero() || at.Before(t.FirstAt) {
			t.FirstAt = at
		}
		if at.After(t.LastAt) {
			t.LastAt = at
		}
		if p.cur >= 0 && at.After(t.Turns[p.cur].EndedAt) && !t.Turns[p.cur].Ended {
			t.Turns[p.cur].EndedAt = at
		}
	}

	switch env.Type {
	case "event_msg":
		p.event(env.Payload, at)
	case "response_item":
		p.responseItem(env.Payload, at)
	case "turn_context":
		var c struct {
			TurnID string `json:"turn_id"`
			Model  string `json:"model"`
			Effort string `json:"effort"`
			Cwd    string `json:"cwd"`
			Mode   struct {
				Settings struct {
					Effort string `json:"reasoning_effort"`
				} `json:"settings"`
			} `json:"collaboration_mode"`
		}
		if json.Unmarshal(env.Payload, &c) != nil {
			t.BadLines++
			return
		}
		effort := c.Effort
		if effort == "" {
			effort = c.Mode.Settings.Effort
		}
		if c.Model != "" {
			p.model = c.Model
		}
		p.effort = effort
		p.addCwd(c.Cwd)
		if i, ok := p.byID[c.TurnID]; ok {
			tr := &t.Turns[i]
			tr.Model, tr.Effort, tr.Cwd = c.Model, effort, c.Cwd
		}
	case "token_usage_record":
		var u struct {
			ResponseID string `json:"response_id"`
			TurnID     string `json:"turn_id"`
			Usage      usage  `json:"usage"`
		}
		if json.Unmarshal(env.Payload, &u) != nil || u.ResponseID == "" {
			t.BadLines++
			return
		}
		turn := p.cur
		if i, ok := p.byID[u.TurnID]; ok {
			turn = i
		}
		rec := usageRec{ResponseID: u.ResponseID, At: at, Turn: turn, Model: p.model, Effort: p.effort, Tier: p.tier, Usage: u.Usage}
		if turn >= 0 && t.Turns[turn].Model != "" {
			rec.Model, rec.Effort = t.Turns[turn].Model, t.Turns[turn].Effort
		}
		t.Usage = append(t.Usage, rec)
	case "compacted":
		var c struct {
			ResponseID string `json:"compaction_response_id"`
		}
		_ = json.Unmarshal(env.Payload, &c)
		t.Compacts = append(t.Compacts, compactRec{At: at, Turn: p.cur, ResponseID: c.ResponseID})
		if p.cur >= 0 {
			t.Turns[p.cur].Compactions++
		}
	case "world_state", "inter_agent_communication_metadata":
	default:
		t.Unknown[env.Type]++
	}
}

func (p *parser) event(raw json.RawMessage, at time.Time) {
	t := p.t
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &head) != nil {
		t.BadLines++
		return
	}
	switch head.Type {
	case "task_started":
		var e struct {
			TurnID string `json:"turn_id"`
			Attr   struct {
				ParentTurnID string `json:"parent_turn_id"`
				Trigger      string `json:"turn_trigger"`
			} `json:"turn_attribution"`
		}
		if json.Unmarshal(raw, &e) != nil {
			t.BadLines++
			return
		}
		id, parent := e.TurnID, e.Attr.ParentTurnID
		if t.Source.Kind == sourceRoot && parent != "" {
			// A root thread has no parent turn: this is a child's turn mirrored into the
			// root while the root's own turn (named here as the parent) runs, as for /review.
			id, parent = parent, ""
		}
		if i, ok := p.byID[id]; ok {
			p.cur = i
			return
		}
		p.byID[id] = len(t.Turns)
		p.cur = len(t.Turns)
		t.Turns = append(t.Turns, turnRec{ID: id, ParentTurnID: parent, Trigger: e.Attr.Trigger, StartedAt: at, EndedAt: at, Review: p.review})
		p.review = false
	case "task_complete", "turn_aborted":
		var e struct {
			TurnID     string `json:"turn_id"`
			DurationMs int64  `json:"duration_ms"`
			Reason     string `json:"reason"`
			LastAnswer string `json:"last_agent_message"`
			Error      *struct {
				Info string `json:"codex_error_info"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &e) != nil {
			t.BadLines++
			return
		}
		i, ok := p.byID[e.TurnID]
		if !ok {
			i = p.cur
		}
		if i < 0 {
			return
		}
		tr := &t.Turns[i]
		tr.Ended, tr.DurationMs = true, e.DurationMs
		if !at.IsZero() {
			tr.EndedAt = at
		}
		if head.Type == "turn_aborted" {
			tr.AbortReason = e.Reason
			if tr.AbortReason == "" {
				tr.AbortReason = "aborted"
			}
		} else if e.Error != nil {
			tr.ErrorInfo = e.Error.Info
			if tr.ErrorInfo == "" {
				tr.ErrorInfo = "error"
			}
		}
		if e.LastAnswer != "" {
			tr.FinalText = e.LastAnswer
		}
	case "thread_settings_applied":
		var e struct {
			Settings struct {
				Model  string `json:"model"`
				Effort string `json:"reasoning_effort"`
				Tier   string `json:"service_tier"`
			} `json:"thread_settings"`
		}
		if json.Unmarshal(raw, &e) == nil {
			if e.Settings.Model != "" {
				p.model = e.Settings.Model
			}
			p.effort = e.Settings.Effort
			p.tier = e.Settings.Tier
		}
	case "item_completed":
		p.item(raw, at)
	case "token_count":
	default:
		t.Unknown["event_msg/"+head.Type]++
	}
}

func (p *parser) item(raw json.RawMessage, at time.Time) {
	t := p.t
	var e struct {
		Item struct {
			Type    string `json:"type"`
			Phase   string `json:"phase"`
			Status  string `json:"status"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			Changes map[string]struct {
				Type     string  `json:"type"`
				Content  string  `json:"content"`
				Diff     string  `json:"unified_diff"`
				MovePath *string `json:"move_path"`
			} `json:"changes"`
		} `json:"item"`
	}
	if json.Unmarshal(raw, &e) != nil {
		t.BadLines++
		return
	}
	it := e.Item
	if it.Type == "EnteredReviewMode" && (p.cur < 0 || t.Turns[p.cur].Ended) {
		p.review = true
		return
	}
	if p.cur < 0 {
		return
	}
	tr := &t.Turns[p.cur]
	switch it.Type {
	case "UserMessage":
		u := userMsg{At: at}
		var parts []string
		for _, c := range it.Content {
			switch c.Type {
			case "text":
				parts = append(parts, c.Text)
			case "local_image", "image":
				u.Images++
			}
		}
		u.Text = strings.Join(parts, "\n")
		tr.Users = append(tr.Users, u)
	case "AgentMessage":
		if it.Phase == "final_answer" {
			var parts []string
			for _, c := range it.Content {
				if c.Text != "" {
					parts = append(parts, c.Text)
				}
			}
			tr.FinalText = strings.Join(parts, "\n")
		}
	case "FileChange":
		if it.Status != "" && it.Status != "completed" {
			return
		}
		paths := make([]string, 0, len(it.Changes))
		for path := range it.Changes {
			paths = append(paths, path)
		}
		sortStrings(paths)
		for _, path := range paths {
			c := it.Changes[path]
			tr.Files = appendUniq(tr.Files, path)
			if c.MovePath != nil && *c.MovePath != "" {
				tr.Files = appendUniq(tr.Files, *c.MovePath)
			}
			switch c.Type {
			case "add":
				tr.LinesAdded += countLines(c.Content)
			case "delete":
				tr.LinesRemoved += countLines(c.Content)
			default:
				a, r := diffLines(c.Diff)
				tr.LinesAdded += a
				tr.LinesRemoved += r
			}
		}
	case "EnteredReviewMode":
		tr.Review = true
	}
}

func (p *parser) responseItem(raw json.RawMessage, at time.Time) {
	t := p.t
	var r struct {
		Type      string `json:"type"`
		Name      string `json:"name"`
		CallID    string `json:"call_id"`
		Arguments string `json:"arguments"`
		Author    string `json:"author"`
		Content   []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &r) != nil {
		t.BadLines++
		return
	}
	switch r.Type {
	case "custom_tool_call", "function_call":
		if p.cur >= 0 {
			tr := &t.Turns[p.cur]
			tr.ToolCalls++
			if tr.ToolsByName == nil {
				tr.ToolsByName = map[string]int64{}
			}
			tr.ToolsByName[r.Name]++
		}
		switch r.Name {
		case "spawn_agent", "followup_task", "send_message", "interrupt_agent":
			var a struct {
				TaskName string `json:"task_name"`
				Model    string `json:"model"`
				Effort   string `json:"reasoning_effort"`
				Fork     string `json:"fork_turns"`
				Message  string `json:"message"`
				Target   string `json:"target"`
			}
			_ = json.Unmarshal([]byte(r.Arguments), &a)
			c := callRec{Name: r.Name, CallID: r.CallID, At: at, Turn: p.cur, TaskName: a.TaskName,
				Model: a.Model, Effort: a.Effort, Fork: a.Fork, Message: a.Message, Target: a.Target}
			if fernet(c.Message) {
				c.Message, c.Encrypted = "", true
			}
			t.Calls = append(t.Calls, c)
		}
	case "agent_message":
		own := t.Source.AgentPath
		if own == "" {
			own = "/root"
		}
		if r.Author == "" || r.Author == own {
			return
		}
		var parts []string
		for _, c := range r.Content {
			if c.Type == "encrypted_content" {
				return // a message whose text is only in the sender's call
			}
			if c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		t.Reports = append(t.Reports, reportRec{At: at, Author: r.Author, Text: strings.Join(parts, "\n"), Turn: p.cur})
	case "message", "reasoning", "custom_tool_call_output", "function_call_output", "additional_tools", "compaction",
		"web_search_call", "local_shell_call":
	default:
		t.Unknown["response_item/"+r.Type]++
	}
}

func (p *parser) finish() {
	if len(p.t.Unknown) == 0 {
		p.t.Unknown = nil
	}
}

func appendUniq(list []string, s string) []string {
	for _, x := range list {
		if x == s {
			return list
		}
	}
	return append(list, s)
}

func countLines(s string) int64 {
	if s == "" {
		return 0
	}
	n := int64(strings.Count(s, "\n"))
	if !strings.HasSuffix(s, "\n") {
		n++
	}
	return n
}

// diffLines counts the added and removed lines of a unified diff. File headers (--- and
// +++ before the first hunk) are not lines.
func diffLines(d string) (added, removed int64) {
	inHunk := false
	for _, l := range strings.Split(d, "\n") {
		switch {
		case strings.HasPrefix(l, "@@"):
			inHunk = true
		case !inHunk && (strings.HasPrefix(l, "+++") || strings.HasPrefix(l, "---")):
		case strings.HasPrefix(l, "+"):
			added++
		case strings.HasPrefix(l, "-"):
			removed++
		}
	}
	return added, removed
}

// fernet reports whether s is a Fernet token, as Codex stores the messages its agents send each
// other: URL-safe base64 of version byte 0x80, a timestamp, an IV, the ciphertext and an HMAC.
func fernet(s string) bool {
	if len(s) < 100 || !strings.HasPrefix(s, "gAAAAA") {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	return err == nil && len(b) >= 73 && b[0] == 0x80 && (len(b)-57)%16 == 0
}
