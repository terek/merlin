package pi

import (
	"fmt"
	"path"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/terek/merlin/internal/beads"
	"github.com/terek/merlin/internal/model"
)

// ParserVersion identifies the output of this package. Bump it whenever a change would
// change a digest built from the same files.
const ParserVersion = 2

// Pricer prices one API call; *pricing.Table satisfies it. ok is false for a model with no
// price.
type Pricer interface {
	Cost(name string, tok model.Tokens, fast bool) (model.ModelCost, bool)
}

// localProviders are the providers that run a model on the user's own machine. Their calls
// carry tokens and no cost, and are left unpriced (a lower bound), never priced from the
// table's API rates and never counted as free.
var localProviders = map[string]bool{
	"llama-cpp": true, "llamabarn": true, "ollama": true, "lmstudio": true, "lm-studio": true,
	"vllm": true, "localai": true, "local": true,
}

// workCall is one edit or shell command and the directory it worked in.
type workCall struct {
	dir  string
	edit bool
}

// callInfo is a tool call of an assistant message, kept until its result arrives.
type callInfo struct {
	rec    int // the assistant entry
	id     string
	msgID  string
	turn   int // turn index; -1 outside every turn
	name   string
	cmd    string
	at     time.Time
	result bool
}

// turnAcc collects what one turn did.
type turnAcc struct {
	turn      model.Turn
	started   time.Time
	ended     time.Time
	userRec   int
	files     map[string]bool
	work      []workCall
	final     string
	lastStop  string // stopReason of the turn's last assistant message
	haveFinal bool
}

// buildSession reads the session file and returns its digest. The result is a pure
// function of the file.
func buildSession(src source, pricer Pricer) (*model.SessionDigest, error) {
	p, err := readFile(src.Path)
	if err != nil {
		return nil, err
	}
	if !p.hasHead {
		return nil, fmt.Errorf("%s: no session header on the first line", src.Path)
	}
	d := &model.SessionDigest{
		SchemaVersion: model.SchemaVersion,
		ParserVersion: ParserVersion,
		Source:        slices.Clone(src.Fingerprint),
		Harness:       HarnessName,
		ID:            src.ID,
		ProjectKey:    src.ProjectKey,
	}
	b := &builder{d: d, p: p, pricer: pricer, unpriced: map[string]bool{}}
	b.build()
	return d, nil
}

type builder struct {
	d      *model.SessionDigest
	p      *parsed
	pricer Pricer

	par      []int // parent entry index, -1 at a root or an orphan
	onPath   []bool
	turnOf   []int // entry index -> turn index (-1: none)
	turns    []*turnAcc
	calls    map[string]*callInfo
	callList []*callInfo // in file order

	unpriced map[string]bool
	assist   int64 // billed assistant messages
}

func (b *builder) build() {
	b.tree()
	b.assignTurns()
	b.walk()
	b.finish()
}

// tree indexes the entries and marks the current path: the chain of parents from the last
// entry, which is the leaf (Pi keeps the leaf only in memory; on load it is the last entry).
func (b *builder) tree() {
	recs := b.p.recs
	byID := make(map[string]int, len(recs))
	for i, r := range recs {
		if _, dup := byID[r.id]; !dup {
			byID[r.id] = i
		}
	}
	b.par = make([]int, len(recs))
	for i, r := range recs {
		b.par[i] = -1
		if j, ok := byID[r.parent]; ok && r.parent != "" && j != i {
			b.par[i] = j
		}
	}
	b.onPath = make([]bool, len(recs))
	for i := len(recs) - 1; i >= 0 && !b.onPath[i]; i = b.par[i] {
		b.onPath[i] = true
		if b.par[i] < 0 {
			break
		}
	}
}

// isUser reports an entry that starts a turn.
func isUser(r *rec) bool { return r.typ == "message" && r.role == "user" }

// assignTurns finds the turns: each user message starts one, and it runs through every entry
// below it up to the next user message on the same branch. A turn is abandoned when its user
// message is off the current path.
func (b *builder) assignTurns() {
	recs := b.p.recs
	var users []int
	for i := range recs {
		if isUser(&recs[i]) {
			users = append(users, i)
		}
	}
	sort.SliceStable(users, func(x, y int) bool {
		a, c := &recs[users[x]], &recs[users[y]]
		if at, ct := b.start(a), b.start(c); !at.Equal(ct) {
			return earlier(at, ct)
		}
		return a.id < c.id
	})
	idx := make(map[int]int, len(users))
	for k, u := range users {
		r := &recs[u]
		idx[u] = k
		t := &turnAcc{userRec: u, started: b.start(r), files: map[string]bool{}}
		t.turn = model.Turn{
			Index:     k,
			UUID:      messageID(r),
			Abandoned: !b.onPath[u],
			StartedAt: t.started,
			Origin:    model.OriginHuman,
			UserText:  r.text,
			Images:    r.images,
		}
		t.ended = t.started
		b.turns = append(b.turns, t)
	}
	b.turnOf = make([]int, len(recs))
	state := make([]int8, len(recs)) // 0 unseen, 1 in progress, 2 done
	var of func(i int) int
	of = func(i int) int {
		if state[i] == 2 {
			return b.turnOf[i]
		}
		if state[i] == 1 { // a cycle in parentId: none by construction, but never loop
			return -1
		}
		state[i] = 1
		t := -1
		if k, ok := idx[i]; ok {
			t = k
		} else if b.par[i] >= 0 {
			t = of(b.par[i])
		}
		b.turnOf[i] = t
		state[i] = 2
		return t
	}
	for i := range recs {
		of(i)
	}
}

// start is when a message began: its own timestamp, else the entry's.
func (b *builder) start(r *rec) time.Time {
	if r.msgMs > 0 {
		return time.UnixMilli(r.msgMs).UTC()
	}
	return r.at
}

// messageID is the id of a message across sessions: the entry id (8 hex characters, unique
// only within a file, copied unchanged into forks) joined with the message's own timestamp in
// milliseconds, which separates two unrelated sessions that drew the same entry id.
func messageID(r *rec) string {
	ms := r.msgMs
	if ms == 0 {
		ms = r.at.UnixMilli()
	}
	return fmt.Sprintf("%s.%d", r.id, ms)
}

// otherID is the id of spend that is not an assistant message: the entry id, the entry's
// timestamp as written, and a suffix for what spent it.
func otherID(r *rec, suffix string) string {
	return fmt.Sprintf("%s.%s.%s", r.id, r.at.Format(time.RFC3339Nano), suffix)
}

// walk reads the entries in file order, which is the order they were appended.
func (b *builder) walk() {
	d, recs := b.d, b.p.recs
	h := b.p.head
	cwd := string(h.Cwd)
	b.calls = map[string]*callInfo{}
	var lastAsst time.Time // when the last assistant message before the entry began
	for i := range recs {
		r := &recs[i]
		t := b.turnOf[i]
		var acc *turnAcc
		if t >= 0 {
			acc = b.turns[t]
			if r.at.After(acc.ended) {
				acc.ended = r.at
			}
		}
		switch r.typ {
		case "session_info":
			d.Title = r.name // the last one on the file wins; an empty name clears it
		case "message":
			switch r.role {
			case "assistant":
				if b.assistant(i, acc, t, cwd) {
					lastAsst = b.start(r)
				}
			case "toolResult":
				b.toolResult(i, t)
			case "bashExecution":
				b.bashExecution(i, acc, t, cwd)
			}
		case "compaction":
			b.compaction(i, t, lastAsst)
		case "branch_summary":
			if r.usage != nil {
				b.spend(i, i, "branch", r.usage, t)
			}
		case "usage":
			if r.usage != nil {
				b.spend(i, i, "usage", r.usage, t)
			}
		}
	}
}

// assistant records one assistant message: its calls and, when it was billed, its cost. It
// reports whether the message was billed.
func (b *builder) assistant(i int, acc *turnAcc, t int, cwd string) (billed bool) {
	r := &b.p.recs[i]
	id := messageID(r)
	if r.usage != nil {
		modelName, provider := b.modelOf(i)
		if m, ok := b.price(id, b.start(r), modelName, provider, r.usage); ok {
			b.addMessage(m, t)
			billed = true
			b.assist++
			if acc != nil {
				u := r.usage
				acc.turn.AssistantMessages++
				acc.turn.ContextTokens = int64(u.Input) + int64(u.CacheRead) + int64(u.CacheWrite) + int64(u.Output)
			}
		}
	}
	for _, c := range r.calls {
		info := &callInfo{rec: i, id: c.ID, msgID: id, turn: t, name: c.Name, cmd: c.Command, at: b.start(r)}
		if c.ID != "" {
			b.calls[c.ID] = info
		}
		b.callList = append(b.callList, info)
		if acc == nil {
			continue
		}
		acc.turn.ToolCalls++
		if acc.turn.ToolsByName == nil {
			acc.turn.ToolsByName = map[string]int64{}
		}
		acc.turn.ToolsByName[c.Name]++
		switch c.Name {
		case "edit", "write":
			if c.Path != "" {
				full := resolve(cwd, c.Path)
				acc.files[full] = true
				acc.work = append(acc.work, workCall{dir: path.Dir(full), edit: true})
			}
		case "bash":
			if c.Command != "" {
				acc.work = append(acc.work, workCall{dir: beads.RunDir(c.Command, cwd)})
			}
		}
	}
	if acc != nil {
		if acc.turn.Abandoned || b.onPath[i] {
			acc.lastStop = r.stop
		}
		// The final text is the last text that did not end in a tool call, an abort or an error. A live turn
		// takes it from the current path only: a retried branch's answer is not its answer.
		if r.text != "" && r.stop != "toolUse" && r.stop != "aborted" && r.stop != "error" && (acc.turn.Abandoned || b.onPath[i]) {
			acc.final, acc.haveFinal = r.text, true
		}
	}
	return billed
}

// resolve makes a path from a tool call absolute against the session's directory.
func resolve(cwd, p string) string {
	if path.IsAbs(p) || !path.IsAbs(cwd) {
		return path.Clean(p)
	}
	return path.Join(cwd, p)
}

// toolResult records what a tool call returned: an edit's changed lines, a bash call's bead
// events, and the spend of a tool that called a model itself.
func (b *builder) toolResult(i, t int) {
	r := &b.p.recs[i]
	c := b.calls[r.toolCallID]
	if c != nil {
		c.result = true
	}
	if r.usage != nil {
		ref := i
		if c != nil {
			ref = c.rec // the model of the assistant message that made the call: a guess
		}
		b.spend(i, ref, "tool", r.usage, t)
	}
	switch r.toolName {
	case "edit":
		b.d.Stats.LinesAdded += r.added
		b.d.Stats.LinesRemoved += r.removed
	case "bash":
		if c != nil {
			b.beadEvents(c, &beads.Result{Output: r.output, Failed: r.isErr}, r.at)
		}
	}
}

// bashExecution is a command the user ran with ! or !!: not a model call, but it can name
// beads and it worked in a directory.
func (b *builder) bashExecution(i int, acc *turnAcc, t int, cwd string) {
	r := &b.p.recs[i]
	if r.command == "" {
		return
	}
	if acc != nil {
		acc.work = append(acc.work, workCall{dir: beads.RunDir(r.command, cwd)})
	}
	res := &beads.Result{Output: r.output, Failed: r.exitCode != nil && *r.exitCode != 0}
	for _, ev := range beads.Parse(r.command, cwd, res) {
		ev.At, ev.ToolUseID = r.at, r.id
		if t >= 0 {
			v := t
			ev.Turn = &v
		}
		b.d.Beads = append(b.d.Beads, ev)
	}
}

func (b *builder) beadEvents(c *callInfo, res *beads.Result, at time.Time) {
	if c.cmd == "" {
		return
	}
	for _, ev := range beads.Parse(c.cmd, string(b.p.head.Cwd), res) {
		ev.At, ev.MessageID, ev.ToolUseID = at, c.msgID, c.id
		if c.turn >= 0 {
			v := c.turn
			ev.Turn = &v
		}
		b.d.Beads = append(b.d.Beads, ev)
	}
}

// compaction records a compaction on the current path, and the spend of the call that wrote
// its summary when Pi recorded it. A compaction off the path was abandoned with its branch:
// its spend stays, it is no compaction of the session.
func (b *builder) compaction(i, t int, lastAsst time.Time) {
	r := &b.p.recs[i]
	var msg *model.Message
	if r.usage != nil {
		msg = b.spend(i, i, "compaction", r.usage, t)
	}
	if !b.onPath[i] {
		return
	}
	c := model.Compaction{At: r.at, Turn: t, PreTokens: r.tokensBefore, Summary: r.summary}
	if msg != nil {
		c.MessageID = msg.ID
		if !msg.Unpriced && !lastAsst.IsZero() {
			c.Call = b.compactionCall(msg, r.usage, lastAsst)
		}
	}
	b.d.Compactions = append(b.d.Compactions, c)
}

// compactionCall describes the recorded call that wrote a summary. Cold means less than half
// of its context came from the cache.
func (b *builder) compactionCall(m *model.Message, u *usage, lastAsst time.Time) *model.CompactionCall {
	ctx := int64(u.Input) + int64(u.CacheRead) + int64(u.CacheWrite)
	call := &model.CompactionCall{
		Model:        m.Model,
		IdleMs:       max(m.At.Sub(lastAsst).Milliseconds(), 0),
		Cache:        model.CacheWarm,
		Billing:      model.BillingCacheRead,
		InputTokens:  ctx,
		OutputTokens: int64(u.Output),
		USD:          m.USD,
		WarmUSD:      m.USD,
	}
	if 2*int64(u.CacheRead) < ctx {
		call.Cache, call.Billing = model.CacheCold, model.BillingInput
		if mc, ok := b.pricer.Cost(m.Model, model.Tokens{CacheRead: ctx, Output: int64(u.Output)}, false); ok {
			call.WarmUSD = mc.USD
		}
	}
	return call
}

// spend records the spend of an entry that is not an assistant message as a message of its
// own, so totals are right: the id is the entry id, its timestamp and a suffix. The model of
// such an entry is named by a usage entry; otherwise it is a guess, the model of entry ref (or
// the nearest assistant message or model_change above it).
func (b *builder) spend(i, ref int, suffix string, u *usage, t int) *model.Message {
	r := &b.p.recs[i]
	modelName, provider := b.modelOf(ref)
	m, ok := b.price(otherID(r, suffix), r.at, modelName, provider, u)
	if !ok {
		return nil
	}
	b.addMessage(m, t)
	return &b.d.Messages[len(b.d.Messages)-1]
}

// modelOf is the model and provider of entry i: its own when it names one, else those of the
// nearest ancestor that does.
func (b *builder) modelOf(i int) (modelName, provider string) {
	for n := 0; i >= 0 && n <= len(b.p.recs); n++ {
		r := &b.p.recs[i]
		if r.model != "" && (r.typ == "model_change" || r.typ == "usage" || r.role == "assistant") {
			return r.model, r.provider
		}
		i = b.par[i]
	}
	return "", ""
}

// price turns a usage record into a billed message. ok is false when nothing was billed (no
// tokens and no cost).
//
// The cost is Pi's own figure when it is above 0 (Recorded); a 0 with tokens means Pi has no
// price for the model, so the price table is asked by model name; a model the table does not
// know, and any local model, is Unpriced: tokens billed, dollars unknown.
func (b *builder) price(id string, at time.Time, modelName, provider string, u *usage) (model.Message, bool) {
	cost := float64(u.Cost.Total)
	if u.tokens() == 0 && cost <= 0 {
		return model.Message{}, false
	}
	w1h := min(max(int64(u.CacheWrite1h), 0), int64(u.CacheWrite))
	tok := model.Tokens{
		Input:        int64(u.Input),
		Output:       int64(u.Output),
		CacheRead:    int64(u.CacheRead),
		CacheWrite5m: int64(u.CacheWrite) - w1h,
		CacheWrite1h: w1h,
	}
	m := model.Message{ID: id, At: at, Model: modelName, Tokens: tok}
	switch {
	case cost > 0:
		m.USD, m.Recorded = cost, true
	case localProviders[strings.ToLower(provider)]:
		b.markUnpriced(&m)
	default:
		if mc, ok := b.pricer.Cost(modelName, tok, false); ok {
			m.USD = mc.USD
		} else {
			b.markUnpriced(&m)
		}
	}
	return m, true
}

func (b *builder) markUnpriced(m *model.Message) {
	m.Unpriced = true
	name := m.Model
	if name == "" {
		name = "(unknown)"
	}
	b.unpriced[name] = true
}

// addMessage lists a billed message and adds its cost to the session and its turn.
func (b *builder) addMessage(m model.Message, t int) {
	if t >= 0 {
		v := t
		m.Turn = &v
		addCost(&b.turns[t].turn.Cost, m)
	}
	b.d.Messages = append(b.d.Messages, m)
	addCost(&b.d.Cost, m)
}

func addCost(c *model.Cost, m model.Message) {
	if m.Unpriced {
		c.AddUnpriced()
		return
	}
	c.AddMessage(m.Model, m.Tokens, m.USD)
}

// finish puts the collected parts into the digest, ordered by time and then id.
func (b *builder) finish() {
	d, p := b.d, b.p
	h := p.head
	cwd := string(h.Cwd)

	// A call that never got a result (an aborted run) names its beads with no outcome.
	for _, c := range b.callList {
		if !c.result && c.name == "bash" {
			b.beadEvents(c, nil, c.at)
		}
	}

	for _, t := range b.turns {
		tr := t.turn
		tr.EndedAt = t.ended
		if !t.started.IsZero() && t.ended.After(t.started) {
			tr.DurationMs = t.ended.Sub(t.started).Milliseconds()
		}
		tr.FinalText = t.final
		tr.Interrupted = t.lastStop == "aborted"
		tr.FilesTouched = sortedSet(t.files)
		tr.WorkDirs = workDirs(t.work)
		tr.CostWithAgents = tr.Cost.USD
		tr.Epoch = epoch(d.Compactions, tr.StartedAt)
		d.Turns = append(d.Turns, tr)
	}

	slices.SortStableFunc(d.Messages, func(a, c model.Message) int {
		if !a.At.Equal(c.At) {
			if earlier(a.At, c.At) {
				return -1
			}
			return 1
		}
		return strings.Compare(a.ID, c.ID)
	})
	slices.SortStableFunc(d.Compactions, func(a, c model.Compaction) int {
		if !a.At.Equal(c.At) {
			if earlier(a.At, c.At) {
				return -1
			}
			return 1
		}
		return strings.Compare(a.MessageID, c.MessageID)
	})
	slices.SortStableFunc(d.Beads, func(a, c model.BeadEvent) int {
		if !a.At.Equal(c.At) {
			if earlier(a.At, c.At) {
				return -1
			}
			return 1
		}
		return strings.Compare(a.ToolUseID, c.ToolUseID)
	})

	d.Project, d.Cwd = cwd, cwd
	if cwd != "" {
		d.Cwds = []string{cwd}
	}
	d.Kind = model.KindInteractive
	if ts, err := time.Parse(time.RFC3339Nano, string(h.Timestamp)); err == nil {
		d.StartedAt = ts.UTC()
	}
	for i := range p.recs {
		r := &p.recs[i]
		for _, at := range []time.Time{r.at, b.start(r)} {
			if at.After(d.LastActivityAt) {
				d.LastActivityAt = at
			}
		}
		if d.StartedAt.IsZero() && !r.at.IsZero() {
			d.StartedAt = r.at
		}
	}
	if pid := string(h.ParentSession); pid != "" {
		d.Lineage.ForkedFrom = &model.ForkRef{SessionID: parentSessionID(pid)}
	}
	d.EndState = b.endState()
	if d.Title == "" {
		d.Title = firstLine(firstPrompt(d.Turns))
	}

	s := &d.Stats
	s.Turns = int64(len(d.Turns))
	s.AssistantMessages = b.assist
	for _, t := range d.Turns {
		if !t.Abandoned {
			s.HumanTurns++
		}
		s.ToolCalls += t.ToolCalls
		for name, n := range t.ToolsByName {
			if s.ToolsByName == nil {
				s.ToolsByName = map[string]int64{}
			}
			s.ToolsByName[name] += n
		}
	}

	d.Diagnostics.BadLines = p.bad
	if len(p.unknown) > 0 {
		d.Diagnostics.UnknownTypes = p.unknown
	}
	d.Diagnostics.UnpricedModels = sortedKeys(b.unpriced)
}

// endState is how the file ends, from the last message on the current path.
func (b *builder) endState() model.EndState {
	for i := len(b.p.recs) - 1; i >= 0; i-- {
		if !b.onPath[i] {
			continue
		}
		r := &b.p.recs[i]
		if r.typ != "message" {
			continue
		}
		switch r.role {
		case "user", "toolResult":
			return model.EndMidTurn
		case "assistant":
			switch r.stop {
			case "aborted":
				return model.EndInterrupted
			case "toolUse":
				return model.EndMidTurn
			case "error":
				return model.EndUnknown
			}
			return model.EndClean
		}
	}
	return model.EndUnknown
}

// parentSessionID is the id of the session a fork came from: the part of the parent file's
// name after the last underscore ("<timestamp>_<id>.jsonl"). No parent file is read; the
// entries were copied into the fork.
func parentSessionID(parent string) string {
	name := path.Base(strings.ReplaceAll(parent, `\`, "/"))
	name = strings.TrimSuffix(name, ".jsonl")
	if i := strings.LastIndex(name, "_"); i >= 0 {
		name = name[i+1:]
	}
	return name
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

// workDirs counts the calls per absolute directory, sorted by directory; nil for none.
func workDirs(calls []workCall) []model.WorkDir {
	by := map[string]*model.WorkDir{}
	for _, c := range calls {
		if !path.IsAbs(c.dir) {
			continue
		}
		dir := path.Clean(c.dir)
		e := by[dir]
		if e == nil {
			e = &model.WorkDir{Dir: dir}
			by[dir] = e
		}
		if c.edit {
			e.Edits++
		} else {
			e.Commands++
		}
	}
	if len(by) == 0 {
		return nil
	}
	out := make([]model.WorkDir, 0, len(by))
	for _, e := range by {
		out = append(out, *e)
	}
	slices.SortFunc(out, func(a, c model.WorkDir) int { return strings.Compare(a.Dir, c.Dir) })
	return out
}

func firstPrompt(turns []model.Turn) string {
	for _, t := range turns {
		if !t.Abandoned && strings.TrimSpace(t.UserText) != "" {
			return t.UserText
		}
	}
	for _, t := range turns {
		if strings.TrimSpace(t.UserText) != "" {
			return t.UserText
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

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedSet(m map[string]bool) []string {
	if len(m) == 0 {
		return nil
	}
	return sortedKeys(m)
}

// earlier orders times with the zero time last.
func earlier(a, b time.Time) bool {
	if a.IsZero() || b.IsZero() {
		return !a.IsZero() && b.IsZero()
	}
	return a.Before(b)
}
