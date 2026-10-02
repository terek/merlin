package digest

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/terek/merlin/explorer/internal/claude/discover"
	"github.com/terek/merlin/explorer/internal/fixtures"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/pricing"
)

var update = flag.Bool("update", false, "rewrite testdata/golden from the current output")

// fixtureSources lists every session of the fixture tree.
func fixtureSources(t testing.TB) []discover.Source {
	t.Helper()
	res, err := discover.Scan(filepath.Join(fixtures.ClaudeDir(), "projects"))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) > 0 {
		t.Fatalf("scan warnings: %v", res.Warnings)
	}
	return res.Sessions
}

func buildFixture(t testing.TB, src discover.Source) *model.SessionDigest {
	t.Helper()
	d, err := BuildSession(src, pricing.Default())
	if err != nil {
		t.Fatalf("%s/%s: %v", src.ProjectKey, src.ID, err)
	}
	return d
}

// goldenName names a session's golden file so a person can find the scenario: the project
// key (without its leading dash) and the session id.
func goldenName(src discover.Source) string {
	return strings.TrimPrefix(src.ProjectKey, "-") + "." + src.ID + ".json"
}

// goldenJSON renders a digest for comparison. The fingerprint's paths are made relative to
// the Claude config directory and its mtimes are zeroed: both depend on where and when the
// checkout was made. Sizes stay (they are content).
func goldenJSON(t testing.TB, d *model.SessionDigest, root string) []byte {
	t.Helper()
	c := *d
	c.Source = nil
	for _, f := range d.Source {
		rel, err := filepath.Rel(root, f.Path)
		if err != nil {
			t.Fatal(err)
		}
		// Sizes and mtimes are left out: a formatter or a checkout may rewrite fixture
		// files without changing what they mean.
		c.Source = append(c.Source, model.SourceFile{Path: filepath.ToSlash(rel)})
	}
	b, err := json.MarshalIndent(&c, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return append(b, '\n')
}

func TestGolden(t *testing.T) {
	dir := filepath.Join(fixtures.Root(), "golden")
	srcs := fixtureSources(t)
	if len(srcs) != 35 {
		t.Fatalf("fixture sessions = %d, want 35", len(srcs))
	}
	want := map[string]bool{}
	for _, src := range srcs {
		name := goldenName(src)
		want[name] = true
		got := goldenJSON(t, buildFixture(t, src), fixtures.ClaudeDir())
		path := filepath.Join(dir, name)
		if *update {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, got, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		exp, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("%s: %v (run with -update to create it)", name, err)
			continue
		}
		if !sameJSON(t, got, exp) {
			t.Errorf("%s differs from its golden file; review the change and run with -update", name)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil && !*update {
		t.Fatal(err)
	}
	for _, e := range entries {
		if !want[e.Name()] {
			if *update {
				os.Remove(filepath.Join(dir, e.Name()))
			} else {
				t.Errorf("stray golden file %s", e.Name())
			}
		}
	}
}

// sameJSON compares two JSON documents by value, so that a formatter rewriting the golden
// files (indentation, line breaks) does not fail the test.
func sameJSON(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		t.Fatalf("generated digest is not JSON: %v", err)
	}
	if err := json.Unmarshal(b, &y); err != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}
