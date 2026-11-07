package claude

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/model"
)

// registryDir is where Claude Code keeps one <pid>.json per running session.
func registryDir(configDir string) string { return filepath.Join(configDir, "sessions") }

// ReadRegistry reads every <configDir>/sessions/*.json and keeps the entries whose pid
// alive reports true (nil alive: catalog.ProcessAlive). A missing directory gives an
// empty registry; unreadable or malformed files are skipped. When several live
// processes name the same session, the most recently updated wins.
func ReadRegistry(configDir string, alive func(pid int) bool) (catalog.Registry, error) {
	return readRegistry(registryDir(configDir), alive)
}

func readRegistry(dir string, alive func(pid int) bool) (catalog.Registry, error) {
	if alive == nil {
		alive = catalog.ProcessAlive
	}
	reg := catalog.Registry{}
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
		ent := catalog.RegistryEntry{PID: raw.PID, SessionID: raw.SessionID, Status: raw.Status, Cwd: raw.Cwd}
		if raw.UpdatedAt > 0 {
			ent.UpdatedAt = time.UnixMilli(int64(raw.UpdatedAt))
		}
		key := model.SessionKey{Harness: Name, ID: raw.SessionID}
		if old, ok := reg[key]; ok && old.UpdatedAt.After(ent.UpdatedAt) {
			continue
		}
		reg[key] = ent
	}
	return reg, nil
}
