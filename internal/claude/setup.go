package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ShellCompressor reports whether Claude Code's user settings (settings.json in configDir)
// set up a shell output compressor: a hook whose command contains "rtk" (rtk, the CLI proxy
// that rewrites `git status` to `rtk git status`). since is the file's modification time,
// the nearest honest answer to "since when": any edit of the file moves it. A missing or
// unreadable file, or one that is not JSON, reports false.
func ShellCompressor(configDir string) (since time.Time, ok bool) {
	path := filepath.Join(configDir, "settings.json")
	b, err := os.ReadFile(path)
	if err != nil {
		return time.Time{}, false
	}
	var doc struct {
		Hooks json.RawMessage `json:"hooks"`
	}
	if json.Unmarshal(b, &doc) != nil || len(doc.Hooks) == 0 {
		return time.Time{}, false
	}
	var hooks any
	if json.Unmarshal(doc.Hooks, &hooks) != nil || !hookCommandMentions(hooks, "rtk") {
		return time.Time{}, false
	}
	fi, err := os.Stat(path)
	if err != nil {
		return time.Time{}, false
	}
	return fi.ModTime().UTC(), true
}

// hookCommandMentions reports whether any "command" string in a hooks tree contains word.
func hookCommandMentions(v any, word string) bool {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			if s, isStr := e.(string); isStr && k == "command" && strings.Contains(s, word) {
				return true
			}
			if hookCommandMentions(e, word) {
				return true
			}
		}
	case []any:
		for _, e := range x {
			if hookCommandMentions(e, word) {
				return true
			}
		}
	}
	return false
}
