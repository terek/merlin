// Package paths resolves the directories Explorer reads and writes.
package paths

import (
	"os"
	"path/filepath"
)

// Home returns the directory the program keeps its state in: MERLIN_HOME, defaulting to
// ~/.merlin. EXPLORER_HOME, the variable's earlier name, is still honoured when
// MERLIN_HOME is not set, so that a script written for it cannot fall through to the
// real home.
//
// ~/.merlin is shared with the earlier Merlin program, whose files may still be there.
// This program only ever touches claude/, codex/ (and other per-harness directories),
// config.json (read only, by package config), merlin.lock and merlin.log in it.
func Home() (string, error) {
	if v := os.Getenv("MERLIN_HOME"); v != "" {
		return filepath.Clean(v), nil
	}
	return resolve("EXPLORER_HOME", ".merlin")
}

// CodexHome returns CODEX_HOME, defaulting to ~/.codex.
func CodexHome() (string, error) {
	return resolve("CODEX_HOME", ".codex")
}

// ClaudeConfigDir returns CLAUDE_CONFIG_DIR, defaulting to ~/.claude.
func ClaudeConfigDir() (string, error) {
	return resolve("CLAUDE_CONFIG_DIR", ".claude")
}

// PiAgentDir returns PI_CODING_AGENT_DIR, defaulting to ~/.pi/agent.
func PiAgentDir() (string, error) {
	if v := os.Getenv("PI_CODING_AGENT_DIR"); v != "" {
		return filepath.Clean(v), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".pi", "agent"), nil
}

// PiSessionsDir returns the directory Pi keeps its sessions in: PI_CODING_AGENT_SESSION_DIR
// when set (the session files then lie directly in it), else <PiAgentDir>/sessions. Pi's
// --session-dir flag and sessionDir setting, which rank above the variable, are not followed.
func PiSessionsDir() (string, error) {
	if v := os.Getenv("PI_CODING_AGENT_SESSION_DIR"); v != "" {
		return filepath.Clean(v), nil
	}
	dir, err := PiAgentDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "sessions"), nil
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
