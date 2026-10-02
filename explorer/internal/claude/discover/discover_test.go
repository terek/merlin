package discover

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/fixtures"
)

func scanFixtures(t *testing.T) Result {
	t.Helper()
	res, err := Scan(filepath.Join(fixtures.ClaudeDir(), "projects"))
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestScanFixtures(t *testing.T) {
	const p = "-home-dev-acme-"
	type want struct {
		project, id string
		main        bool
		agents      []string
	}
	u := func(sc, v string) string { return sc + sc + sc + sc + "-0000-4000-8000-" + v }
	v1 := "000000000001"
	table := []want{
		{p + "coststate", u("16", v1), true, []string{"a16e0c0de0000001"}},
		{p + "cwdchange", u("18", v1), true, nil},
		{p + "daybound", u("19", v1), true, nil},
		{p + "fork", u("10", v1), true, []string{"a10e0c0de0000001", "a10e0c0de0000002", "a10e0c0de0000003"}},
		{p + "hostile", u("17", v1), true, nil},
		{p + "interrupt", u("04", v1), true, nil},
		{p + "linkage", u("11", v1), true, []string{"a11e0c0de0000001", "a11e0c0de0000002", "a11e0c0de0000003"}},
		{p + "misc", u("21", v1), true, nil},
		{p + "multi-line", u("02", v1), true, nil},
		{p + "nest", u("22", v1), true, nil},
		{p + "nest", u("22", "000000000002"), true, []string{"a22e0c0de0000001"}}, // inner project dir
		{p + "orphan", u("12", v1), false, []string{"a12e0c0de0000001", "a1b2c3d", "acompact-12e0c0de"}},
		{p + "plain", u("01", v1), true, nil},
		{p + "pricing", u("20", v1), true, nil},
		{p + "rewind", u("14", v1), true, nil},
		{p + "s05-compaction", u("05", "000000000001"), true, nil},
		{p + "s05-compaction", u("05", "000000000002"), true, nil},
		{p + "s05-compaction", u("05", "000000000003"), true, nil},
		{p + "s05-compaction", u("05", "000000000004"), true, []string{"a05e0c0de0000001"}},
		{p + "s13a-continuation", u("13", "000000000001"), true, nil},
		{p + "s13a-continuation", u("13", "000000000002"), true, nil},
		{p + "s13b-fork-unmarked", u("13", "000000000003"), true, nil},
		{p + "s13b-fork-unmarked", u("13", "000000000004"), true, nil},
		{p + "s13c-fork-marked", u("13", "000000000005"), true, nil},
		{p + "s13c-fork-marked", u("13", "000000000006"), true, nil},
		{p + "s13d-partial-copy", u("13", "000000000007"), true, nil},
		{p + "s13d-partial-copy", u("13", "000000000008"), true, nil},
		{p + "s13e-sdk-pickup", u("13", "000000000009"), true, nil},
		{p + "s13e-sdk-pickup", u("13", "000000000010"), true, nil},
		{p + "sdk", u("15", v1), true, nil},
		{p + "slash", u("03", v1), true, nil},
		{p + "subbg", u("07", v1), true, []string{"a07e0c0de0000001"}},
		{p + "subnest", u("08", v1), true, []string{"a08e0c0de0000001", "a08e0c0de0000002"}},
		{p + "subsync", u("06", v1), true, []string{"a06e0c0de0000001"}},
		{p + "team", u("09", v1), true, []string{"areviewer-09e0c0de00000001"}},
	}
	res := scanFixtures(t)
	if len(res.Warnings) != 0 {
		t.Errorf("warnings: %v", res.Warnings)
	}
	if len(res.Sessions) != len(table) {
		for _, s := range res.Sessions {
			t.Logf("got %s %s main=%v agents=%d", s.ProjectKey, s.ID, s.Main != "", len(s.Agents))
		}
		t.Fatalf("got %d sessions, want %d", len(res.Sessions), len(table))
	}
	for _, w := range table {
		var found *Source
		for i := range res.Sessions {
			if s := &res.Sessions[i]; s.ID == w.id && s.ProjectKey == w.project {
				found = s
			}
		}
		if found == nil {
			t.Errorf("missing %s/%s", w.project, w.id)
			continue
		}
		if (found.Main != "") != w.main {
			t.Errorf("%s: main present = %v, want %v", w.id, found.Main != "", w.main)
		}
		var ids []string
		files := 0
		for _, a := range found.Agents {
			ids = append(ids, a.ID)
			files++
			if a.MetaPath != "" {
				files++
			}
		}
		if len(ids) != len(w.agents) {
			t.Errorf("%s: agents %v, want %v", w.id, ids, w.agents)
		} else {
			for i := range ids {
				if ids[i] != w.agents[i] {
					t.Errorf("%s: agents %v, want %v", w.id, ids, w.agents)
				}
			}
		}
		if found.Main != "" {
			files++
		}
		if len(found.Fingerprint) != files {
			t.Errorf("%s: fingerprint has %d files, want %d", w.id, len(found.Fingerprint), files)
		}
	}
}

func TestScanOrderedAndDeterministic(t *testing.T) {
	a, b := scanFixtures(t), scanFixtures(t)
	if len(a.Sessions) != len(b.Sessions) {
		t.Fatal("scans differ in length")
	}
	for i := range a.Sessions {
		if !a.Sessions[i].Fingerprint.Equal(b.Sessions[i].Fingerprint) || a.Sessions[i].Fingerprint.String() != b.Sessions[i].Fingerprint.String() {
			t.Errorf("session %d fingerprint differs between scans", i)
		}
		fp := a.Sessions[i].Fingerprint
		for j := 1; j < len(fp); j++ {
			if fp[j-1].Path >= fp[j].Path {
				t.Errorf("fingerprint not sorted: %s, %s", fp[j-1].Path, fp[j].Path)
			}
		}
	}
}

func TestOrphanAndNested(t *testing.T) {
	res := scanFixtures(t)
	for _, s := range res.Sessions {
		switch s.ID {
		case "12121212-0000-4000-8000-000000000001":
			if s.Main != "" || len(s.Agents) != 3 {
				t.Errorf("orphan: %+v", s)
			}
			for _, a := range s.Agents {
				if a.ID == "a1b2c3d" && a.MetaPath != "" {
					t.Errorf("a1b2c3d has no meta file, got %s", a.MetaPath)
				}
			}
		case "22222222-0000-4000-8000-000000000002":
			if s.ProjectKey != "-home-dev-acme-nest" {
				t.Errorf("nested project key = %s", s.ProjectKey)
			}
		}
	}
}

// copyTree copies the fixture projects dir into a temp dir.
func copyTree(t *testing.T) string {
	t.Helper()
	src := filepath.Join(fixtures.ClaudeDir(), "projects")
	dst := filepath.Join(t.TempDir(), "projects")
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, rel), data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

func find(t *testing.T, dir, id string) Source {
	t.Helper()
	res, err := Scan(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range res.Sessions {
		if s.ID == id {
			return s
		}
	}
	t.Fatalf("session %s not found", id)
	return Source{}
}

func TestFingerprintChanges(t *testing.T) {
	const sub = "06060606-0000-4000-8000-000000000001"
	dir := copyTree(t)
	base := find(t, dir, sub)
	if len(base.Agents) != 1 {
		t.Fatalf("agents: %+v", base.Agents)
	}
	sessDir := filepath.Dir(base.Main)

	if !find(t, dir, sub).Fingerprint.Equal(base.Fingerprint) {
		t.Error("fingerprint changed without any change")
	}
	// Files outside the session (and ignored files inside it) do not matter.
	if err := os.WriteFile(filepath.Join(sessDir, sub, "tool-results", "x.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessDir, "other.jsonl"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !find(t, dir, sub).Fingerprint.Equal(base.Fingerprint) {
		t.Error("fingerprint changed after adding ignored files")
	}

	cases := []struct {
		name   string
		change func(t *testing.T)
	}{
		{"append main", func(t *testing.T) {
			f, err := os.OpenFile(base.Main, os.O_APPEND|os.O_WRONLY, 0)
			if err != nil {
				t.Fatal(err)
			}
			f.WriteString("{}\n")
			f.Close()
		}},
		{"touch agent", func(t *testing.T) {
			future := time.Now().Add(time.Hour)
			if err := os.Chtimes(base.Agents[0].Path, future, future); err != nil {
				t.Fatal(err)
			}
		}},
		{"touch meta", func(t *testing.T) {
			future := time.Now().Add(2 * time.Hour)
			if err := os.Chtimes(base.Agents[0].MetaPath, future, future); err != nil {
				t.Fatal(err)
			}
		}},
		{"add agent", func(t *testing.T) {
			p := filepath.Join(filepath.Dir(base.Agents[0].Path), "agent-anew.jsonl")
			if err := os.WriteFile(p, []byte("{}\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"remove meta", func(t *testing.T) {
			if err := os.Remove(base.Agents[0].MetaPath); err != nil {
				t.Fatal(err)
			}
		}},
		{"remove main", func(t *testing.T) {
			if err := os.Remove(base.Main); err != nil {
				t.Fatal(err)
			}
		}},
	}
	// Each change builds on the previous one; every step must differ from the one before.
	prev := find(t, dir, sub).Fingerprint
	for _, c := range cases {
		c.change(t)
		cur := find(t, dir, sub).Fingerprint
		if cur.Equal(prev) || cur.String() == prev.String() {
			t.Errorf("%s: fingerprint did not change", c.name)
		}
		prev = cur
	}
}

func TestUnreadableDirIsWarning(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read everything")
	}
	dir := copyTree(t)
	bad := filepath.Join(dir, "-home-dev-acme-plain")
	if err := os.Chmod(bad, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(bad, 0o755) })
	res, err := Scan(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) != 1 || res.Warnings[0].Path != bad {
		t.Errorf("warnings: %v", res.Warnings)
	}
	for _, s := range res.Sessions {
		if s.ProjectKey == "-home-dev-acme-plain" {
			t.Error("unreadable project still listed")
		}
	}
	if len(res.Sessions) < 30 {
		t.Errorf("other sessions lost: %d", len(res.Sessions))
	}
}

func TestMissingRoot(t *testing.T) {
	if _, err := Scan(filepath.Join(t.TempDir(), "nope")); !os.IsNotExist(unwrap(err)) {
		t.Errorf("err = %v", err)
	}
}

func unwrap(err error) error {
	for {
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return err
		}
		err = u.Unwrap()
	}
}
