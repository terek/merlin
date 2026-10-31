package hooks

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/terek/merlin/internal/hookfile"
)

func setup(t *testing.T, hooksJSON *string) Config {
	t.Helper()
	root := t.TempDir()
	cfg := Config{
		CodexHome:    filepath.Join(root, "codex"),
		ExplorerHome: filepath.Join(root, "merlin"),
		Binary:       filepath.Join(root, "bin", "merlin"),
	}
	if err := os.MkdirAll(cfg.CodexHome, 0o755); err != nil {
		t.Fatal(err)
	}
	if hooksJSON != nil {
		if err := os.WriteFile(cfg.HooksPath(), []byte(*hooksJSON), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return cfg
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func writeBinary(t *testing.T, cfg Config, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(cfg.Binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg.Binary, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestInstallCreatesHooksJSON(t *testing.T) {
	cfg := setup(t, nil)
	res, err := Install(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Events) != len(Events) || res.BackupPath != "" {
		t.Fatalf("result %+v", res)
	}
	var doc struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Type    string `json:"type"`
				Command string `json:"command"`
				Timeout int    `json:"timeout"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(read(t, cfg.HooksPath())), &doc); err != nil {
		t.Fatal(err)
	}
	for _, ev := range Events {
		g := doc.Hooks[ev]
		if len(g) != 1 || len(g[0].Hooks) != 1 || g[0].Hooks[0].Command != cfg.ScriptPath() ||
			g[0].Hooks[0].Type != "command" || g[0].Hooks[0].Timeout != hookTimeoutSeconds {
			t.Errorf("%s: %+v", ev, g)
		}
	}
	if !strings.HasSuffix(cfg.ScriptPath(), filepath.FromSlash("/codex/hooks/notify.sh")) {
		t.Errorf("script outside MERLIN_HOME/codex: %s", cfg.ScriptPath())
	}
}

// Another tool's hooks, a description and odd layout survive install and uninstall byte
// for byte.
func TestUninstallRestoresBytes(t *testing.T) {
	orig := "{\n  \"description\": \"team hooks\",\n  \"hooks\": {\n" +
		"    \"PreToolUse\": [{\"matcher\": \"Bash\", \"hooks\": [{\"type\": \"command\", \"command\": \"check.sh\"}]}],\n" +
		"    \"Stop\": [ {\"hooks\":[{\"type\":\"command\",\"command\":\"other.sh\"}]} ]\n  }\n}"
	cfg := setup(t, &orig)
	res, err := Install(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if res.BackupPath == "" || read(t, res.BackupPath) != orig {
		t.Error("no faithful backup")
	}
	if !json.Valid([]byte(read(t, cfg.HooksPath()))) {
		t.Fatalf("invalid JSON:\n%s", read(t, cfg.HooksPath()))
	}
	if _, err := Uninstall(cfg); err != nil {
		t.Fatal(err)
	}
	if got := read(t, cfg.HooksPath()); got != orig {
		t.Errorf("not restored:\n%s", got)
	}
	if _, err := os.Stat(cfg.ScriptPath()); !os.IsNotExist(err) {
		t.Error("notify.sh not removed")
	}
}

func TestStatusReadsCodexTrust(t *testing.T) {
	// Our Stop entry goes after another tool's group: group 1, handler 0.
	orig := `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"other.sh"}]}]}}`
	cfg := setup(t, &orig)
	sts, err := Status(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, st := range sts {
		if st.State != hookfile.Missing {
			t.Errorf("before install %s: %s", st.Event, st.State)
		}
	}
	if _, err := Install(cfg); err != nil {
		t.Fatal(err)
	}
	writeBinary(t, cfg, "#!/bin/sh\n")
	byEvent := func() map[string]hookfile.State {
		sts, err := Status(cfg)
		if err != nil {
			t.Fatal(err)
		}
		m := map[string]hookfile.State{}
		for _, st := range sts {
			m[st.Event] = st.State
		}
		return m
	}
	for ev, st := range byEvent() {
		if st != Untrusted {
			t.Errorf("no config.toml %s: %s", ev, st)
		}
	}

	p := cfg.HooksPath()
	toml := "model = \"m\"\n\n[hooks.state]\n\n" +
		"[hooks.state.\"" + p + ":session_start:0:0\"]\ntrusted_hash = \"sha256:aa\"\n\n" +
		"[hooks.state.\"" + p + ":stop:1:0\"]\ntrusted_hash = \"sha256:bb\"\nenabled = true\n\n" +
		"[hooks.state.\"" + p + ":stop:0:0\"]\ntrusted_hash = \"sha256:other\"\n\n" +
		"[hooks.state.\"" + p + ":session_end:0:0\"]\ntrusted_hash = \"sha256:cc\"\nenabled = false\n\n" +
		"[hooks.state.\"/elsewhere/hooks.json:user_prompt_submit:0:0\"]\ntrusted_hash = \"sha256:dd\"\n\n" +
		"[profiles.x]\ntrusted_hash = \"not a hook\"\n"
	if err := os.WriteFile(filepath.Join(cfg.CodexHome, "config.toml"), []byte(toml), 0o600); err != nil {
		t.Fatal(err)
	}
	want := map[string]hookfile.State{
		"SessionStart":     hookfile.Installed,
		"Stop":             hookfile.Installed,
		"SessionEnd":       Disabled,
		"UserPromptSubmit": Untrusted,
		"SubagentStop":     Untrusted,
	}
	if got := byEvent(); len(got) != len(want) {
		t.Errorf("got %v", got)
	} else {
		for ev, st := range want {
			if got[ev] != st {
				t.Errorf("%s: %s, want %s", ev, got[ev], st)
			}
		}
	}

	// The inline form under [hooks.state] counts too.
	inline := "[hooks.state]\n\"" + p + ":subagent_stop:0:0\" = { trusted_hash = \"sha256:ee\" }\n"
	if err := os.WriteFile(filepath.Join(cfg.CodexHome, "config.toml"), []byte(inline), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := byEvent()["SubagentStop"]; got != hookfile.Installed {
		t.Errorf("inline trust: %s", got)
	}
}

// The script runs `merlin hook codex`, prints nothing and forwards stdin.
func TestScriptRunsHookCodex(t *testing.T) {
	cfg := setup(t, nil)
	if _, err := Install(cfg); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "out")
	writeBinary(t, cfg, "#!/bin/sh\necho noise\necho \"$@\" > '"+out+".args'\ncat > '"+out+".in'\n")
	cmd := exec.Command(cfg.ScriptPath())
	cmd.Stdin = strings.NewReader(`{"x":1}`)
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	if err := cmd.Run(); err != nil || buf.Len() != 0 {
		t.Fatalf("err=%v out=%q", err, buf.String())
	}
	if got := read(t, out+".args"); got != "hook codex\n" {
		t.Errorf("args %q", got)
	}
	if got := read(t, out+".in"); got != `{"x":1}` {
		t.Errorf("stdin %q", got)
	}
}
