package transcript

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/terek/merlin/explorer/internal/model"
)

func mustDecode(t *testing.T, line string) *Record {
	t.Helper()
	r, err := Decode([]byte(line))
	if err != nil {
		t.Fatalf("decode %q: %v", line, err)
	}
	return r
}

// One hand-written example of every record type, with invented content.
func TestDecodeEveryRecordType(t *testing.T) {
	tests := []struct {
		name  string
		line  string
		check func(t *testing.T, r *Record)
	}{
		{"user string content", `{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-03-01T10:00:00.250Z","sessionId":"s1","cwd":"/w","gitBranch":"main","version":"2.1.9","entrypoint":"cli","isSidechain":false,"message":{"role":"user","content":"hello there"}}`,
			func(t *testing.T, r *Record) {
				m, ok := r.UserMessage()
				if !ok || !m.Content.FromString || m.Content.Text() != "hello there" {
					t.Fatalf("%+v", m)
				}
				if !r.IsPrompt() || r.UUID != "u1" || r.ParentUUID != "" || r.Cwd != "/w" || r.Entrypoint != "cli" {
					t.Fatalf("%+v", r.Envelope)
				}
				if ts, ok := r.Time(); !ok || ts.UnixMilli() != 1772359200250 {
					t.Fatalf("time %v %v", ts, ok)
				}
			}},
		{"user array content with image", `{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"text","text":"look"},{"type":"image","source":{"type":"base64","data":"AAAA"}},{"type":"text","text":"at this"}]}}`,
			func(t *testing.T, r *Record) {
				m, _ := r.UserMessage()
				if m.Content.FromString || r.PromptText() != "look\nat this" || r.PromptImages() != 1 || !r.IsPrompt() {
					t.Fatalf("%+v", m)
				}
			}},
		{"user tool_result with agent toolUseResult completed", `{"type":"user","uuid":"u3","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"result words"}]}]},"toolUseResult":{"status":"completed","agentId":"abc123","content":[{"type":"text","text":"x"}],"totalTokens":900,"totalDurationMs":1500,"totalToolUseCount":4,"usage":{"input_tokens":5,"output_tokens":6}}}`,
			func(t *testing.T, r *Record) {
				if !r.IsToolResult() || r.IsPrompt() {
					t.Fatal("should be a tool result")
				}
				m, _ := r.UserMessage()
				if got := m.Content.Blocks[0]; got.ToolUseID != "tu1" || got.ResultText() != "result words" {
					t.Fatalf("%+v", got)
				}
				tr, ok := r.ToolUseResult()
				if !ok || tr.Status != SpawnCompleted || tr.AgentID != "abc123" || tr.TotalTokens != 900 ||
					tr.TotalDurationMs != 1500 || tr.TotalToolUseCount != 4 || tr.Usage.OutputTokens != 6 {
					t.Fatalf("%+v", tr)
				}
			}},
		{"toolUseResult async_launched", `{"type":"user","uuid":"u4","message":{"content":[{"type":"tool_result","tool_use_id":"tu2","content":"ok"}]},"toolUseResult":{"status":"async_launched","agentId":"bg1","description":"scan","resolvedModel":"claude-sonnet-5-5","outputFile":"/o/f"}}`,
			func(t *testing.T, r *Record) {
				tr, ok := r.ToolUseResult()
				if !ok || tr.Status != SpawnAsyncLaunched || tr.AgentID != "bg1" || tr.ResolvedModel != "claude-sonnet-5-5" || tr.OutputFile != "/o/f" || tr.Description != "scan" {
					t.Fatalf("%+v", tr)
				}
				m, _ := r.UserMessage()
				if m.Content.Blocks[0].ResultText() != "ok" {
					t.Fatal("string tool_result content")
				}
			}},
		{"toolUseResult teammate_spawned", `{"type":"user","uuid":"u5","message":{"content":[{"type":"tool_result","tool_use_id":"tu3","content":"ok"}]},"toolUseResult":{"status":"teammate_spawned","name":"reviewer","team_name":"crew","agent_id":"reviewer@crew","model":"sonnet"}}`,
			func(t *testing.T, r *Record) {
				tr, ok := r.ToolUseResult()
				if !ok || tr.Name != "reviewer" || tr.TeamName != "crew" || tr.TeammateID != "reviewer@crew" || tr.Model != "sonnet" {
					t.Fatalf("%+v", tr)
				}
			}},
		{"toolUseResult as string", `{"type":"user","uuid":"u6","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]},"toolUseResult":"Error: nope"}`,
			func(t *testing.T, r *Record) {
				if _, ok := r.ToolUseResult(); ok {
					t.Fatal("string toolUseResult is not an agent spawn")
				}
				if !r.IsToolResult() {
					t.Fatal("still a tool result")
				}
			}},
		{"toolUseResult plain object without status", `{"type":"user","uuid":"u7","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]},"toolUseResult":{"stdout":"hi"}}`,
			func(t *testing.T, r *Record) {
				if _, ok := r.ToolUseResult(); ok {
					t.Fatal("no status")
				}
			}},
		{"assistant with usage", `{"type":"assistant","uuid":"a1","parentUuid":"u1","requestId":"req1","timestamp":"2026-03-01T10:00:02Z","message":{"id":"msg_01","model":"claude-opus-5-5","role":"assistant","stop_reason":null,"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"answer"},{"type":"tool_use","id":"tu9","name":"Agent","input":{"description":"look around","prompt":"find things","subagent_type":"Explore","name":"scout","run_in_background":true,"isolation":"worktree","model":"haiku"}}],"usage":{"input_tokens":3,"output_tokens":40,"cache_read_input_tokens":1000,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"server_tool_use":{"web_search_requests":2,"web_fetch_requests":1},"speed":"fast","service_tier":"standard","iterations":[{"x":1}]}}}`,
			func(t *testing.T, r *Record) {
				m, ok := r.AssistantMessage()
				if !ok || m.ID != "msg_01" || m.Model != "claude-opus-5-5" || m.StopReason != "" || len(m.Content.Blocks) != 3 {
					t.Fatalf("%+v", m)
				}
				u := m.Usage
				w5, w1 := u.CacheWrites()
				if u.InputTokens != 3 || u.OutputTokens != 40 || u.CacheReadInputTokens != 1000 || w5 != 100 || w1 != 200 ||
					u.Speed != "fast" || u.ServerToolUse.WebSearchRequests != 2 || u.ServerToolUse.WebFetchRequests != 1 || u.ContextTokens() != 1303 {
					t.Fatalf("%+v", u)
				}
				in, ok := m.Content.Blocks[2].AgentInput()
				if !ok || in.Prompt != "find things" || in.SubagentType != "Explore" || in.Name != "scout" || !in.RunInBackground || in.Isolation != "worktree" || in.Description != "look around" {
					t.Fatalf("%+v", in)
				}
				if m.Content.Blocks[2].ID != "tu9" || m.Content.Text() != "answer" || r.RequestID != "req1" {
					t.Fatal("blocks")
				}
			}},
		{"assistant without cache breakdown", `{"type":"assistant","uuid":"a2","message":{"id":"m2","model":"x","stop_reason":"end_turn","content":[{"type":"text","text":"t"}],"usage":{"cache_creation_input_tokens":50}}}`,
			func(t *testing.T, r *Record) {
				m, _ := r.AssistantMessage()
				if w5, w1 := m.Usage.CacheWrites(); w5 != 50 || w1 != 0 || m.StopReason != "end_turn" || m.Usage.InputTokens != 0 {
					t.Fatalf("%+v", m.Usage)
				}
			}},
		{"assistant string content", `{"type":"assistant","uuid":"a3","isApiErrorMessage":true,"message":{"id":"m3","model":"<synthetic>","content":"API Error"}}`,
			func(t *testing.T, r *Record) {
				m, _ := r.AssistantMessage()
				if m.Content.Text() != "API Error" || !r.IsAPIErrorMessage || m.Model != "<synthetic>" {
					t.Fatalf("%+v", m)
				}
			}},
		{"compact boundary", `{"type":"system","subtype":"compact_boundary","uuid":"c1","parentUuid":null,"logicalParentUuid":"a9","timestamp":"2026-03-01T11:00:00Z","compactMetadata":{"trigger":"auto","preTokens":200000,"postTokens":9000,"durationMs":4000,"cumulativeDroppedTokens":1,"preservedSegment":{"headUuid":"h","anchorUuid":"an","tailUuid":"tl"},"extra":true}}`,
			func(t *testing.T, r *Record) {
				m, ok := r.CompactMetadata()
				if !r.IsCompactBoundary() || !ok || r.LogicalParentUUID != "a9" || m.Trigger != "auto" || m.PreTokens != 200000 ||
					*m.PostTokens != 9000 || *m.DurationMs != 4000 || m.PreservedSegment.TailUUID != "tl" {
					t.Fatalf("%+v", m)
				}
			}},
		{"compact boundary old version", `{"type":"system","subtype":"compact_boundary","uuid":"c2","compactMetadata":{"trigger":"manual","preTokens":5}}`,
			func(t *testing.T, r *Record) {
				m, _ := r.CompactMetadata()
				if m.PostTokens != nil || m.DurationMs != nil || m.PreTokens != 5 {
					t.Fatalf("%+v", m)
				}
			}},
		{"compact summary", `{"type":"user","uuid":"c3","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"content":"This session is being continued from a previous conversation ..."}}`,
			func(t *testing.T, r *Record) {
				if r.IsPrompt() || !r.IsCompactSummary {
					t.Fatal("summary is not a prompt")
				}
			}},
		{"meta user record", `{"type":"user","uuid":"m1","isMeta":true,"message":{"content":"<system-reminder>caveat</system-reminder>"}}`,
			func(t *testing.T, r *Record) {
				if r.IsPrompt() {
					t.Fatal("isMeta is not a prompt")
				}
			}},
		{"cost-state", `{"type":"cost-state","totalCostUSD":12.5,"startTime":1772000000000,"totalAPIDuration":321.5,"totalLinesAdded":10,"totalLinesRemoved":2,"modelUsage":{"claude-opus-5-5[1m]":{"inputTokens":1,"outputTokens":2,"thinkingTokens":3,"cacheReadInputTokens":4,"cacheCreationInputTokens":5,"webSearchRequests":6,"costUSD":12.5}}}`,
			func(t *testing.T, r *Record) {
				c, ok := r.CostState()
				mu := c.ModelUsage["claude-opus-5-5[1m]"]
				if !ok || c.TotalCostUSD != 12.5 || c.TotalLinesAdded != 10 || c.TotalLinesRemoved != 2 || mu.CacheReadInputTokens != 4 || mu.CostUSD != 12.5 || mu.WebSearchRequests != 6 {
					t.Fatalf("%+v", c)
				}
			}},
		{"ai-title", `{"type":"ai-title","aiTitle":"Fix the thing"}`, func(t *testing.T, r *Record) {
			if r.AITitle() != "Fix the thing" || r.CustomTitle() != "" {
				t.Fatal(r.AITitle())
			}
		}},
		{"custom-title", `{"type":"custom-title","customTitle":"Mine"}`, func(t *testing.T, r *Record) {
			if r.CustomTitle() != "Mine" {
				t.Fatal(r.CustomTitle())
			}
		}},
		{"agent-name", `{"type":"agent-name","agentName":"cedar"}`, func(t *testing.T, r *Record) {
			if r.AgentName() != "cedar" {
				t.Fatal(r.AgentName())
			}
		}},
		{"last-prompt", `{"type":"last-prompt","lastPrompt":"do it","leafUuid":"leaf1"}`, func(t *testing.T, r *Record) {
			p, l, ok := r.LastPrompt()
			if !ok || p != "do it" || l != "leaf1" {
				t.Fatal(p, l)
			}
		}},
		{"away_summary", `{"type":"system","subtype":"away_summary","uuid":"s1","content":"You were fixing the parser."}`, func(t *testing.T, r *Record) {
			if s, ok := r.AwaySummary(); !ok || s != "You were fixing the parser." {
				t.Fatal(s)
			}
		}},
		{"turn_duration", `{"type":"system","subtype":"turn_duration","uuid":"s2","durationMs":4200,"messageCount":7}`, func(t *testing.T, r *Record) {
			if d, n, ok := r.TurnDuration(); !ok || d != 4200 || n != 7 {
				t.Fatal(d, n)
			}
		}},
		{"relocated", `{"type":"relocated","relocatedCwd":"/new/dir"}`, func(t *testing.T, r *Record) {
			if r.RelocatedCwd() != "/new/dir" {
				t.Fatal()
			}
		}},
		{"fork-context-ref", `{"type":"fork-context-ref","agentId":"f1","parentSessionId":"p1","parentLastUuid":"pl","contextLength":321}`, func(t *testing.T, r *Record) {
			f, ok := r.ForkContextRef()
			if !ok || f.AgentID != "f1" || f.ParentSessionID != "p1" || f.ParentLastUUID != "pl" || f.ContextLength != 321 {
				t.Fatalf("%+v", f)
			}
		}},
		{"origin and promptSource", `{"type":"user","uuid":"o1","origin":{"kind":"human"},"promptSource":"typed","turnOrigin":"human","forkedFrom":{"sessionId":"p","messageUuid":"m"},"session_id":"other","message":{"content":"hi"}}`,
			func(t *testing.T, r *Record) {
				if r.Origin.Kind != "human" || r.PromptSource != "typed" || r.TurnOrigin != "human" ||
					r.ForkedFrom.SessionID != "p" || r.ForkedFrom.MessageUUID != "m" || r.OtherSessionID != "other" {
					t.Fatalf("%+v", r.Envelope)
				}
			}},
		{"known ignored type", `{"type":"file-history-snapshot","messageId":"x"}`, func(t *testing.T, r *Record) {
			if !r.Known() {
				t.Fatal("file-history-* is known")
			}
		}},
		{"attachment", `{"type":"attachment","uuid":"at1","parentUuid":"u1","attachment":{"type":"hook_success"}}`, func(t *testing.T, r *Record) {
			if !r.Known() || r.UUID != "at1" || r.ParentUUID != "u1" {
				t.Fatal()
			}
		}},
		{"unknown type", `{"type":"quantum-entangle","uuid":"zz","foo":{"bar":1}}`, func(t *testing.T, r *Record) {
			if r.Known() || r.Type != "quantum-entangle" || !reflect.DeepEqual(r.Envelope, Envelope{Type: "quantum-entangle"}) {
				t.Fatalf("%+v", r.Envelope)
			}
		}},
		{"no type at all", `{"foo":1}`, func(t *testing.T, r *Record) {
			if r.Type != "" || r.Known() {
				t.Fatal()
			}
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { tc.check(t, mustDecode(t, tc.line)) })
	}
}

func TestDecodeTolerance(t *testing.T) {
	// Wrong-typed fields are dropped but the rest of the record survives.
	r := mustDecode(t, `{"type":"user","uuid":"u","isMeta":"yes","isSidechain":3,"cwd":["x"],"forkedFrom":"nope","origin":"human","message":{"content":"hi"}}`)
	if r.UUID != "u" || r.IsMeta || r.Cwd != "" || r.ForkedFrom != nil || r.Origin == nil || r.Origin.Kind != "human" {
		t.Fatalf("%+v", r.Envelope)
	}
	if !r.IsPrompt() || r.PromptText() != "hi" {
		t.Fatal("record should still be a prompt")
	}
	// content of unexpected shape, numeric fields absent.
	r = mustDecode(t, `{"type":"assistant","uuid":"a","message":{"id":"m","content":42,"usage":{"input_tokens":"many"}}}`)
	m, ok := r.AssistantMessage()
	if !ok || len(m.Content.Blocks) != 0 || m.Usage.InputTokens != 0 || m.Usage.OutputTokens != 0 {
		t.Fatalf("%+v %v", m, ok)
	}
	// A block that is not an object does not fail the record.
	r = mustDecode(t, `{"type":"user","message":{"content":["str",{"type":"text","text":"ok"},{"type":"mystery","x":1}]}}`)
	if r.PromptText() != "ok" {
		t.Fatal(r.PromptText())
	}
	// message missing or not an object.
	for _, line := range []string{`{"type":"user"}`, `{"type":"user","message":"str"}`, `{"type":"assistant","message":null}`} {
		r := mustDecode(t, line)
		if _, ok := r.UserMessage(); ok && r.Type == "assistant" {
			t.Fatal("unexpected")
		}
		_ = r.IsPrompt()
		_ = r.PromptText()
		_, _ = r.AssistantMessage()
	}
	// Decode must keep its own copy of the line.
	buf := []byte(`{"type":"ai-title","aiTitle":"abc"}`)
	r = mustDecode(t, string(buf))
	r2, _ := Decode(buf)
	copy(buf, `{"type":"ai-title","aiTitle":"xyz"}`)
	if r2.AITitle() != "abc" {
		t.Fatal("Decode must copy its input")
	}

	for _, bad := range []string{``, `   `, `[1,2]`, `"s"`, `{"type":"user"`, `not json`, `123`} {
		if _, err := Decode([]byte(bad)); err == nil {
			t.Errorf("Decode(%q) should fail", bad)
		}
	}
	if r, err := Decode([]byte("  {\"type\":\"ai-title\"}\n")); err != nil || r.Type != "ai-title" {
		t.Fatal("surrounding whitespace")
	}
}

func TestAgentMeta(t *testing.T) {
	m, err := ParseAgentMeta([]byte(`{"agentType":"general-purpose","description":"d","toolUseId":"tu","spawnDepth":1,"parentAgentId":"p","model":"sonnet","isFork":true,"future":1}`))
	if err != nil || m.AgentType != "general-purpose" || m.ToolUseID != "tu" || *m.SpawnDepth != 1 || m.ParentAgentID != "p" || !m.IsFork {
		t.Fatalf("%+v %v", m, err)
	}
	m, _ = ParseAgentMeta([]byte(`{"agentType":"reviewer","name":"reviewer","teamName":"crew","taskKind":"in_process_teammate","color":"blue","spawnDepth":0}`))
	if m.SpawnDepth == nil || *m.SpawnDepth != 0 || m.Name != "reviewer" || m.TeamName != "crew" || m.TaskKind != "in_process_teammate" || m.Color != "blue" {
		t.Fatalf("%+v", m)
	}
	m, _ = ParseAgentMeta([]byte(`{"spawnDepth":"deep","agentType":"x"}`))
	if m.SpawnDepth != nil || m.AgentType != "x" {
		t.Fatalf("%+v", m)
	}
	if _, err := ParseAgentMeta([]byte(`{`)); err == nil {
		t.Fatal("invalid JSON should fail")
	}
}

func TestStructsRoundTrip(t *testing.T) {
	// Content keeps its string/array form.
	for _, in := range []string{`"plain"`, `[{"type":"text","text":"a"},{"type":"tool_use","id":"i","name":"Bash","input":{"command":"ls"}}]`} {
		var c Content
		if err := json.Unmarshal([]byte(in), &c); err != nil {
			t.Fatal(err)
		}
		out, err := json.Marshal(c)
		if err != nil || string(out) != in {
			t.Fatalf("got %s want %s (%v)", out, in, err)
		}
	}
	u := Usage{InputTokens: 1, OutputTokens: 2, CacheReadInputTokens: 3, CacheCreationInputTokens: 4,
		CacheCreation: &CacheCreation{1, 3}, ServerToolUse: &ServerToolUse{1, 2}, Speed: "fast", ServiceTier: "standard"}
	b, _ := json.Marshal(u)
	var u2 Usage
	if err := json.Unmarshal(b, &u2); err != nil || !reflect.DeepEqual(u, u2) {
		t.Fatalf("%+v %v", u2, err)
	}
	cm := CompactMetadata{Trigger: "auto", PreTokens: 1, PostTokens: new(int64)}
	b, _ = json.Marshal(cm)
	var cm2 CompactMetadata
	if err := json.Unmarshal(b, &cm2); err != nil || !reflect.DeepEqual(cm, cm2) {
		t.Fatalf("%+v %v", cm2, err)
	}
}

// Every origin and text prefix of transcript-format.md §4.
func TestPromptOrigin(t *testing.T) {
	tests := []struct {
		name string
		line string
		want model.TurnOrigin
	}{
		{"origin human typed", `{"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"content":"fix it"}}`, model.OriginHuman},
		{"origin human queued", `{"type":"user","origin":{"kind":"human"},"promptSource":"queued","message":{"content":"fix it"}}`, model.OriginHuman},
		{"origin human suggestion", `{"type":"user","origin":{"kind":"human"},"promptSource":"suggestion_accepted","message":{"content":"yes"}}`, model.OriginHuman},
		{"origin task-notification", `{"type":"user","origin":{"kind":"task-notification"},"message":{"content":"done"}}`, model.OriginTaskNotification},
		{"origin peer", `{"type":"user","origin":{"kind":"peer"},"message":{"content":"from a teammate"}}`, model.OriginPeer},
		{"origin auto-continuation", `{"type":"user","origin":{"kind":"auto-continuation"},"message":{"content":"keep going"}}`, model.OriginContinuation},
		{"promptSource sdk", `{"type":"user","promptSource":"sdk","message":{"content":"one shot"}}`, model.OriginSDK},
		{"promptSource system", `{"type":"user","promptSource":"system","message":{"content":"tick"}}`, model.OriginContinuation},
		// The entrypoint is NOT evidence of who wrote a prompt: a copy of a session made by
		// a programmatic client stamps "sdk-cli" on records the user typed in a terminal.
		{"sdk entrypoint without origin info", `{"type":"user","entrypoint":"sdk-cli","message":{"content":"typed, then copied"}}`, model.OriginHuman},
		{"teammate message with intro line", `{"type":"user","message":{"content":"Another Claude session sent a message:\n<teammate-message teammate_id=\"worker\">done</teammate-message>"}}`, model.OriginPeer},
		{"bare teammate message", `{"type":"user","message":{"content":"<teammate-message teammate_id=\"lead\">please check</teammate-message>"}}`, model.OriginPeer},
		{"cross-session message", `{"type":"user","message":{"content":"<cross-session-message from=\"other\">hi</cross-session-message>"}}`, model.OriginPeer},
		{"turnOrigin scheduled", `{"type":"user","turnOrigin":"scheduled","message":{"content":"nightly check"}}`, model.OriginScheduled},
		{"system with task-notification origin", `{"type":"user","promptSource":"system","origin":{"kind":"task-notification"},"message":{"content":"agent finished"}}`, model.OriginTaskNotification},
		{"unknown origin kind falls back", `{"type":"user","origin":{"kind":"carrier-pigeon"},"message":{"content":"coo"}}`, model.OriginHuman},
		{"origin human but command text", `{"type":"user","origin":{"kind":"human"},"message":{"content":"<command-name>/foo</command-name>"}}`, model.OriginCommand},
		{"no origin plain", `{"type":"user","message":{"content":"just typed"}}`, model.OriginHuman},
		{"prefix task-notification", `{"type":"user","message":{"content":"<task-notification>\n<task-id>x</task-id></task-notification>"}}`, model.OriginTaskNotification},
		{"prefix command-name", `{"type":"user","message":{"content":"<command-name>/review</command-name>\n<command-args>123</command-args>"}}`, model.OriginCommand},
		{"prefix command-message", `{"type":"user","message":{"content":"<command-message>review</command-message>"}}`, model.OriginCommand},
		{"prefix local-command-stdout", `{"type":"user","message":{"content":"<local-command-stdout>ok</local-command-stdout>"}}`, model.OriginCommand},
		{"prefix bash-input", `{"type":"user","message":{"content":"<bash-input>ls</bash-input>"}}`, model.OriginCommand},
		{"prefix bash-stdout", `{"type":"user","message":{"content":"<bash-stdout>a</bash-stdout>"}}`, model.OriginCommand},
		{"prefix in array content", `{"type":"user","message":{"content":[{"type":"text","text":"<command-name>/x</command-name>"}]}}`, model.OriginCommand},
		{"prefix with leading space", `{"type":"user","message":{"content":"  \n<task-notification>x"}}`, model.OriginTaskNotification},
		{"prefix not at start is human", `{"type":"user","message":{"content":"please explain <command-name> to me"}}`, model.OriginHuman},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := mustDecode(t, tc.line).PromptOrigin(); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
	if PromptOriginFromText("<bash-input>x") != model.OriginCommand || PromptOriginFromText("hello") != model.OriginHuman {
		t.Fatal("PromptOriginFromText")
	}
}

func TestIsPrompt(t *testing.T) {
	tests := []struct {
		name string
		line string
		want bool
	}{
		{"string", `{"type":"user","message":{"content":"hi"}}`, true},
		{"text array", `{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}`, true},
		{"tool result", `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]}}`, false},
		{"meta", `{"type":"user","isMeta":true,"message":{"content":"x"}}`, false},
		{"compact summary", `{"type":"user","isCompactSummary":true,"message":{"content":"x"}}`, false},
		{"assistant", `{"type":"assistant","message":{"content":"x"}}`, false},
		{"system", `{"type":"system","content":"x"}`, false},
		{"unknown", `{"type":"zzz"}`, false},
		{"local command output", `{"type":"user","message":{"content":"<local-command-stdout>ok</local-command-stdout>"}}`, false},
		{"bash output", `{"type":"user","message":{"content":"<bash-stdout>a</bash-stdout>"}}`, false},
		{"bash input", `{"type":"user","message":{"content":"<bash-input>ls</bash-input>"}}`, true},
		{"interruption marker is still a user record", `{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}`, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := mustDecode(t, tc.line).IsPrompt(); got != tc.want {
				t.Fatalf("got %v", got)
			}
		})
	}
}

func TestSplitInterruption(t *testing.T) {
	tests := []struct {
		in    string
		rest  string
		found bool
	}{
		{"[Request interrupted by user]", "", true},
		{"[Request interrupted by user for tool use]", "", true},
		{"  [Request interrupted by user]\n", "", true},
		{"[Request interrupted by user] and now do this", "and now do this", true},
		{"[Request interrupted by user for tool use]\nplease retry", "please retry", true},
		{"normal text", "normal text", false},
		{"text then [Request interrupted by user]", "text then [Request interrupted by user]", false},
		{"", "", false},
	}
	for _, tc := range tests {
		rest, found := SplitInterruption(tc.in)
		if rest != tc.rest || found != tc.found {
			t.Errorf("SplitInterruption(%q) = %q, %v; want %q, %v", tc.in, rest, found, tc.rest, tc.found)
		}
	}
}

func TestSlashCommand(t *testing.T) {
	tests := []struct {
		in         string
		name, args string
		ok         bool
	}{
		{"<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>123 now</command-args>", "/review", "123 now", true},
		{"<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>", "/clear", "", true},
		{"<command-name> /multi\nline </command-name>", "/multi\nline", "", true},
		{"<command-name>/x</command-name>", "/x", "", true},
		{"hello", "", "", false},
		{"<command-message>only message</command-message>", "", "", false},
	}
	for _, tc := range tests {
		name, args, ok := SlashCommand(tc.in)
		if name != tc.name || args != tc.args || ok != tc.ok {
			t.Errorf("SlashCommand(%q) = %q, %q, %v", tc.in, name, args, ok)
		}
	}
}
