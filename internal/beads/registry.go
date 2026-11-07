package beads

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/terek/merlin/internal/store"
)

// RegistryDir is the registry's directory in MERLIN_HOME: one file per beads database.
const RegistryDir = "beads"

// Database is a snapshot of one beads database, read from its export (.beads/issues.jsonl).
// It is merged, never replaced: an issue missing from a newer export is kept, marked Gone.
type Database struct {
	Version   int    `json:"version"`
	Key       string `json:"key"`                 // the file name: ProjectID, else path-<hash of the first .beads dir>
	ProjectID string `json:"projectId,omitempty"` // metadata.json project_id: the same in every clone and worktree
	Database  string `json:"database,omitempty"`  // metadata.json dolt_database
	// Dirs are the .beads directories found to hold this database, in the order found.
	Dirs []string `json:"dirs"`
	// Prefixes are the id prefixes of its issues (merlin for merlin-t8s.48), sorted.
	Prefixes []string `json:"prefixes,omitempty"`
	// Sources are the exports read, one per directory, with the size and mtime they had: an
	// export is read again only when they change.
	Sources []Source `json:"sources,omitempty"`
	// BadLines is the unparseable lines of the export plus InteractionsBadLines, from the latest reads.
	BadLines             int64   `json:"badLines,omitempty"`
	InteractionsBadLines int64   `json:"interactionsBadLines,omitempty"`
	Issues               []Issue `json:"issues"` // sorted by id
	// Statuses are the latest status change per issue in interactions.jsonl, sorted by id. Databases
	// without an export have only these.
	Statuses []Status `json:"statuses,omitempty"`
}

// Status is the latest status change of an issue recorded in interactions.jsonl.
type Status struct {
	ID     string    `json:"id"`
	Status string    `json:"status"`
	At     time.Time `json:"at"`
	Reason string    `json:"reason,omitempty"`
}

// Source is an export file as it was when read.
type Source struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	MtimeNs int64  `json:"mtimeNs"`
}

// Issue is one bead. Descriptions, notes and comments are not kept.
type Issue struct {
	ID          string    `json:"id"`
	Title       string    `json:"title,omitempty"`
	Type        string    `json:"type,omitempty"`
	Status      string    `json:"status,omitempty"`
	Priority    *int      `json:"priority,omitempty"`
	Parent      string    `json:"parent,omitempty"` // from the parent-child dependency
	Deps        []Dep     `json:"deps,omitempty"`   // the other dependencies
	Assignee    string    `json:"assignee,omitempty"`
	Labels      []string  `json:"labels,omitempty"`
	CreatedAt   time.Time `json:"createdAt,omitzero"`
	StartedAt   time.Time `json:"startedAt,omitzero"`
	ClosedAt    time.Time `json:"closedAt,omitzero"`
	CloseReason string    `json:"closeReason,omitempty"`
	// Gone marks an issue that a later export no longer has (deleted, or compacted away).
	Gone bool `json:"gone,omitempty"`
	// Source, FirstSeen and LastSeen are set by Fold only (the registry never writes them): where
	// the bead is known from, and when the sessions first and last named it.
	Source    string    `json:"source,omitempty"`
	FirstSeen time.Time `json:"firstSeen,omitzero"`
	LastSeen  time.Time `json:"lastSeen,omitzero"`
}

// Issue.Source values.
const (
	SourceExport   = "export"   // an export has the issue (even if gone)
	SourceSessions = "sessions" // known only from bd calls in sessions
	SourceImplied  = "implied"  // a parent or dotted ancestor no source describes: the id only
)

// Dep is a dependency of an issue: it depends on ID (type blocks, related, …).
type Dep struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

// Registry holds the snapshots under <MERLIN_HOME>/beads. It is safe for concurrent use.
type Registry struct {
	dir string

	mu    sync.Mutex
	dbs   map[string]*Database // by key
	byDir map[string]string    // .beads directory -> key
}

// OpenRegistry loads every snapshot under <home>/beads. Unreadable files are skipped.
func OpenRegistry(home string) *Registry {
	r := &Registry{dir: filepath.Join(home, RegistryDir), dbs: map[string]*Database{}, byDir: map[string]string{}}
	entries, _ := os.ReadDir(r.dir)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(r.dir, e.Name()))
		if err != nil {
			continue
		}
		var db Database
		if json.Unmarshal(b, &db) != nil || db.Key == "" {
			continue
		}
		r.dbs[db.Key] = &db
		for _, d := range db.Dirs {
			r.byDir[d] = db.Key
		}
	}
	return r
}

// ForDir returns a copy of the snapshot of the database in a .beads directory.
func (r *Registry) ForDir(beadsDir string) (Database, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if k, ok := r.byDir[filepath.Clean(beadsDir)]; ok {
		return clone(r.dbs[k]), true
	}
	return Database{}, false
}

// All returns copies of every snapshot, sorted by key.
func (r *Registry) All() []Database {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Database, 0, len(r.dbs))
	for _, db := range r.dbs {
		out = append(out, clone(db))
	}
	slices.SortFunc(out, func(a, b Database) int { return strings.Compare(a.Key, b.Key) })
	return out
}

func clone(db *Database) Database {
	c := *db
	c.Dirs, c.Prefixes, c.Sources = slices.Clone(db.Dirs), slices.Clone(db.Prefixes), slices.Clone(db.Sources)
	c.Issues, c.Statuses = slices.Clone(db.Issues), slices.Clone(db.Statuses)
	return c
}

// Refresh reads the database in a .beads directory when its export changed since it was last
// read (or was never read), merges it into the snapshot and saves the snapshot. It reports
// whether the snapshot changed. A directory without metadata.json is not a database.
func (r *Registry) Refresh(beadsDir string) (bool, error) {
	beadsDir = filepath.Clean(beadsDir)
	var meta struct {
		ProjectID    string `json:"project_id"`
		DoltDatabase string `json:"dolt_database"`
	}
	b, err := os.ReadFile(filepath.Join(beadsDir, "metadata.json"))
	if err != nil {
		return false, err
	}
	_ = json.Unmarshal(b, &meta) // an unreadable metadata.json still names a database
	key := meta.ProjectID
	if !store.ValidName(key) {
		h := sha256.Sum256([]byte(beadsDir))
		key = "path-" + hex.EncodeToString(h[:8])
	}

	export, st, err := exportOf(beadsDir)
	if err != nil {
		return false, err
	}
	src := Source{Path: export}
	if st != nil {
		src.Size, src.MtimeNs = st.Size(), st.ModTime().UnixNano()
	}

	r.mu.Lock()
	db, had := r.dbs[key]
	if !had {
		db = &Database{Version: 1, Key: key}
	}
	next := clone(db)
	r.mu.Unlock()

	changed := !had
	if !slices.Contains(next.Dirs, beadsDir) {
		next.Dirs = append(next.Dirs, beadsDir)
		changed = true
	}
	if next.ProjectID != meta.ProjectID || next.Database != meta.DoltDatabase {
		next.ProjectID, next.Database = meta.ProjectID, meta.DoltDatabase
		changed = true
	}
	k := slices.IndexFunc(next.Sources, func(s Source) bool { return s.Path == export })
	if st != nil && (k < 0 || next.Sources[k] != src) {
		issues, bad, err := readExport(export)
		if err != nil {
			return false, err
		}
		next.Issues, next.BadLines = merge(next.Issues, issues), bad+next.InteractionsBadLines
		next.Prefixes = prefixes(next.Issues)
		if k < 0 {
			next.Sources = append(next.Sources, src)
		} else {
			next.Sources[k] = src
		}
		changed = true
	}
	ipath := filepath.Join(beadsDir, "interactions.jsonl")
	if ist, err := os.Stat(ipath); err == nil {
		isrc := Source{Path: ipath, Size: ist.Size(), MtimeNs: ist.ModTime().UnixNano()}
		ik := slices.IndexFunc(next.Sources, func(s Source) bool { return s.Path == ipath })
		if ik < 0 || next.Sources[ik] != isrc {
			sts, bad, err := readInteractions(ipath)
			if err != nil {
				return false, err
			}
			next.Statuses = mergeStatuses(next.Statuses, sts)
			next.BadLines += bad - next.InteractionsBadLines
			next.InteractionsBadLines = bad
			if ik < 0 {
				next.Sources = append(next.Sources, isrc)
			} else {
				next.Sources[ik] = isrc
			}
			changed = true
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	if !changed {
		return false, nil
	}
	out, err := json.MarshalIndent(&next, "", "  ")
	if err != nil {
		return false, err
	}
	if err := store.WriteFileAtomic(filepath.Join(r.dir, key+".json"), append(out, '\n')); err != nil {
		return false, err
	}
	r.mu.Lock()
	r.dbs[key] = &next
	for _, d := range next.Dirs {
		r.byDir[d] = key
	}
	r.mu.Unlock()
	return true, nil
}

// exportOf is a database's export: issues.jsonl, or beads.jsonl in older databases. st is nil
// when there is none.
func exportOf(beadsDir string) (string, fs.FileInfo, error) {
	first := filepath.Join(beadsDir, "issues.jsonl")
	for _, name := range []string{"issues.jsonl", "beads.jsonl"} {
		p := filepath.Join(beadsDir, name)
		st, err := os.Stat(p)
		if err == nil {
			return p, st, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", nil, err
		}
	}
	return first, nil, nil
}

// exportIssue is the part of an export line the registry keeps.
type exportIssue struct {
	Type        string    `json:"_type"`
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Status      string    `json:"status"`
	Priority    *int      `json:"priority"`
	IssueType   string    `json:"issue_type"`
	Assignee    string    `json:"assignee"`
	Labels      []string  `json:"labels"`
	CreatedAt   time.Time `json:"created_at"`
	StartedAt   time.Time `json:"started_at"`
	ClosedAt    time.Time `json:"closed_at"`
	CloseReason string    `json:"close_reason"`
	Deps        []struct {
		IssueID     string `json:"issue_id"`
		DependsOnID string `json:"depends_on_id"`
		Type        string `json:"type"`
	} `json:"dependencies"`
}

// readExport reads an export. Lines that do not parse, or are not issues, are counted.
func readExport(path string) ([]Issue, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	var out []Issue
	var bad int64
	rd := bufio.NewReaderSize(f, 256<<10)
	for {
		line, err := rd.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 && (err == nil || errors.Is(err, io.EOF)) {
			var e exportIssue
			if json.Unmarshal(line, &e) != nil || e.ID == "" || (e.Type != "" && e.Type != "issue") {
				bad++
			} else {
				out = append(out, issueOf(e))
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, 0, err
		}
	}
	return out, bad, nil
}

func issueOf(e exportIssue) Issue {
	is := Issue{
		ID: e.ID, Title: e.Title, Type: e.IssueType, Status: e.Status, Priority: e.Priority,
		Assignee: e.Assignee, Labels: e.Labels, CloseReason: e.CloseReason,
		CreatedAt: e.CreatedAt.UTC(), StartedAt: e.StartedAt.UTC(), ClosedAt: e.ClosedAt.UTC(),
	}
	for _, d := range e.Deps {
		if d.DependsOnID == "" || (d.IssueID != "" && d.IssueID != e.ID) {
			continue
		}
		if d.Type == "parent-child" {
			is.Parent = d.DependsOnID
			continue
		}
		is.Deps = append(is.Deps, Dep{ID: d.DependsOnID, Type: d.Type})
	}
	return is
}

// merge returns the new export's issues plus the old ones it no longer has, marked gone,
// sorted by id.
func merge(old, cur []Issue) []Issue {
	out := slices.Clone(cur)
	have := make(map[string]bool, len(cur))
	for _, is := range cur {
		have[is.ID] = true
	}
	for _, is := range old {
		if !have[is.ID] {
			is.Gone = true
			out = append(out, is)
		}
	}
	slices.SortFunc(out, func(a, b Issue) int { return strings.Compare(a.ID, b.ID) })
	return slices.CompactFunc(out, func(a, b Issue) bool { return a.ID == b.ID })
}

// Prefix is a bead id's prefix: what precedes the last dash of its root (merlin for
// merlin-t8s.48.1, my-app for my-app-k2).
func Prefix(id string) string {
	root, _, _ := strings.Cut(id, ".")
	if i := strings.LastIndexByte(root, '-'); i > 0 {
		return root[:i]
	}
	return ""
}

// Root is the root of a bead id's hierarchy as its id spells it (merlin-t8s for
// merlin-t8s.48.1). The registry's parent links are the authority; this is the fallback.
func Root(id string) string {
	root, _, _ := strings.Cut(id, ".")
	return root
}

func prefixes(issues []Issue) []string {
	var out []string
	for _, is := range issues {
		if p := Prefix(is.ID); p != "" && !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	slices.Sort(out)
	return out
}

// readInteractions reads interactions.jsonl and returns the latest status change per issue,
// sorted by id. Lines that do not parse are counted; other kinds and fields are skipped.
func readInteractions(path string) ([]Status, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	latest := map[string]Status{}
	var bad int64
	rd := bufio.NewReaderSize(f, 256<<10)
	for {
		line, err := rd.ReadBytes('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, 0, err
		}
		if len(strings.TrimSpace(string(line))) > 0 {
			var e struct {
				Kind      string    `json:"kind"`
				CreatedAt time.Time `json:"created_at"`
				IssueID   string    `json:"issue_id"`
				Extra     struct {
					Field    string `json:"field"`
					NewValue string `json:"new_value"`
					Reason   string `json:"reason"`
				} `json:"extra"`
			}
			if json.Unmarshal(line, &e) != nil {
				bad++
			} else if e.Kind == "field_change" && e.Extra.Field == "status" && e.IssueID != "" && e.Extra.NewValue != "" {
				s := Status{ID: e.IssueID, Status: e.Extra.NewValue, At: e.CreatedAt.UTC(), Reason: e.Extra.Reason}
				if old, ok := latest[s.ID]; !ok || !s.At.Before(old.At) {
					latest[s.ID] = s
				}
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
	}
	return statusList(latest), bad, nil
}

func statusList(m map[string]Status) []Status {
	out := make([]Status, 0, len(m))
	for _, s := range m {
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b Status) int { return strings.Compare(a.ID, b.ID) })
	return out
}

// mergeStatuses returns the latest status per issue of the old and the new read: an issue the
// new read lacks is kept, and an older change never replaces a later one.
func mergeStatuses(old, cur []Status) []Status {
	m := make(map[string]Status, len(old)+len(cur))
	for _, s := range old {
		m[s.ID] = s
	}
	for _, s := range cur {
		if o, ok := m[s.ID]; !ok || !s.At.Before(o.At) {
			m[s.ID] = s
		}
	}
	return statusList(m)
}
