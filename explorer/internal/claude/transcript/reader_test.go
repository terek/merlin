package transcript

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func appendFile(t *testing.T, p, content string) {
	t.Helper()
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatal(err)
	}
}

func readAll(t *testing.T, r *Reader) []*Record {
	t.Helper()
	var out []*Record
	for {
		rec, err := r.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, rec)
	}
}

func uuids(recs []*Record) []string {
	var s []string
	for _, r := range recs {
		s = append(s, r.UUID)
	}
	return s
}

func line(uuid string) string {
	return `{"type":"user","uuid":"` + uuid + `","message":{"role":"user","content":"hi"}}` + "\n"
}

func eq(a, b []string) bool { return strings.Join(a, ",") == strings.Join(b, ",") }

func TestReaderBasic(t *testing.T) {
	p := writeFile(t, "a.jsonl", line("a")+"\n"+line("b"))
	r, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	recs := readAll(t, r)
	if !eq(uuids(recs), []string{"a", "b"}) || r.Offset() != int64(len(line("a"))+1+len(line("b"))) {
		t.Fatalf("%v %d", uuids(recs), r.Offset())
	}
	if len(recs[0].Raw) == 0 || r.Records() != 2 || r.BadLines() != 0 {
		t.Fatal("counters/raw")
	}
}

func TestReaderHugeLine(t *testing.T) {
	big := strings.Repeat("x", 3<<20)
	huge := `{"type":"user","uuid":"big","message":{"role":"user","content":"` + big + `"}}` + "\n"
	p := writeFile(t, "a.jsonl", line("a")+huge+line("c"))
	r, _ := Open(p)
	defer r.Close()
	recs := readAll(t, r)
	if !eq(uuids(recs), []string{"a", "big", "c"}) {
		t.Fatal(uuids(recs))
	}
	if len(recs[1].Raw) != len(huge)-1 {
		t.Fatalf("raw len %d want %d", len(recs[1].Raw), len(huge)-1)
	}
	if m, ok := recs[1].UserMessage(); !ok || len(m.Content.Text()) != len(big) {
		t.Fatal("content not intact")
	}
}

func TestReaderCorruptAndUnknown(t *testing.T) {
	p := writeFile(t, "a.jsonl", line("a")+"{not json\n"+"[1,2]\n"+`{"type":"brand-new-kind","x":1}`+"\n"+line("b"))
	r, _ := Open(p)
	defer r.Close()
	recs := readAll(t, r)
	if len(recs) != 3 || r.BadLines() != 2 || r.UnknownRecords() != 1 {
		t.Fatalf("recs=%d bad=%d unknown=%d", len(recs), r.BadLines(), r.UnknownRecords())
	}
	if recs[1].Type != "brand-new-kind" || recs[2].UUID != "b" {
		t.Fatal("order")
	}
}

func TestReaderPartialLastLine(t *testing.T) {
	full := line("a")
	partial := `{"type":"user","uuid":"b","mess`
	p := writeFile(t, "a.jsonl", full+partial)
	r, _ := Open(p)
	defer r.Close()
	if got := uuids(readAll(t, r)); !eq(got, []string{"a"}) {
		t.Fatal(got)
	}
	if r.Offset() != int64(len(full)) {
		t.Fatalf("offset %d", r.Offset())
	}
	// Same reader notices completion.
	appendFile(t, p, `age":{"role":"user","content":"x"}}`+"\n")
	if got := uuids(readAll(t, r)); !eq(got, []string{"b"}) {
		t.Fatalf("same reader: %v", got)
	}
	if r.BadLines() != 0 {
		t.Fatal("partial line counted as bad")
	}

	// A fresh resume also reads it once.
	r2, ok, err := OpenAt(p, int64(len(full)), guardOf([]byte(full)))
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	defer r2.Close()
	if got := uuids(readAll(t, r2)); !eq(got, []string{"b"}) {
		t.Fatalf("resume: %v", got)
	}
}

func TestReaderResume(t *testing.T) {
	p := writeFile(t, "a.jsonl", line("a")+"junk\n"+line("b")+`{"type":"x`)
	r, _ := Open(p)
	readAll(t, r)
	off, guard := r.Offset(), r.Guard()
	r.Close()

	appendFile(t, p, `y"}`+"\n"+line("c"))
	r2, ok, err := OpenAt(p, off, guard)
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	defer r2.Close()
	recs := readAll(t, r2)
	if len(recs) != 2 || recs[0].Type != "xy" || recs[1].UUID != "c" {
		t.Fatalf("%v", recs)
	}
	// Reader resumed at off reports the same guard as one that read from the start.
	r3, _ := Open(p)
	defer r3.Close()
	readAll(t, r3)
	if r3.Offset() != r2.Offset() || r3.Guard() != r2.Guard() {
		t.Fatal("offset/guard differ between full and resumed reads")
	}
	// Nothing new: resume at end yields nothing.
	r4, ok, _ := OpenAt(p, r3.Offset(), r3.Guard())
	if !ok || len(readAll(t, r4)) != 0 {
		t.Fatal("expected empty resume")
	}
	r4.Close()
}

func TestReaderResumeShortGuard(t *testing.T) {
	// Offset smaller than GuardSize: the guard covers all bytes before it.
	p := writeFile(t, "a.jsonl", "{\"type\":\"x\"}\n"+line("b"))
	r, _ := Open(p)
	r.Next()
	off, g := r.Offset(), r.Guard()
	r.Close()
	if off >= GuardSize {
		t.Fatal("test premise")
	}
	r2, ok, err := OpenAt(p, off, g)
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	defer r2.Close()
	if got := uuids(readAll(t, r2)); !eq(got, []string{"b"}) {
		t.Fatal(got)
	}
}

func TestReaderRewrittenFile(t *testing.T) {
	orig := line("aaaa") + line("bbbb") + line("cccc")
	p := writeFile(t, "a.jsonl", orig)
	r, _ := Open(p)
	readAll(t, r)
	off, guard := r.Offset(), r.Guard()
	r.Close()

	// Same size, content before the offset changed (a redaction pass).
	redacted := strings.Replace(orig, "bbbb", "REDA", 1)
	if len(redacted) != len(orig) {
		t.Fatal("premise")
	}
	if err := os.WriteFile(p, []byte(redacted), 0o644); err != nil {
		t.Fatal(err)
	}
	if rr, ok, err := OpenAt(p, off, guard); ok || err != nil || rr != nil {
		t.Fatalf("rewrite not detected: ok=%v err=%v", ok, err)
	}
	// Change outside the guarded window is not detectable by design; one inside is.
	big := strings.Repeat(line("z"), 20)
	p2 := writeFile(t, "b.jsonl", big)
	r2, _ := Open(p2)
	readAll(t, r2)
	off, guard = r2.Offset(), r2.Guard()
	r2.Close()
	mut := []byte(big)
	mut[len(mut)-3] ^= 1 // within last 256 bytes
	os.WriteFile(p2, mut, 0o644)
	if _, ok, _ := OpenAt(p2, off, guard); ok {
		t.Fatal("tail change not detected")
	}
}

func TestReaderShrunkFile(t *testing.T) {
	p := writeFile(t, "a.jsonl", line("a")+line("b"))
	r, _ := Open(p)
	readAll(t, r)
	off, guard := r.Offset(), r.Guard()
	r.Close()
	os.WriteFile(p, []byte(line("a")), 0o644)
	if rr, ok, err := OpenAt(p, off, guard); ok || err != nil || rr != nil {
		t.Fatalf("shrink: ok=%v err=%v", ok, err)
	}
}

func TestOpenMissing(t *testing.T) {
	p := filepath.Join(t.TempDir(), "nope.jsonl")
	if _, err := Open(p); err == nil {
		t.Fatal("want error")
	}
	if _, ok, err := OpenAt(p, 10, "g"); ok || err == nil {
		t.Fatal("want error")
	}
}

func TestReadAgentMeta(t *testing.T) {
	dir := t.TempDir()
	if m, found, err := ReadAgentMeta(filepath.Join(dir, "none.meta.json")); found || err != nil || m.AgentType != "" {
		t.Fatal(m, found, err)
	}
	p := writeFile(t, "agent-x.meta.json", `{"agentType":"Explore","description":"d","spawnDepth":0,"extra":1}`)
	m, found, err := ReadAgentMeta(p)
	if err != nil || !found || m.AgentType != "Explore" || m.SpawnDepth == nil || *m.SpawnDepth != 0 {
		t.Fatalf("%+v %v %v", m, found, err)
	}
	bad := writeFile(t, "bad.meta.json", `{oops`)
	if _, found, err := ReadAgentMeta(bad); !found || err == nil {
		t.Fatal("invalid json should be an error")
	}
}
