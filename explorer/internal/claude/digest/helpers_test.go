package digest

import (
	"errors"
	"io"
	"path/filepath"
	"testing"

	"github.com/terek/merlin/explorer/internal/claude/transcript"
	"github.com/terek/merlin/explorer/internal/fixtures"
	"github.com/terek/merlin/explorer/internal/pricing"
)

// fixturePath finds the main transcript of a fixture session by id.
func fixturePath(t testing.TB, id string) string {
	t.Helper()
	m, _ := filepath.Glob(filepath.Join(fixtures.ClaudeDir(), "projects", "*", id+".jsonl"))
	if len(m) != 1 {
		t.Fatalf("fixture %s: found %v", id, m)
	}
	return m[0]
}

// readAll reads every record of a file and its bad-line count.
func readAll(t testing.TB, path string) ([]*transcript.Record, int) {
	t.Helper()
	r, err := transcript.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	var recs []*transcript.Record
	for {
		rec, err := r.Next()
		if errors.Is(err, io.EOF) {
			return recs, r.BadLines()
		}
		if err != nil {
			t.Fatal(err)
		}
		recs = append(recs, rec)
	}
}

// build feeds a fixture whole.
func build(t testing.TB, id string) *FileResult {
	t.Helper()
	recs, bad := readAll(t, fixturePath(t, id))
	b := NewBuilder(pricing.Default())
	for _, r := range recs {
		b.Apply(r)
	}
	b.AddBadLines(bad)
	return b.Result()
}
