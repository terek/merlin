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

// PricesFile returns the absolute path of explorer/testdata/prices.json: price overrides in
// the shape of config.json that give the models the prices generate.ts worked the fixtures'
// costs out with, where they differ from the embedded table. Load it with pricing.Load, or
// copy it to MERLIN_HOME/config.json, so that a change of a real price does not move the
// expected figures.
func PricesFile() string {
	return filepath.Join(Root(), "prices.json")
}
