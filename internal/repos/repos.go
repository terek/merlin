// Package repos resolves a directory to the git checkout, repository (common dir), remote and
// beads database it belongs to, and keeps the answers in <MERLIN_HOME>/repos.json so that a
// directory that is later deleted (a removed worktree) still resolves. It reads files only and
// never runs git or bd. Harness-neutral. Design: docs/location.md §2, §3, §5; beads:
// docs/beads-and-repos.md.
package repos

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/terek/merlin/internal/store"
)

// Repo is where a directory sits in git and beads. The zero Repo means "not in a repository
// and no beads database".
type Repo struct {
	Checkout     string `json:"checkout,omitempty"`     // top of the working tree; none in a bare repository
	GitCommonDir string `json:"gitCommonDir,omitempty"` // the object store: the canonical git common dir
	Worktree     bool   `json:"worktree,omitempty"`     // Checkout is a linked worktree of GitCommonDir
	Remote       string `json:"remote,omitempty"`       // the normalised origin URL
	Beads        string `json:"beads,omitempty"`        // the .beads directory bd uses from here
	Gone         bool   `json:"gone,omitempty"`         // the directory no longer exists; this is the last answer seen
	Inferred     bool   `json:"inferred,omitempty"`     // worked out from recorded siblings or ancestors, not read
}

// Name is the display name of a repository, from its common dir: the base name; when that is
// .git or .bare, its parent's; a .git suffix stripped. A pure function of the path.
func Name(common string) string {
	if common == "" {
		return ""
	}
	b := filepath.Base(common)
	if b == ".git" || b == ".bare" {
		b = filepath.Base(filepath.Dir(common))
	}
	if t := strings.TrimSuffix(b, ".git"); t != "" {
		b = t
	}
	return b
}

// Resolve looks dir up on disk. ok is false when dir does not exist.
func Resolve(dir string) (r Repo, ok bool) {
	dir = filepath.Clean(dir)
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return Repo{}, false
	}
	walk := dir
	if p, err := filepath.EvalSymlinks(dir); err == nil {
		walk = p
	}
	r, main := find(walk)
	r.Beads = beadsDir(dir, main)
	return r, true
}

// find walks up from dir (§3). main is the main repository's directory for a worktree found
// through commondir, as the beads lookup has always computed it (not canonicalised), else "".
func find(dir string) (r Repo, main string) {
	for d := dir; ; d = filepath.Dir(d) {
		if r, main, ok := at(d); ok {
			return r, main
		}
		if filepath.Dir(d) == d {
			return Repo{}, ""
		}
	}
}

func at(d string) (r Repo, main string, ok bool) {
	gitPath := filepath.Join(d, ".git")
	if _, err := os.Lstat(gitPath); err != nil {
		// No .git entry: a bare repository, or somewhere inside a store.
		if filepath.Base(d) != ".git" && isDir(d) && exists(filepath.Join(d, "HEAD")) &&
			isDir(filepath.Join(d, "objects")) && isDir(filepath.Join(d, "refs")) {
			return Repo{GitCommonDir: canon(d), Remote: remoteOf(d)}, "", true
		}
		return Repo{}, "", false
	}
	st, err := os.Stat(gitPath)
	if err != nil {
		return Repo{}, "", false
	}
	if st.IsDir() {
		if !exists(filepath.Join(gitPath, "HEAD")) {
			return Repo{}, "", false
		}
		r = Repo{GitCommonDir: canon(gitPath), Remote: remoteOf(gitPath)}
		if !isBare(gitPath) {
			r.Checkout = canon(d)
		}
		return r, "", true
	}
	x := readGitdir(gitPath)
	if x == "" {
		return Repo{}, "", false
	}
	if !filepath.IsAbs(x) {
		x = filepath.Join(d, x)
	}
	x = filepath.Clean(x)
	if b, err := os.ReadFile(filepath.Join(x, "commondir")); err == nil {
		c := strings.TrimSpace(string(b))
		if !filepath.IsAbs(c) {
			c = filepath.Join(x, c)
		}
		c = filepath.Clean(c)
		main = c
		if filepath.Base(c) == ".git" {
			main = filepath.Dir(c)
		}
		return Repo{Checkout: canon(d), GitCommonDir: canon(c), Worktree: true, Remote: remoteOf(c)}, main, true
	}
	if isDir(x) {
		r = Repo{GitCommonDir: canon(x), Remote: remoteOf(x)}
		if !isBare(x) {
			r.Checkout = canon(d)
		}
		return r, "", true
	}
	// The git directory is gone. A linked worktree names <Y>/worktrees/<n>.
	r = Repo{Checkout: canon(d)}
	if wt := filepath.Dir(x); filepath.Base(wt) == "worktrees" {
		r.GitCommonDir = canon(filepath.Dir(wt))
		r.Worktree = true
	}
	return r, "", true
}

func canon(p string) string {
	if c, err := filepath.EvalSymlinks(p); err == nil {
		return c
	}
	return filepath.Clean(p)
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func isDir(p string) bool { st, err := os.Stat(p); return err == nil && st.IsDir() }

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

// isBare is core.bare = true in the git directory's own config.
func isBare(gitDir string) bool {
	bare := false
	for _, e := range readConfig(filepath.Join(gitDir, "config")) {
		if e.section == "core" && e.key == "bare" {
			bare = truthy(e)
		}
	}
	return bare
}

func truthy(e configEntry) bool {
	if !e.hasValue {
		return true
	}
	switch strings.ToLower(e.value) {
	case "true", "yes", "on", "1":
		return true
	}
	return false
}

// remoteOf is the normalised origin URL of the repository whose common dir is common.
func remoteOf(common string) string {
	for _, e := range readConfig(filepath.Join(common, "config")) {
		if e.section == "remote" && e.sub == "origin" && e.key == "url" && e.hasValue {
			return normalizeIn(e.value, filepath.Dir(common))
		}
	}
	return ""
}

// ---- git config -----------------------------------------------------------------------------

type configEntry struct {
	section  string // lower-cased
	sub      string // as written
	key      string // lower-cased
	value    string
	hasValue bool
}

// readConfig parses a git config file read whole. Unparseable lines are skipped.
func readConfig(path string) []configEntry {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []configEntry
	section, sub := "", ""
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		if line[0] == '[' {
			var rest string
			var ok bool
			section, sub, rest, ok = parseHeader(line)
			if !ok {
				section, sub = "", ""
				continue
			}
			line = strings.TrimSpace(rest)
			if line == "" || line[0] == '#' || line[0] == ';' {
				continue
			}
		}
		if section == "" {
			continue
		}
		e := configEntry{section: section, sub: sub}
		k, v, has := strings.Cut(line, "=")
		e.key = strings.ToLower(strings.TrimSpace(k))
		if !has {
			// A bare key is true; strip a trailing comment.
			e.key = strings.ToLower(strings.TrimSpace(stripValue(k)))
		} else {
			e.value, e.hasValue = stripValue(v), true
		}
		if e.key == "" {
			continue
		}
		out = append(out, e)
	}
	return out
}

// parseHeader reads `[section]`, `[section "sub"]` or `[section.sub]` (the old form, subsection
// lower-cased by git); rest is what follows the closing bracket.
func parseHeader(line string) (section, sub, rest string, ok bool) {
	body := line[1:]
	if i := strings.IndexAny(body, " \t\"]"); i >= 0 {
		section = body[:i]
		body = body[i:]
	} else {
		return "", "", "", false
	}
	section = strings.ToLower(section)
	body = strings.TrimLeft(body, " \t")
	if strings.HasPrefix(body, "\"") {
		var sb strings.Builder
		i := 1
		for ; i < len(body); i++ {
			c := body[i]
			if c == '\\' && i+1 < len(body) {
				i++
				sb.WriteByte(body[i])
				continue
			}
			if c == '"' {
				break
			}
			sb.WriteByte(c)
		}
		if i >= len(body) {
			return "", "", "", false
		}
		sub = sb.String()
		body = strings.TrimLeft(body[i+1:], " \t")
	}
	if !strings.HasPrefix(body, "]") {
		return "", "", "", false
	}
	if before, after, found := strings.Cut(section, "."); found {
		section, sub = before, after
	}
	return section, sub, body[1:], true
}

// stripValue trims a value, removes an inline comment outside quotes and the quotes themselves.
func stripValue(v string) string {
	var sb strings.Builder
	inQ := false
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch {
		case c == '\\' && i+1 < len(v):
			i++
			switch v[i] {
			case 'n':
				sb.WriteByte('\n')
			case 't':
				sb.WriteByte('\t')
			case 'b':
				sb.WriteByte('\b')
			default:
				sb.WriteByte(v[i])
			}
		case c == '"':
			inQ = !inQ
		case !inQ && (c == '#' || c == ';'):
			return strings.TrimSpace(sb.String())
		default:
			sb.WriteByte(c)
		}
	}
	return strings.TrimSpace(sb.String())
}

// ---- remotes --------------------------------------------------------------------------------

// NormalizeRemote reduces an origin URL to host/path form: scheme, user, password, a default
// port, a trailing "/" and ".git" are dropped, the host is lower-cased and the path keeps its
// case. A local path stays a path. Credentials, query and fragment never survive. It is not
// idempotent for a remote with a port ("h:2222/a" reads as scp syntax), so apply it once, to
// what git wrote, never to a stored value.
func NormalizeRemote(raw string) string { return normalizeIn(raw, "") }

// normalizeIn is NormalizeRemote with relative local paths resolved against base.
func normalizeIn(raw, base string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var out string
	switch scheme, rest, ok := strings.Cut(raw, "://"); {
	case ok && strings.EqualFold(scheme, "file"):
		rest = beforeQuery(rest)
		// file:///srv/x or file://host/srv/x: the path.
		if i := strings.Index(rest, "/"); i > 0 {
			rest = rest[i:]
		}
		out = localPath(rest, base)
	case ok:
		// The authority ends at the first of / ? #; a query or fragment is dropped.
		out = hostPath(strings.ToLower(scheme), beforeQuery(rest))
	case isScp(raw):
		host, path, _ := strings.Cut(raw, ":")
		host = userless(host)
		out = strings.ToLower(host) + "/" + strings.TrimLeft(path, "/")
	default:
		out = localPath(raw, base)
	}
	return trimRemote(out)
}

func beforeQuery(s string) string {
	if i := strings.IndexAny(s, "?#"); i >= 0 {
		return s[:i]
	}
	return s
}

func isScp(s string) bool {
	if strings.HasPrefix(s, "/") || strings.HasPrefix(s, ".") {
		return false
	}
	colon := strings.Index(s, ":")
	slash := strings.Index(s, "/")
	return colon > 0 && (slash < 0 || colon < slash)
}

// userless drops "user[:password]@".
func userless(authority string) string {
	if i := strings.LastIndex(authority, "@"); i >= 0 {
		return authority[i+1:]
	}
	return authority
}

func hostPath(scheme, rest string) string {
	authority, path := rest, ""
	if i := strings.Index(rest, "/"); i >= 0 {
		authority, path = rest[:i], rest[i:]
	}
	host := strings.ToLower(userless(authority))
	if i := strings.LastIndex(host, ":"); i >= 0 && !strings.HasSuffix(host, "]") {
		port := host[i+1:]
		def := map[string]string{"ssh": "22", "https": "443", "http": "80"}[scheme]
		if port == "" || port == def {
			host = host[:i]
		}
	}
	return host + path
}

func localPath(p, base string) string {
	if !filepath.IsAbs(p) && base != "" {
		p = filepath.Join(base, p)
	}
	if p == "" {
		return ""
	}
	return filepath.Clean(p)
}

func trimRemote(s string) string {
	for {
		t := strings.TrimRight(s, "/")
		t = strings.TrimSuffix(t, ".git")
		if t == s {
			break
		}
		s = t
	}
	if s == "" {
		return "/"
	}
	return s
}

// ---- beads ----------------------------------------------------------------------------------

// beadsDir is the .beads directory bd uses from dir. A linked worktree shares its main
// repository's database (its own .beads holds a checked-out copy of the export), so the main
// repository's (main, non-empty for a worktree found through commondir) comes first; otherwise
// the nearest .beads with a metadata.json walking up. A .beads/redirect file names another
// .beads directory.
func beadsDir(dir, main string) string {
	if main != "" {
		if b := beadsAt(main); b != "" {
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

// Version is the current version of the cache file.
const Version = 2

type file struct {
	Version int             `json:"version"`
	Paths   map[string]Repo `json:"paths"`
}

// repoV1 is an entry of a version 1 file.
type repoV1 struct {
	Top      string `json:"top"`
	Repo     string `json:"repo"`
	Worktree bool   `json:"worktree"`
	Remote   string `json:"remote"`
	Beads    string `json:"beads"`
	Gone     bool   `json:"gone"`
}

// migrate maps a version 1 entry (§5): top becomes checkout, repo becomes the common dir
// (repo itself when it is named .bare, ends in .git or has a HEAD, else repo/.git), and the
// remote is normalised.
func (o repoV1) migrate() Repo {
	r := Repo{Checkout: o.Top, Worktree: o.Worktree, Beads: o.Beads, Gone: o.Gone}
	if o.Repo != "" {
		r.GitCommonDir = filepath.Join(o.Repo, ".git")
		if b := filepath.Base(o.Repo); b == ".bare" || strings.HasSuffix(b, ".git") || exists(filepath.Join(o.Repo, "HEAD")) {
			r.GitCommonDir = o.Repo
		}
	}
	r.Remote = normalizeIn(o.Remote, filepath.Dir(r.GitCommonDir))
	return r
}

// Cache holds resolved directories. It is safe for concurrent use.
type Cache struct {
	path string

	mu      sync.Mutex
	paths   map[string]Repo
	checked map[string]time.Time // when each directory was last looked at in this process
	dirty   bool
}

// Open loads <home>/repos.json; a missing or unreadable file gives an empty cache. A version 1
// file is migrated and counts as changed, so the next Save writes version 2.
func Open(home string) *Cache {
	c := &Cache{path: filepath.Join(home, FileName), paths: map[string]Repo{}, checked: map[string]time.Time{}}
	b, err := os.ReadFile(c.path)
	if err != nil {
		return c
	}
	var raw struct {
		Version int                        `json:"version"`
		Paths   map[string]json.RawMessage `json:"paths"`
	}
	if json.Unmarshal(b, &raw) != nil || raw.Paths == nil {
		return c
	}
	switch {
	case raw.Version == Version:
		for k, m := range raw.Paths {
			var r Repo
			if json.Unmarshal(m, &r) == nil {
				c.paths[k] = r
			}
		}
	case raw.Version <= 1:
		for k, m := range raw.Paths {
			var o repoV1
			if json.Unmarshal(m, &o) == nil {
				c.paths[k] = o.migrate()
			}
		}
		c.dirty = true
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
	// Pass 1: what is on disk. Directories that are gone and have no real answer are left
	// for pass 2, so that the evidence of this refresh counts wherever a directory sorts.
	var gone []string
	for _, d := range todo {
		r, ok := Resolve(d)
		c.mu.Lock()
		old, had := c.paths[d]
		switch {
		case ok && (!had || old != r):
			c.paths[d] = r
			changed++
		case !ok && had && !old.Inferred:
			if !old.Gone {
				old.Gone = true
				c.paths[d] = old
				changed++
			}
		case !ok:
			gone = append(gone, d)
		}
		c.checked[d] = now
		c.mu.Unlock()
	}
	changed += c.inferGone(gone)
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
	// Recorded real entries that are not gone are looked at too: a checkout recorded only
	// because a gone directory was inferred from it is named by no session.
	all := slices.Clone(dirs)
	for k, r := range c.paths {
		if !r.Gone && !r.Inferred {
			all = append(all, k)
		}
	}
	for _, d := range all {
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
	b, err := json.MarshalIndent(file{Version: Version, Paths: c.paths}, "", "  ")
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

// ---- gone directories (docs/location.md §4) --------------------------------------------------

// evidence is what real (not inferred) entries say about checkouts. Built once per refresh.
type evidence struct {
	byCheckout map[string]Repo   // first entry, in key order, for each checkout
	byParent   map[string][]Repo // checkouts directly under a directory, sorted by checkout
}

func buildEvidence(paths map[string]Repo, live map[string]Repo) evidence {
	e := evidence{byCheckout: map[string]Repo{}, byParent: map[string][]Repo{}}
	add := func(r Repo) {
		if r.Checkout == "" || r.Inferred {
			return
		}
		if _, dup := e.byCheckout[r.Checkout]; dup {
			return
		}
		e.byCheckout[r.Checkout] = r
		p := filepath.Dir(r.Checkout)
		e.byParent[p] = append(e.byParent[p], r)
	}
	for _, k := range slices.Sorted(maps.Keys(paths)) {
		add(paths[k])
	}
	for _, k := range slices.Sorted(maps.Keys(live)) {
		add(live[k])
	}
	for _, l := range e.byParent {
		slices.SortFunc(l, func(a, b Repo) int { return strings.Compare(a.Checkout, b.Checkout) })
	}
	return e
}

// anchor is the nearest existing ancestor of a gone directory and what is on disk there.
type anchor struct {
	canon string // P with symlinks resolved
	repo  Repo   // what P resolves to (without beads)
}

type inferred struct {
	repo Repo
	live string // the live checkout the answer came from, whose own entry is recorded
}

// inferGone works out the gone directories that have no real answer: from sibling worktrees,
// else from the deeper of a recorded checkout above and the live ancestor on disk. An entry
// that infers nothing any more is removed. It returns how many entries changed.
func (c *Cache) inferGone(gone []string) int {
	if len(gone) == 0 {
		return 0
	}
	c.mu.Lock()
	paths := maps.Clone(c.paths)
	c.mu.Unlock()

	anchors := map[string]*anchor{}
	liveReal := map[string]Repo{} // live checkouts that were looked at
	answers := map[string]inferred{}
	// A live checkout recorded because of one answer is evidence for the others; repeat until
	// no new one appears (a few rounds at most) so a second refresh finds nothing to change.
	live := map[string]Repo{}
	for round := 0; round < 4; round++ {
		ev := buildEvidence(paths, live)
		answers = map[string]inferred{}
		grew := false
		for _, d := range gone {
			a, ok := inferOne(d, ev, anchors)
			if !ok {
				continue
			}
			answers[d] = a
			if a.live == "" {
				continue
			}
			if _, known := ev.byCheckout[a.live]; known {
				continue
			}
			r, ok := liveReal[a.live]
			if !ok {
				r, _ = Resolve(a.live)
				liveReal[a.live] = r
			}
			live[a.live] = r
			grew = true
		}
		if !grew {
			break
		}
	}

	// Resolve each distinct live checkout once, before taking the lock.
	for _, a := range answers {
		if _, ok := liveReal[a.live]; a.live != "" && !ok {
			liveReal[a.live], _ = Resolve(a.live)
		}
	}

	changed := 0
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, d := range gone {
		old, had := c.paths[d]
		a, ok := answers[d]
		switch {
		case ok && (!had || old != a.repo):
			c.paths[d] = a.repo
			changed++
		case !ok && had && old.Inferred:
			delete(c.paths, d)
			changed++
		}
	}
	for _, d := range gone {
		a, ok := answers[d]
		if !ok || a.live == "" {
			continue
		}
		r := liveReal[a.live]
		if old, had := c.paths[a.live]; !had || old != r {
			c.paths[a.live] = r
			changed++
		}
	}
	return changed
}

// inferOne answers for one gone directory d from the evidence.
func inferOne(d string, ev evidence, anchors map[string]*anchor) (inferred, bool) {
	p := filepath.Dir(d)
	for !isDir(p) && filepath.Dir(p) != p {
		p = filepath.Dir(p)
	}
	an := anchors[p]
	if an == nil {
		an = &anchor{canon: canon(p)}
		an.repo, _ = find(an.canon)
		anchors[p] = an
	}
	rel, err := filepath.Rel(p, d)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return inferred{}, false
	}
	cd := filepath.Join(an.canon, rel)
	name, _, _ := strings.Cut(rel, string(filepath.Separator))

	// 1. Sibling worktrees: all checkouts directly under P are linked worktrees of one repository.
	if sibs := ev.byParent[an.canon]; len(sibs) > 0 {
		one := sibs[0].GitCommonDir != ""
		remote := ""
		for _, s := range sibs {
			if !s.Worktree || s.GitCommonDir != sibs[0].GitCommonDir {
				one = false
				break
			}
			if remote == "" {
				remote = s.Remote
			}
		}
		if one {
			return inferred{repo: Repo{Checkout: filepath.Join(an.canon, name), GitCommonDir: sibs[0].GitCommonDir,
				Worktree: true, Remote: remote, Gone: true, Inferred: true}}, true
		}
	}

	// 2. Ancestor: the deeper of the longest recorded checkout above d and the live one at P.
	var pre Repo
	for a := cd; ; a = filepath.Dir(a) {
		if r, ok := ev.byCheckout[a]; ok {
			pre = r
			break
		}
		if filepath.Dir(a) == a {
			break
		}
	}
	lc := an.repo.Checkout
	if lc != "" && len(lc) >= len(pre.Checkout) {
		r := an.repo
		return inferred{repo: Repo{Checkout: lc, GitCommonDir: r.GitCommonDir, Worktree: r.Worktree,
			Remote: r.Remote, Gone: true, Inferred: true}, live: lc}, true
	}
	if pre.Checkout != "" {
		return inferred{repo: Repo{Checkout: pre.Checkout, GitCommonDir: pre.GitCommonDir, Worktree: pre.Worktree,
			Remote: pre.Remote, Gone: true, Inferred: true}}, true
	}
	if an.repo.GitCommonDir != "" {
		return inferred{repo: Repo{GitCommonDir: an.repo.GitCommonDir, Remote: an.repo.Remote, Gone: true, Inferred: true}}, true
	}
	return inferred{}, false
}
