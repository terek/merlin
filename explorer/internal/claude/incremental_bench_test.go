package claude

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/claude/digest"
	"github.com/terek/merlin/explorer/internal/claude/discover"
	"github.com/terek/merlin/explorer/internal/harness"
)

// benchSession writes a synthetic main transcript of about mb megabytes: many turns, each
// with a prompt, an assistant message with a tool call, and a long tool result.
func benchSession(b *testing.B, mb int) (*oneFile, int) {
	b.Helper()
	cfg := b.TempDir()
	o := &oneFile{cfg: cfg, h: newTestHarness(b, cfg), id: "cccccccc-0000-4000-8000-000000000001"}
	o.path = filepath.Join(cfg, "projects", "-p", o.id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(o.path), 0o755); err != nil {
		b.Fatal(err)
	}
	long := strings.Repeat("lorem ipsum dolor sit amet ", 800) // ~21 KB: a long line
	var sb strings.Builder
	n := 0
	for sb.Len() < mb<<20 {
		n++
		sb.WriteString(synthTurn(o.id, n, long))
	}
	if err := os.WriteFile(o.path, []byte(sb.String()), 0o644); err != nil {
		b.Fatal(err)
	}
	return o, n
}

func synthTurn(id string, n int, long string) string {
	ts := time.Date(2026, 1, 2, 3, 0, 0, 0, time.UTC).Add(time.Duration(n) * time.Second).Format("2006-01-02T15:04:05.000Z")
	return fmt.Sprintf(`{"type":"user","uuid":"u%[2]d","parentUuid":null,"timestamp":"%[3]s","sessionId":"%[1]s","cwd":"/w","version":"1","message":{"role":"user","content":"prompt %[2]d %[4]s"}}`+"\n"+
		`{"type":"assistant","uuid":"a%[2]d","parentUuid":"u%[2]d","timestamp":"%[3]s","sessionId":"%[1]s","message":{"id":"m%[2]d","role":"assistant","model":"claude-sonnet-4-5","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t%[2]d","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":3,"output_tokens":4}}}`+"\n"+
		`{"type":"user","uuid":"r%[2]d","parentUuid":"a%[2]d","timestamp":"%[3]s","sessionId":"%[1]s","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t%[2]d","content":"%[4]s"}]}}`+"\n"+
		`{"type":"assistant","uuid":"b%[2]d","parentUuid":"r%[2]d","timestamp":"%[3]s","sessionId":"%[1]s","message":{"id":"n%[2]d","role":"assistant","model":"claude-sonnet-4-5","stop_reason":"end_turn","content":[{"type":"text","text":"answer %[2]d %[4]s"}],"usage":{"input_tokens":3,"output_tokens":4}}}`+"\n",
		id, n, ts, long)
}

const benchMB = 40

// BenchmarkLiveUpdate compares one update of a live session after a few records were
// appended: rebuilding from scratch (what every update cost before) and the incremental
// path.
func BenchmarkLiveUpdate(b *testing.B) {
	o, turns := benchSession(b, benchMB)
	long := strings.Repeat("lorem ipsum dolor sit amet ", 800)
	src := func() discover.Source {
		return locate(b, o.h, o.id).Handle.(discover.Source)
	}
	grow := func() {
		turns++
		f, err := os.OpenFile(o.path, os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			b.Fatal(err)
		}
		f.WriteString(synthTurn(o.id, turns, long))
		f.Close()
	}
	fi, _ := os.Stat(o.path)
	b.Logf("transcript: %.1f MB, %d turns", float64(fi.Size())/(1<<20), turns)

	b.Run("full", func(b *testing.B) {
		for range b.N {
			b.StopTimer()
			grow()
			s := src()
			b.StartTimer()
			if _, err := digest.BuildSession(s, o.h.pricer); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("incremental", func(b *testing.B) {
		o.h.Follow(harness.SessionRef{ID: o.id})
		if _, err := o.h.Build(locate(b, o.h, o.id)); err != nil { // the first build reads whole
			b.Fatal(err)
		}
		before := o.h.IncrementalStats()
		b.ResetTimer()
		for range b.N {
			b.StopTimer()
			grow()
			s := locate(b, o.h, o.id)
			b.StartTimer()
			if _, err := o.h.Build(s); err != nil {
				b.Fatal(err)
			}
		}
		b.StopTimer()
		after := o.h.IncrementalStats()
		if after.FullFiles != before.FullFiles {
			b.Fatalf("incremental benchmark read whole files: %+v -> %+v", before, after)
		}
	})
	b.Run("incremental-nochange", func(b *testing.B) {
		s := locate(b, o.h, o.id)
		o.h.Build(s)
		b.ResetTimer()
		for range b.N {
			if _, err := o.h.Build(s); err != nil {
				b.Fatal(err)
			}
		}
	})
}

// TestKeptStateSize logs how much memory the kept Builders take next to the source, which
// is what DefaultMaxHeldBytes assumes. Not an assertion on exact numbers.
func TestKeptStateSize(t *testing.T) {
	if testing.Short() {
		t.Skip("allocates tens of MB")
	}
	cfg := t.TempDir()
	o := &oneFile{t: t, cfg: cfg, h: newTestHarness(t, cfg), id: "cccccccc-0000-4000-8000-000000000001"}
	o.path = filepath.Join(cfg, "projects", "-p", o.id+".jsonl")
	os.MkdirAll(filepath.Dir(o.path), 0o755)
	long := strings.Repeat("lorem ipsum dolor sit amet ", 800)
	var sb strings.Builder
	for n := 1; sb.Len() < 20<<20; n++ {
		sb.WriteString(synthTurn(o.id, n, long))
	}
	o.put(sb.String())
	var m0, m1 runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&m0)
	o.h.Follow(harness.SessionRef{ID: o.id})
	d, err := o.h.Build(locate(t, o.h, o.id))
	if err != nil {
		t.Fatal(err)
	}
	var texts int
	for _, tn := range d.Turns {
		texts += len(tn.UserText) + len(tn.FinalText)
	}
	t.Logf("texts in the digest: %d MB over %d turns", texts>>20, len(d.Turns))
	d = nil
	runtime.GC()
	runtime.ReadMemStats(&m1)
	t.Logf("source %d MB, kept Builder heap %d MB", sb.Len()>>20, (int64(m1.HeapAlloc)-int64(m0.HeapAlloc))>>20)
	runtime.KeepAlive(o.h)
}
