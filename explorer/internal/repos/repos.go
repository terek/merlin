// Package repos resolves a directory to the git repository, worktree and beads database it
// belongs to, and keeps the answers in <MERLIN_HOME>/repos.json so that a directory that is
// later deleted (a removed worktree) still resolves. It reads files only and never runs git or
// bd. Harness-neutral. Design: docs/beads-and-repos.md §3.2.
package repos

import (
	"bufio"
	"encoding/json"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/terek/merlin/explorer/internal/store"
)

// Repo is where a directory sits in git and beads. The zero Repo means "not in a repository
// and no beads database".
type Repo struct {
	Top      string `json:"top,omitempty"`      // the directory holding .git: the worktree's top
	Repo     string `json:"repo,omitempty"`     // the main repository: for a linked worktree, the one it belongs to
	Worktree bool   `json:"worktree,omitempty"` // Top is a linked worktree of Repo
	Remote   string `json:"remote,omitempty"`   // the origin URL
	Beads    string `json:"beads,omitempty"`    // the .beads directory bd uses from here
	Gone     bool   `json:"gone,omitempty"`     // the directory no longer exists; this is the last answer seen
}

// Resolve looks dir up on disk. ok is false when dir does not exist.
func Resolve(dir string) (r Repo, ok bool) {
	dir = filepath.Clean(dir)
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return Repo{}, false
	}
	for d := dir; ; d = filepath.Dir(d) {
		if git, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			r = gitRepo(d, git)
			break
		}
		if filepath.Dir(d) == d {
			break
		}
	}
	r.Beads = beadsDir(dir, r)
	return r, true
}

// gitRepo describes the repository whose .git entry is in top.
func gitRepo(top string, git fs.FileInfo) Repo {
	r := Repo{Top: top, Repo: top}
	common := filepath.Join(top, ".git")
	if !git.IsDir() {
		// A linked worktree or a submodule: ".git" is a file naming the git directory.
		gd := readGitdir(filepath.Join(top, ".git"))
		if gd == "" {
			return r
		}
		if !filepath.IsAbs(gd) {
			gd = filepath.Join(top, gd)
		}
		common = gd
		if b, err := os.ReadFile(filepath.Join(gd, "commondir")); err == nil {
			c := strings.TrimSpace(string(b))
			if !filepath.IsAbs(c) {
				c = filepath.Join(gd, c)
			}
			common = filepath.Clean(c)
			r.Worktree = true
			r.Repo = common
			if filepath.Base(common) == ".git" {
				r.Repo = filepath.Dir(common)
			}
		}
	}
	r.Remote = originURL(filepath.Join(common, "config"))
	return r
}

func readGitdir(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(b))
	if v, ok := strings.CutPrefix(s, "gitdir:"); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// originURL reads [remote "origin"] url from a git config file.
func originURL(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	in := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") {
			in = strings.ReplaceAll(line, " ", "") == `[remote"origin"]`
			continue
		}
		if !in {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) == "url" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// beadsDir is the .beads directory bd uses from dir. A linked worktree shares its main
// repository's database (its own .beads holds a checked-out copy of the export), so the main
// repository's comes first; otherwise the nearest .beads with a metadata.json walking up. A
// .beads/redirect file names another .beads directory.
func beadsDir(dir string, r Repo) string {
	if r.Worktree {
		if b := beadsAt(r.Repo); b != "" {
			return b
		}
	}
	for d := dir; ; d = filepath.Dir(d) {
		if b := beadsAt(d); b != "" {
			return b
		}
		if filepath.Dir(d) == d {
			return ""
		}
	}
}

func beadsAt(d string) string {
	b := filepath.Join(d, ".beads")
	if raw, err := os.ReadFile(filepath.Join(b, "redirect")); err == nil {
		if t := strings.TrimSpace(string(raw)); t != "" {
			if !filepath.IsAbs(t) {
				t = filepath.Join(d, t)
			}
			return filepath.Clean(t)
		}
	}
	if _, err := os.Stat(filepath.Join(b, "metadata.json")); err == nil {
		return b
	}
	return ""
}

// ---- cache ----------------------------------------------------------------------------------

// FileName is the cache's file in MERLIN_HOME.
const FileName = "repos.json"

type file struct {
	Version int             `json:"version"`
	Paths   map[string]Repo `json:"paths"`
}

// Cache holds resolved directories. It is safe for concurrent use.
type Cache struct {
	path string

	mu      sync.Mutex
	paths   map[string]Repo
	checked map[string]time.Time // when each directory was last looked at in this process
	dirty   bool
}

// Open loads <home>/repos.json; a missing or unreadable file gives an empty cache.
func Open(home string) *Cache {
	c := &Cache{path: filepath.Join(home, FileName), paths: map[string]Repo{}, checked: map[string]time.Time{}}
	if b, err := os.ReadFile(c.path); err == nil {
		var f file
		if json.Unmarshal(b, &f) == nil && f.Paths != nil {
			c.paths = f.Paths
		}
	}
	return c
}

// Lookup returns what is known about dir.
func (c *Cache) Lookup(dir string) (Repo, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r, ok := c.paths[filepath.Clean(dir)]
	return r, ok
}

// All returns a copy of every known directory.
func (c *Cache) All() map[string]Repo {
	c.mu.Lock()
	defer c.mu.Unlock()
	return maps.Clone(c.paths)
}

// Refresh resolves the directories that were not looked at in the last maxAge (all of them on
// the first call in a process). A directory that no longer exists keeps its last answer, marked
// gone; one that never resolved is not recorded. It returns how many entries changed.
func (c *Cache) Refresh(dirs []string, maxAge time.Duration, now time.Time) int {
	todo := c.due(dirs, maxAge, now)
	changed := 0
	for _, d := range todo {
		r, ok := Resolve(d)
		c.mu.Lock()
		old, had := c.paths[d]
		switch {
		case ok && (!had || old != r):
			c.paths[d] = r
			changed++
		case !ok && had && !old.Gone:
			old.Gone = true
			c.paths[d] = old
			changed++
		}
		c.checked[d] = now
		c.mu.Unlock()
	}
	if changed > 0 {
		c.mu.Lock()
		c.dirty = true
		c.mu.Unlock()
	}
	return changed
}

func (c *Cache) due(dirs []string, maxAge time.Duration, now time.Time) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	seen := map[string]bool{}
	var out []string
	for _, d := range dirs {
		if d == "" || !filepath.IsAbs(d) {
			continue
		}
		d = filepath.Clean(d)
		if seen[d] {
			continue
		}
		seen[d] = true
		if t, ok := c.checked[d]; ok && now.Sub(t) < maxAge {
			continue
		}
		out = append(out, d)
	}
	slices.Sort(out)
	return out
}

// Save writes the cache if it changed since it was loaded or last saved.
func (c *Cache) Save() error {
	c.mu.Lock()
	if !c.dirty {
		c.mu.Unlock()
		return nil
	}
	b, err := json.MarshalIndent(file{Version: 1, Paths: c.paths}, "", "  ")
	c.dirty = false
	c.mu.Unlock()
	if err != nil {
		return err
	}
	if err := store.WriteFileAtomic(c.path, append(b, '\n')); err != nil {
		c.mu.Lock()
		c.dirty = true
		c.mu.Unlock()
		return err
	}
	return nil
}
