package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/terek/merlin/explorer/internal/model"
)

// Ref names one stored digest: <root>/<Harness>/projects/<ProjectKey>/sessions/<SessionID>.json.
type Ref struct {
	Harness    string
	ProjectKey string
	SessionID  string
}

// String returns "harness/projectKey/sessionID".
func (r Ref) String() string { return r.Harness + "/" + r.ProjectKey + "/" + r.SessionID }

// RefOf returns the Ref a digest is stored under.
func RefOf(d *model.SessionDigest) Ref {
	return Ref{Harness: d.Harness, ProjectKey: d.ProjectKey, SessionID: d.ID}
}

// Header is the part of a digest the engine needs to decide whether it is stale.
type Header struct {
	SchemaVersion int                `json:"schemaVersion"`
	ParserVersion int                `json:"parserVersion"`
	Source        []model.SourceFile `json:"source"`
	SourceMissing bool               `json:"sourceMissing,omitempty"`
	Error         string             `json:"error,omitempty"`
}

// Store reads and writes digest files under a root directory (the Explorer home).
// It never deletes digests. Safe for concurrent use.
type Store struct {
	root string

	// Warn, if non-nil, receives a message whenever a stored file is unreadable as a
	// digest and is treated as absent. Set it before the store is shared.
	Warn func(msg string)
}

// New returns a Store rooted at root. The directory is created on first write.
func New(root string) (*Store, error) {
	if root == "" {
		return nil, errors.New("store: empty root")
	}
	return &Store{root: filepath.Clean(root)}, nil
}

// Root returns the root directory.
func (s *Store) Root() string { return s.root }

// ValidName reports whether name is safe to use as one path element: non-empty, not
// "." or "..", no path separators or control characters, and not starting with "."
// (leading dots are reserved for temp files).
func ValidName(name string) bool {
	if name == "" || strings.HasPrefix(name, ".") {
		return false
	}
	for _, r := range name {
		if r == '/' || r == '\\' || r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func checkName(kind, name string) error {
	if !ValidName(name) {
		return fmt.Errorf("store: invalid %s %q", kind, name)
	}
	return nil
}

func (r Ref) validate() error {
	if err := checkName("harness", r.Harness); err != nil {
		return err
	}
	if err := checkName("project key", r.ProjectKey); err != nil {
		return err
	}
	return checkName("session id", r.SessionID)
}

func (s *Store) projectDir(harness, key string) (string, error) {
	if err := checkName("harness", harness); err != nil {
		return "", err
	}
	if err := checkName("project key", key); err != nil {
		return "", err
	}
	return filepath.Join(s.root, harness, "projects", key), nil
}

// Path returns the file a digest is stored in.
func (s *Store) Path(r Ref) (string, error) {
	if err := r.validate(); err != nil {
		return "", err
	}
	return filepath.Join(s.root, r.Harness, "projects", r.ProjectKey, "sessions", r.SessionID+".json"), nil
}

func (s *Store) warnf(format string, args ...any) {
	if s.Warn != nil {
		s.Warn(fmt.Sprintf(format, args...))
	}
}

// Write stores d atomically under its own (harness, projectKey, id). Readers see the
// old file or the new one, never a partial one.
func (s *Store) Write(d *model.SessionDigest) error {
	p, err := s.Path(RefOf(d))
	if err != nil {
		return err
	}
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return writeFileAtomic(p, b)
}

// Read loads a digest. A missing file is (nil, false, nil). A file that does not parse,
// or whose identity does not match its path, is also (nil, false, nil) plus a call to
// Warn. The error is reserved for invalid refs and I/O failures other than absence.
func (s *Store) Read(r Ref) (*model.SessionDigest, bool, error) {
	p, err := s.Path(r)
	if err != nil {
		return nil, false, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var d model.SessionDigest
	if err := json.Unmarshal(b, &d); err != nil {
		s.warnf("store: ignoring unreadable digest %s: %v", p, err)
		return nil, false, nil
	}
	if RefOf(&d) != r {
		s.warnf("store: ignoring digest %s: it describes %s", p, RefOf(&d))
		return nil, false, nil
	}
	return &d, true, nil
}

// ReadHeader loads only the staleness fields of a digest. It streams the file with a
// token decoder, skipping every other top-level value without building it, and stops at
// the first key after the header ("harness"). That relies on the header fields being
// declared first in model.SessionDigest, which a test guards. Because it stops early it
// does not notice damage later in the file; Read does. Missing and unparseable files
// behave as in Read.
func (s *Store) ReadHeader(r Ref) (*Header, bool, error) {
	p, err := s.Path(r)
	if err != nil {
		return nil, false, err
	}
	f, err := os.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	if !endsLikeJSONObject(f) {
		s.warnf("store: ignoring truncated digest %s", p)
		return nil, false, nil
	}
	h, err := decodeHeader(json.NewDecoder(f))
	if err != nil {
		s.warnf("store: ignoring unreadable digest %s: %v", p, err)
		return nil, false, nil
	}
	return h, true, nil
}

func decodeHeader(dec *json.Decoder) (*Header, error) {
	if t, err := dec.Token(); err != nil {
		return nil, err
	} else if d, ok := t.(json.Delim); !ok || d != '{' {
		return nil, errors.New("not a JSON object")
	}
	var h Header
	seenSchema := false
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := t.(string)
		var target any
		switch key {
		case "schemaVersion":
			target, seenSchema = &h.SchemaVersion, true
		case "parserVersion":
			target = &h.ParserVersion
		case "source":
			target = &h.Source
		case "sourceMissing":
			target = &h.SourceMissing
		case "error":
			target = &h.Error
		case "harness":
			if !seenSchema {
				return nil, errors.New("no schemaVersion")
			}
			return &h, nil
		}
		if target != nil {
			err = dec.Decode(target)
		} else {
			err = skipValue(dec)
		}
		if err != nil {
			return nil, err
		}
	}
	if !seenSchema {
		return nil, errors.New("no schemaVersion")
	}
	return &h, nil
}

// skipValue consumes one JSON value without retaining it.
func skipValue(dec *json.Decoder) error {
	t, err := dec.Token()
	if err != nil {
		return err
	}
	d, ok := t.(json.Delim)
	if !ok || d == '}' || d == ']' {
		return nil
	}
	for depth := 1; depth > 0; {
		t, err := dec.Token()
		if err != nil {
			return err
		}
		if d, ok := t.(json.Delim); ok {
			if d == '{' || d == '[' {
				depth++
			} else {
				depth--
			}
		}
	}
	return nil
}

// MarkSourceMissing sets sourceMissing on a stored digest and rewrites it atomically,
// leaving every other field as it was. It reports whether a digest was found. A digest
// already marked is not rewritten.
func (s *Store) MarkSourceMissing(r Ref) (bool, error) {
	d, found, err := s.Read(r)
	if err != nil || !found {
		return false, err
	}
	if d.SourceMissing {
		return true, nil
	}
	d.SourceMissing = true
	return true, s.Write(d)
}

// ErrorStub builds the digest written when building a session failed. It carries the
// source fingerprint and versions so the session is retried only when its files or the
// parser change.
func ErrorStub(r Ref, schemaVersion, parserVersion int, source []model.SourceFile, msg string) *model.SessionDigest {
	if msg == "" {
		msg = "unknown error"
	}
	return &model.SessionDigest{
		SchemaVersion: schemaVersion,
		ParserVersion: parserVersion,
		Source:        source,
		Error:         msg,
		Harness:       r.Harness,
		ID:            r.SessionID,
		ProjectKey:    r.ProjectKey,
	}
}

// List returns every stored digest of one harness, or of all harnesses when harness is
// empty, sorted by harness, project key and session id. Only regular files named
// <valid-id>.json directly under <project>/sessions count: temp files left by a crash
// (leading dot, .tmp suffix), directories and unrelated files are skipped.
func (s *Store) List(harness string) ([]Ref, error) {
	harnesses, err := s.harnesses(harness)
	if err != nil {
		return nil, err
	}
	var out []Ref
	for _, h := range harnesses {
		keys, err := s.ProjectKeys(h)
		if err != nil {
			return nil, err
		}
		for _, k := range keys {
			dir := filepath.Join(s.root, h, "projects", k, "sessions")
			ents, err := os.ReadDir(dir)
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, err
			}
			for _, e := range ents {
				id, ok := strings.CutSuffix(e.Name(), ".json")
				if !ok || !ValidName(id) || !e.Type().IsRegular() {
					continue
				}
				out = append(out, Ref{Harness: h, ProjectKey: k, SessionID: id})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Harness != b.Harness {
			return a.Harness < b.Harness
		}
		if a.ProjectKey != b.ProjectKey {
			return a.ProjectKey < b.ProjectKey
		}
		return a.SessionID < b.SessionID
	})
	return out, nil
}

// harnesses returns the harness directories to walk.
func (s *Store) harnesses(harness string) ([]string, error) {
	if harness != "" {
		if err := checkName("harness", harness); err != nil {
			return nil, err
		}
		return []string{harness}, nil
	}
	ents, err := os.ReadDir(s.root)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		if e.IsDir() && ValidName(e.Name()) {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

// ProjectKeys returns the project directories of one harness, sorted.
func (s *Store) ProjectKeys(harness string) ([]string, error) {
	if err := checkName("harness", harness); err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(filepath.Join(s.root, harness, "projects"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		if e.IsDir() && ValidName(e.Name()) {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

// WriteProject atomically writes v as <harness>/projects/<key>/project.json. The store
// does not interpret v: the catalog owns its shape.
func (s *Store) WriteProject(harness, projectKey string, v any) error {
	dir, err := s.projectDir(harness, projectKey)
	if err != nil {
		return err
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(dir, "project.json"), b)
}

// ReadProject decodes project.json into v. Missing, or unparseable (with a Warn call),
// gives found == false.
func (s *Store) ReadProject(harness, projectKey string, v any) (bool, error) {
	dir, err := s.projectDir(harness, projectKey)
	if err != nil {
		return false, err
	}
	p := filepath.Join(dir, "project.json")
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(b, v); err != nil {
		s.warnf("store: ignoring unreadable project listing %s: %v", p, err)
		return false, nil
	}
	return true, nil
}

// writeFileAtomic writes b to path via a temp file in the same directory, then renames it
// into place. The temp file is removed on any error.
//
// There is deliberately no fsync. The rename alone guarantees that a killed or crashed
// process leaves either the old file or the new one. fsync would only add protection
// against power loss, at ~5 ms per file on macOS (17 s instead of 2 s for a first scan of
// 3,355 sessions), and a digest lost or torn that way is simply rebuilt: digests are
// derived data, Read rejects a file that does not parse, and ReadHeader rejects one that
// is cut short.
func writeFileAtomic(path string, b []byte) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			f.Close()
			os.Remove(tmp)
		}
	}()
	if _, err = f.Write(b); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Chmod(tmp, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// endsLikeJSONObject reports whether the file's last non-blank byte is '}'. A digest cut
// short or zero-filled by a power loss fails this cheap check.
func endsLikeJSONObject(f *os.File) bool {
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return false
	}
	n := min(st.Size(), 64)
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, st.Size()-n); err != nil {
		return false
	}
	t := bytes.TrimRight(buf, " \t\r\n")
	return len(t) > 0 && t[len(t)-1] == '}'
}
