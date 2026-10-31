package codex

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/terek/merlin/internal/harness"
)

func TestParseHook(t *testing.T) {
	home := t.TempDir()
	writeTree(t, home)
	h := New(home, fakePricer{})
	sub := filepath.Join(home, "sessions", "2026", "10", "01", "rollout-2026-10-01T09-00-13-B.jsonl")
	cases := []struct {
		name, body string
		want       harness.HookEvent
		ok         bool
	}{
		{"root stop", `{"session_id":"R","hook_event_name":"Stop","turn_id":"r1"}`,
			harness.HookEvent{Name: "Stop", Ref: harness.SessionRef{ID: "R"}, Final: true}, true},
		{"subagent thread maps to its session", `{"session_id":"B","hook_event_name":"UserPromptSubmit"}`,
			harness.HookEvent{Name: "UserPromptSubmit", Ref: harness.SessionRef{ID: "R"}}, true},
		{"transcript path maps to its session", fmt.Sprintf(`{"session_id":"x","transcript_path":%q,"hook_event_name":"SubagentStop"}`, sub),
			harness.HookEvent{Name: "SubagentStop", Ref: harness.SessionRef{ID: "R"}}, true},
		{"session end", `{"session_id":"R","hook_event_name":"SessionEnd","reason":"other"}`,
			harness.HookEvent{Name: "SessionEnd", Ref: harness.SessionRef{ID: "R"}, Final: true, Ended: true}, true},
		{"thread not on disk yet", `{"session_id":"N","hook_event_name":"SessionStart","source":"startup"}`,
			harness.HookEvent{Name: "SessionStart", Ref: harness.SessionRef{ID: "N"}}, true},
		{"empty", ``, harness.HookEvent{}, false},
		{"garbage", `}{`, harness.HookEvent{}, false},
		{"no event name", `{"session_id":"R"}`, harness.HookEvent{}, false},
		{"no session", `{"hook_event_name":"Stop"}`, harness.HookEvent{}, false},
		{"path as session", `{"session_id":"../R","hook_event_name":"Stop"}`, harness.HookEvent{}, false},
	}
	for _, c := range cases {
		got, ok := h.ParseHook([]byte(c.body))
		got.Ref.ProjectKey = ""
		if ok != c.ok || got != c.want {
			t.Errorf("%s: got %+v %v, want %+v %v", c.name, got, ok, c.want, c.ok)
		}
	}
}
