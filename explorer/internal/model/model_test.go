package model

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func ptr[T any](v T) *T { return &v }

func sampleDigest() SessionDigest {
	t0 := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	long := strings.Repeat("a long prompt ", 5000) // texts are stored whole
	return SessionDigest{
		SchemaVersion: SchemaVersion, ParserVersion: 3,
		Source:  []SourceFile{{Path: "/x/s.jsonl", Size: 10, MtimeNs: 99}},
		Harness: "claude", ID: "s1", ProjectKey: "-tmp-p", Project: "/tmp/p",
		Cwd: "/tmp/p", Cwds: []string{"/tmp/p"}, GitBranches: []string{"main"}, HarnessVersions: []string{"1.2.3"},
		Kind: KindInteractive, Title: "t", Name: "n", Slug: "s",
		StartedAt: t0, LastActivityAt: t0.Add(time.Hour), EndState: EndClean,
		Recaps:      []Recap{{At: t0, Text: "recap"}},
		Lineage:     Lineage{ForkedFrom: &ForkRef{SessionID: "p", MessageUUID: "m"}, InheritedFrom: []string{"p"}},
		Stats:       Stats{HumanTurns: 1, Turns: 1, AssistantMessages: 2, ToolCalls: 3, ToolsByName: map[string]int64{"Bash": 3}, LinesAdded: 4},
		Cost:        Cost{USD: 1.5, ByModel: map[string]ModelCost{"m": {Tokens: Tokens{Input: 1, Output: 2, CacheRead: 3, CacheWrite5m: 4, CacheWrite1h: 5}, USD: 1.5}}},
		Reported:    &Reported{TotalUSD: 1.6, ByModel: map[string]ReportedModel{"m": {InputTokens: 1, USD: 1.6}}},
		Compactions: []Compaction{{At: t0, Turn: 1, Trigger: TriggerManual, PreTokens: 100, PostTokens: 10, DurationMs: 5, Summary: "sum"}},
		Turns: []Turn{{
			Index: 0, Epoch: 0, UUID: "u1", Abandoned: true, StartedAt: t0, EndedAt: t0.Add(time.Minute), DurationMs: 60000,
			Origin: OriginHuman, UserText: long, Images: 1, Command: "/x", FinalText: "done", Interrupted: true,
			AssistantMessages: 2, ToolCalls: 3, ToolsByName: map[string]int64{"Bash": 3}, FilesTouched: []string{"a.go"},
			ContextTokens: 1000, Cost: Cost{USD: 1}, CostWithAgents: 2, Spawned: []string{"a1"},
		}},
		Agents: []Agent{{
			ID: "a1", Kind: AgentSubagent, Name: "n", AgentType: "Explore", Description: "d", Model: "m",
			ParentAgentID: nil, SpawnToolUseID: "tu", SpawnTurn: ptr(0), Depth: 1, Background: true, Linkage: LinkMeta,
			StartedAt: t0, EndedAt: t0.Add(time.Second), Status: StatusCompleted, Prompt: "p", FinalText: "f",
			Inbox:             []InboxMessage{{At: t0, From: "lead", Text: "hi"}},
			AssistantMessages: 1, ToolCalls: 1, ToolsByName: map[string]int64{"Read": 1},
			Compactions: []Compaction{{At: t0, Turn: 0, Trigger: TriggerAuto}},
			Cost:        Cost{USD: 1}, SubtreeUSD: 1,
		}},
		Messages:    []Message{{ID: "msg1", At: t0, Model: "m", AgentID: "a1", Turn: ptr(0), USD: 0.5, Tokens: Tokens{Input: 7}}},
		Diagnostics: Diagnostics{UnknownTypes: map[string]int64{"zzz": 2}, BadLines: 1, UnpricedModels: []string{"q"}, UnresolvedAgents: 1},
	}
}

func TestDigestRoundTrip(t *testing.T) {
	want := sampleDigest()
	b, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var got SessionDigest
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("round trip differs:\nwant %+v\ngot  %+v", want, got)
	}
	// Marshalling again must be byte-identical (deterministic output).
	b2, _ := json.Marshal(got)
	if string(b) != string(b2) {
		t.Fatal("marshal is not deterministic")
	}
	if len(got.Turns[0].UserText) != len(want.Turns[0].UserText) {
		t.Fatal("text was altered")
	}
}

func TestJSONKeys(t *testing.T) {
	b, _ := json.Marshal(sampleDigest())
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for _, k := range []string{"schemaVersion", "projectKey", "harnessVersions", "startedAt", "reported", "diagnostics"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing key %q", k)
		}
	}
	turn := m["turns"].([]any)[0].(map[string]any)
	for _, k := range []string{"uuid", "abandoned", "costWithAgents", "userText"} {
		if _, ok := turn[k]; !ok {
			t.Errorf("turn missing key %q", k)
		}
	}
	// The main agent's parent is an explicit null, not an absent key.
	ag := m["agents"].([]any)[0].(map[string]any)
	if v, ok := ag["parentAgentId"]; !ok || v != nil {
		t.Errorf("parentAgentId = %v, %v; want explicit null", v, ok)
	}
	// Message tokens are flattened beside the message fields.
	msg := m["messages"].([]any)[0].(map[string]any)
	if msg["input"] != float64(7) {
		t.Errorf("message tokens not flattened: %v", msg)
	}
}

func TestZeroTimesOmitted(t *testing.T) {
	b, _ := json.Marshal(Agent{ID: "a"})
	if strings.Contains(string(b), "startedAt") || strings.Contains(string(b), "endedAt") {
		t.Fatalf("zero times should be omitted: %s", b)
	}
}

func TestCost(t *testing.T) {
	var c Cost // zero value is usable
	c.AddMessage("m1", Tokens{Input: 10, Output: 5}, 0.25)
	c.AddMessage("m1", Tokens{Input: 1, CacheWrite1h: 2}, 0.5)
	c.AddMessage("m2", Tokens{CacheRead: 3}, 1)
	if c.USD != 1.75 {
		t.Errorf("USD = %v", c.USD)
	}
	if got := c.ByModel["m1"]; got.Input != 11 || got.Output != 5 || got.CacheWrite1h != 2 || got.USD != 0.75 {
		t.Errorf("m1 = %+v", got)
	}

	var d Cost
	d.Add(c)
	d.Add(c)
	if d.USD != 3.5 || d.ByModel["m2"].CacheRead != 6 || d.ByModel["m2"].USD != 2 {
		t.Errorf("Add = %+v", d)
	}
	// Add must not alias the source's map.
	if c.ByModel["m2"].USD != 1 {
		t.Errorf("source mutated: %+v", c)
	}
	var e Cost
	e.Add(Cost{})
	if e.ByModel != nil || e.USD != 0 {
		t.Errorf("empty add: %+v", e)
	}
}

func TestSessionKey(t *testing.T) {
	d := SessionDigest{Harness: "claude", ID: "abc"}
	if k := d.Key(); k != (SessionKey{"claude", "abc"}) || k.String() != "claude/abc" {
		t.Errorf("key = %v", k)
	}
}
