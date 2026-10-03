package digest

import (
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/terek/merlin/explorer/internal/claude/transcript"
	"github.com/terek/merlin/explorer/internal/model"
)

// Pricer prices one API message. *pricing.Table satisfies it. ok is false for a model
// that is not in the table; "<synthetic>" must price to zero with ok true.
type Pricer interface {
	Cost(name string, tok model.Tokens, fast bool) (model.ModelCost, bool)
}

// summaryWindow is how many records after a compact boundary the isCompactSummary record
// may sit and still be attached to it (usually +1, sometimes +2).
const summaryWindow = 4

// node is one entry of the uuid chain.
type node struct {
	parent string
	pos    int
}

// tailKind is the kind of the last conversation record of a file.
type tailKind int

const (
	tailNone tailKind = iota
	tailPrompt
	tailToolResult
	tailAssistant
)

// turnState is the mutable form of a turn.
type turnState struct {
	epoch       int
	uuid        string
	promptPos   int // -1 for a continuation turn
	startedAt   time.Time
	endedAt     time.Time
	durationMs  int64 // from a turn_duration record, 0 when absent
	origin      model.TurnOrigin
	userText    string
	inbox       []model.InboxMessage
	queued      []model.QueuedPrompt
	images      int
	command     string
	interrupted bool
	msgs        []int // indexes into Builder.msgs, in order of first appearance
}

// toolUse is one tool_use block of a message.
type toolUse struct {
	name string
	file string // file_path of an Edit / Write / NotebookEdit input
}

// msgState groups the assistant lines of one API message.
type msgState struct {
	id        string
	model     string
	usage     transcript.Usage // from the last line
	stop      string           // stop_reason of the last line; empty when null
	firstTS   time.Time
	turn      int
	texts     []string
	tools     []toolUse
	toolIDs   map[string]struct{}
	synthetic bool
}

// Builder reduces the records of ONE transcript file into a FileResult. Feed it records
// with Apply in file order; it never needs a later record. Result may be called at any
// time, any number of times; it finalises a copy and leaves the Builder untouched, so a
// kept Builder can be fed appended records later. A Builder is not safe for concurrent
// use.
type Builder struct {
	pricer Pricer

	pos      int             // number of records accepted so far (position of the next)
	nodes    map[string]node // every uuid seen -> parent and position
	lastConv string          // uuid of the last user/assistant record

	epoch int // compactions so far
	cur   int // index of the current turn, -1 when none
	turns []turnState

	msgs   []*msgState
	msgIdx map[string]int

	compactions    []model.Compaction
	pendingSummary int // index of a compaction awaiting its summary, -1 when none
	pendingPos     int

	spawns       []AgentSpawn
	spawnIDs     map[string]struct{}
	spawnRes     []SpawnResult
	notes        []TaskNotification
	workflows    []WorkflowLaunch
	compVersions []string // harness version at each compaction, parallel to compactions
	killed       []AgentsKilled
	costStates   []CostStateRecord
	recaps       []model.Recap
	forkRefs     []ForkContextRef
	forkedFrom   *model.ForkRef
	aiTitle      string
	customTitle  string
	agentName    string
	lastPrompt   string
	lastLeaf     string

	slugs, cwds, branches, versions, entrypoints, kinds, sessionIDs, agentIDs, inherited uniq

	first, last time.Time

	// tail describes the last conversation record: what the file ends on.
	tail     tailKind
	tailText bool   // the last assistant line ends in a text block
	lastCwd  string // working directory of the latest record that names one
	tailStop string // stop_reason of the last assistant line when tail is tailAssistant

	counters Counters
	unknown  map[string]int64
	badLines int64
}

// NewBuilder returns an empty Builder that prices messages with pricer.
func NewBuilder(pricer Pricer) *Builder {
	return &Builder{
		pricer:         pricer,
		nodes:          make(map[string]node),
		cur:            -1,
		msgIdx:         make(map[string]int),
		pendingSummary: -1,
		spawnIDs:       make(map[string]struct{}),
		unknown:        make(map[string]int64),
	}
}

// AddBadLines adds n to the count of unparseable lines (the transcript Reader's
// BadLines). The Builder never sees such lines, so the caller reports them.
func (b *Builder) AddBadLines(n int) { b.badLines += int64(n) }

// Feed applies every remaining record of r, then adds r's bad-line count. A Reader
// continues where a previous one stopped (OpenAt), so Feed can be called once per
// Reader. It returns nil at end of file.
func (b *Builder) Feed(r *transcript.Reader) error {
	for {
		rec, err := r.Next()
		if errors.Is(err, io.EOF) {
			b.AddBadLines(r.BadLines())
			return nil
		}
		if err != nil {
			return err
		}
		b.Apply(rec)
	}
}

// Apply reduces one record. Records must arrive in file order.
func (b *Builder) Apply(r *transcript.Record) {
	if r == nil {
		return
	}
	b.counters.Records++
	if !r.Known() {
		t := r.Type
		if t == "" {
			t = "(none)"
		}
		b.unknown[t]++
		return
	}
	if r.UUID != "" {
		if _, dup := b.nodes[r.UUID]; dup {
			b.counters.DuplicateUUIDs++
			return
		}
		parent := r.ParentUUID
		if r.IsCompactBoundary() && r.LogicalParentUUID != "" {
			parent = r.LogicalParentUUID
		}
		b.nodes[r.UUID] = node{parent: parent, pos: b.pos}
	}
	pos := b.pos
	b.pos++

	prevLast := b.last // latest timestamp before this record
	ts, hasTS := r.Time()
	if hasTS {
		if b.first.IsZero() || ts.Before(b.first) {
			b.first = ts
		}
		if ts.After(b.last) {
			b.last = ts
		}
	}
	b.envelope(r)

	away := false
	switch r.Type {
	case transcript.TypeAssistant:
		b.assistant(r, ts, pos)
		if r.UUID != "" {
			b.lastConv = r.UUID
		}
	case transcript.TypeUser:
		b.user(r, ts, pos)
		if r.UUID != "" {
			b.lastConv = r.UUID
		}
	case transcript.TypeSystem:
		away = b.system(r, ts, pos)
	case transcript.TypeAttachment:
		b.queued(r, ts)
	case transcript.TypeAITitle:
		if t := r.AITitle(); t != "" {
			b.aiTitle = t
		}
	case transcript.TypeCustomTitle:
		if t := r.CustomTitle(); t != "" {
			b.customTitle = t
		}
	case transcript.TypeAgentName:
		if t := r.AgentName(); t != "" {
			b.agentName = t
		}
	case transcript.TypeLastPrompt:
		if p, leaf, ok := r.LastPrompt(); ok {
			b.lastPrompt, b.lastLeaf = p, leaf
		}
	case transcript.TypeCostState:
		if c, ok := r.CostState(); ok {
			rec := costStateRecord(c)
			rec.At = prevLast
			b.costStates = append(b.costStates, rec)
		}
	case transcript.TypeRelocated:
		b.cwds.add(r.RelocatedCwd())
		if c := r.RelocatedCwd(); c != "" {
			b.lastCwd = c
		}
	case transcript.TypeForkContextRef:
		if f, ok := r.ForkContextRef(); ok {
			b.forkRefs = append(b.forkRefs, ForkContextRef{
				AgentID: f.AgentID, ParentSessionID: f.ParentSessionID,
				ParentLastUUID: f.ParentLastUUID, ContextLength: f.ContextLength,
			})
		}
	}

	// Every timestamped record belongs to the current turn, which gives the turn its end.
	// An away summary is written long after the work and does not extend it.
	if hasTS && !away && b.cur >= 0 && ts.After(b.turns[b.cur].endedAt) {
		b.turns[b.cur].endedAt = ts
	}
}

// envelope collects the per-file sets from the envelope.
func (b *Builder) envelope(r *transcript.Record) {
	b.cwds.add(r.Cwd)
	if r.Cwd != "" {
		b.lastCwd = r.Cwd
	}
	b.branches.add(r.GitBranch)
	b.versions.add(r.Version)
	b.entrypoints.add(r.Entrypoint)
	b.kinds.add(r.SessionKind)
	b.slugs.add(r.Slug)
	b.sessionIDs.add(r.SessionID)
	b.agentIDs.add(r.AgentID)
	if r.OtherSessionID != "" && r.OtherSessionID != r.SessionID {
		b.inherited.add(r.OtherSessionID)
	}
	if f := r.ForkedFrom; f != nil && b.forkedFrom == nil {
		b.forkedFrom = &model.ForkRef{SessionID: f.SessionID, MessageUUID: f.MessageUUID}
	}
}

func costStateRecord(c *transcript.CostState) CostStateRecord {
	rec := CostStateRecord{
		TotalCostUSD: c.TotalCostUSD, StartTime: c.StartTime,
		LinesAdded: c.TotalLinesAdded, LinesRemoved: c.TotalLinesRemoved,
	}
	rec.Start = parseEpochMillis(c.StartTime)
	if len(c.ModelUsage) > 0 {
		rec.ByModel = make(map[string]model.ReportedModel, len(c.ModelUsage))
		for name, u := range c.ModelUsage {
			name = strings.TrimSuffix(name, "[1m]")
			m := rec.ByModel[name]
			m.InputTokens += u.InputTokens
			m.OutputTokens += u.OutputTokens
			m.ThinkingTokens += u.ThinkingTokens
			m.CacheReadTokens += u.CacheReadInputTokens
			m.CacheCreationTokens += u.CacheCreationInputTokens
			m.WebSearchRequests += u.WebSearchRequests
			m.USD += u.CostUSD
			rec.ByModel[name] = m
		}
	}
	return rec
}

// startTurn opens a new turn and makes it current.
func (b *Builder) startTurn(t turnState) {
	t.epoch = b.epoch
	b.turns = append(b.turns, t)
	b.cur = len(b.turns) - 1
}

// system handles system records. It reports whether the record is an away summary.
func (b *Builder) system(r *transcript.Record, ts time.Time, pos int) (away bool) {
	switch r.Subtype {
	case transcript.SubtypeCompactBoundary:
		c := model.Compaction{At: ts, Turn: len(b.turns) - 1}
		if md, ok := r.CompactMetadata(); ok {
			c.Trigger = model.CompactionTrigger(md.Trigger)
			c.PreTokens = md.PreTokens
			if md.PostTokens != nil {
				c.PostTokens = *md.PostTokens
			}
			if md.DurationMs != nil {
				c.DurationMs = *md.DurationMs
			}
		}
		b.compactions = append(b.compactions, c)
		b.compVersions = append(b.compVersions, r.Version)
		b.pendingSummary, b.pendingPos = len(b.compactions)-1, pos
		b.epoch++
	case transcript.SubtypeTurnDuration:
		if ms, _, ok := r.TurnDuration(); ok && b.cur >= 0 {
			b.turns[b.cur].durationMs = ms
		}
	case transcript.SubtypeAwaySummary:
		if text, ok := r.AwaySummary(); ok {
			b.recaps = append(b.recaps, model.Recap{At: ts, Text: recapText(text)})
		}
		return true
	case transcript.SubtypeAgentsKilled:
		b.killed = append(b.killed, AgentsKilled{
			Turn: b.cur, At: ts, AgentIDs: killedAgentIDs(r.Raw), Raw: r.Raw,
		})
	}
	return false
}

// queued handles a prompt that arrived while a turn was running. It starts no turn: it is
// kept on the running turn, and a task notification among them counts like any other.
func (b *Builder) queued(r *transcript.Record, ts time.Time) {
	q, ok := r.QueuedCommand()
	if !ok {
		return
	}
	text := q.Prompt.Text()
	origin := q.PromptOrigin()
	if origin == model.OriginTaskNotification {
		n := parseNotification(text)
		n.Turn, n.At = b.cur, ts
		b.notes = append(b.notes, n)
	}
	if b.cur < 0 || strings.TrimSpace(text) == "" {
		return
	}
	qp := model.QueuedPrompt{At: ts, Origin: origin, Text: text}
	if origin == model.OriginPeer || origin == model.OriginTaskNotification {
		if msgs, rest, ok := delivered(text, ts); ok {
			qp.Inbox, qp.Text = msgs, rest
		}
	}
	b.turns[b.cur].queued = append(b.turns[b.cur].queued, qp)
}

// user handles user records: summaries, tool results and prompts.
func (b *Builder) user(r *transcript.Record, ts time.Time, pos int) {
	if r.IsCompactSummary {
		if b.pendingSummary >= 0 && pos-b.pendingPos <= summaryWindow {
			c := &b.compactions[b.pendingSummary]
			c.Summary = r.PromptText()
			c.Boilerplate = summaryBoilerplate(c.Summary)
			b.pendingSummary = -1
		} else {
			b.counters.UnattachedSummaries++
		}
		return
	}
	if r.IsToolResult() {
		b.tail = tailToolResult
		b.toolResult(r, ts)
		return
	}
	if !r.IsPrompt() {
		return // isMeta, local command output
	}

	b.tail = tailPrompt
	text := r.PromptText()
	origin := r.PromptOrigin()
	if rest, found := transcript.SplitInterruption(text); found {
		if b.cur >= 0 {
			b.turns[b.cur].interrupted = true
		}
		if rest == "" {
			return // bare marker: flags the previous turn, starts none
		}
		text = rest
		// The marker hid the text's own prefix from the classifier.
		if o := transcript.PromptOriginFromText(rest); o != model.OriginHuman && origin == model.OriginHuman {
			origin = o
		}
	}

	t := turnState{
		uuid: r.UUID, promptPos: pos, startedAt: ts, endedAt: ts,
		origin: origin, userText: text, images: r.PromptImages(),
	}
	if origin == model.OriginCommand {
		// The harness wraps what was typed in tags; store what the user typed.
		if name, args, ok := transcript.SlashCommand(text); ok {
			t.command = strings.TrimPrefix(name, "/")
			t.userText = "/" + t.command
			if args != "" {
				t.userText += " " + args
			}
		} else if m := reBashInput.FindStringSubmatch(text); m != nil {
			t.command = "!"
			t.userText = "!" + strings.TrimSpace(m[1])
		}
	}
	if origin == model.OriginTaskNotification {
		n := parseNotification(text)
		n.Turn, n.At = len(b.turns), ts
		b.notes = append(b.notes, n)
	}
	if origin == model.OriginPeer || origin == model.OriginTaskNotification {
		// The harness wraps what was delivered in markup of its own; store the messages.
		if msgs, rest, ok := delivered(text, ts); ok {
			t.inbox, t.userText = msgs, rest
		}
	}
	b.startTurn(t)
}

var (
	reTaskID    = regexp.MustCompile(`(?s)<task-id>(.*?)</task-id>`)
	reStatus    = regexp.MustCompile(`(?s)<status>(.*?)</status>`)
	reToolUseID = regexp.MustCompile(`(?s)<tool-use-id>(.*?)</tool-use-id>`)
	reSummary   = regexp.MustCompile(`(?s)<summary>(.*?)</summary>`)
	reBashInput = regexp.MustCompile(`(?s)^\s*<bash-input>(.*?)</bash-input>`)
)

func parseNotification(text string) TaskNotification {
	get := func(re *regexp.Regexp) string {
		if m := re.FindStringSubmatch(text); m != nil {
			return strings.TrimSpace(m[1])
		}
		return ""
	}
	return TaskNotification{
		TaskID: get(reTaskID), Status: get(reStatus), ToolUseID: get(reToolUseID),
		Summary: get(reSummary),
	}
}

// toolResult records the tool_results that answer an Agent tool_use or that look like a
// spawn.
func (b *Builder) toolResult(r *transcript.Record, ts time.Time) {
	um, ok := r.UserMessage()
	if !ok {
		return
	}
	tur, hasTUR := r.ToolUseResult()
	for _, blk := range um.Content.Blocks {
		if blk.Type != "tool_result" {
			continue
		}
		if hasTUR && tur.RunID != "" {
			b.workflows = append(b.workflows, WorkflowLaunch{
				ToolUseID: blk.ToolUseID, Turn: b.cur, At: ts, RunID: tur.RunID, TaskID: tur.TaskID,
				Name: tur.WorkflowName, Summary: tur.Summary,
			})
		}
		_, owned := b.spawnIDs[blk.ToolUseID]
		spawnLike := hasTUR && (tur.Status == transcript.SpawnCompleted ||
			tur.Status == transcript.SpawnAsyncLaunched || tur.Status == transcript.SpawnTeammateSpawned)
		if !owned && !spawnLike {
			continue
		}
		res := SpawnResult{
			ToolUseID: blk.ToolUseID, Turn: b.cur, At: ts, IsError: blk.IsError,
			HasToolUseOwner: owned,
		}
		if hasTUR {
			res.Status = tur.Status
			res.AgentID = tur.AgentID
			res.TeammateID = tur.TeammateID
			res.Name = tur.Name
			res.TeamName = tur.TeamName
			res.OutputFile = tur.OutputFile
		}
		b.spawnRes = append(b.spawnRes, res)
		hasTUR = false // the envelope's toolUseResult belongs to the first block only
	}
}

// assistant groups a line into its message.
func (b *Builder) assistant(r *transcript.Record, ts time.Time, pos int) {
	am, ok := r.AssistantMessage()
	if !ok || (am.ID == "" && am.Model == "") { // not an API message at all
		b.counters.MalformedRecords++
		return
	}
	if b.cur < 0 {
		// Activity before any prompt (orphan or resumed file): keep it, with its cost.
		b.startTurn(turnState{promptPos: -1, startedAt: ts, endedAt: ts, origin: model.OriginContinuation})
	}
	key := am.ID
	if key == "" {
		key = "uuid:" + r.UUID
		if r.UUID == "" {
			key = "pos:" + itoa(pos)
		}
	}
	idx, seen := b.msgIdx[key]
	if !seen {
		idx = len(b.msgs)
		b.msgIdx[key] = idx
		b.msgs = append(b.msgs, &msgState{id: key, firstTS: ts, turn: b.cur})
		b.turns[b.cur].msgs = append(b.turns[b.cur].msgs, idx)
	}
	m := b.msgs[idx]
	if am.Model != "<synthetic>" {
		b.tail, b.tailStop = tailAssistant, am.StopReason
		n := len(am.Content.Blocks)
		b.tailText = n > 0 && am.Content.Blocks[n-1].Type == "text"
	}
	m.usage = am.Usage // the last line wins
	m.stop = am.StopReason
	if am.Model != "" {
		m.model = am.Model
	}
	m.synthetic = m.model == "<synthetic>"

	for _, blk := range am.Content.Blocks {
		switch blk.Type {
		case "text":
			if blk.Text != "" {
				m.texts = append(m.texts, blk.Text)
			}
		case "tool_use":
			if blk.ID != "" {
				if _, dup := m.toolIDs[blk.ID]; dup {
					continue
				}
				if m.toolIDs == nil {
					m.toolIDs = make(map[string]struct{})
				}
				m.toolIDs[blk.ID] = struct{}{}
			}
			m.tools = append(m.tools, toolUse{name: blk.Name, file: touchedFile(blk)})
			if blk.IsAgentSpawn() {
				b.spawn(blk, m, ts)
			}
		}
	}
}

func (b *Builder) spawn(blk transcript.Block, m *msgState, ts time.Time) {
	if blk.ID != "" {
		if _, dup := b.spawnIDs[blk.ID]; dup {
			return
		}
		b.spawnIDs[blk.ID] = struct{}{}
	}
	s := AgentSpawn{ToolUseID: blk.ID, MessageID: m.id, Turn: m.turn, At: ts}
	if in, ok := blk.AgentInput(); ok {
		s.Name, s.Description, s.Prompt = in.Name, in.Description, in.Prompt
		s.SubagentType, s.Model = in.SubagentType, in.Model
		s.RunInBackground, s.Isolation = in.RunInBackground, in.Isolation
	}
	b.spawns = append(b.spawns, s)
}

// parseEpochMillis reads a cost-state startTime: a number (or numeric string) of epoch
// milliseconds. Anything else gives the zero time.
func parseEpochMillis(raw json.RawMessage) time.Time {
	s := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	if s == "" || s == "null" {
		return time.Time{}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f <= 0 || f > 1e15 {
		return time.Time{}
	}
	return time.UnixMilli(int64(f)).UTC()
}

// recapHint is the pointer to its settings that Claude Code appends to a recap. It is
// chrome of the terminal UI, not part of the recap, and the one piece of text the digest
// drops.
const recapHint = "(disable recaps in /config)"

// recapText is a recap without the trailing settings hint.
func recapText(s string) string {
	t := strings.TrimRightFunc(s, unicode.IsSpace)
	if strings.HasSuffix(t, recapHint) {
		return strings.TrimRightFunc(strings.TrimSuffix(t, recapHint), unicode.IsSpace)
	}
	return s
}
