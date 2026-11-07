package shape

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Markers must never appear in any output.
var markers = []string{
	"SECRETMARKER", "HOMEMARKER", "ARGMARKER", "KEYMARKER", "BADJSONMARKER", "DEEPMARKER", "LONGMARKER", "PATHKEYMARKER",
}

func write(t *testing.T, dir, name string, lines ...string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func hostileDir(t *testing.T) string {
	dir := t.TempDir()
	deep := strings.Repeat(`{"a":`, 5000) + `"DEEPMARKER"` + strings.Repeat(`}`, 5000)
	tooDeep := strings.Repeat(`[`, 20000) + `"DEEPMARKER"` + strings.Repeat(`]`, 20000)
	long := `{"type":"message","message":{"role":"user","content":"` + strings.Repeat("LONGMARKER", 250000) + `"}}`
	if len(long) < 2<<20 {
		t.Fatal("long line too short")
	}
	var pathKeys []string
	for i := 0; i < 60; i++ {
		pathKeys = append(pathKeys, fmt.Sprintf(`"/Users/zsolt/PATHKEYMARKER/file%d.go":{"add":1}`, i))
	}
	write(t, dir, "a.jsonl",
		`{"type":"message","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"SECRETMARKER sk-live"}]},"note":"SECRETMARKER"}`,
		`{"type":"message","message":{"role":"assistant","model":"/Users/zsolt/HOMEMARKER/m","stopReason":"sk-live-SECRETMARKER0123456789abcdef"}}`,
		`{"type":"message","message":{"role":"assistant","model":"Users/zsolt/HOMEMARKER","provider":"~/HOMEMARKER"}}`,
		`{"type":"message","message":{"role":"assistant","model":"zsolt@HOMEMARKER.example.com"}}`,
		`{"type":"event_msg","payload":{"type":"token_count","changes":{`+strings.Join(pathKeys, ",")+`}}}`,
		`{"type":"event_msg","payload":{"type":"function_call","arguments":{"odd key ARGMARKER":"ARGMARKER","$x":1,"sk-live-KEYMARKER0123456789abcdef":2},"input":{"ARGMARKER":["ARGMARKER"]}}}`,
		`{"type":"event_msg","payload":{"type":"token_count","sk-live-KEYMARKER0123456789abcdef0123":"SECRETMARKER","my KEYMARKER":1}}`,
		`BADJSONMARKER {not json`,
		`{"type":"x"} BADJSONMARKER`,
		`{"type":"SECRETMARKER sk-abc 123"}`,
		deep, tooDeep, long)
	write(t, dir, "sub/b.jsonl", `{"type":"message","message":{"role":"user","content":"SECRETMARKER"}}`, ``, `{"type":"event_msg","payload":{"type":"token_count"}}`)
	write(t, dir, "ignored.txt", `{"type":"ignored"}`)
	return dir
}

func outputs(t *testing.T, r *Report) (string, string) {
	var tb bytes.Buffer
	if err := r.WriteText(&tb); err != nil {
		t.Fatal(err)
	}
	j, err := json.MarshalIndent(r, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	return tb.String(), string(j)
}

func TestNoLeak(t *testing.T) {
	dir := hostileDir(t)
	r, err := Scan([]string{dir}, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	text, js := outputs(t, r)
	for _, m := range append(markers, dir, filepath.Base(dir), "zsolt", "Users", "sk-live") {
		if strings.Contains(text, m) || strings.Contains(js, m) {
			t.Errorf("marker %q leaked\n%s", m, text)
		}
	}
	// the harmless short token is still shown
	if !strings.Contains(text, "claude-sonnet-4") {
		t.Errorf("model token missing:\n%s", text)
	}
	if t.Failed() {
		t.Log(text)
	}
}

func TestCounts(t *testing.T) {
	dir := hostileDir(t)
	r, err := Scan([]string{dir}, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if r.Files != 2 {
		t.Errorf("files=%d", r.Files)
	}
	// bad: 2 invalid json lines, too-deep array (>10000 levels) = 3
	if r.BadLines != 3 {
		t.Errorf("bad=%d", r.BadLines)
	}
	kinds := map[string]KindReport{}
	for _, k := range r.Kinds {
		kinds[k.Kind] = k
	}
	if k := kinds["message/user"]; k.Records != 2 || k.Files != 2 {
		t.Errorf("message/user=%+v", k)
	}
	if k := kinds["message/assistant"]; k.Records != 4 || k.Files != 1 {
		t.Errorf("message/assistant records=%d files=%d", k.Records, k.Files)
	}
	tc := kinds["event_msg/token_count"]
	if tc.Records != 3 || tc.Files != 2 {
		t.Errorf("token_count=%d/%d", tc.Records, tc.Files)
	}
	want := map[string]bool{"unknown": false, "other": false}
	for k := range kinds {
		if _, ok := want[k]; ok {
			want[k] = true
		}
	}
	if !want["other"] {
		t.Errorf("kind other missing: %v", kinds)
	}
	fp := map[string]Field{}
	for _, f := range tc.Fields {
		fp[f.Path] = f
	}
	if f := fp["payload"]; f.Count != 3 || f.Files != 2 {
		t.Errorf("payload=%+v", f)
	}
	if f := fp["payload.changes.*"]; f.Count != 60 {
		t.Errorf("changes.*=%+v (paths %v)", f, tc.Fields)
	}
	for p := range fp {
		if strings.HasPrefix(p, "payload.changes.") && p != "payload.changes.*" && !strings.HasPrefix(p, "payload.changes.*.") {
			t.Errorf("unexpected path %q", p)
		}
	}
	if f := fp["payload.type"]; len(f.Values) != 1 || f.Values[0] != (ValueCount{"token_count", 3}) {
		t.Errorf("payload.type=%+v", f)
	}
	am := kinds["message/assistant"]
	for _, f := range am.Fields {
		if f.Path == "message.model" {
			if len(f.Values) != 1 || f.Values[0].Value != "claude-sonnet-4" || f.OtherValues != 3 {
				t.Errorf("model=%+v", f)
			}
		}
	}
}

func TestFreeFormAndPayload(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "c.jsonl", `{"type":"event_msg","payload":{"type":"call","arguments":{"a":1,"b":"x"},"input":{"q":[1,2]}}}`)
	r, _ := Scan([]string{dir}, DefaultOptions())
	text, _ := outputs(t, r)
	for _, p := range []string{"payload.type", "payload.arguments.*", "payload.input.*"} {
		if !strings.Contains(text, p) {
			t.Errorf("missing %s:\n%s", p, text)
		}
	}
	if strings.Contains(text, "payload.arguments.a") || strings.Contains(text, "payload.input.q") {
		t.Errorf("walked into free-form:\n%s", text)
	}
	// with an empty free-form list the keys show
	opt := DefaultOptions()
	opt.FreeForm = nil
	r, _ = Scan([]string{dir}, opt)
	text, _ = outputs(t, r)
	if !strings.Contains(text, "payload.arguments.a") {
		t.Errorf("flag ignored:\n%s", text)
	}
}

func TestWideObjectAndValueCollapse(t *testing.T) {
	dir := t.TempDir()
	var lines []string
	for i := 0; i < 50; i++ {
		lines = append(lines, fmt.Sprintf(`{"type":"t","m":{"k%d":%d},"model":"v%d"}`, i, i, i))
	}
	write(t, dir, "w.jsonl", lines...)
	r, _ := Scan([]string{dir}, DefaultOptions())
	text, js := outputs(t, r)
	if strings.Contains(text, "m.k1") || !strings.Contains(text, "m.*") {
		t.Errorf("wide object not collapsed:\n%s", text)
	}
	if strings.Contains(js, `"v1"`) || !strings.Contains(text, ">30 distinct") {
		t.Errorf("values not collapsed:\n%s", text)
	}
}

func TestSeenInNOfM(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "1.jsonl", `{"type":"a","x":1}`, `{"type":"a","x":2,"y":true}`)
	write(t, dir, "2.jsonl", `{"type":"a","x":1.5}`)
	write(t, dir, "3.jsonl", `{"type":"a"}`)
	r, _ := Scan([]string{dir}, DefaultOptions())
	text, _ := outputs(t, r)
	if !strings.Contains(text, "seen in 3 of 3 files") || !strings.Contains(text, "1 of 3 files") || !strings.Contains(text, "2 of 3 files") {
		t.Errorf("counts:\n%s", text)
	}
	for _, f := range r.Kinds[0].Fields {
		if f.Path == "x" && (f.Files != 2 || f.Count != 3 || f.Types["integer"] != 2 || f.Types["number"] != 1) {
			t.Errorf("x=%+v", f)
		}
	}
}

func TestDeterministic(t *testing.T) {
	dir := hostileDir(t)
	var first string
	for i := 0; i < 5; i++ {
		r, err := Scan([]string{dir, dir}, DefaultOptions())
		if err != nil {
			t.Fatal(err)
		}
		text, js := outputs(t, r)
		if i == 0 {
			first = text + js
		} else if text+js != first {
			t.Fatal("output differs between runs")
		}
	}
}

func TestMissingPathDoesNotEcho(t *testing.T) {
	_, err := Scan([]string{"/nonexistent/zsolt-secret"}, DefaultOptions())
	if err == nil || strings.Contains(err.Error(), "zsolt") {
		t.Errorf("err=%v", err)
	}
}

func TestValueOK(t *testing.T) {
	good := []string{"claude-sonnet-4-5", "gpt-5", "openai/gpt-4o", "anthropic/claude-3.5-sonnet", "model@20250101", "ollama:llama3"}
	for _, s := range good {
		if !valueOK("model", s) {
			t.Errorf("rejected %q", s)
		}
	}
	bad := []string{"/Users/a/b", "~/x", "Users/a", "home/a", "C:/Users/a", "a/../b", "a/b/c/d", "10.0.0.1", "a b", "", "x@y.com",
		"sk-abcdef", "eyJhbGciOiJIUzI1NiJ9", strings.Repeat("a", 50), "abcdef0123456789abcd"}
	for _, s := range bad {
		if valueOK("model", s) {
			t.Errorf("accepted %q", s)
		}
	}
	if valueOK("source", "a/b") || valueOK("version", "a:b") || !valueOK("version", "2.1.0") {
		t.Error("generic value rules")
	}
}
