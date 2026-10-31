package fixtures

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

var (
	uuidRe  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	agentRe = regexp.MustCompile(`^agent-(.+)\.jsonl$`)
)

// badLines lists the files that deliberately contain a corrupt (newline-terminated) line,
// and partialTail the files that deliberately end in an unterminated line.
var (
	badLines    = map[string]int{"projects/-home-dev-acme-hostile/17171717-0000-4000-8000-000000000001.jsonl": 1}
	partialTail = map[string]bool{"projects/-home-dev-acme-hostile/17171717-0000-4000-8000-000000000001.jsonl": true}
	// files that deliberately repeat a record uuid
	repeatsUUID = map[string]bool{"projects/-home-dev-acme-s05-compaction/05050505-0000-4000-8000-000000000003.jsonl": true}
	// the only file with a line over 1 MB
	bigLine = "projects/-home-dev-acme-hostile/17171717-0000-4000-8000-000000000001.jsonl"
)

func TestRootExists(t *testing.T) {
	if _, err := os.Stat(filepath.Join(ClaudeDir(), "projects")); err != nil {
		t.Fatal(err)
	}
}

func TestTreeIsValid(t *testing.T) {
	root := ClaudeDir()
	readme, err := os.ReadFile(filepath.Join(Root(), "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	sawBig := false
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		switch {
		case strings.HasSuffix(rel, ".json"):
			if !json.Valid(data) {
				t.Errorf("%s: invalid JSON", rel)
			}
		case strings.HasSuffix(rel, ".jsonl"):
			checkJSONL(t, rel, data, string(readme))
			if rel == bigLine {
				for _, l := range bytes.Split(data, []byte("\n")) {
					if len(l) > 1<<20 {
						sawBig = true
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !sawBig {
		t.Errorf("%s: no line over 1 MB", bigLine)
	}
}

func checkJSONL(t *testing.T, rel string, data []byte, readme string) {
	t.Helper()
	base := filepath.Base(rel)
	parent := filepath.Base(filepath.Dir(rel))
	isMain := uuidRe.MatchString(strings.TrimSuffix(base, ".jsonl"))
	isAgent := parent == "subagents" && agentRe.MatchString(base)
	if isMain || isAgent {
		id := strings.TrimSuffix(base, ".jsonl")
		if isAgent {
			id = agentRe.FindStringSubmatch(base)[1]
		}
		if !strings.Contains(readme, id) {
			t.Errorf("%s: id %s is not listed in README.md", rel, id)
		}
	}

	lines := bytes.Split(data, []byte("\n"))
	last := lines[len(lines)-1]
	lines = lines[:len(lines)-1] // everything after the last \n
	if len(last) > 0 && !partialTail[rel] {
		t.Errorf("%s: unexpected unterminated last line", rel)
	}
	if len(last) == 0 && partialTail[rel] {
		t.Errorf("%s: expected an unterminated last line", rel)
	}

	bad := 0
	seen := map[string]bool{}
	var prev time.Time
	for i, l := range lines {
		var r map[string]any
		if err := json.Unmarshal(l, &r); err != nil {
			bad++
			continue
		}
		if uuid, _ := r["uuid"].(string); uuid != "" && (isMain || isAgent) {
			if seen[uuid] && !repeatsUUID[rel] {
				t.Errorf("%s:%d: repeated uuid %s", rel, i+1, uuid)
			}
			seen[uuid] = true
		}
		if ts, ok := r["timestamp"].(string); ok {
			tm, err := time.Parse(time.RFC3339, ts)
			if err != nil {
				t.Errorf("%s:%d: bad timestamp %q", rel, i+1, ts)
			} else if tm.Before(prev) {
				t.Errorf("%s:%d: timestamp %s goes backwards", rel, i+1, ts)
			} else {
				prev = tm
			}
		}
		if !isMain && !isAgent {
			continue
		}
		if sid, ok := r["sessionId"].(string); ok {
			want := strings.TrimSuffix(base, ".jsonl")
			if isAgent {
				want = filepath.Base(filepath.Dir(filepath.Dir(rel)))
			}
			if sid != want {
				t.Errorf("%s:%d: sessionId %s, want %s", rel, i+1, sid, want)
			}
		}
		if isAgent {
			if _, has := r["uuid"]; has && r["isSidechain"] != true {
				t.Errorf("%s:%d: subagent record without isSidechain", rel, i+1)
			}
			if a, ok := r["agentId"].(string); ok && a != agentRe.FindStringSubmatch(base)[1] {
				t.Errorf("%s:%d: agentId %s does not match file", rel, i+1, a)
			}
		}
		if isMain {
			if _, has := r["uuid"]; has && r["isSidechain"] == true {
				t.Errorf("%s:%d: sidechain record in a main file", rel, i+1)
			}
		}
	}
	if bad != badLines[rel] {
		t.Errorf("%s: %d unparseable lines, want %d", rel, bad, badLines[rel])
	}
}
