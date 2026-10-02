package claude_test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/terek/merlin/explorer/internal/claude"
	"github.com/terek/merlin/explorer/internal/fixtures"
	"github.com/terek/merlin/explorer/internal/harness"
)

const (
	plainID   = "01010101-0000-4000-8000-000000000001"
	plainProj = "-home-dev-acme-plain"
)

func TestParseHook(t *testing.T) {
	cfg := "/cfg"
	h := claude.New(cfg, nil)
	main := filepath.Join(cfg, "projects", plainProj, plainID+".jsonl")
	sub := filepath.Join(cfg, "projects", plainProj, plainID, "subagents", "agent-a1.jsonl")
	cases := []struct {
		name, body string
		want       harness.HookEvent
		ok         bool
	}{
		{"stop", fmt.Sprintf(`{"session_id":%q,"transcript_path":%q,"cwd":"/x","hook_event_name":"Stop"}`, plainID, main),
			harness.HookEvent{Name: "Stop", Ref: harness.SessionRef{ID: plainID, ProjectKey: plainProj}, Final: true}, true},
		{"session end", fmt.Sprintf(`{"session_id":%q,"transcript_path":%q,"hook_event_name":"SessionEnd"}`, plainID, main),
			harness.HookEvent{Name: "SessionEnd", Ref: harness.SessionRef{ID: plainID, ProjectKey: plainProj}, Final: true, Ended: true}, true},
		{"prompt", fmt.Sprintf(`{"session_id":%q,"transcript_path":%q,"hook_event_name":"UserPromptSubmit","prompt":"hi"}`, plainID, main),
			harness.HookEvent{Name: "UserPromptSubmit", Ref: harness.SessionRef{ID: plainID, ProjectKey: plainProj}}, true},
		{"subagent stop without paths", fmt.Sprintf(`{"session_id":%q,"hook_event_name":"SubagentStop","agent_id":"a1"}`, plainID),
			harness.HookEvent{Name: "SubagentStop", Ref: harness.SessionRef{ID: plainID}}, true},
		{"subagent stop with agent path", fmt.Sprintf(`{"session_id":%q,"agent_transcript_path":%q,"hook_event_name":"SubagentStop"}`, plainID, sub),
			harness.HookEvent{Name: "SubagentStop", Ref: harness.SessionRef{ID: plainID, ProjectKey: plainProj}}, true},
		{"id from file name", fmt.Sprintf(`{"transcript_path":%q,"hook_event_name":"Stop"}`, main),
			harness.HookEvent{Name: "Stop", Ref: harness.SessionRef{ID: plainID, ProjectKey: plainProj}, Final: true}, true},
		{"path outside projects", fmt.Sprintf(`{"session_id":%q,"transcript_path":"/elsewhere/p/x.jsonl","hook_event_name":"Stop"}`, plainID),
			harness.HookEvent{Name: "Stop", Ref: harness.SessionRef{ID: plainID}, Final: true}, true},
		{"path is the projects dir itself", fmt.Sprintf(`{"session_id":%q,"transcript_path":%q,"hook_event_name":"Stop"}`, plainID, filepath.Join(cfg, "projects", plainProj)),
			harness.HookEvent{Name: "Stop", Ref: harness.SessionRef{ID: plainID}, Final: true}, true},
		{"empty", ``, harness.HookEvent{}, false},
		{"garbage", `}{`, harness.HookEvent{}, false},
		{"array", `[1]`, harness.HookEvent{}, false},
		{"no event name", fmt.Sprintf(`{"session_id":%q}`, plainID), harness.HookEvent{}, false},
		{"no session", `{"hook_event_name":"Stop"}`, harness.HookEvent{}, false},
		{"id with path", `{"session_id":"../x","hook_event_name":"Stop"}`, harness.HookEvent{}, false},
	}
	for _, c := range cases {
		got, ok := h.ParseHook([]byte(c.body))
		if ok != c.ok || got != c.want {
			t.Errorf("%s: got %+v %v, want %+v %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestLocate(t *testing.T) {
	h := claude.New(fixtures.ClaudeDir(), nil)
	disc, err := h.Discover()
	if err != nil {
		t.Fatal(err)
	}
	// Locate agrees with Discover for every session, with or without the project key.
	for _, want := range disc.Sessions {
		for _, key := range []string{want.ProjectKey, ""} {
			got, found, err := h.Locate(harness.SessionRef{ID: want.Key.ID, ProjectKey: key})
			if err != nil || !found {
				t.Fatalf("%s (project %q): found=%v err=%v", want.Key.ID, key, found, err)
			}
			if got.ProjectKey != want.ProjectKey || got.Key != want.Key || fmt.Sprint(got.Fingerprint) != fmt.Sprint(want.Fingerprint) {
				t.Errorf("%s: Locate differs from Discover:\n%+v\n%+v", want.Key.ID, got, want)
			}
		}
	}
	for _, ref := range []harness.SessionRef{
		{ID: "ffffffff-0000-4000-8000-000000000000"},
		{ID: plainID, ProjectKey: "-no-such-project"},
		{ID: "../x"},
		{ID: ""},
		{ID: plainID, ProjectKey: "../.."},
	} {
		if _, found, err := h.Locate(ref); found || err != nil {
			t.Errorf("%+v: found=%v err=%v", ref, found, err)
		}
	}
}

func TestLiveSessions(t *testing.T) {
	cfg := t.TempDir()
	h := claude.New(cfg, nil)
	if refs, err := h.LiveSessions(); err != nil || len(refs) != 0 {
		t.Fatalf("no registry: %v %v", refs, err)
	}
	os.MkdirAll(filepath.Join(cfg, "sessions"), 0o755)
	write := func(name, body string) { os.WriteFile(filepath.Join(cfg, "sessions", name), []byte(body), 0o644) }
	write("alive.json", fmt.Sprintf(`{"pid":%d,"sessionId":%q,"status":"idle"}`, os.Getpid(), plainID))
	write("dead.json", `{"pid":2147483000,"sessionId":"dead","status":"busy"}`)
	write("junk.json", `{`)
	refs, err := h.LiveSessions()
	if err != nil || len(refs) != 1 || refs[0].ID != plainID {
		t.Fatalf("LiveSessions = %v, %v", refs, err)
	}
}
