package main

import (
	"bytes"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/fixtures"
)

var (
	buildOnce sync.Once
	binPath   string
	buildErr  error
)

// binary builds the explorer binary once for the tests that need a real process.
func binary(t *testing.T) string {
	t.Helper()
	buildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "explorer-bin")
		if err != nil {
			buildErr = err
			return
		}
		binPath = filepath.Join(dir, "merlin")
		out, err := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", binPath, ".").CombinedOutput()
		if err != nil {
			buildErr = fmt.Errorf("go build: %v\n%s", err, out)
		}
	})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	return binPath
}

func copyTree(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, rel), b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

type serveProc struct {
	cmd    *exec.Cmd
	stderr *bytes.Buffer
	port   int
}

// startServe runs `merlin serve` with temp directories and waits for /healthz.
func startServe(t *testing.T, home, cfg string, extra ...string) *serveProc {
	t.Helper()
	port := freePort(t)
	args := append([]string{"serve", "--port", fmt.Sprint(port)}, extra...)
	cmd := exec.Command(binary(t), args...)
	cmd.Env = append(os.Environ(), "EXPLORER_HOME="+home, "CLAUDE_CONFIG_DIR="+cfg)
	p := &serveProc{cmd: cmd, stderr: &bytes.Buffer{}, port: port}
	cmd.Stderr = p.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
		if err == nil {
			resp.Body.Close()
			return p
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("serve did not come up:\n%s", p.stderr)
	return nil
}

func (p *serveProc) terminate(t *testing.T) int {
	t.Helper()
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			return 0
		}
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		t.Fatal(err)
	case <-time.After(20 * time.Second):
		t.Fatal("serve did not exit after SIGTERM")
	}
	return -1
}

func tmpFiles(root string) (out []string) {
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err == nil && strings.HasSuffix(p, ".tmp") {
			out = append(out, p)
		}
		return nil
	})
	return out
}

func TestServeProcess(t *testing.T) {
	home := t.TempDir()
	cfg := copyTree(t, fixtures.ClaudeDir())
	settings := filepath.Join(cfg, "settings.json")
	p := startServe(t, home, cfg, "--no-hooks")

	// --no-hooks leaves settings.json alone.
	if _, err := os.Stat(settings); !os.IsNotExist(err) {
		t.Errorf("--no-hooks touched settings.json: %v", err)
	}

	// A second instance refuses and names the lock.
	second := exec.Command(binary(t), "serve", "--port", fmt.Sprint(freePort(t)), "--no-hooks")
	second.Env = append(os.Environ(), "EXPLORER_HOME="+home, "CLAUDE_CONFIG_DIR="+cfg)
	out, err := second.CombinedOutput()
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() == 0 {
		t.Errorf("second instance: err=%v", err)
	}
	if !strings.Contains(string(out), filepath.Join(home, "explorer.lock")) {
		t.Errorf("second instance did not name the lock:\n%s", out)
	}

	// It indexed the fixtures, and logs to the file.
	deadline := time.Now().Add(15 * time.Second)
	for {
		if b, _ := os.ReadFile(filepath.Join(home, "explorer.log")); strings.Contains(string(b), "rescan:") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no rescan logged:\n%s", p.stderr)
		}
		time.Sleep(10 * time.Millisecond)
	}

	if code := p.terminate(t); code != 0 {
		t.Errorf("exit code after SIGTERM = %d\n%s", code, p.stderr)
	}
	if tmp := tmpFiles(home); len(tmp) > 0 {
		t.Errorf("temp files left: %v", tmp)
	}
}

func TestServeInstallsHooksIntoConfigDirOnly(t *testing.T) {
	home := t.TempDir()
	cfg := copyTree(t, fixtures.ClaudeDir())
	p := startServe(t, home, cfg)
	b, err := os.ReadFile(filepath.Join(cfg, "settings.json"))
	if err != nil {
		t.Fatalf("settings.json not written in the temp config dir: %v", err)
	}
	if !strings.Contains(string(b), "/claude/hooks/notify.sh") || !strings.Contains(string(b), home) {
		t.Errorf("settings.json lacks the hook for this home:\n%s", b)
	}
	if _, err := os.Stat(filepath.Join(home, "claude", "hooks", "notify.sh")); err != nil {
		t.Errorf("notify.sh: %v", err)
	}
	if code := p.terminate(t); code != 0 {
		t.Errorf("exit code = %d", code)
	}
}
