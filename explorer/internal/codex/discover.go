package codex

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/terek/merlin/explorer/internal/model"
)

// HarnessName is the harness name: the session key prefix and the storage directory.
const HarnessName = "codex"

// fileRef is one rollout of a session tree.
type fileRef struct {
	Path   string
	Thread string // thread id (session_meta.id)
}

// source is one session tree as discovery found it: the Handle the engine hands back to
// Build.
type source struct {
	ID         string // session id: the root thread's id
	ProjectKey string
	Files      []fileRef // the tree's rollouts, sorted by path
	// Bases are the rollouts a fork inherits history from (history_base), by thread id.
	Bases map[string]string
	// ForkSession is the session the root thread forked from (forked_from_id names a thread).
	ForkSession string
	// Index is session_index.jsonl when it exists: titles live there.
	Index       string
	Fingerprint []model.SourceFile
}

// metaCache keeps the session_meta of every rollout seen: it is the first line of a file
// and never changes, so discovery reads each file's first line once.
type metaCache struct {
	mu sync.Mutex
	m  map[string]cachedMeta
}

type cachedMeta struct {
	size int64
	meta sessionMeta
	src  threadSource
	err  error
}

func (c *metaCache) get(path string, size int64) (sessionMeta, threadSource, error) {
	c.mu.Lock()
	e, ok := c.m[path]
	c.mu.Unlock()
	if ok && size >= e.size && (e.err == nil || size == e.size) {
		return e.meta, e.src, e.err
	}
	m, err := readMeta(path)
	src := parseSource(m.Source)
	if src.Parent == "" {
		src.Parent = m.ParentThreadID
	}
	if src.AgentPath == "" {
		src.AgentPath = m.AgentPath
	}
	c.mu.Lock()
	if c.m == nil {
		c.m = map[string]cachedMeta{}
	}
	c.m[path] = cachedMeta{size: size, meta: m, src: src, err: err}
	c.mu.Unlock()
	return m, src, err
}

// scanned is one rollout found by the walk.
type scanned struct {
	path string
	info fs.FileInfo
	meta sessionMeta
	src  threadSource
}

// scan walks <home>/sessions and groups the rollouts into session trees.
func (c *metaCache) scan(home string) ([]source, []string, error) {
	root := filepath.Join(home, "sessions")
	var files []scanned
	var warnings []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == root {
				return err
			}
			warnings = append(warnings, fmt.Sprintf("%s: %v", path, err))
			return nil
		}
		if d.IsDir() || !strings.HasPrefix(d.Name(), "rollout-") || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s: %v", path, err))
			return nil
		}
		m, src, err := c.get(path, info.Size())
		if err != nil {
			if info.Size() > 0 {
				warnings = append(warnings, err.Error())
			}
			return nil
		}
		files = append(files, scanned{path: path, info: info, meta: m, src: src})
		return nil
	})
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].path < files[j].path })

	byThread := map[string]*scanned{}
	for i := range files {
		f := &files[i]
		if prev, dup := byThread[f.meta.ID]; dup {
			warnings = append(warnings, fmt.Sprintf("thread %s found in two files; ignoring %s, keeping %s", f.meta.ID, f.path, prev.path))
			continue
		}
		byThread[f.meta.ID] = f
	}

	index := filepath.Join(home, "session_index.jsonl")
	indexInfo, indexErr := os.Stat(index)

	trees := map[string]*source{}
	var order []string
	for i := range files {
		f := &files[i]
		if byThread[f.meta.ID] != f {
			continue
		}
		id := sessionOf(f.meta)
		s := trees[id]
		if s == nil {
			s = &source{ID: id}
			trees[id] = s
			order = append(order, id)
		}
		s.Files = append(s.Files, fileRef{Path: f.path, Thread: f.meta.ID})
	}
	out := make([]source, 0, len(order))
	for _, id := range order {
		s := trees[id]
		rootCwd := ""
		var fp []model.SourceFile
		for _, f := range s.Files {
			sc := byThread[f.Thread]
			fp = append(fp, sourceFile(sc.path, sc.info))
			if f.Thread == id {
				rootCwd = sc.meta.Cwd
				if from := sc.meta.ForkedFromID; from != "" {
					s.ForkSession = from
					if p := byThread[from]; p != nil {
						s.ForkSession = sessionOf(p.meta)
					}
				}
			}
			// A fork reads the part of the files it forked from that comes before the fork
			// point, and the files that one forked from, and so on.
			for hb, n := sc.meta.HistoryBase, 0; hb != nil && n < 8; n++ {
				base := byThread[hb.ThreadID]
				if base == nil || s.Bases[hb.ThreadID] != "" {
					break
				}
				if s.Bases == nil {
					s.Bases = map[string]string{}
				}
				s.Bases[hb.ThreadID] = base.path
				fp = append(fp, sourceFile(base.path, base.info))
				hb = base.meta.HistoryBase
			}
		}
		if rootCwd == "" && len(s.Files) > 0 {
			rootCwd = byThread[s.Files[0].Thread].meta.Cwd
		}
		s.ProjectKey = projectKey(rootCwd)
		if indexErr == nil {
			s.Index = index
			fp = append(fp, sourceFile(index, indexInfo))
		}
		sort.Slice(fp, func(i, j int) bool { return fp[i].Path < fp[j].Path })
		s.Fingerprint = dedupe(fp)
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ProjectKey != out[j].ProjectKey {
			return out[i].ProjectKey < out[j].ProjectKey
		}
		return out[i].ID < out[j].ID
	})
	return out, warnings, nil
}

// sessionOf is the session a thread belongs to: the root thread of its tree.
func sessionOf(m sessionMeta) string {
	if m.SessionID != "" {
		return m.SessionID
	}
	return m.ID
}

func sourceFile(path string, info fs.FileInfo) model.SourceFile {
	return model.SourceFile{Path: path, Size: info.Size(), MtimeNs: info.ModTime().UnixNano()}
}

func dedupe(fp []model.SourceFile) []model.SourceFile {
	out := fp[:0]
	for i, f := range fp {
		if i > 0 && f.Path == fp[i-1].Path {
			continue
		}
		out = append(out, f)
	}
	return out
}

// projectKey names a working directory the way Claude Code names its project directories
// (every character other than a letter or a digit becomes '-'), so that the two harnesses'
// keys for one directory agree.
func projectKey(cwd string) string {
	if cwd == "" {
		return "-"
	}
	b := []byte(cwd)
	for i, c := range b {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			b[i] = '-'
		}
	}
	return string(b)
}

func sortStrings(s []string) { sort.Strings(s) }
