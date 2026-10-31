package paths

import (
	"path/filepath"
	"testing"
)

func TestDefaults(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("MERLIN_HOME", "")
	t.Setenv("EXPLORER_HOME", "")
	t.Setenv("CLAUDE_CONFIG_DIR", "")

	got, err := Home()
	if err != nil || got != filepath.Join(home, ".merlin") {
		t.Fatalf("Home = %q, %v", got, err)
	}
	got, err = ClaudeConfigDir()
	if err != nil || got != filepath.Join(home, ".claude") {
		t.Fatalf("ClaudeConfigDir = %q, %v", got, err)
	}
}

func TestEnvOverride(t *testing.T) {
	mh, cc := t.TempDir(), t.TempDir()
	t.Setenv("MERLIN_HOME", mh)
	t.Setenv("EXPLORER_HOME", "")
	t.Setenv("CLAUDE_CONFIG_DIR", cc)

	if got, err := Home(); err != nil || got != mh {
		t.Fatalf("Home = %q, %v", got, err)
	}
	if got, err := ClaudeConfigDir(); err != nil || got != cc {
		t.Fatalf("ClaudeConfigDir = %q, %v", got, err)
	}
}

// The variable's earlier name still works, and the new name wins over it.
func TestEarlierVariableName(t *testing.T) {
	old, cur := t.TempDir(), t.TempDir()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("MERLIN_HOME", "")
	t.Setenv("EXPLORER_HOME", old)
	if got, err := Home(); err != nil || got != old {
		t.Fatalf("Home with EXPLORER_HOME only = %q, %v", got, err)
	}
	t.Setenv("MERLIN_HOME", cur)
	if got, err := Home(); err != nil || got != cur {
		t.Fatalf("Home with both = %q, %v", got, err)
	}
}
