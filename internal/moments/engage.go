package moments

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// EngagedFile is the file under MERLIN_HOME that remembers which suggestions the person opened and
// which fixes they copied.
const EngagedFile = "moments.json"

// Engagement is what the person did with one suggestion or technique: the first time they opened
// its row and the latest time they copied its fix.
type Engagement struct {
	Moment   string    `json:"moment"`
	OpenedAt time.Time `json:"openedAt,omitzero"`
	CopiedAt time.Time `json:"copiedAt,omitzero"`
}

// The two actions the page reports.
const (
	ActionOpen = "open"
	ActionCopy = "copy"
)

type engagedFile struct {
	Engaged []Engagement `json:"engaged"`
}

var engageMu sync.Mutex

// LoadEngaged reads home/moments.json. A missing or unreadable file gives none.
func LoadEngaged(home string) []Engagement {
	engageMu.Lock()
	defer engageMu.Unlock()
	return loadEngaged(home)
}

func loadEngaged(home string) []Engagement {
	b, err := os.ReadFile(filepath.Join(home, EngagedFile))
	if err != nil {
		return nil
	}
	var f engagedFile
	if json.Unmarshal(b, &f) != nil {
		return nil
	}
	return f.Engaged
}

// RecordEngagement notes an action on a moment at the given time and writes the file
// atomically (a temp file, then a rename). The first open and the latest copy are kept.
func RecordEngagement(home, moment, action string, at time.Time) error {
	if action != ActionOpen && action != ActionCopy {
		return errors.New("unknown action " + action)
	}
	engageMu.Lock()
	defer engageMu.Unlock()
	list := loadEngaged(home)
	i := slices.IndexFunc(list, func(e Engagement) bool { return e.Moment == moment })
	if i < 0 {
		list = append(list, Engagement{Moment: moment})
		i = len(list) - 1
	}
	at = at.UTC()
	switch action {
	case ActionOpen:
		if list[i].OpenedAt.IsZero() {
			list[i].OpenedAt = at
		}
	case ActionCopy:
		list[i].CopiedAt = at
	}
	b, err := json.MarshalIndent(engagedFile{Engaged: list}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(home, EngagedFile+".*.tmp")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(append(b, '\n'))
	cerr := tmp.Close()
	if err := errors.Join(werr, cerr); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(home, EngagedFile)); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return nil
}
