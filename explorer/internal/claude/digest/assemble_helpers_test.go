package digest

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/terek/merlin/explorer/internal/claude/transcript"
	"github.com/terek/merlin/explorer/internal/fixtures"
	"github.com/terek/merlin/explorer/internal/pricing"
)

// buildFile reads one transcript file into a FileResult.
func buildFile(t testing.TB, path string) *FileResult {
	t.Helper()
	r, err := transcript.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	b := NewBuilder(pricing.Default())
	for {
		rec, err := r.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b.Apply(rec)
	}
	b.AddBadLines(r.BadLines())
	return b.Result()
}

// assembleFixture assembles a fixture session: the main file when there is one, and every
// agent file under <session>/subagents with its meta.
func assembleFixture(t testing.TB, id string) *Assembly {
	t.Helper()
	var main *FileResult
	if m, _ := filepath.Glob(filepath.Join(fixtures.ClaudeDir(), "projects", "*", id+".jsonl")); len(m) == 1 {
		main = buildFile(t, m[0])
	}
	dirs, _ := filepath.Glob(filepath.Join(fixtures.ClaudeDir(), "projects", "*", id, "subagents"))
	var files []AgentFile
	for _, dir := range dirs {
		paths, _ := filepath.Glob(filepath.Join(dir, "agent-*.jsonl"))
		for _, p := range paths {
			base := strings.TrimSuffix(filepath.Base(p), ".jsonl")
			f := AgentFile{ID: strings.TrimPrefix(base, "agent-"), Result: buildFile(t, p)}
			metaPath := filepath.Join(dir, base+".meta.json")
			if _, err := os.Stat(metaPath); err == nil {
				m, found, err := transcript.ReadAgentMeta(metaPath)
				if err != nil {
					t.Fatal(err)
				}
				if found {
					f.Meta = &m
				}
			}
			files = append(files, f)
		}
	}
	return Assemble(main, files)
}
