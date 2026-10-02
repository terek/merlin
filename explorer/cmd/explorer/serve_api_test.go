package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/fixtures"
)

// TestServeAPI runs the real daemon over the fixtures and reads the API and the event stream.
func TestServeAPI(t *testing.T) {
	home := t.TempDir()
	cfg := copyTree(t, fixtures.ClaudeDir())
	p := startServe(t, home, cfg, "--no-hooks")
	base := fmt.Sprintf("http://127.0.0.1:%d", p.port)

	// The first scan runs while we ask: wait until every fixture is in the catalog.
	var list struct {
		Total int `json:"total"`
	}
	for end := time.Now().Add(20 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		resp, err := http.Get(base + "/api/sessions?limit=1")
		if err != nil {
			t.Fatal(err)
		}
		list.Total = 0
		json.NewDecoder(resp.Body).Decode(&list)
		resp.Body.Close()
		if resp.StatusCode == 200 && list.Total == 34 {
			break
		}
		if time.Now().After(end) {
			t.Fatalf("catalog has %d sessions, want 34\n%s", list.Total, p.stderr)
		}
	}

	req, _ := http.NewRequest(http.MethodGet, base+"/api/events", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("events Content-Type %q", ct)
	}
	lines := bufio.NewReader(resp.Body)
	var saw string
	for !strings.Contains(saw, "event: scan-progress") {
		line, err := lines.ReadString('\n')
		if err != nil {
			t.Fatalf("event stream: %v (saw %q)", err, saw)
		}
		saw += line
	}

	// A foreign Host is refused; /healthz and /hook are untouched.
	req, _ = http.NewRequest(http.MethodGet, base+"/api/projects", nil)
	req.Host = "evil.example"
	r2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r2.Body.Close()
	if r2.StatusCode != 403 {
		t.Errorf("foreign Host = %d", r2.StatusCode)
	}
	if r3, err := http.Get(base + "/healthz"); err != nil || r3.StatusCode != 200 {
		t.Errorf("healthz: %v %v", err, r3)
	}
	if code := p.terminate(t); code != 0 {
		t.Errorf("exit code after SIGTERM = %d\n%s", code, p.stderr)
	}
}
