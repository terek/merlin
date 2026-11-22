package claude

import (
	"os"
	"path/filepath"
	"testing"
)

func TestShellCompressor(t *testing.T) {
	dir := t.TempDir()
	if _, ok := ShellCompressor(dir); ok {
		t.Error("no settings file: want false")
	}
	write := func(s string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(`not json`)
	if _, ok := ShellCompressor(dir); ok {
		t.Error("bad file: want false")
	}
	write(`{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/usr/local/bin/other-tool"}]}]},"note":"rtk"}`)
	if _, ok := ShellCompressor(dir); ok {
		t.Error("rtk only outside a hook command: want false")
	}
	write(`{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]}]}}`)
	since, ok := ShellCompressor(dir)
	if !ok || since.IsZero() {
		t.Errorf("rtk hook: got %v, %v", since, ok)
	}
}
