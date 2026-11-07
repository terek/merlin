package catalog

import (
	"errors"
	"os"
	"syscall"
	"time"

	"github.com/terek/merlin/internal/model"
)

// RegistryEntry is one live-session file of a harness. Reading them is the harness's job
// (see claude.ReadRegistry); the catalog only holds the result.
type RegistryEntry struct {
	PID       int
	SessionID string
	Status    string // "busy" or "idle"
	UpdatedAt time.Time
	Cwd       string
}

// Registry maps sessions to the process that currently runs them. It only holds entries
// whose process was alive when it was read.
type Registry map[model.SessionKey]RegistryEntry

// Liveness is what List needs to say whether sessions are running: the registry and the
// current time. "Now" is always passed in; the catalog never reads the clock. The zero
// value knows nothing and reports every session as ended (Now is zero).
type Liveness struct {
	Registry Registry
	Now      time.Time
}

func (lv Liveness) known() bool { return !lv.Now.IsZero() || len(lv.Registry) > 0 }

// StateOf returns running (busy or idle) for a session with a live registry entry, else
// recent when its last activity is within ten minutes of Now, else ended.
func (lv Liveness) StateOf(key model.SessionKey, lastActivity time.Time) State {
	if e, ok := lv.Registry[key]; ok {
		if e.Status == "busy" {
			return StateBusy
		}
		return StateIdle
	}
	if !lv.Now.IsZero() && !lastActivity.IsZero() && lv.Now.Sub(lastActivity) <= recentWindow {
		return StateRecent
	}
	return StateEnded
}

// ProcessAlive reports whether a process with this pid exists.
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}
