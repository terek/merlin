// Package discover walks a Claude Code projects directory and lists every session with
// the files that belong to it and a cheap fingerprint of those files.
//
// It only lists directories and stats files; it never opens a file. See
// docs/transcript-format.md section 1 for the layout.
package discover

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/terek/merlin/explorer/internal/model"
)

// Harness is the harness name used in session keys.
const Harness = "claude"

// Agent is one subagent of a session.
type Agent struct {
	ID   string // parsed from agent-<id>.jsonl
	Path string // the transcript
	// Dir is the directory of the transcript relative to the session's subagents directory,
	// with forward slashes: empty for a file directly in it, "workflows/<runId>" for an
	// agent of a workflow run.
	Dir      string
	MetaPath string // agent-<id>.meta.json; empty when absent
}

// Source is one session and the files it is built from.
type Source struct {
	ProjectKey  string      // top-level directory name under the projects directory
	ID          string      // session id (UUID)
	Main        string      // main transcript path; empty for an orphan
	Agents      []Agent     // sorted by agent id
	Fingerprint Fingerprint // main, agent transcripts and meta files, sorted by path
}

// Key returns the session's (harness, id) key.
func (s Source) Key() model.SessionKey { return model.SessionKey{Harness: Harness, ID: s.ID} }

// Warning reports a path that could not be read. The scan carries on without it.
type Warning struct {
	Path string
	Err  error
}

func (w Warning) String() string { return w.Path + ": " + w.Err.Error() }

// Result is the outcome of a scan.
type Result struct {
	Sessions []Source // sorted by project key, session id, then location
	Warnings []Warning
}

// Fingerprint is the (path, size, mtime) of every file of a session, sorted by path.
type Fingerprint []model.SourceFile

// Equal reports whether both fingerprints list the same files with the same size and mtime.
func (f Fingerprint) Equal(o Fingerprint) bool {
	if len(f) != len(o) {
		return false
	}
	for i := range f {
		if f[i] != o[i] {
			return false
		}
	}
	return true
}

// String is a stable, one-line-per-file form: path, size, mtimeNs separated by tabs.
func (f Fingerprint) String() string {
	var b strings.Builder
	for i, sf := range f {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(sf.Path)
		b.WriteByte('\t')
		b.WriteString(strconv.FormatInt(sf.Size, 10))
		b.WriteByte('\t')
		b.WriteString(strconv.FormatInt(sf.MtimeNs, 10))
	}
	return b.String()
}

// Scan walks projectsDir. A projectsDir that cannot be listed is an error; anything below
// it that cannot be read is skipped and reported in Result.Warnings.
func Scan(projectsDir string) (Result, error) {
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return Result{}, fmt.Errorf("discover: %w", err)
	}
	w := &walker{}
	for _, e := range entries {
		if e.IsDir() {
			w.dir(filepath.Join(projectsDir, e.Name()), e.Name())
		}
	}
	sort.Slice(w.out, func(i, j int) bool {
		a, b := w.out[i], w.out[j]
		if a.ProjectKey != b.ProjectKey {
			return a.ProjectKey < b.ProjectKey
		}
		if a.ID != b.ID {
			return a.ID < b.ID
		}
		return locus(a) < locus(b)
	})
	sort.Slice(w.warnings, func(i, j int) bool { return w.warnings[i].Path < w.warnings[j].Path })
	return Result{Sessions: w.out, Warnings: w.warnings}, nil
}

func locus(s Source) string {
	if s.Main != "" {
		return s.Main
	}
	return s.Agents[0].Path
}

type walker struct {
	out      []Source
	warnings []Warning
}

func (w *walker) warn(path string, err error) {
	w.warnings = append(w.warnings, Warning{Path: path, Err: err})
}

// skipDirs never hold transcripts and can be large.
var skipDirs = map[string]bool{"tool-results": true, "memory": true}

// session accumulates the files of one session id found in one directory.
type session struct {
	main   *model.SourceFile
	agents map[string]*agentFiles
}

type agentFiles struct {
	id, dir     string
	jsonl, meta *model.SourceFile
}

func pathJoin(rel, name string) string {
	if rel == "" {
		return name
	}
	return rel + "/" + name
}

// dir handles one directory that is a project directory or sits inside one: UUID-named
// jsonl files are main transcripts, UUID-named subdirectories are session directories
// (only their subagents directory is read, with its subdirectories), other directories are
// walked recursively.
func (w *walker) dir(path, project string) {
	entries, err := os.ReadDir(path)
	if err != nil {
		w.warn(path, err)
		return
	}
	sessions := map[string]*session{}
	get := func(id string) *session {
		s := sessions[id]
		if s == nil {
			s = &session{agents: map[string]*agentFiles{}}
			sessions[id] = s
		}
		return s
	}
	for _, e := range entries {
		name := e.Name()
		full := filepath.Join(path, name)
		switch {
		case e.IsDir() && isUUID(name):
			w.subagents(filepath.Join(full, "subagents"), "", get(name))
		case e.IsDir():
			if !skipDirs[name] {
				w.dir(full, project)
			}
		case strings.HasSuffix(name, ".jsonl") && isUUID(strings.TrimSuffix(name, ".jsonl")):
			if sf, ok := w.stat(full, e); ok {
				get(strings.TrimSuffix(name, ".jsonl")).main = &sf
			}
		}
	}
	for id, s := range sessions {
		if src, ok := build(path, project, id, s); ok {
			w.out = append(w.out, src)
		}
	}
}

// subagents lists the agent files in path and, recursively, in its subdirectories: Claude
// Code puts the agents of a workflow run in subagents/workflows/<runId>/. rel is path
// relative to the session's subagents directory.
func (w *walker) subagents(path, rel string, s *session) {
	entries, err := os.ReadDir(path)
	if err != nil {
		if !os.IsNotExist(err) {
			w.warn(path, err)
		}
		return
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			w.subagents(filepath.Join(path, name), pathJoin(rel, name), s)
			continue
		}
		if !strings.HasPrefix(name, "agent-") {
			continue
		}
		var id string
		var meta bool
		switch {
		case strings.HasSuffix(name, ".meta.json"):
			id, meta = strings.TrimSuffix(strings.TrimPrefix(name, "agent-"), ".meta.json"), true
		case strings.HasSuffix(name, ".jsonl"):
			id = strings.TrimSuffix(strings.TrimPrefix(name, "agent-"), ".jsonl")
		default:
			continue
		}
		if id == "" {
			continue
		}
		sf, ok := w.stat(filepath.Join(path, name), e)
		if !ok {
			continue
		}
		// An agent id names one agent of the session; should two directories hold the same
		// id, each is listed and the assembly keeps the first.
		key := rel + "\x00" + id
		a := s.agents[key]
		if a == nil {
			a = &agentFiles{id: id, dir: rel}
			s.agents[key] = a
		}
		if meta {
			a.meta = &sf
		} else {
			a.jsonl = &sf
		}
	}
}

// stat returns the fingerprint entry for a file, following a symlink to a regular file.
func (w *walker) stat(path string, e fs.DirEntry) (model.SourceFile, bool) {
	var info fs.FileInfo
	var err error
	if e.Type()&fs.ModeSymlink != 0 {
		info, err = os.Stat(path)
	} else {
		info, err = e.Info()
	}
	if err != nil {
		w.warn(path, err)
		return model.SourceFile{}, false
	}
	if !info.Mode().IsRegular() {
		return model.SourceFile{}, false
	}
	return model.SourceFile{Path: path, Size: info.Size(), MtimeNs: info.ModTime().UnixNano()}, true
}

func build(dir, project, id string, s *session) (Source, bool) {
	src := Source{ProjectKey: project, ID: id}
	if s.main != nil {
		src.Main = s.main.Path
		src.Fingerprint = append(src.Fingerprint, *s.main)
	}
	for _, a := range s.agents {
		if a.jsonl == nil {
			continue // metadata without a transcript describes nothing
		}
		ag := Agent{ID: a.id, Path: a.jsonl.Path, Dir: a.dir}
		src.Fingerprint = append(src.Fingerprint, *a.jsonl)
		if a.meta != nil {
			ag.MetaPath = a.meta.Path
			src.Fingerprint = append(src.Fingerprint, *a.meta)
		}
		src.Agents = append(src.Agents, ag)
	}
	if src.Main == "" && len(src.Agents) == 0 {
		return Source{}, false
	}
	sort.Slice(src.Agents, func(i, j int) bool {
		if src.Agents[i].ID != src.Agents[j].ID {
			return src.Agents[i].ID < src.Agents[j].ID
		}
		return src.Agents[i].Dir < src.Agents[j].Dir
	})
	sort.Slice(src.Fingerprint, func(i, j int) bool { return src.Fingerprint[i].Path < src.Fingerprint[j].Path })
	return src, true
}

// isUUID reports whether s is a canonical 8-4-4-4-12 hex UUID.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		switch i {
		case 8, 13, 18, 23:
			if s[i] != '-' {
				return false
			}
		default:
			c := s[i]
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return false
			}
		}
	}
	return true
}
