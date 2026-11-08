package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A price table that does not hold together warns and falls back; it does not fail.
func TestLoadConfigLenientPrices(t *testing.T) {
	home := t.TempDir()
	body := `{"port": 8123, "prices": {"claude-opus-4.5": {"input": 1, "output": 2, "cacheRead": 0.1}}}`
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, pricer := loadConfig(home, "merlin test")
	if cfg.Port != 8123 {
		t.Errorf("port %d", cfg.Port)
	}
	if _, p, ok := pricer.Lookup("claude-opus-4-5"); !ok || p.Input == 1 {
		t.Errorf("the built-in table should be in use: %v %v", p, ok)
	}
}
