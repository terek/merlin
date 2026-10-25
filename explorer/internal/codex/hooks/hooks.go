// Package hooks installs and removes Merlin's Codex hooks in $CODEX_HOME/hooks.json and
// reports whether Codex trusts them.
//
// Codex skips a new or changed command hook until the user trusts it in /hooks; it keeps
// that trust in config.toml under [hooks.state."<hooks.json>:<event>:<group>:<handler>"].
// Merlin never writes config.toml: Status only reads it. The entries run a fixed script
// path, so trust given once survives reinstalls and binary upgrades.
package hooks

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"

	"github.com/terek/merlin/explorer/internal/hookfile"
)

// Events are the Codex hook events Merlin subscribes to.
var Events = []string{"SessionStart", "UserPromptSubmit", "Stop", "SubagentStop", "SessionEnd"}

// hookTimeoutSeconds is the timeout written into each entry (Codex caps SessionEnd at 3).
const hookTimeoutSeconds = 2

// scriptSuffix identifies a Merlin entry, whatever MERLIN_HOME it was installed under.
const scriptSuffix = "/codex/hooks/notify.sh"

// Config says where to install.
type Config struct {
	CodexHome    string // CODEX_HOME, normally ~/.codex
	ExplorerHome string // MERLIN_HOME
	Binary       string // merlin binary recorded in notify.sh; default os.Executable
}

// HooksPath is the hooks.json that is edited.
func (c Config) HooksPath() string { return filepath.Join(c.CodexHome, "hooks.json") }

// ScriptPath is the wrapper script the hook entries run.
func (c Config) ScriptPath() string {
	return filepath.Join(c.ExplorerHome, "codex", "hooks", "notify.sh")
}

func (c Config) file() hookfile.File {
	return hookfile.File{
		Path: c.HooksPath(), Script: c.ScriptPath(), Suffix: scriptSuffix, Events: Events,
		Timeout: hookTimeoutSeconds, Args: "hook codex", Binary: c.Binary,
	}
}

// States beyond hookfile's, for entries Codex does not run.
const (
	Untrusted hookfile.State = "installed, not trusted yet (review it with /hooks in Codex)"
	Disabled  hookfile.State = "installed, disabled in Codex (/hooks)"
)

// Install writes notify.sh and adds one entry per event to hooks.json, leaving every
// other byte of the file alone. It is idempotent. New entries run only once trusted.
func Install(c Config) (hookfile.Result, error) { return hookfile.Install(c.file()) }

// Uninstall removes exactly the entries Install added, and the wrapper script. Codex's
// trust records in config.toml are left; they name entries that no longer exist.
func Uninstall(c Config) (hookfile.Result, error) { return hookfile.Uninstall(c.file()) }

// Status reports, per event, whether a Merlin entry is present, usable and trusted.
// Trust is read from config.toml: an entry with no trusted hash is Untrusted. A recorded
// hash is taken as trust; whether it still matches the entry is Codex's to check.
func Status(c Config) ([]hookfile.EventStatus, error) {
	sts, err := hookfile.Status(c.file())
	if err != nil {
		return nil, err
	}
	trust := readTrust(filepath.Join(c.CodexHome, "config.toml"))
	for i, st := range sts {
		if st.State != hookfile.Installed {
			continue
		}
		suffix := ":" + snake(st.Event) + ":" + strconv.Itoa(st.Group) + ":" + strconv.Itoa(st.Handler)
		t, ok := trust[c.HooksPath()+suffix]
		if real, err := filepath.EvalSymlinks(c.HooksPath()); !ok && err == nil {
			t = trust[real+suffix]
		}
		switch {
		case t.disabled:
			sts[i].State = Disabled
		case !t.trusted:
			sts[i].State = Untrusted
		}
	}
	return sts, nil
}

// snake turns an event name into the form trust keys use: SessionStart → session_start.
func snake(s string) string {
	var b strings.Builder
	for i, r := range s {
		if unicode.IsUpper(r) {
			if i > 0 {
				b.WriteByte('_')
			}
			r = unicode.ToLower(r)
		}
		b.WriteRune(r)
	}
	return b.String()
}

type trustState struct{ trusted, disabled bool }

// readTrust reads the hooks.state tables of config.toml, by key. It understands the
// form Codex writes ([hooks.state."<key>"] followed by trusted_hash and enabled lines,
// or "<key>" = { … } inline under [hooks.state]); anything else is no trust. A missing
// or unreadable file is no trust.
func readTrust(path string) map[string]trustState {
	out := map[string]trustState{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	const prefix = "hooks.state."
	section, inState := "", false
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadString('\n')
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "[["):
			section, inState = "", false
		case strings.HasPrefix(line, "["):
			name := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"))
			section, inState = "", name == "hooks.state"
			if key, ok := strings.CutPrefix(name, prefix); ok {
				if k, ok := tomlString(key); ok {
					section = k
				}
			}
		case section != "":
			out[section] = applyPair(out[section], line)
		case inState && strings.HasPrefix(line, `"`):
			end := closingQuote(line)
			if end < 0 {
				break
			}
			k, ok := tomlString(line[:end+1])
			rest := strings.TrimSpace(line[end+1:])
			if !ok || !strings.HasPrefix(rest, "=") {
				break
			}
			body := strings.TrimSpace(strings.TrimPrefix(rest, "="))
			body = strings.TrimSuffix(strings.TrimPrefix(body, "{"), "}")
			st := out[k]
			for _, pair := range strings.Split(body, ",") {
				st = applyPair(st, pair)
			}
			out[k] = st
		}
		if err != nil {
			return out
		}
	}
}

func applyPair(st trustState, pair string) trustState {
	k, v, ok := strings.Cut(pair, "=")
	if !ok {
		return st
	}
	v = strings.TrimSpace(v)
	switch strings.TrimSpace(k) {
	case "trusted_hash":
		if s, ok := tomlString(v); ok && s != "" {
			st.trusted = true
		}
	case "enabled":
		st.disabled = v == "false"
	}
	return st
}

// closingQuote returns the index of the quote that closes the basic string at s[0].
func closingQuote(s string) int {
	for i := 1; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case '"':
			return i
		}
	}
	return -1
}

// tomlString decodes a TOML basic string ("…") or literal string ('…').
func tomlString(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && s[0] == '\'' && s[len(s)-1] == '\'' {
		return s[1 : len(s)-1], true
	}
	if len(s) < 2 || s[0] != '"' || closingQuote(s) != len(s)-1 {
		return "", false
	}
	u, err := strconv.Unquote(s)
	return u, err == nil
}
