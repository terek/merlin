package catalog

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

// RegistryEntry is one live-session file of a harness (for Claude Code,
// <config>/sessions/<pid>.json).
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

// ReadRegistry reads every <dir>/*.json for a harness and keeps the entries whose pid
// alive reports true (nil alive: ProcessAlive). A missing directory gives an empty
// registry; unreadable or malformed files are skipped. When several live processes name
// the same session, the most recently updated wins.
func ReadRegistry(harness, dir string, alive func(pid int) bool) (Registry, error) {
	if alive == nil {
		alive = ProcessAlive
	}
	reg := Registry{}
	ents, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return reg, nil
	}
	if err != nil {
		return nil, err
	}
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".json") || !e.Type().IsRegular() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var raw struct {
			PID       int     `json:"pid"`
			SessionID string  `json:"sessionId"`
			Status    string  `json:"status"`
			UpdatedAt float64 `json:"updatedAt"` // epoch milliseconds
			Cwd       string  `json:"cwd"`
		}
		if json.Unmarshal(b, &raw) != nil || raw.PID <= 0 || raw.SessionID == "" || !alive(raw.PID) {
			continue
		}
		ent := RegistryEntry{PID: raw.PID, SessionID: raw.SessionID, Status: raw.Status, Cwd: raw.Cwd}
		if raw.UpdatedAt > 0 {
			ent.UpdatedAt = time.UnixMilli(int64(raw.UpdatedAt))
		}
		key := model.SessionKey{Harness: harness, ID: raw.SessionID}
		if old, ok := reg[key]; ok && old.UpdatedAt.After(ent.UpdatedAt) {
			continue
		}
		reg[key] = ent
	}
	return reg, nil
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
