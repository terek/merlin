package paths

import (
	"path/filepath"
	"testing"
)

func TestDefaults(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("EXPLORER_HOME", "")
	t.Setenv("CLAUDE_CONFIG_DIR", "")

	got, err := ExplorerHome()
	if err != nil || got != filepath.Join(home, ".explorer") {
		t.Fatalf("ExplorerHome = %q, %v", got, err)
	}
	got, err = ClaudeConfigDir()
	if err != nil || got != filepath.Join(home, ".claude") {
		t.Fatalf("ClaudeConfigDir = %q, %v", got, err)
	}
}

func TestEnvOverride(t *testing.T) {
	eh, cc := t.TempDir(), t.TempDir()
	t.Setenv("EXPLORER_HOME", eh)
	t.Setenv("CLAUDE_CONFIG_DIR", cc)

	if got, err := ExplorerHome(); err != nil || got != eh {
		t.Fatalf("ExplorerHome = %q, %v", got, err)
	}
	if got, err := ClaudeConfigDir(); err != nil || got != cc {
		t.Fatalf("ClaudeConfigDir = %q, %v", got, err)
	}
}
