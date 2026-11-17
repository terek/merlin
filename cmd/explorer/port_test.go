package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/terek/merlin/internal/fixtures"
)

func TestServePort(t *testing.T) {
	const bad = `merlin serve: ignoring PORT="%s": not a port number`
	tests := []struct {
		name      string
		flag      int
		env       string
		cfg       int
		want      int
		wantBadEn string
	}{
		{"flag beats env", 9000, "9100", 9200, 9000, ""},
		{"env beats config", 0, "9100", 9200, 9100, ""},
		{"empty env, config", 0, "", 9200, 9200, ""},
		{"empty env, default", 0, "", 0, 7433, ""},
		{"abc to config", 0, "abc", 9200, 9200, "abc"},
		{"zero to config", 0, "0", 9200, 9200, "0"},
		{"70000 to default", 0, "70000", 0, 7433, "70000"},
		{"flag ignores bad env silently", 9000, "abc", 0, 9000, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, warn := servePort(tc.flag, tc.env, tc.cfg)
			want := ""
			if tc.wantBadEn != "" {
				want = fmt.Sprintf(bad, tc.wantBadEn)
			}
			if got != tc.want || warn != want {
				t.Errorf("servePort = %d, %q; want %d, %q", got, warn, tc.want, want)
			}
		})
	}
}

func TestDaemonPort(t *testing.T) {
	home := t.TempDir()
	if p := daemonPort(home); p != 7433 {
		t.Errorf("default = %d", p)
	}
	writePort(t, home, 9200)
	if p := daemonPort(home); p != 9200 {
		t.Errorf("config = %d", p)
	}
	os.WriteFile(filepath.Join(home, "merlin.lock"), []byte("123\n9300\n"), 0o644)
	if p := daemonPort(home); p != 9300 {
		t.Errorf("lock = %d", p)
	}
}

// The hook finds a daemon on the port it recorded in merlin.lock, not the configured one.
func TestHookUsesRecordedPort(t *testing.T) {
	home := t.TempDir()
	got := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got <- r.URL.Path }))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	writePort(t, home, freePort(t))
	if err := os.WriteFile(filepath.Join(home, "merlin.lock"), []byte(fmt.Sprintf("123\n%d\n", port)), 0o644); err != nil {
		t.Fatal(err)
	}
	runCLI(t, home, `{"hook_event_name":"SessionStart","session_id":"s"}`, "hook")
	select {
	case <-got:
	default:
		t.Error("the daemon on the recorded port got no POST")
	}
}

// With no --port, serve listens on $PORT.
func TestServeListensOnPortEnv(t *testing.T) {
	home := t.TempDir()
	cfg := copyTree(t, fixtures.ClaudeDir())
	port := freePort(t)
	cmd := exec.Command(binary(t), "serve", "--no-hooks")
	cmd.Env = isolatedEnv(t, "MERLIN_HOME="+home, "CLAUDE_CONFIG_DIR="+cfg, "PORT="+strconv.Itoa(port))
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
		if err == nil {
			resp.Body.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("serve did not listen on PORT=%d", port)
}
