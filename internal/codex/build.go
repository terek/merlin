package codex

import (
	"bufio"
	"encoding/json"
	"errors"

	"os"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/terek/merlin/internal/model"
)

// ParserVersion identifies the output of this package. Bump it whenever a change would
// change a digest built from the same files.
const ParserVersion = 6

// Pricer prices one API call; *pricing.Table satisfies it. ok is false for a model with no
// price.
type Pricer interface {
	Cost(name string, tok model.Tokens, fast bool) (model.ModelCost, bool)
}

// buildSession reads the rollouts of one session tree and returns its digest. The result
// is a pure function of the files.
func buildSession(src source, pricer Pricer) (*model.SessionDigest, error) {
	d := &model.SessionDigest{
		SchemaVersion: model.SchemaVersion,
		ParserVersion: ParserVersion,
		Source:        slices.Clone(src.Fingerprint),
		Harness:       HarnessName,
		ID:            src.ID,
		ProjectKey:    src.ProjectKey,
	}
	var threads []*thread
	for _, f := range src.Files {
		t, err := readThread(f.Path, limit{})
		if err != nil {
			return nil, err
		}
		if t.Meta.ID == "" {
			t.Meta.ID = f.Thread
		}
		threads = append(threads, t)
	}
	b := newBuilder(d, threads, pricer)
	b.forkSession = src.ForkSession
	if err := b.inherit(src); err != nil {
		return nil, err
	}
	b.build()
	if src.Index != "" {
		if title := readTitle(src.Index, src.ID); title != "" {
			d.Title = title
		}
	}
	if d.Title == "" {
		d.Title = firstLine(firstPrompt(d.Turns))
		if d.Title == "" && len(d.Agents) > 0 {
			d.Title = firstLine(d.Agents[0].Prompt)
		}
	}
	return d, nil
}

// builder assembles the threads of one tree into a digest.
type builder struct {
	d      *model.SessionDigest
	pricer Pricer
	root   *thread   // nil when the root rollout is missing
	agents []*thread // every other thread, by start time then id
	byID   map[string]*thread
	byPath map[string]*thread
	copied *thread // history a fork inherits, read from the files it forked from
	// forkSession is the session the root forked from (discovery maps the thread it names).
	forkSession string
	unpriced    map[string]bool
	diag        model.Diagnostics

	// filled while building
	agentIdx  map[string]int            // thread id -> index into d.Agents
	turnIdx   map[string]map[string]int // thread id -> turn id -> index (main: into d.Turns; agent: into its Turns)
	mainTurn0 int                       // index in d.Turns of the root's first own turn
}

func newBuilder(d *model.SessionDigest, threads []*thread, pricer Pricer) *builder {
	b := &builder{d: d, pricer: pricer, byID: map[string]*thread{}, byPath: map[string]*thread{}, unpriced: map[string]bool{},
		agentIdx: map[string]int{}, turnIdx: map[string]map[string]int{}}
	for _, t := range threads {
		b.byID[t.Meta.ID] = t
		if t.Meta.ID == d.ID {
			b.root = t
			continue
		}
		b.agents = append(b.agents, t)
		if t.Source.AgentPath != "" {
			b.byPath[t.Source.AgentPath] = t
		}
	}
	sort.SliceStable(b.agents, func(i, j int) bool {
		a, c := b.agents[i], b.agents[j]
		if !a.FirstAt.Equal(c.FirstAt) {
			return earlier(a.FirstAt, c.FirstAt)
		}
		return a.Meta.ID < c.Meta.ID
	})
	return b
}

// inherit reads the history a forked root inherits: each file it forked from, up to the
// fork point, oldest first.
func (b *builder) inherit(src source) error {
	if b.root == nil || b.root.Meta.HistoryBase == nil {
		return nil
	}
	var chain []*thread
	hb := b.root.Meta.HistoryBase
	for n := 0; hb != nil && n < 8; n++ {
		path := src.Bases[hb.ThreadID]
		if path == "" {
			break
		}
		t, err := readThread(path, limit{bytes: hb.EndByteOffset, ordinal: hb.EndOrdinalExclusive})
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				break
			}
			return err
		}
		chain = append(chain, t)
		hb = t.Meta.HistoryBase
	}
	if len(chain) == 0 {
		return nil
	}
	// Each file's limited read already holds what it inherited only as far as it copied
	// it; the oldest file's turns come first.
	slices.Reverse(chain)
	c := &thread{Meta: chain[0].Meta, Source: threadSource{Kind: sourceRoot}}
	for _, t := range chain {
		off := len(c.Turns)
		c.Turns = append(c.Turns, t.Turns...)
		for _, u := range t.Usage {
			if u.Turn >= 0 {
				u.Turn += off
			}
			c.Usage = append(c.Usage, u)
		}
		for _, k := range t.Compacts {
			if k.Turn >= 0 {
				k.Turn += off
			}
			c.Compacts = append(c.Compacts, k)
		}
	}
	b.copied = c
	return nil
}

func (b *builder) build() {
	b.mainTurns()
	b.buildAgents()
	b.resolveRootTurns()
	b.inboxes()
	b.rollUp()
	b.messages()
	b.beads()
	b.describe()
	b.diagnostics()
}

// ---- main turns -------------------------------------------------------------------------

func (b *builder) mainTurns() {
	d := b.d
	ids := map[string]int{}
	add := func(t *thread, copied bool) {
		off := len(d.Turns)
		for i := range t.Turns {
			tr := &t.Turns[i]
			mt := mainTurn(tr, off+i)
			if t.Meta.Git != nil {
				mt.GitBranch = t.Meta.Git.Branch
			}
			d.Turns = append(d.Turns, mt)
			if _, seen := ids[tr.ID]; !seen || !copied {
				ids[tr.ID] = off + i
			}
		}
		for _, k := range t.Compacts {
			turn := -1
			if k.Turn >= 0 {
				turn = off + k.Turn
			}
			d.Compactions = append(d.Compactions, b.compaction(t, k, turn, t.Turns))
		}
	}
	if b.copied != nil {
		add(b.copied, true)
		if n := len(b.copied.Turns); n > 0 {
			d.Lineage.ForkedFrom = &model.ForkRef{SessionID: b.forkSession, MessageUUID: b.copied.Turns[n-1].ID}
		}
	}
	b.mainTurn0 = len(d.Turns)
	if b.root != nil {
		add(b.root, false)
		if d.Lineage.ForkedFrom == nil && b.root.Meta.ForkedFromID != "" {
			d.Lineage.ForkedFrom = &model.ForkRef{SessionID: b.forkSession}
		}
	}
	b.turnIdx[d.ID] = ids
	for i := range d.Turns {
		d.Turns[i].Epoch = epoch(d.Compactions, d.Turns[i].StartedAt)
	}
}

func mainTurn(tr *turnRec, index int) model.Turn {
	t := model.Turn{
		Index:        index,
		UUID:         tr.ID,
		StartedAt:    tr.StartedAt,
		EndedAt:      tr.EndedAt,
		DurationMs:   tr.DurationMs,
		FinalText:    tr.FinalText,
		Interrupted:  tr.AbortReason != "",
		ToolCalls:    tr.ToolCalls,
		ToolsByName:  cloneCounts(tr.ToolsByName),
		FilesTouched: slices.Clone(tr.Files),
	}
	if t.DurationMs == 0 && tr.Ended && !tr.StartedAt.IsZero() {
		t.DurationMs = tr.EndedAt.Sub(tr.StartedAt).Milliseconds()
	}
	switch {
	case tr.Trigger == "exec":
		t.Origin = model.OriginSDK
	case tr.Review:
		t.Origin, t.Command = model.OriginCommand, "review"
	case len(tr.Users) == 0 && tr.Compactions > 0:
		t.Origin, t.Command = model.OriginCommand, "compact"
	default:
		t.Origin = model.OriginHuman
	}
	for k, u := range tr.Users {
		if k == 0 {
			t.UserText, t.Images = u.Text, u.Images
			continue
		}
		t.Queued = append(t.Queued, model.QueuedPrompt{At: u.At, Origin: model.OriginHuman, Text: u.Text})
		t.Images += u.Images
	}
	return t
}

// compaction turns a compacted record into a Compaction. A compaction in a turn the user
// started without typing anything (/compact) is manual; one in the middle of other work
// is automatic. Its call is recorded: Call describes that message, cold when less than
// half of the context came from the cache.
func (b *builder) compaction(t *thread, k compactRec, turn int, turns []turnRec) model.Compaction {
	c := model.Compaction{At: k.At, Turn: turn, MessageID: k.ResponseID, Trigger: model.TriggerAuto}
	if k.Turn >= 0 && k.Turn < len(turns) && len(turns[k.Turn].Users) == 0 {
		c.Trigger = model.TriggerManual
	}
	for i, u := range t.Usage {
		if u.ResponseID != k.ResponseID {
			continue
		}
		c.PreTokens = u.Usage.Input
		c.Call = b.compactionCall(u, t.Usage[:i])
		break
	}
	return c
}

// compactionCall describes a compaction's recorded call; nil when its model is unpriced
// or nothing was called before it (no idle time to tell).
func (b *builder) compactionCall(u usageRec, before []usageRec) *model.CompactionCall {
	m := b.price(u)
	if b.unpriced[u.Model] || len(before) == 0 {
		return nil
	}
	call := &model.CompactionCall{
		Model:        u.Model,
		IdleMs:       u.At.Sub(before[len(before)-1].At).Milliseconds(),
		Cache:        model.CacheWarm,
		Billing:      model.BillingCacheRead,
		InputTokens:  u.Usage.Input,
		OutputTokens: u.Usage.Output,
		USD:          m.USD,
		WarmUSD:      m.USD,
	}
	if 2*u.Usage.Cached < u.Usage.Input {
		call.Cache, call.Billing = model.CacheCold, model.BillingInput
		warm := model.Tokens{CacheRead: u.Usage.Input, Output: u.Usage.Output}
		if mc, ok := b.pricer.Cost(u.Model, warm, m.Fast); ok {
			call.WarmUSD = mc.USD
		}
	}
	return call
}

func epoch(cs []model.Compaction, at time.Time) int {
	n := 0
	for _, c := range cs {
		if !at.IsZero() && c.At.Before(at) {
			n++
		}
	}
	return n
}

// ---- agents -----------------------------------------------------------------------------

func (b *builder) buildAgents() {
	d := b.d
	claimed := map[string]bool{} // spawn call ids
	for _, t := range b.agents {
		a := model.Agent{
			ID:        t.Meta.ID,
			Name:      t.Source.Nickname,
			AgentType: t.Source.Role,
			StartedAt: t.FirstAt,
			EndedAt:   t.LastAt,
			Linkage:   model.LinkMeta,
			Status:    model.StatusOpen,
		}
		switch t.Source.Kind {
		case sourceReview:
			a.Kind = model.AgentReview
		case sourceGuardian:
			a.Kind = model.AgentApprovalReview
		default:
			a.Kind = model.AgentSubagent
			a.Addressable = true
		}
		if t.Source.AgentPath != "" {
			a.Description = lastSegment(t.Source.AgentPath)
		}
		parent := b.byID[t.Source.Parent]
		if parent == nil {
			a.Linkage = model.LinkUnresolved
			b.diag.UnresolvedAgents++
		} else if parent != b.root {
			p := parent.Meta.ID
			a.ParentAgentID = &p
		}
		// The spawning call: in the parent, the spawn_agent whose task name ends the agent's path.
		var spawn *callRec
		if parent != nil && t.Source.Kind == sourceSpawn {
			for i := range parent.Calls {
				c := &parent.Calls[i]
				if c.Name == "spawn_agent" && !claimed[c.CallID] && c.TaskName != "" && c.TaskName == a.Description {
					spawn = c
					claimed[c.CallID] = true
					break
				}
			}
		}
		if spawn != nil {
			a.SpawnToolUseID = spawn.CallID
			a.Prompt, a.PromptEncrypted = spawn.Message, spawn.Encrypted
			a.Model = spawn.Model
			a.InheritsContext = spawn.Fork != "" && spawn.Fork != "none"
		}
		if t.Meta.SubagentHistoryStartOrdinal != nil {
			a.InheritsContext = true
		}
		if len(t.Turns) > 0 && t.Turns[0].Model != "" {
			a.Model = t.Turns[0].Model // the model it ran on
		}
		if a.Model == "" && len(t.Usage) > 0 {
			a.Model = t.Usage[0].Model
		}

		ids := map[string]int{}
		for i := range t.Turns {
			tr := &t.Turns[i]
			at := model.AgentTurn{
				Index:       i,
				StartedAt:   tr.StartedAt,
				EndedAt:     tr.EndedAt,
				Origin:      model.OriginPeer,
				FinalText:   tr.FinalText,
				Interrupted: tr.AbortReason != "",
				ToolCalls:   tr.ToolCalls,
				ToolsByName: cloneCounts(tr.ToolsByName),
			}
			if i == 0 {
				at.Origin, at.Prompt, at.PromptEncrypted = model.OriginSpawn, a.Prompt, a.PromptEncrypted
			}
			for k, u := range tr.Users {
				if k == 0 && (i > 0 || (at.Prompt == "" && !at.PromptEncrypted)) {
					// A turn the user typed into; for a review, the request it was started with.
					if i > 0 {
						at.Origin = model.OriginHuman
					} else {
						a.Prompt = u.Text
					}
					at.Prompt = u.Text
					continue
				}
				at.Queued = append(at.Queued, model.QueuedPrompt{At: u.At, Origin: model.OriginHuman, Text: u.Text})
			}
			a.Turns = append(a.Turns, at)
			ids[tr.ID] = i
			a.ToolCalls += tr.ToolCalls
			for name, n := range tr.ToolsByName {
				if a.ToolsByName == nil {
					a.ToolsByName = map[string]int64{}
				}
				a.ToolsByName[name] += n
			}
		}
		b.turnIdx[a.ID] = ids
		if n := len(t.Turns); n > 0 {
			last := t.Turns[n-1]
			a.FinalText = last.FinalText
			switch {
			case !last.Ended:
			case last.AbortReason != "" || last.ErrorInfo != "":
				a.Status = model.StatusKilled
			default:
				a.Status = model.StatusCompleted
			}
		}
		for _, k := range t.Compacts {
			a.Compactions = append(a.Compactions, b.compaction(t, k, k.Turn, t.Turns))
		}
		b.agentIdx[a.ID] = len(d.Agents)
		d.Agents = append(d.Agents, a)
	}
	// Depth: from the parent chain (1 for an agent of the main agent).
	for i := range d.Agents {
		depth, cur := 1, d.Agents[i].ParentAgentID
		for cur != nil && depth <= len(d.Agents) {
			depth++
			cur = d.Agents[b.agentIdx[*cur]].ParentAgentID
		}
		d.Agents[i].Depth = depth
	}
}

// resolveRootTurns sets each agent turn's RootTurn from the parent turn Codex records,
// following agents of agents up to the main agent; by time when that fails. Then SpawnTurn:
// the root turn of its top-level ancestor's first turn.
func (b *builder) resolveRootTurns() {
	d := b.d
	order := make([]int, len(d.Agents))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(x, y int) bool { return d.Agents[order[x]].Depth < d.Agents[order[y]].Depth })
	starts := turnStarts(d.Turns)
	for _, i := range order {
		a := &d.Agents[i]
		t := b.byID[a.ID]
		parent := b.byID[t.Source.Parent]
		for k := range a.Turns {
			at := &a.Turns[k]
			var r *int
			if parent != nil && k < len(t.Turns) && t.Turns[k].ParentTurnID != "" {
				pid := t.Turns[k].ParentTurnID
				if parent == b.root {
					if x, ok := b.turnIdx[d.ID][pid]; ok {
						r = &x
					}
				} else if pi, ok := b.agentIdx[parent.Meta.ID]; ok {
					if x, ok := b.turnIdx[parent.Meta.ID][pid]; ok {
						r = d.Agents[pi].Turns[x].RootTurn
					}
				}
			}
			if r == nil && !at.StartedAt.IsZero() && len(starts) > 0 {
				if x := sort.Search(len(starts), func(j int) bool { return starts[j].After(at.StartedAt) }) - 1; x >= 0 {
					r = &x
				}
			}
			if r != nil {
				v := *r
				at.RootTurn = &v
			}
		}
	}
	for i := range d.Agents {
		top := i
		for d.Agents[top].ParentAgentID != nil {
			top = b.agentIdx[*d.Agents[top].ParentAgentID]
		}
		ta := &d.Agents[top]
		if len(ta.Turns) > 0 && ta.Turns[0].RootTurn != nil {
			v := *ta.Turns[0].RootTurn
			d.Agents[i].SpawnTurn = &v
		}
	}
}

func turnStarts(turns []model.Turn) []time.Time {
	starts := make([]time.Time, len(turns))
	for i, t := range turns {
		starts[i] = t.StartedAt
		if starts[i].IsZero() && i > 0 {
			starts[i] = starts[i-1]
		}
	}
	return starts
}

// ---- messages between agents ------------------------------------------------------------

// delivery is one message to a thread: from another thread's call, or a report.
type delivery struct {
	to  string // thread id
	msg model.InboxMessage
}

// inboxes places every message a thread received: the follow-ups and messages other threads
// sent it (from the sender's call, whose text Codex encrypts too from 0.164) and the
// final answers of its own subagents. A message that arrives while a turn runs is queued in
// it; one that arrives between turns starts the next turn when nobody typed that turn.
func (b *builder) inboxes() {
	d := b.d
	var all []delivery
	threads := append([]*thread{}, b.agents...)
	if b.root != nil {
		threads = append([]*thread{b.root}, threads...)
	}
	for _, s := range threads {
		from, fromID := s.Source.Nickname, s.Meta.ID
		if s == b.root {
			from, fromID = "", ""
		}
		for _, c := range s.Calls {
			if c.Name != "send_message" && c.Name != "followup_task" {
				continue
			}
			to := b.target(s, c.Target)
			if to == nil || to == s {
				continue
			}
			kind := model.InboxMessageKind
			if c.Name == "followup_task" {
				kind = model.InboxAssignment
			}
			all = append(all, delivery{to: to.Meta.ID, msg: model.InboxMessage{At: c.At, Kind: kind, From: from, AgentID: fromID, Text: c.Message, Encrypted: c.Encrypted}})
		}
		for _, r := range s.Reports {
			sender := b.byPath[r.Author]
			m := model.InboxMessage{At: r.At, Kind: model.InboxTask, Status: string(model.StatusCompleted), Text: r.Text}
			if sender != nil {
				m.From, m.AgentID, m.TaskID = sender.Source.Nickname, sender.Meta.ID, sender.Meta.ID
			}
			all = append(all, delivery{to: s.Meta.ID, msg: m})
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return earlier(all[i].msg.At, all[j].msg.At) })
	for _, dl := range all {
		if b.root != nil && dl.to == b.root.Meta.ID {
			placeMain(d.Turns[b.mainTurn0:], dl.msg)
			continue
		}
		if i, ok := b.agentIdx[dl.to]; ok {
			placeAgent(&d.Agents[i], dl.msg)
		}
	}
}

// target resolves the target of a call made by thread s: "/root", an agent path, or a task
// name or nickname (s's own subagents first, then its siblings, then any).
func (b *builder) target(s *thread, name string) *thread {
	switch {
	case name == "":
		return nil
	case name == "/root" || name == "root":
		return b.root
	}
	if t := b.byPath[name]; t != nil {
		return t
	}
	var child, sibling, other *thread
	for _, t := range b.agents {
		if lastSegment(t.Source.AgentPath) != name && t.Source.Nickname != name {
			continue
		}
		switch {
		case t.Source.Parent == s.Meta.ID && child == nil:
			child = t
		case t.Source.Parent == s.Source.Parent && sibling == nil:
			sibling = t
		case other == nil:
			other = t
		}
	}
	for _, t := range []*thread{child, sibling, other} {
		if t != nil {
			return t
		}
	}
	return nil
}

func placeMain(turns []model.Turn, m model.InboxMessage) {
	if len(turns) == 0 {
		return
	}
	r := sort.Search(len(turns), func(i int) bool { return turns[i].StartedAt.After(m.At) }) - 1
	if r >= 0 && (turns[r].EndedAt.IsZero() || !m.At.After(turns[r].EndedAt)) {
		turns[r].Queued = append(turns[r].Queued, queued(m))
		return
	}
	if n := r + 1; n < len(turns) && turns[n].UserText == "" && turns[n].Origin != model.OriginSDK && turns[n].Command == "" {
		turns[n].Inbox = append(turns[n].Inbox, m)
		turns[n].Origin = originOf(turns[n].Inbox[0])
		return
	}
	turns[max(r, 0)].Queued = append(turns[max(r, 0)].Queued, queued(m))
}

func placeAgent(a *model.Agent, m model.InboxMessage) {
	ts := a.Turns
	if len(ts) == 0 {
		a.Inbox = append(a.Inbox, m)
		return
	}
	r := sort.Search(len(ts), func(i int) bool { return ts[i].StartedAt.After(m.At) }) - 1
	switch {
	case r >= 0 && (ts[r].EndedAt.IsZero() || !m.At.After(ts[r].EndedAt)):
		ts[r].Queued = append(ts[r].Queued, queued(m))
	case r+1 < len(ts) && r+1 > 0 && ts[r+1].Prompt == "":
		ts[r+1].Inbox = append(ts[r+1].Inbox, m)
		ts[r+1].Origin = originOf(ts[r+1].Inbox[0])
	default:
		ts[max(r, 0)].Queued = append(ts[max(r, 0)].Queued, queued(m))
	}
	if !m.At.Before(ts[0].StartedAt) {
		a.Inbox = append(a.Inbox, m)
	}
}

func queued(m model.InboxMessage) model.QueuedPrompt {
	return model.QueuedPrompt{At: m.At, Origin: originOf(m), Inbox: []model.InboxMessage{m}}
}

func originOf(m model.InboxMessage) model.TurnOrigin {
	if m.Kind == model.InboxTask {
		return model.OriginTaskNotification
	}
	return model.OriginPeer
}

// ---- cost -------------------------------------------------------------------------------

// price turns one usage record into a billed message.
func (b *builder) price(u usageRec) model.Message {
	tok := model.Tokens{Input: max(u.Usage.Input-u.Usage.Cached, 0), CacheRead: u.Usage.Cached, Output: u.Usage.Output}
	m := model.Message{ID: u.ResponseID, At: u.At, Model: u.Model, Fast: u.Tier == "priority", Tokens: tok}
	mc, ok := b.pricer.Cost(u.Model, tok, m.Fast)
	if !ok {
		b.unpriced[u.Model] = true
		m.Unpriced = true
		return m
	}
	m.USD = mc.USD
	return m
}

func (b *builder) addCost(c *model.Cost, m model.Message) {
	if m.Unpriced {
		c.AddUnpriced()
		return
	}
	c.AddMessage(m.Model, m.Tokens, m.USD)
}

// rollUp prices every call, fills per-turn and per-agent costs and the subtree totals.
func (b *builder) rollUp() {
	d := b.d
	addMain := func(t *thread, off int) {
		for _, u := range t.Usage {
			m := b.price(u)
			if u.Turn >= 0 && off+u.Turn < len(d.Turns) {
				tr := &d.Turns[off+u.Turn]
				tr.AssistantMessages++
				b.addCost(&tr.Cost, m)
				tr.ContextTokens = u.Usage.Input + u.Usage.Output
			}
		}
	}
	if b.copied != nil {
		addMain(b.copied, 0)
	}
	if b.root != nil {
		addMain(b.root, b.mainTurn0)
	}
	for i := range d.Agents {
		a := &d.Agents[i]
		for _, u := range b.byID[a.ID].Usage {
			m := b.price(u)
			a.AssistantMessages++
			b.addCost(&a.Cost, m)
			k := u.Turn
			if k < 0 || k >= len(a.Turns) {
				k = 0
			}
			if len(a.Turns) > 0 {
				a.Turns[k].AssistantMessages++
				b.addCost(&a.Turns[k].Cost, m)
			}
		}
	}
	// Subtree totals: own plus every descendant.
	for i := range d.Agents {
		d.Agents[i].SubtreeUSD = d.Agents[i].Cost.USD
	}
	for i := range d.Agents {
		for p := d.Agents[i].ParentAgentID; p != nil; p = d.Agents[b.agentIdx[*p]].ParentAgentID {
			d.Agents[b.agentIdx[*p]].SubtreeUSD += d.Agents[i].Cost.USD
		}
	}
	for i := range d.Turns {
		d.Turns[i].CostWithAgents = d.Turns[i].Cost.USD
	}
	for _, a := range d.Agents {
		if a.ParentAgentID != nil || a.SpawnTurn == nil || *a.SpawnTurn >= len(d.Turns) {
			continue
		}
		t := &d.Turns[*a.SpawnTurn]
		t.Spawned = append(t.Spawned, a.ID)
		t.CostWithAgents += a.SubtreeUSD
	}
}

// messages lists every billed call once: the main thread's (inherited ones first), then
// the agents', in time order.
func (b *builder) messages() {
	d := b.d
	add := func(t *thread, off int, agent *model.Agent) {
		for _, u := range t.Usage {
			m := b.price(u)
			if agent == nil {
				if u.Turn >= 0 {
					v := off + u.Turn
					m.Turn = &v
				}
			} else {
				m.AgentID = agent.ID
				if agent.SpawnTurn != nil {
					v := *agent.SpawnTurn
					m.Turn = &v
				}
				if len(agent.Turns) > 0 {
					k := u.Turn
					if k < 0 || k >= len(agent.Turns) {
						k = 0
					}
					m.AgentTurn = &k
				}
			}
			d.Messages = append(d.Messages, m)
			b.addCost(&d.Cost, m)
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
	sort.SliceStable(d.Messages, func(i, j int) bool { return earlier(d.Messages[i].At, d.Messages[j].At) })
}

// beads lists the bead events of the main thread (inherited ones first) and the agents,
// placed like their messages, in time order.
func (b *builder) beads() {
	d := b.d
	add := func(t *thread, off int, agent *model.Agent) {
		for _, r := range t.Beads {
			ev := r.ev
			if agent == nil {
				if r.turn >= 0 {
					v := off + r.turn
					ev.Turn = &v
				}
			} else {
				ev.AgentID = agent.ID
				if agent.SpawnTurn != nil {
					v := *agent.SpawnTurn
					ev.Turn = &v
				}
				if len(agent.Turns) > 0 {
					k := r.turn
					if k < 0 || k >= len(agent.Turns) {
						k = 0
					}
					ev.AgentTurn = &k
				}
			}
			d.Beads = append(d.Beads, ev)
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
	sort.SliceStable(d.Beads, func(i, j int) bool {
		x, y := d.Beads[i], d.Beads[j]
		if !x.At.Equal(y.At) {
			return earlier(x.At, y.At)
		}
		return x.ToolUseID < y.ToolUseID
	})
}

// ---- session-level fields ---------------------------------------------------------------

func (b *builder) describe() {
	d := b.d
	all := append([]*thread{}, b.agents...)
	if b.root != nil {
		all = append([]*thread{b.root}, all...)
	}
	var cwds, branches, versions []string
	for _, t := range all {
		for _, c := range t.Cwds {
			cwds = appendUniq(cwds, c)
		}
		if t.Meta.Git != nil && t.Meta.Git.Branch != "" {
			branches = appendUniq(branches, t.Meta.Git.Branch)
		}
		if t.Meta.CLIVersion != "" {
			versions = appendUniq(versions, t.Meta.CLIVersion)
		}
		if !t.FirstAt.IsZero() && (d.StartedAt.IsZero() || t.FirstAt.Before(d.StartedAt)) {
			d.StartedAt = t.FirstAt
		}
		if t.LastAt.After(d.LastActivityAt) {
			d.LastActivityAt = t.LastAt
		}
	}
	d.Cwds, d.GitBranches, d.HarnessVersions = cwds, branches, versions
	d.Kind = model.KindInteractive
	d.EndState = model.EndUnknown
	if r := b.root; r != nil {
		d.Project, d.Cwd = r.Meta.Cwd, r.Meta.Cwd
		if n := len(r.Turns); n > 0 && r.Turns[n-1].Cwd != "" {
			d.Cwd = r.Turns[n-1].Cwd
		}
		if r.Meta.Originator == "codex_exec" || r.Source.Name == "exec" {
			d.Kind = model.KindSDK
		}
		if n := len(r.Turns); n > 0 {
			last := r.Turns[n-1]
			switch {
			case !last.Ended:
				d.EndState = model.EndMidTurn
			case last.AbortReason != "":
				d.EndState = model.EndInterrupted
			case last.ErrorInfo == "":
				d.EndState = model.EndClean
			}
		}
	} else if len(cwds) > 0 {
		d.Project, d.Cwd = cwds[0], cwds[0]
	}

	s := &d.Stats
	s.Turns = int64(len(d.Turns))
	s.AssistantMessages = int64(len(d.Messages))
	tools := func(calls int64, byName map[string]int64) {
		s.ToolCalls += calls
		for name, n := range byName {
			if s.ToolsByName == nil {
				s.ToolsByName = map[string]int64{}
			}
			s.ToolsByName[name] += n
		}
	}
	for _, t := range d.Turns {
		if t.Origin == model.OriginHuman || t.Origin == model.OriginCommand {
			s.HumanTurns++
		}
		tools(t.ToolCalls, t.ToolsByName)
	}
	for _, a := range d.Agents {
		tools(a.ToolCalls, a.ToolsByName)
	}
	for _, t := range all {
		for _, tr := range t.Turns {
			s.LinesAdded += tr.LinesAdded
			s.LinesRemoved += tr.LinesRemoved
		}
	}
}

func (b *builder) diagnostics() {
	d := b.d
	all := append([]*thread{}, b.agents...)
	if b.root != nil {
		all = append(all, b.root)
	}
	for _, t := range all {
		d.Diagnostics.BadLines += t.BadLines
		for k, v := range t.Unknown {
			if d.Diagnostics.UnknownTypes == nil {
				d.Diagnostics.UnknownTypes = map[string]int64{}
			}
			d.Diagnostics.UnknownTypes[k] += v
		}
	}
	for m := range b.unpriced {
		d.Diagnostics.UnpricedModels = append(d.Diagnostics.UnpricedModels, m)
	}
	sort.Strings(d.Diagnostics.UnpricedModels)
	d.Diagnostics.UnresolvedAgents = b.diag.UnresolvedAgents
}

// readTitle returns the last thread name session_index.jsonl gives the thread.
func readTitle(path, id string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	r := bufio.NewReader(f)
	title := ""
	for {
		line, err := readLine(r)
		if errors.Is(err, errLongLine) {
			continue
		}
		if err != nil {
			return title // io.EOF, or a read error: what was read so far
		}
		var e struct {
			ID   string `json:"id"`
			Name string `json:"thread_name"`
		}
		if json.Unmarshal(line, &e) == nil && e.ID == id && e.Name != "" {
			title = e.Name
		}
	}
}

// ---- helpers ----------------------------------------------------------------------------

func firstPrompt(turns []model.Turn) string {
	for _, origin := range []model.TurnOrigin{model.OriginHuman, model.OriginSDK} {
		for _, t := range turns {
			if t.Origin == origin && strings.TrimSpace(t.UserText) != "" {
				return t.UserText
			}
		}
	}
	return ""
}

func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return l
		}
	}
	return ""
}

func lastSegment(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

func cloneCounts(m map[string]int64) map[string]int64 {
	if len(m) == 0 {
		return nil
	}
	out := make(map[string]int64, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// earlier orders times with the zero time last.
func earlier(a, b time.Time) bool {
	if a.IsZero() || b.IsZero() {
		return !a.IsZero() && b.IsZero()
	}
	return a.Before(b)
}
