package store

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/paths"
)

func newStore(t *testing.T) (*Store, *[]string) {
	t.Helper()
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var warns []string
	s.Warn = func(m string) { warns = append(warns, m) }
	return s, &warns
}

func digest(harness, key, id string) *model.SessionDigest {
	return &model.SessionDigest{
		SchemaVersion: 1, ParserVersion: 7,
		Source:  []model.SourceFile{{Path: "/a/b.jsonl", Size: 10, MtimeNs: 99}},
		Harness: harness, ID: id, ProjectKey: key, Project: "/work/x",
		Title:     "héllo \"quoted\"",
		StartedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
		Stats:     model.Stats{Turns: 2, ToolsByName: map[string]int64{"Bash": 3}},
		Cost:      model.Cost{},
		Turns:     []model.Turn{{Index: 0, UserText: "hi\nthere", FinalText: "ok"}},
		Messages:  []model.Message{{ID: "m1", Model: "x", USD: 0.5}},
	}
}

func TestRoundTrip(t *testing.T) {
	s, warns := newStore(t)
	d := digest("h1", "-proj", "s1")
	if err := s.Write(d); err != nil {
		t.Fatal(err)
	}
	got, found, err := s.Read(RefOf(d))
	if err != nil || !found {
		t.Fatalf("found=%v err=%v", found, err)
	}
	if !reflect.DeepEqual(got, d) {
		t.Fatalf("round trip differs:\n%+v\n%+v", got, d)
	}
	if _, found, err := s.Read(Ref{"h1", "-proj", "nope"}); found || err != nil {
		t.Fatalf("missing: found=%v err=%v", found, err)
	}
	if len(*warns) != 0 {
		t.Fatalf("warnings: %v", *warns)
	}
}

func TestUnparseableIsNotFoundWithWarning(t *testing.T) {
	s, warns := newStore(t)
	d := digest("h1", "k", "s1")
	if err := s.Write(d); err != nil {
		t.Fatal(err)
	}
	p, _ := s.Path(RefOf(d))
	full, _ := os.ReadFile(p)
	for name, content := range map[string][]byte{
		"truncated": full[:len(full)/2],
		"garbage":   []byte("\x00\xffnot json"),
		"empty":     {},
		"array":     []byte("[1,2]"),
	} {
		*warns = nil
		os.WriteFile(p, content, 0o644)
		if _, found, err := s.Read(RefOf(d)); found || err != nil {
			t.Errorf("%s Read: found=%v err=%v", name, found, err)
		}
		if len(*warns) != 1 {
			t.Errorf("%s Read: warnings %v", name, *warns)
		}
		*warns = nil
		if _, found, err := s.ReadHeader(RefOf(d)); (found && name != "truncated") || err != nil {
			t.Errorf("%s ReadHeader: found=%v err=%v", name, found, err)
		}
	}
	// A digest moved to another path does not answer for that path.
	os.WriteFile(p, full, 0o644)
	other := Ref{"h1", "k", "other"}
	op, _ := s.Path(other)
	os.WriteFile(op, full, 0o644)
	*warns = nil
	if _, found, _ := s.Read(other); found || len(*warns) != 1 {
		t.Errorf("identity mismatch: found=%v warns=%v", found, *warns)
	}
}

func TestReadHeader(t *testing.T) {
	s, _ := newStore(t)
	d := digest("h1", "k", "s1")
	d.SourceMissing = true
	d.Error = "boom"
	if err := s.Write(d); err != nil {
		t.Fatal(err)
	}
	h, found, err := s.ReadHeader(RefOf(d))
	if err != nil || !found {
		t.Fatal(found, err)
	}
	want := Header{SchemaVersion: 1, ParserVersion: 7, Source: d.Source, SourceMissing: true, Error: "boom"}
	if !reflect.DeepEqual(*h, want) {
		t.Fatalf("got %+v want %+v", *h, want)
	}
	if _, found, err := s.ReadHeader(Ref{"h1", "k", "none"}); found || err != nil {
		t.Fatal(found, err)
	}
}

// ReadHeader stops at "harness", so the header fields must be declared before it.
func TestHeaderFieldsComeFirst(t *testing.T) {
	d := digest("h", "k", "i")
	d.SourceMissing, d.Error = true, "e"
	b, _ := json.Marshal(d)
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.Token()
	var keys []string
	for dec.More() {
		tok, _ := dec.Token()
		keys = append(keys, tok.(string))
		if err := skipValue(dec); err != nil {
			t.Fatal(err)
		}
	}
	idx := map[string]int{}
	for i, k := range keys {
		idx[k] = i
	}
	for _, k := range []string{"schemaVersion", "parserVersion", "source", "sourceMissing", "error"} {
		if i, ok := idx[k]; !ok || i > idx["harness"] {
			t.Errorf("%q must precede \"harness\" in model.SessionDigest", k)
		}
	}
}

func TestSkipValueNested(t *testing.T) {
	h, err := decodeHeader(json.NewDecoder(strings.NewReader(
		`{"a":{"b":[1,{"c":[]}]},"schemaVersion":3,"z":[[],{}],"parserVersion":4,"unknown":"x"}`)))
	if err != nil || h.SchemaVersion != 3 || h.ParserVersion != 4 {
		t.Fatalf("%+v %v", h, err)
	}
}

func TestMarkSourceMissingPreservesEverything(t *testing.T) {
	s, _ := newStore(t)
	d := digest("h1", "k", "s1")
	s.Write(d)
	ok, err := s.MarkSourceMissing(RefOf(d))
	if !ok || err != nil {
		t.Fatal(ok, err)
	}
	got, _, _ := s.Read(RefOf(d))
	if !got.SourceMissing {
		t.Fatal("flag not set")
	}
	got.SourceMissing = false
	if !reflect.DeepEqual(got, d) {
		t.Fatalf("fields changed:\n%+v\n%+v", got, d)
	}
	if ok, err := s.MarkSourceMissing(Ref{"h1", "k", "none"}); ok || err != nil {
		t.Fatal(ok, err)
	}
}

func TestErrorStub(t *testing.T) {
	s, _ := newStore(t)
	r := Ref{"h1", "k", "bad"}
	src := []model.SourceFile{{Path: "p", Size: 1, MtimeNs: 2}}
	if err := s.Write(ErrorStub(r, 1, 2, src, "parse failed")); err != nil {
		t.Fatal(err)
	}
	h, found, _ := s.ReadHeader(r)
	if !found || h.Error != "parse failed" || !reflect.DeepEqual(h.Source, src) || h.ParserVersion != 2 {
		t.Fatalf("%+v", h)
	}
	d, found, _ := s.Read(r)
	if !found || d.Error != "parse failed" || d.Key() != (model.SessionKey{Harness: "h1", ID: "bad"}) {
		t.Fatalf("%+v", d)
	}
}

func TestConcurrentWritersNeverTear(t *testing.T) {
	s, warns := newStore(t)
	r := Ref{"h1", "k", "s1"}
	mk := func(n int) *model.SessionDigest {
		d := digest("h1", "k", "s1")
		d.Title = strings.Repeat("x", 1000*(n+1))
		d.ParserVersion = n
		return d
	}
	s.Write(mk(0))
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				if err := s.Write(mk(w*100 + i)); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	var rd sync.WaitGroup
	rd.Add(1)
	go func() {
		defer rd.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			d, found, err := s.Read(r)
			if err != nil || !found || len(d.Title) != 1000*(d.ParserVersion+1) {
				t.Errorf("torn read: found=%v err=%v", found, err)
				return
			}
		}
	}()
	wg.Wait()
	close(stop)
	rd.Wait()
	if len(*warns) != 0 {
		t.Fatalf("warnings: %v", *warns)
	}
	ents, _ := os.ReadDir(filepath.Dir(mustPath(t, s, r)))
	if len(ents) != 1 {
		t.Fatalf("leftover files: %v", ents)
	}
}

func mustPath(t *testing.T, s *Store, r Ref) string {
	p, err := s.Path(r)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestNoTempFileOnError(t *testing.T) {
	s, _ := newStore(t)
	r := Ref{"h1", "k", "s1"}
	p := mustPath(t, s, r)
	// A directory where the file must go makes rename fail.
	os.MkdirAll(p, 0o755)
	os.WriteFile(filepath.Join(p, "keep"), nil, 0o644)
	if err := s.Write(digest("h1", "k", "s1")); err == nil {
		t.Fatal("expected error")
	}
	ents, _ := os.ReadDir(filepath.Dir(p))
	if len(ents) != 1 {
		t.Fatalf("temp file left behind: %v", ents)
	}
}

func TestListAcrossHarnesses(t *testing.T) {
	s, _ := newStore(t)
	var want []Ref
	for _, r := range []Ref{
		{"claude", "-a", "s1"}, {"claude", "-a", "s2"}, {"claude", "-b", "s3"}, {"codex", "p", "s1"},
	} {
		if err := s.Write(digest(r.Harness, r.ProjectKey, r.SessionID)); err != nil {
			t.Fatal(err)
		}
		want = append(want, r)
	}
	// Noise: stale temp file, foreign files, a directory, config at the root.
	sd := filepath.Dir(mustPath(t, s, want[0]))
	os.WriteFile(filepath.Join(sd, ".s1.json.123.tmp"), []byte("{"), 0o644)
	os.WriteFile(filepath.Join(sd, "notes.txt"), nil, 0o644)
	os.WriteFile(filepath.Join(sd, "s9.json.bak"), nil, 0o644)
	os.Mkdir(filepath.Join(sd, "dir.json"), 0o755)
	os.WriteFile(filepath.Join(s.Root(), "config.json"), nil, 0o644)
	os.MkdirAll(filepath.Join(s.Root(), "claude", "hooks"), 0o755)
	s.WriteProject("claude", "-a", map[string]int{"n": 2})

	got, err := s.List("")
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("all: %v %v", got, err)
	}
	got, _ = s.List("codex")
	if !reflect.DeepEqual(got, want[3:]) {
		t.Fatalf("codex: %v", got)
	}
	got, _ = s.List("pi")
	if len(got) != 0 {
		t.Fatalf("pi: %v", got)
	}
	keys, _ := s.ProjectKeys("claude")
	if !reflect.DeepEqual(keys, []string{"-a", "-b"}) {
		t.Fatalf("keys %v", keys)
	}
	empty, _ := New(filepath.Join(t.TempDir(), "absent"))
	if got, err := empty.List(""); len(got) != 0 || err != nil {
		t.Fatal(got, err)
	}
}

func TestInvalidNamesRejected(t *testing.T) {
	s, _ := newStore(t)
	bad := []string{"", ".", "..", "a/b", "../x", "a\\b", "/abs", ".hidden", "a\x00b", "a\nb"}
	for _, n := range bad {
		for i, r := range []Ref{{n, "k", "s"}, {"h", n, "s"}, {"h", "k", n}} {
			if _, _, err := s.Read(r); err == nil {
				t.Errorf("Read accepted %q in position %d", n, i)
			}
			if _, _, err := s.ReadHeader(r); err == nil {
				t.Errorf("ReadHeader accepted %q in position %d", n, i)
			}
			d := digest(r.Harness, r.ProjectKey, r.SessionID)
			if err := s.Write(d); err == nil {
				t.Errorf("Write accepted %q in position %d", n, i)
			}
			if _, err := s.MarkSourceMissing(r); err == nil {
				t.Errorf("MarkSourceMissing accepted %q in position %d", n, i)
			}
		}
		if err := s.WriteProject(n, "k", 1); err == nil {
			t.Errorf("WriteProject accepted harness %q", n)
		}
		if err := s.WriteProject("h", n, 1); err == nil {
			t.Errorf("WriteProject accepted key %q", n)
		}
		if _, err := s.ReadProject("h", n, new(int)); err == nil {
			t.Errorf("ReadProject accepted key %q", n)
		}
		if n != "" {
			if _, err := s.List(n); err == nil {
				t.Errorf("List accepted %q", n)
			}
		}
	}
	// Nothing escaped or was created.
	if ents, _ := os.ReadDir(s.Root()); len(ents) != 0 {
		t.Fatalf("root not empty: %v", ents)
	}
	for _, ok := range []string{"-Users-x-y", "0a1b-2c", "a.b", "claude"} {
		if !ValidName(ok) {
			t.Errorf("rejected %q", ok)
		}
	}
}

func TestProjectJSON(t *testing.T) {
	s, warns := newStore(t)
	type listing struct {
		Name     string
		Sessions []string
	}
	in := listing{"x", []string{"a", "b"}}
	var out listing
	if found, err := s.ReadProject("claude", "k", &out); found || err != nil {
		t.Fatal(found, err)
	}
	if err := s.WriteProject("claude", "k", in); err != nil {
		t.Fatal(err)
	}
	if found, err := s.ReadProject("claude", "k", &out); !found || err != nil || !reflect.DeepEqual(in, out) {
		t.Fatal(found, err, out)
	}
	os.WriteFile(filepath.Join(s.Root(), "claude", "projects", "k", "project.json"), []byte("{oops"), 0o644)
	if found, err := s.ReadProject("claude", "k", &out); found || err != nil || len(*warns) != 1 {
		t.Fatal(found, err, *warns)
	}
}

func TestExplorerHomeOverride(t *testing.T) {
	home := t.TempDir()
	t.Setenv("EXPLORER_HOME", home)
	root, err := paths.ExplorerHome()
	if err != nil {
		t.Fatal(err)
	}
	s, _ := New(root)
	if err := s.Write(digest("claude", "k", "s1")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "claude", "projects", "k", "sessions", "s1.json")); err != nil {
		t.Fatal(err)
	}
}

func TestNewRejectsEmptyRoot(t *testing.T) {
	if _, err := New(""); err == nil {
		t.Fatal("expected error")
	}
}

func TestReadHeaderRejectsTruncatedDigest(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var warned int
	s.Warn = func(string) { warned++ }
	d := &model.SessionDigest{SchemaVersion: 1, ParserVersion: 1, Harness: "claude", ProjectKey: "p", ID: "s1", Title: "kept whole"}
	if err := s.Write(d); err != nil {
		t.Fatal(err)
	}
	ref := RefOf(d)
	if _, found, err := s.ReadHeader(ref); err != nil || !found {
		t.Fatalf("intact digest: found=%v err=%v", found, err)
	}
	p, _ := s.Path(ref)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	// Cut the file after the header fields: the header still decodes, the tail is gone.
	if err := os.WriteFile(p, b[:len(b)/2], 0o644); err != nil {
		t.Fatal(err)
	}
	if _, found, err := s.ReadHeader(ref); err != nil || found {
		t.Fatalf("truncated digest: found=%v err=%v, want not found", found, err)
	}
	if err := os.WriteFile(p, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, found, err := s.ReadHeader(ref); err != nil || found {
		t.Fatalf("empty digest: found=%v err=%v, want not found", found, err)
	}
	if warned != 2 {
		t.Fatalf("warnings = %d, want 2", warned)
	}
}
