package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestMain lets the test binary act as `explorer` when re-executed.
func TestMain(m *testing.M) {
	if os.Getenv("EXPLORER_TEST_AS_CLI") == "1" {
		os.Exit(dispatch(os.Args[1:]))
	}
	os.Exit(m.Run())
}

func runCLI(t *testing.T, home, stdin string, args ...string) (stdout, stderr string, code int, took time.Duration) {
	t.Helper()
	cmd := exec.Command(os.Args[0], args...)
	cmd.Env = append(os.Environ(), "EXPLORER_TEST_AS_CLI=1", "EXPLORER_HOME="+home, "CLAUDE_CONFIG_DIR="+t.TempDir())
	cmd.Stdin = strings.NewReader(stdin)
	var o, e bytes.Buffer
	cmd.Stdout, cmd.Stderr = &o, &e
	start := time.Now()
	err := cmd.Run()
	took = time.Since(start)
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return o.String(), e.String(), code, took
}

func writePort(t *testing.T, home string, port int) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"port":`+strconv.Itoa(port)+`}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestHookCommand(t *testing.T) {
	home := t.TempDir()
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
	}))
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	writePort(t, home, port)

	out, errs, code, _ := runCLI(t, home, `{"hook_event_name":"SessionStart","session_id":"s"}`, "hook")
	if out != "" || errs != "" || code != 0 || got != `{"hook_event_name":"SessionStart","session_id":"s"}` {
		t.Errorf("deliver: out=%q err=%q code=%d got=%q", out, errs, code, got)
	}
	got = ""
	out, errs, code, _ = runCLI(t, home, "garbage", "hook")
	if out != "" || errs != "" || code != 0 || got != "" {
		t.Errorf("garbage: out=%q err=%q code=%d got=%q", out, errs, code, got)
	}
	srv.Close()

	out, errs, code, _ = runCLI(t, home, `{}`, "hook")
	if out != "" || errs != "" || code != 0 {
		t.Errorf("no daemon: out=%q err=%q code=%d", out, errs, code)
	}

	slow := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { time.Sleep(time.Second) }))
	defer slow.Close()
	u, _ = url.Parse(slow.URL)
	port, _ = strconv.Atoi(u.Port())
	writePort(t, home, port)
	out, errs, code, took := runCLI(t, home, `{}`, "hook")
	if out != "" || errs != "" || code != 0 {
		t.Errorf("slow: out=%q err=%q code=%d", out, errs, code)
	}
	// Process start-up alone can take a second under -race, so compare against
	// a run that does no network I/O rather than against an absolute bound.
	_, _, _, startup := runCLI(t, home, "", "version")
	if took > startup+700*time.Millisecond {
		t.Errorf("slow daemon: took %v (start-up alone %v)", took, startup)
	}
}
