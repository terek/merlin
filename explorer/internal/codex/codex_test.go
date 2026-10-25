package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/model"
)

// ---- synthetic rollouts -------------------------------------------------------------------

// fakePricer prices model "m" (and "m2") at $1/M input, $0.10/M cached, $10/M output; fast
// doubles it. Every other model is unpriced.
type fakePricer struct{}

func (fakePricer) Cost(name string, tok model.Tokens, fast bool) (model.ModelCost, bool) {
	if name != "m" && name != "m2" {
		return model.ModelCost{}, false
	}
	usd := (float64(tok.Input) + float64(tok.CacheRead)*0.1 + float64(tok.Output)*10) / 1e6
	if fast {
		usd *= 2
	}
	return model.ModelCost{Tokens: tok, USD: usd}, true
}

var t0 = time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)

func ts(sec int) string { return t0.Add(time.Duration(sec) * time.Second).Format(time.RFC3339Nano) }

// rollout writes records as a rollout file; ordinals are their positions unless a record
// sets one.
type rollout struct {
	t    *testing.T
	recs []map[string]any
}

func (r *rollout) add(sec int, typ string, payload map[string]any) *rollout {
	r.recs = append(r.recs, map[string]any{"timestamp": ts(sec), "type": typ, "payload": payload})
	return r
}

func (r *rollout) event(sec int, payload map[string]any) *rollout {
	return r.add(sec, "event_msg", payload)
}
func (r *rollout) item(sec int, payload map[string]any) *rollout {
	return r.add(sec, "response_item", payload)
}

func (r *rollout) meta(id, session string, source any, extra map[string]any) *rollout {
	p := map[string]any{"id": id, "session_id": session, "timestamp": ts(0), "cwd": "/home/dev/acme", "originator": "codex-tui",
		"cli_version": "0.164.0", "source": source, "git": map[string]any{"branch": "main"},
		"base_instructions": map[string]any{"text": "Synthetic instructions."}}
	for k, v := range extra {
		p[k] = v
	}
	return r.add(0, "session_meta", p)
}

func (r *rollout) start(sec int, turn, parent, trigger string) *rollout {
	attr := map[string]any{"turn_id": turn, "turn_trigger": trigger, "parent_turn_id": nil}
	if parent != "" {
		attr["parent_turn_id"] = parent
	}
	return r.event(sec, map[string]any{"type": "task_started", "turn_id": turn, "turn_attribution": attr})
}

func (r *rollout) ctx(sec int, turn, mdl string, effort any) *rollout {
	return r.add(sec, "turn_context", map[string]any{"turn_id": turn, "model": mdl, "effort": effort, "cwd": "/home/dev/acme"})
}

func (r *rollout) user(sec int, text string, images int) *rollout {
	content := []any{map[string]any{"type": "text", "text": text}}
	for range images {
		content = append(content, map[string]any{"type": "local_image", "path": "/tmp/x.png"})
	}
	return r.event(sec, map[string]any{"type": "item_completed", "item": map[string]any{"type": "UserMessage", "content": content}})
}

func (r *rollout) answer(sec int, text string) *rollout {
	return r.event(sec, map[string]any{"type": "item_completed", "item": map[string]any{"type": "AgentMessage", "phase": "final_answer",
		"content": []any{map[string]any{"type": "Text", "text": text}}}})
}

func (r *rollout) tool(sec int, name string, args map[string]any) *rollout {
	if args == nil {
		return r.item(sec, map[string]any{"type": "custom_tool_call", "name": name, "call_id": "c-" + name + ts(sec), "input": "x"})
	}
	b, _ := json.Marshal(args)
	return r.item(sec, map[string]any{"type": "function_call", "name": name, "namespace": "collaboration", "call_id": "call-" + name + ts(sec), "arguments": string(b)})
}

func (r *rollout) usage(sec int, resp, turn string, in, cached, out int64) *rollout {
	u := map[string]any{"input_tokens": in, "cached_input_tokens": cached, "cache_write_input_tokens": 0, "output_tokens": out,
		"reasoning_output_tokens": 0, "total_tokens": in + out}
	return r.add(sec, "token_usage_record", map[string]any{"response_id": resp, "turn_id": turn, "usage": u})
}

func (r *rollout) done(sec int, turn string) *rollout {
	return r.event(sec, map[string]any{"type": "task_complete", "turn_id": turn, "duration_ms": 1000})
}

func (r *rollout) write(dir, name string) string {
	r.t.Helper()
	path := filepath.Join(dir, "sessions", "2026", "10", "01", name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		r.t.Fatal(err)
	}
	var b strings.Builder
	for i, rec := range r.recs {
		if _, ok := rec["ordinal"]; !ok {
			rec["ordinal"] = i
		}
		line, _ := json.Marshal(rec)
		b.Write(line)
		b.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		r.t.Fatal(err)
	}
	return path
}

func newRollout(t *testing.T) *rollout { return &rollout{t: t} }

func spawnSource(parent, path, nick string, depth int) map[string]any {
	return map[string]any{"subagent": map[string]any{"thread_spawn": map[string]any{
		"parent_thread_id": parent, "depth": depth, "agent_nickname": nick, "agent_path": path, "agent_role": nil}}}
}

// build discovers home and builds the session with the given id.
func build(t *testing.T, home, id string) *model.SessionDigest {
	t.Helper()
	h := New(home, fakePricer{})
	disc, err := h.Discover()
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range disc.Sessions {
		if s.Key.ID == id {
			d, err := h.Build(s)
			if err != nil {
				t.Fatal(err)
			}
			return d
		}
	}
	t.Fatalf("session %s not discovered (%d sessions, warnings %v)", id, len(disc.Sessions), disc.Warnings)
	return nil
}

func near(a, b float64) bool { return a-b < 1e-12 && b-a < 1e-12 }

// ---- a session tree -----------------------------------------------------------------------

// writeTree writes a root thread R with a subagent A (which spawns B) and a review thread V.
//
//	R turn r1: user prompt with an image; spawns A; A reports back; compaction in r2.
//	R turn r2: /compact (no prompt): the compaction call.
//	R turn r3: follow-up to A; interrupted; review mode entered after it.
//	R turn r4: the review (mirrored child turn v1 names r4 as its parent).
func writeTree(t *testing.T, home string) {
	newRollout(t).meta("R", "R", "vscode", nil).
		event(1, map[string]any{"type": "thread_settings_applied", "thread_settings": map[string]any{"model": "m", "service_tier": "default"}}).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).
		user(2, "Build the thing.", 1).
		tool(3, "exec", nil).
		tool(4, "spawn_agent", map[string]any{"task_name": "worker", "model": "m2", "reasoning_effort": "high", "fork_turns": "none", "message": "Do part one."}).
		usage(5, "resp-r1a", "r1", 1000, 600, 50).
		event(6, map[string]any{"type": "item_completed", "item": map[string]any{"type": "FileChange", "status": "completed", "changes": map[string]any{
			"/home/dev/acme/a.go": map[string]any{"type": "add", "content": "package a\n\nfunc A() {}\n"},
			"/home/dev/acme/b.go": map[string]any{"type": "update", "unified_diff": "--- a/b.go\n+++ b/b.go\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n"},
		}}}).
		item(20, map[string]any{"type": "agent_message", "author": "/root/worker", "recipient": "/root", "content": []any{map[string]any{"type": "input_text", "text": "Part one done."}}}).
		answer(21, "Started the worker.").
		usage(21, "resp-r1b", "r1", 2000, 1800, 40).
		done(22, "r1").
		start(30, "r2", "", "").ctx(30, "r2", "m", nil).
		usage(31, "resp-compact", "r2", 3000, 2900, 300).
		add(31, "compacted", map[string]any{"compaction_response_id": "resp-compact", "window_number": 1}).
		done(32, "r2").
		event(39, map[string]any{"type": "thread_settings_applied", "thread_settings": map[string]any{"model": "m", "service_tier": "priority"}}).
		start(40, "r3", "", "user").ctx(40, "r3", "m", "medium").
		user(41, "Now part two.", 0).
		tool(42, "followup_task", map[string]any{"target": "worker", "message": "Do part two."}).
		usage(43, "resp-r3", "r3", 500, 0, 10).
		event(44, map[string]any{"type": "turn_aborted", "turn_id": "r3", "reason": "interrupted", "duration_ms": 4000}).
		event(45, map[string]any{"type": "item_completed", "item": map[string]any{"type": "EnteredReviewMode", "target": map[string]any{"type": "uncommittedChanges"}}}).
		start(46, "v1", "r4", "").
		user(46, "Review my changes.", 0).
		event(60, map[string]any{"type": "task_complete", "turn_id": "r4", "duration_ms": 14000}).
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")

	newRollout(t).meta("A", "R", spawnSource("R", "/root/worker", "Ada", 1), map[string]any{"agent_nickname": "Ada", "agent_path": "/root/worker", "parent_thread_id": "R"}).
		start(10, "a1", "r1", "user").ctx(10, "a1", "m2", "high").
		item(10, map[string]any{"type": "agent_message", "author": "/root", "recipient": "/root/worker", "content": []any{map[string]any{"type": "input_text", "text": "wrapper"}, map[string]any{"type": "encrypted_content", "encrypted_content": "zz"}}}).
		tool(11, "spawn_agent", map[string]any{"task_name": "helper", "model": "m2", "fork_turns": "none", "message": "Help with part one."}).
		usage(12, "resp-a1", "a1", 4000, 1000, 100).
		answer(19, "Part one done.").done(19, "a1").
		start(43, "a2", "r3", "user").ctx(43, "a2", "m2", "high").
		usage(44, "resp-a2", "a2", 100, 0, 1).
		answer(50, "Part two done.").done(50, "a2").
		write(home, "rollout-2026-10-01T09-00-10-A.jsonl")

	newRollout(t).meta("B", "R", spawnSource("A", "/root/worker/helper", "Bo", 2), map[string]any{"agent_nickname": "Bo", "agent_path": "/root/worker/helper", "parent_thread_id": "A"}).
		start(13, "b1", "a1", "user").ctx(13, "b1", "m2", "low").
		usage(14, "resp-b1", "b1", 10, 0, 1).
		answer(15, "Helped.").done(15, "b1").
		write(home, "rollout-2026-10-01T09-00-13-B.jsonl")

	newRollout(t).meta("V", "R", map[string]any{"subagent": "review"}, map[string]any{"parent_thread_id": "R"}).
		start(46, "v1", "r4", "").ctx(46, "v1", "m", "medium").
		user(47, "Review my changes.", 0).
		usage(48, "resp-v1", "v1", 700, 0, 70).
		answer(59, "Looks fine.").done(59, "v1").
		write(home, "rollout-2026-10-01T09-00-46-V.jsonl")

	if err := os.WriteFile(filepath.Join(home, "session_index.jsonl"), []byte(
		`{"id":"R","thread_name":"First name","updated_at":"x"}`+"\n"+`{"id":"R","thread_name":"Renamed","updated_at":"y"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBuildTree(t *testing.T) {
	home := t.TempDir()
	writeTree(t, home)
	d := build(t, home, "R")

	if d.Harness != "codex" || d.ProjectKey != "-home-dev-acme" || d.Project != "/home/dev/acme" || d.Kind != model.KindInteractive {
		t.Errorf("identity = %s %s %s %s", d.Harness, d.ProjectKey, d.Project, d.Kind)
	}
	if d.Title != "Renamed" {
		t.Errorf("title = %q (the last session_index line wins)", d.Title)
	}
	if !reflect.DeepEqual(d.HarnessVersions, []string{"0.164.0"}) || !reflect.DeepEqual(d.GitBranches, []string{"main"}) {
		t.Errorf("versions/branches = %v %v", d.HarnessVersions, d.GitBranches)
	}
	if len(d.Source) != 5 { // four rollouts and the session index
		t.Errorf("source = %+v", d.Source)
	}

	// Main turns.
	if len(d.Turns) != 4 {
		t.Fatalf("turns = %d", len(d.Turns))
	}
	r1, r2, r3, r4 := d.Turns[0], d.Turns[1], d.Turns[2], d.Turns[3]
	if r1.Origin != model.OriginHuman || r1.UserText != "Build the thing." || r1.Images != 1 || r1.FinalText != "Started the worker." ||
		r1.AssistantMessages != 2 || r1.ToolCalls != 2 || r1.ToolsByName["spawn_agent"] != 1 || r1.UUID != "r1" {
		t.Errorf("r1 = %+v", r1)
	}
	if !reflect.DeepEqual(r1.FilesTouched, []string{"/home/dev/acme/a.go", "/home/dev/acme/b.go"}) {
		t.Errorf("files = %v", r1.FilesTouched)
	}
	if d.Stats.LinesAdded != 5 || d.Stats.LinesRemoved != 1 {
		t.Errorf("lines = +%d -%d", d.Stats.LinesAdded, d.Stats.LinesRemoved)
	}
	if r2.Origin != model.OriginCommand || r2.Command != "compact" || r2.Epoch != 0 || r3.Epoch != 1 {
		t.Errorf("r2 = %s %q epoch %d, r3 epoch %d", r2.Origin, r2.Command, r2.Epoch, r3.Epoch)
	}
	if !r3.Interrupted || r3.DurationMs != 4000 || r3.UserText != "Now part two." {
		t.Errorf("r3 = %+v", r3)
	}
	if r4.Origin != model.OriginCommand || r4.Command != "review" || r4.UUID != "r4" || r4.AssistantMessages != 0 {
		t.Errorf("r4 (mirrored review turn) = %+v", r4)
	}
	// A's report arrived while r1 ran: queued in it, as a task notification from A.
	if len(r1.Queued) != 1 || r1.Queued[0].Origin != model.OriginTaskNotification || r1.Queued[0].Inbox[0].AgentID != "A" ||
		r1.Queued[0].Inbox[0].Text != "Part one done." || r1.Queued[0].Inbox[0].Kind != model.InboxTask {
		t.Errorf("r1 queued = %+v", r1.Queued)
	}

	// Compaction: its call is recorded, so it is a real message.
	if len(d.Compactions) != 1 {
		t.Fatalf("compactions = %+v", d.Compactions)
	}
	c := d.Compactions[0]
	if c.Turn != 1 || c.Trigger != model.TriggerManual || c.MessageID != "resp-compact" || c.PreTokens != 3000 {
		t.Errorf("compaction = %+v", c)
	}
	// 2900 of 3000 cached: warm, 10 s after the previous call, its cost the message's.
	if call := c.Call; call == nil || call.Cache != model.CacheWarm || call.Billing != model.BillingCacheRead || call.IdleMs != 10000 ||
		call.InputTokens != 3000 || call.OutputTokens != 300 || !near(call.USD, (100+290+3000)/1e6) || call.WarmUSD != call.USD {
		t.Errorf("compaction call = %+v", c.Call)
	}

	// Messages: tokens split into uncached input, cached input and output; priced per model.
	byID := map[string]model.Message{}
	for _, m := range d.Messages {
		byID[m.ID] = m
	}
	if len(d.Messages) != 8 {
		t.Errorf("messages = %d", len(d.Messages))
	}
	m := byID["resp-r1a"]
	if m.Model != "m" || m.Input != 400 || m.CacheRead != 600 || m.Output != 50 || m.Turn == nil || *m.Turn != 0 || m.AgentID != "" {
		t.Errorf("resp-r1a = %+v", m)
	}
	if !near(m.USD, (400+60+500)/1e6) {
		t.Errorf("resp-r1a usd = %v", m.USD)
	}
	if byID["resp-r1a"].Fast {
		t.Error("default tier is not fast")
	}
	if fast := byID["resp-r3"]; fast.Model != "m" || !fast.Fast || !near(fast.USD, 2*(500+100)/1e6) {
		t.Errorf("priority tier must price as fast: %+v", fast)
	}
	if a := byID["resp-a1"]; a.AgentID != "A" || a.Model != "m2" || a.AgentTurn == nil || *a.AgentTurn != 0 || a.Turn == nil || *a.Turn != 0 {
		t.Errorf("resp-a1 = %+v", a)
	}
	if a := byID["resp-a2"]; a.AgentTurn == nil || *a.AgentTurn != 1 {
		t.Errorf("resp-a2 = %+v", a)
	}
	var sum float64
	for _, m := range d.Messages {
		sum += m.USD
	}
	if !near(d.Cost.USD, sum) {
		t.Errorf("cost %v != sum of messages %v", d.Cost.USD, sum)
	}

	// Agents: A (subagent of the main agent), B (A's subagent), V (the review).
	if len(d.Agents) != 3 {
		t.Fatalf("agents = %+v", d.Agents)
	}
	ag := map[string]model.Agent{}
	for _, a := range d.Agents {
		ag[a.ID] = a
	}
	a, b, v := ag["A"], ag["B"], ag["V"]
	if a.Kind != model.AgentSubagent || a.Depth != 1 || a.ParentAgentID != nil || a.Name != "Ada" || a.Description != "worker" ||
		a.Model != "m2" || a.Prompt != "Do part one." || a.Status != model.StatusCompleted || !a.Addressable || a.InheritsContext ||
		a.SpawnToolUseID == "" || a.SpawnTurn == nil || *a.SpawnTurn != 0 || a.FinalText != "Part two done." || a.Linkage != model.LinkMeta {
		t.Errorf("A = %+v", a)
	}
	if len(a.Turns) != 2 {
		t.Fatalf("A turns = %+v", a.Turns)
	}
	if a0 := a.Turns[0]; a0.Origin != model.OriginSpawn || a0.Prompt != "Do part one." || a0.RootTurn == nil || *a0.RootTurn != 0 || a0.AssistantMessages != 1 {
		t.Errorf("A turn 0 = %+v", a0)
	}
	// The follow-up from r3 started A's second turn; its root turn is r3, from the parent turn Codex records.
	if a1 := a.Turns[1]; a1.Origin != model.OriginPeer || len(a1.Inbox) != 1 || a1.Inbox[0].Kind != model.InboxAssignment ||
		a1.Inbox[0].Text != "Do part two." || a1.Inbox[0].AgentID != "" || a1.RootTurn == nil || *a1.RootTurn != 2 {
		t.Errorf("A turn 1 = %+v", a1)
	}
	if len(a.Inbox) != 1 || a.Inbox[0].Text != "Do part two." {
		t.Errorf("A inbox = %+v", a.Inbox)
	}
	if b.Depth != 2 || b.ParentAgentID == nil || *b.ParentAgentID != "A" || b.Prompt != "Help with part one." ||
		b.SpawnTurn == nil || *b.SpawnTurn != 0 || len(b.Turns) != 1 || b.Turns[0].RootTurn == nil || *b.Turns[0].RootTurn != 0 {
		t.Errorf("B = %+v", b)
	}
	if !near(a.SubtreeUSD, a.Cost.USD+b.Cost.USD) {
		t.Errorf("A subtree %v != %v + %v", a.SubtreeUSD, a.Cost.USD, b.Cost.USD)
	}
	if v.Kind != model.AgentReview || v.Addressable || v.Prompt != "Review my changes." || v.SpawnTurn == nil || *v.SpawnTurn != 3 ||
		len(v.Turns) != 1 || v.Turns[0].Origin != model.OriginSpawn {
		t.Errorf("V = %+v", v)
	}
	if !reflect.DeepEqual(r1.Spawned, []string{"A"}) || !near(r1.CostWithAgents, r1.Cost.USD+a.SubtreeUSD) ||
		!reflect.DeepEqual(r4.Spawned, []string{"V"}) {
		t.Errorf("spawned r1 %v (%v) r4 %v", r1.Spawned, r1.CostWithAgents, r4.Spawned)
	}
	if d.EndState != model.EndClean || d.Stats.HumanTurns != 4 || d.Stats.AssistantMessages != 8 {
		t.Errorf("end %s stats %+v", d.EndState, d.Stats)
	}
}

func TestBuildIsDeterministic(t *testing.T) {
	home := t.TempDir()
	writeTree(t, home)
	a, _ := json.Marshal(build(t, home, "R"))
	b, _ := json.Marshal(build(t, home, "R"))
	if string(a) != string(b) {
		t.Error("two builds of the same files differ")
	}
}

// ---- forks, copied history, scripted runs ------------------------------------------------

func TestForkInheritsParentPrefix(t *testing.T) {
	home := t.TempDir()
	parent := newRollout(t).meta("P", "P", "vscode", nil).
		start(1, "p1", "", "user").ctx(1, "p1", "m", nil).user(1, "First.", 0).usage(2, "resp-p1", "p1", 100, 0, 10).done(3, "p1").
		start(4, "p2", "", "user").ctx(4, "p2", "m", nil).user(4, "Second.", 0).usage(5, "resp-p2", "p2", 200, 100, 10).done(6, "p2")
	// The fork point is after p1: the fork inherits p1 only.
	var cut int64
	for i, rec := range parent.recs {
		if p, _ := rec["payload"].(map[string]any); p["turn_id"] == "p2" && p["type"] == "task_started" {
			parent.recs[i]["ordinal"] = i
			cut = int64(i)
		}
	}
	path := parent.write(home, "rollout-2026-10-01T09-00-00-P.jsonl")
	data, _ := os.ReadFile(path)
	offset := int64(0)
	for i, line := range strings.SplitAfter(string(data), "\n") {
		if int64(i) == cut {
			break
		}
		offset += int64(len(line))
	}
	fork := newRollout(t).meta("F", "F", "vscode", map[string]any{"forked_from_id": "P",
		"history_base": map[string]any{"thread_id": "P", "end_byte_offset": offset, "end_ordinal_exclusive": cut}})
	fork.recs[0]["ordinal"] = cut
	fork.start(10, "f1", "", "user").ctx(10, "f1", "m", nil).user(10, "Fork prompt.", 0).usage(11, "resp-f1", "f1", 300, 0, 10).done(12, "f1")
	for i := range fork.recs[1:] {
		fork.recs[i+1]["ordinal"] = cut + int64(i) + 1
	}
	fork.write(home, "rollout-2026-10-01T09-00-10-F.jsonl")

	d := build(t, home, "F")
	if d.Lineage.ForkedFrom == nil || d.Lineage.ForkedFrom.SessionID != "P" || d.Lineage.ForkedFrom.MessageUUID != "p1" {
		t.Fatalf("forkedFrom = %+v", d.Lineage.ForkedFrom)
	}
	if len(d.Turns) != 2 || d.Turns[0].UUID != "p1" || d.Turns[1].UUID != "f1" || d.Turns[1].UserText != "Fork prompt." {
		t.Errorf("turns = %+v", d.Turns)
	}
	if len(d.Messages) != 2 || d.Messages[0].ID != "resp-p1" || d.Messages[1].ID != "resp-f1" {
		t.Errorf("messages = %+v", d.Messages)
	}
	found := false
	for _, s := range d.Source {
		found = found || s.Path == path
	}
	if !found {
		t.Errorf("the parent's rollout must be part of the fork's source: %+v", d.Source)
	}
}

func TestSubagentCopiedHistoryIsSkipped(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("R", "R", "vscode", nil).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).user(1, "Go.", 0).
		tool(2, "spawn_agent", map[string]any{"task_name": "forked", "fork_turns": "all", "message": "Carry on."}).
		usage(3, "resp-r1", "r1", 100, 0, 10).done(9, "r1").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
	child := newRollout(t).meta("C", "R", spawnSource("R", "/root/forked", "Cy", 1), map[string]any{"subagent_history_start_ordinal": 4}).
		meta("R", "R", "vscode", nil). // the parent's copied meta
		start(1, "r1", "", "user").    // the parent's copied turn
		user(1, "Go.", 0).
		start(4, "c1", "r1", "user").ctx(4, "c1", "m", "low").usage(5, "resp-c1", "c1", 50, 0, 5).done(6, "c1")
	child.write(home, "rollout-2026-10-01T09-00-04-C.jsonl")

	d := build(t, home, "R")
	if len(d.Agents) != 1 {
		t.Fatalf("agents = %+v", d.Agents)
	}
	c := d.Agents[0]
	if !c.InheritsContext || len(c.Turns) != 1 || c.Turns[0].Prompt != "Carry on." || c.AssistantMessages != 1 {
		t.Errorf("C = %+v", c)
	}
}

func TestExecSessionIsScripted(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("E", "E", "exec", map[string]any{"originator": "codex_exec"}).
		start(1, "e1", "", "exec").ctx(1, "e1", "unknown-model", "low").user(1, "One shot.", 0).usage(2, "resp-e1", "e1", 10, 0, 1).done(3, "e1").
		write(home, "rollout-2026-10-01T09-00-00-E.jsonl")
	d := build(t, home, "E")
	if d.Kind != model.KindSDK || d.Turns[0].Origin != model.OriginSDK || d.Title != "One shot." {
		t.Errorf("kind %s origin %s title %q", d.Kind, d.Turns[0].Origin, d.Title)
	}
	if !reflect.DeepEqual(d.Diagnostics.UnpricedModels, []string{"unknown-model"}) || d.Cost.USD != 0 || len(d.Messages) != 1 {
		t.Errorf("unpriced: %+v cost %v", d.Diagnostics, d.Cost)
	}
}

func TestColdCompaction(t *testing.T) {
	home := t.TempDir()
	newRollout(t).meta("C", "C", "cli", nil).
		start(1, "c1", "", "user").ctx(1, "c1", "m", nil).user(1, "Go.", 0).usage(2, "resp-c1", "c1", 5000, 0, 10).done(3, "c1").
		start(3600, "c2", "", "").ctx(3600, "c2", "m", nil).
		usage(3610, "resp-cc", "c2", 5100, 1000, 200).
		add(3610, "compacted", map[string]any{"compaction_response_id": "resp-cc", "window_number": 1}).
		done(3611, "c2").
		write(home, "rollout-2026-10-01T09-00-00-C.jsonl")
	d := build(t, home, "C")
	if len(d.Compactions) != 1 || d.Compactions[0].Call == nil {
		t.Fatalf("compactions = %+v", d.Compactions)
	}
	call := d.Compactions[0].Call
	// 1000 of 5100 cached: cold, billed as input; warm would have read all 5100 from the cache.
	if call.Cache != model.CacheCold || call.Billing != model.BillingInput || call.IdleMs != 3608000 ||
		!near(call.USD, (4100+100+2000)/1e6) || !near(call.WarmUSD, (510+2000)/1e6) {
		t.Errorf("call = %+v", call)
	}
}

// ---- discovery and tolerance ------------------------------------------------------------

func TestDiscoverGroupsTreesAndWarns(t *testing.T) {
	home := t.TempDir()
	writeTree(t, home)
	newRollout(t).meta("Z", "Z", "cli", map[string]any{"cwd": "/srv/other.dir"}).write(home, "rollout-2026-10-01T10-00-00-Z.jsonl")
	bad := filepath.Join(home, "sessions", "2026", "10", "01", "rollout-2026-10-01T11-00-00-bad.jsonl")
	if err := os.WriteFile(bad, []byte(`{"type":"something_else"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	disc, err := New(home, fakePricer{}).Discover()
	if err != nil {
		t.Fatal(err)
	}
	if len(disc.Sessions) != 2 {
		t.Fatalf("sessions = %+v", disc.Sessions)
	}
	keys := map[string]string{}
	for _, s := range disc.Sessions {
		keys[s.Key.ID] = s.ProjectKey
		for i := 1; i < len(s.Fingerprint); i++ {
			if s.Fingerprint[i-1].Path >= s.Fingerprint[i].Path {
				t.Errorf("fingerprint not sorted: %+v", s.Fingerprint)
			}
		}
	}
	if keys["R"] != "-home-dev-acme" || keys["Z"] != "-srv-other-dir" {
		t.Errorf("project keys = %v", keys)
	}
	if len(disc.Warnings) != 1 || !strings.Contains(disc.Warnings[0], "bad.jsonl") {
		t.Errorf("warnings = %v", disc.Warnings)
	}
	// No sessions directory: no sessions, no error.
	if disc, err := New(t.TempDir(), fakePricer{}).Discover(); err != nil || len(disc.Sessions) != 0 {
		t.Errorf("empty home: %+v %v", disc, err)
	}
}

func TestToleratesBadPartialAndUnknownLines(t *testing.T) {
	home := t.TempDir()
	path := newRollout(t).meta("R", "R", "vscode", nil).
		start(1, "r1", "", "user").ctx(1, "r1", "m", nil).user(1, "Hi.", 0).
		add(2, "brand_new_record", map[string]any{}).
		event(2, map[string]any{"type": "brand_new_event"}).
		usage(3, "resp-1", "r1", 10, 0, 1).done(4, "r1").
		write(home, "rollout-2026-10-01T09-00-00-R.jsonl")
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("not json\n")
	f.WriteString(`{"timestamp":"` + ts(5) + `","type":"token_usage_record","payload":{"response_id":"partial"`) // still being written
	f.Close()
	d := build(t, home, "R")
	if d.Diagnostics.BadLines != 1 || d.Diagnostics.UnknownTypes["brand_new_record"] != 1 || d.Diagnostics.UnknownTypes["event_msg/brand_new_event"] != 1 {
		t.Errorf("diagnostics = %+v", d.Diagnostics)
	}
	if len(d.Messages) != 1 {
		t.Errorf("the partial last line must not be read: %+v", d.Messages)
	}
}

func TestLocate(t *testing.T) {
	home := t.TempDir()
	writeTree(t, home)
	h := New(home, fakePricer{})
	if s, found, err := h.Locate(harnessRef("R")); err != nil || !found || s.Key.ID != "R" || len(s.Fingerprint) != 5 {
		t.Errorf("locate R = %+v %v %v", s, found, err)
	}
	if _, found, _ := h.Locate(harnessRef("nope")); found {
		t.Error("found a session that does not exist")
	}
}

func harnessRef(id string) harness.SessionRef { return harness.SessionRef{ID: id} }
