package hooks

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/terek/merlin/internal/hookfile"
)

// Events are the Claude Code hook events Explorer subscribes to.
var Events = []string{"SessionStart", "UserPromptSubmit", "Stop", "SubagentStop", "SessionEnd"}

// hookTimeoutSeconds is the timeout written into each entry. The client itself
// gives up after ~150 ms; this only bounds a wedged shell.
const hookTimeoutSeconds = 2

// scriptSuffix identifies an Explorer entry: any hook command ending in it is ours,
// whatever MERLIN_HOME it was installed under.
const scriptSuffix = "/claude/hooks/notify.sh"

// Config says where to install.
type Config struct {
	ClaudeConfigDir string // directory holding settings.json
	ExplorerHome    string // MERLIN_HOME
	Binary          string // explorer binary recorded in notify.sh; default os.Executable
}

// SettingsPath is the settings.json that is edited.
func (c Config) SettingsPath() string { return filepath.Join(c.ClaudeConfigDir, "settings.json") }

// ScriptPath is the wrapper script the hook entries run.
func (c Config) ScriptPath() string {
	return filepath.Join(c.ExplorerHome, "claude", "hooks", "notify.sh")
}

func (c Config) file() hookfile.File {
	return hookfile.File{
		Path: c.SettingsPath(), Script: c.ScriptPath(), Suffix: scriptSuffix, Events: Events,
		Timeout: hookTimeoutSeconds, Args: "hook", Binary: c.Binary,
	}
}

// Result describes what Install or Uninstall did.
type Result = hookfile.Result

// State of one event's hook.
type State = hookfile.State

const (
	Installed     = hookfile.Installed
	Missing       = hookfile.Missing
	MissingBinary = hookfile.MissingBinary
)

// EventStatus is the status of one event.
type EventStatus = hookfile.EventStatus

// Install writes notify.sh and adds one entry per event to settings.json,
// leaving every other byte of the file alone. It is idempotent.
func Install(c Config) (Result, error) { return hookfile.Install(c.file()) }

// Uninstall removes exactly the entries Install added, and the wrapper script.
func Uninstall(c Config) (Result, error) { return hookfile.Uninstall(c.file()) }

// Status reports, per event, whether an Explorer entry is present and usable.
func Status(c Config) ([]EventStatus, error) { return hookfile.Status(c.file()) }

// configPort reads "port" from <explorerHome>/config.json.
func configPort(explorerHome string) int {
	data, err := os.ReadFile(filepath.Join(explorerHome, "config.json"))
	if err != nil {
		return DefaultPort
	}
	var cfg struct {
		Port int `json:"port"`
	}
	if json.Unmarshal(data, &cfg) != nil || cfg.Port <= 0 || cfg.Port > 65535 {
		return DefaultPort
	}
	return cfg.Port
}
