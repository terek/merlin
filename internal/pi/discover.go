package pi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/terek/merlin/internal/model"
)

// HarnessName is the harness name: the session key prefix and the storage directory.
const HarnessName = "pi"

// maxHeader bounds the first line of a file read as a header; a session header is a few
// hundred bytes, so a longer first line is not one.
const maxHeader = 1 << 20

// source is one session as discovery found it: the Handle the engine hands back to Build.
type source struct {
	ID          string
	ProjectKey  string
	Path        string
	Fingerprint []model.SourceFile
}

// headerCache keeps the header of every file seen. A header is the first line and never
// changes while a file is only appended to, so discovery reads each file's first line once;
// the entry is reused while the file has not shrunk (a file that is not a session is looked at
// again when its size changes).
type headerCache struct {
	mu sync.Mutex
	m  map[string]cachedHeader
}

type cachedHeader struct {
	size int64
	head header
	ok   bool // the first line is a session header with an id
}

func (c *headerCache) get(path string, size int64) (header, bool, error) {
	c.mu.Lock()
	e, ok := c.m[path]
	c.mu.Unlock()
	if ok && size >= e.size && (e.ok || size == e.size) {
		return e.head, e.ok, nil
	}
	h, isSession, err := readHeader(path)
	if err != nil {
		return header{}, false, err
	}
	c.mu.Lock()
	if c.m == nil {
		c.m = map[string]cachedHeader{}
	}
	c.m[path] = cachedHeader{size: size, head: h, ok: isSession}
	c.mu.Unlock()
	return h, isSession, nil
}

// readHeader reads the first line of a file. A file whose first line is not a session
// header with an id (a dataset's manifest, say) is not a session: ok is false, no error.
func readHeader(path string) (h header, ok bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		return header{}, false, err
	}
	defer f.Close()
	line, err := bufio.NewReaderSize(io.LimitReader(f, maxHeader), 64<<10).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return header{}, false, err
	}
	if json.Unmarshal(bytes.TrimSpace(line), &h) != nil || h.Type != "session" || h.ID == "" {
		return header{}, false, nil
	}
	return h, true, nil
}

type scanned struct {
	path string
	info fs.FileInfo
	head header
}

// scan walks the sessions directory (recursively: the per-directory level is optional) for
// session files and returns one source per session id. Two files with one header id are one
// session exported twice; the longer file is kept.
func (c *headerCache) scan(root string) ([]source, []string, error) {
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
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s: %v", path, err))
			return nil
		}
		h, ok, err := c.get(path, info.Size())
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s: %v", path, err))
			return nil
		}
		if !ok {
			return nil
		}
		if id := string(h.ID); id == "." || id == ".." || strings.ContainsAny(id, `/\`) {
			warnings = append(warnings, fmt.Sprintf("%s: session id %q is not usable as a name; ignored", path, id))
			return nil
		}
		files = append(files, scanned{path: path, info: info, head: h})
		return nil
	})
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].path < files[j].path })

	byID := map[string]*scanned{}
	var order []string
	for i := range files {
		f := &files[i]
		id := string(f.head.ID)
		prev, dup := byID[id]
		if !dup {
			byID[id] = f
			order = append(order, id)
			continue
		}
		keep, drop := prev, f
		if f.info.Size() > prev.info.Size() {
			keep, drop = f, prev
		}
		byID[id] = keep
		warnings = append(warnings, fmt.Sprintf("session %s found in two files (a re-export?); keeping the longer %s, ignoring %s", id, keep.path, drop.path))
	}
	out := make([]source, 0, len(order))
	for _, id := range order {
		f := byID[id]
		out = append(out, source{
			ID:          id,
			ProjectKey:  projectKey(string(f.head.Cwd)),
			Path:        f.path,
			Fingerprint: []model.SourceFile{{Path: f.path, Size: f.info.Size(), MtimeNs: f.info.ModTime().UnixNano()}},
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ProjectKey != out[j].ProjectKey {
			return out[i].ProjectKey < out[j].ProjectKey
		}
		return out[i].ID < out[j].ID
	})
	return out, warnings, nil
}

// projectKey names a working directory the way Claude Code names its project directories
// (every character other than a letter or a digit becomes '-'), so that the harnesses' keys
// for one directory agree.
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
