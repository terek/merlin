// Package fixtures locates the synthetic transcript tree under explorer/testdata.
//
// The tree is usable directly as CLAUDE_CONFIG_DIR. Tests that modify anything must copy it
// into t.TempDir() first.
package fixtures

import (
	"path/filepath"
	"runtime"
)

// Root returns the absolute path of explorer/testdata.
func Root() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "testdata")
}

// ClaudeDir returns the absolute path of explorer/testdata/claude, a stand-in for ~/.claude.
func ClaudeDir() string {
	return filepath.Join(Root(), "claude")
}
