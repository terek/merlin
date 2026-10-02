// Package paths resolves the directories Explorer reads and writes.
package paths

import (
	"os"
	"path/filepath"
)

// ExplorerHome returns EXPLORER_HOME, defaulting to ~/.explorer.
func ExplorerHome() (string, error) {
	return resolve("EXPLORER_HOME", ".explorer")
}

// ClaudeConfigDir returns CLAUDE_CONFIG_DIR, defaulting to ~/.claude.
func ClaudeConfigDir() (string, error) {
	return resolve("CLAUDE_CONFIG_DIR", ".claude")
}

func resolve(env, defaultName string) (string, error) {
	if v := os.Getenv(env); v != "" {
		return filepath.Clean(v), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, defaultName), nil
}
