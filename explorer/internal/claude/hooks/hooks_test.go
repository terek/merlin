package hooks

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tidwall/gjson"
)

// Unusual indentation (tabs and 3 spaces mixed), a matcher, timeouts, other
// top-level keys, other hooks on the same events, and no trailing newline.
const fixture = "{\n" +
	"\t\"model\":   \"x\",\n" +
	"   \"hooks\" : {\n" +
	"\t\"SessionStart\": [ {\"hooks\":[{\"type\":\"command\",\"command\":\"~/.merlin/a.sh\",\"timeout\":10}]} ,\n" +
	"\t\t{ \"matcher\": \"startup|resume\", \"hooks\": [ { \"type\": \"command\", \"command\": \"echo hi\" } ] }\n" +
	"\t],\n" +
	"\t\"Stop\": [{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"b.sh\",\"timeout\":5}]}],\n" +
	"\t\"PreToolUse\": [\n\t\t{\"matcher\": \"Bash\", \"hooks\": [{\"type\": \"command\", \"command\": \"c.sh\"}]}\n\t]\n" +
	"   },\n" +
	"\t\"permissions\": {\"allow\": [\"Bash(ls)\"]}\n" +
	"}"

func setup(t *testing.T, settings *string) Config {
	t.Helper()
	root := t.TempDir()
	cfg := Config{
		ClaudeConfigDir: filepath.Join(root, "claude"),
		ExplorerHome:    filepath.Join(root, "explorer"),
		Binary:          filepath.Join(root, "bin", "explorer"),
	}
	if err := os.MkdirAll(cfg.ClaudeConfigDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if settings != nil {
		if err := os.WriteFile(cfg.SettingsPath(), []byte(*settings), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return cfg
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func backups(t *testing.T, cfg Config) []string {
	m, _ := filepath.Glob(cfg.SettingsPath() + ".explorer-backup-*")
	return m
}

func TestInstallUninstallRestoresBytes(t *testing.T) {
	s := fixture
	cfg := setup(t, &s)
	res, err := Install(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Events) != len(Events) || res.BackupPath == "" {
		t.Fatalf("result %+v", res)
	}
	installed := read(t, cfg.SettingsPath())
	if !gjson.Valid(installed) {
		t.Fatalf("invalid JSON:\n%s", installed)
	}
	for _, ev := range Events {
		found := false
		for _, g := range gjson.Get(installed, "hooks."+ev).Array() {
			for _, h := range g.Get("hooks").Array() {
				if h.Get("command").String() == cfg.ScriptPath() {
					found = true
				}
			}
		}
		if !found {
			t.Errorf("no entry for %s", ev)
		}
	}
	if got := read(t, res.BackupPath); got != fixture {
		t.Error("backup differs from original")
	}
	// Everything of the original that is not an added entry is untouched:
	// removing the added entries is the only difference.
	if !strings.Contains(installed, "\t\"model\":   \"x\",\n   \"hooks\" : {\n\t\"SessionStart\": [ {\"hooks\":[{\"type\":\"command\",\"command\":\"~/.merlin/a.sh\",\"timeout\":10}]} ,\n") {
		t.Error("prefix reformatted")
	}
	if !strings.HasSuffix(installed, "\t\"permissions\": {\"allow\": [\"Bash(ls)\"]}\n}") {
		t.Error("suffix / missing trailing newline changed")
	}

	if _, err := Uninstall(cfg); err != nil {
		t.Fatal(err)
	}
	if got := read(t, cfg.SettingsPath()); got != fixture {
		t.Errorf("not restored:\n%q\nwant\n%q", got, fixture)
	}
	if _, err := os.Stat(cfg.ScriptPath()); !os.IsNotExist(err) {
		t.Error("notify.sh not removed")
	}
}

func TestInstallTwiceEqualsOnce(t *testing.T) {
	s := fixture
	cfg := setup(t, &s)
	if _, err := Install(cfg); err != nil {
		t.Fatal(err)
	}
	once := read(t, cfg.SettingsPath())
	res, err := Install(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed() || res.BackupPath != "" {
		t.Errorf("second install changed things: %+v", res)
	}
	if read(t, cfg.SettingsPath()) != once {
		t.Error("second install changed the file")
	}
	if n := len(backups(t, cfg)); n != 1 {
		t.Errorf("%d backups, want 1", n)
	}
}

func TestPartialInstallAddsOnlyMissing(t *testing.T) {
	s := fixture
	cfg := setup(t, &s)
	if _, err := Install(cfg); err != nil {
		t.Fatal(err)
	}
	full := read(t, cfg.SettingsPath())
	// Remove only the Stop entry by hand-built uninstall of one event is not
	// exposed; emulate by editing the string.
	doc, removed, err := removeEntries(full)
	if err != nil || len(removed) != len(Events) {
		t.Fatalf("%v %v", removed, err)
	}
	if doc != fixture {
		t.Fatal("removeEntries did not restore")
	}
}

func TestMissingFileAndMissingHooksKey(t *testing.T) {
	cfg := setup(t, nil)
	if _, err := Install(cfg); err != nil {
		t.Fatal(err)
	}
	if !gjson.Valid(read(t, cfg.SettingsPath())) || len(gjson.Get(read(t, cfg.SettingsPath()), "hooks").Map()) != len(Events) {
		t.Fatalf("bad created file:\n%s", read(t, cfg.SettingsPath()))
	}
	if len(backups(t, cfg)) != 0 {
		t.Error("backup made for a file that did not exist")
	}

	for _, orig := range []string{"{}", "{ }\n", "{\n  \"model\": \"x\"\n}\n", "{\"a\":1}", "{\n  \"hooks\": {\n    \"Stop\": []\n  }\n}"} {
		o := orig
		cfg := setup(t, &o)
		if _, err := Install(cfg); err != nil {
			t.Fatalf("%q: %v", orig, err)
		}
		if !gjson.Valid(read(t, cfg.SettingsPath())) {
			t.Fatalf("%q: invalid result", orig)
		}
		if _, err := Uninstall(cfg); err != nil {
			t.Fatal(err)
		}
		got := read(t, cfg.SettingsPath())
		// An already-empty Stop array is indistinguishable from one we created.
		if orig == "{\n  \"hooks\": {\n    \"Stop\": []\n  }\n}" {
			continue
		}
		if got != orig {
			t.Errorf("%q restored as %q", orig, got)
		}
	}
}

func TestUninstallLeavesForeignAndMixedGroups(t *testing.T) {
	cfg := setup(t, nil)
	script := cfg.ScriptPath()
	mixed := `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep.sh"},{"type":"command","command":` + quote(script) + `}]}]}}`
	if err := os.WriteFile(cfg.SettingsPath(), []byte(mixed), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Uninstall(cfg); err != nil {
		t.Fatal(err)
	}
	want := `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep.sh"}]}]}}`
	if got := read(t, cfg.SettingsPath()); got != want {
		t.Errorf("got %s", got)
	}
}

func TestInvalidSettingsRefused(t *testing.T) {
	for _, bad := range []string{"{not json", "[]", `{"hooks": []}`, `{"hooks": {"Stop": {}}}`} {
		b := bad
		cfg := setup(t, &b)
		if _, err := Install(cfg); err == nil {
			t.Errorf("%q: expected error", bad)
		}
		if read(t, cfg.SettingsPath()) != bad {
			t.Errorf("%q: file modified", bad)
		}
		if len(backups(t, cfg)) != 0 {
			t.Errorf("%q: backup written", bad)
		}
	}
}

func TestStatus(t *testing.T) {
	s := fixture
	cfg := setup(t, &s)
	sts, err := Status(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, st := range sts {
		if st.State != Missing {
			t.Errorf("%s: %s", st.Event, st.State)
		}
	}
	// Binary absent: installed entries point at a missing binary.
	if _, err := Install(cfg); err != nil {
		t.Fatal(err)
	}
	sts, _ = Status(cfg)
	for _, st := range sts {
		if st.State != MissingBinary {
			t.Errorf("%s: %s", st.Event, st.State)
		}
	}
	if err := os.MkdirAll(filepath.Dir(cfg.Binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg.Binary, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	sts, _ = Status(cfg)
	for _, st := range sts {
		if st.State != Installed {
			t.Errorf("%s: %s %s", st.Event, st.State, st.Detail)
		}
	}
}

func TestScriptIsSilentAndExitsZero(t *testing.T) {
	s := "{}"
	cfg := setup(t, &s)
	if _, err := Install(cfg); err != nil {
		t.Fatal(err)
	}
	// Binary missing.
	out, err := runScript(cfg, "{}")
	if err != nil || out != "" {
		t.Fatalf("missing binary: err=%v out=%q", err, out)
	}
	// Binary noisy and failing: output is discarded; we cannot hide its exit
	// code (exec), but explorer hook itself always exits 0.
	if err := os.MkdirAll(filepath.Dir(cfg.Binary), 0o755); err != nil {
		t.Fatal(err)
	}
	stdinCopy := filepath.Join(t.TempDir(), "in")
	script := "#!/bin/sh\necho noise\necho err >&2\ncat > " + shellQuote(stdinCopy) + "\nexit 0\n"
	if err := os.WriteFile(cfg.Binary, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	out, err = runScript(cfg, `{"x":1}`)
	if err != nil || out != "" {
		t.Fatalf("err=%v out=%q", err, out)
	}
	if got := read(t, stdinCopy); got != `{"x":1}` {
		t.Errorf("stdin not forwarded: %q", got)
	}
}

func runScript(cfg Config, stdin string) (string, error) {
	cmd := execCommand(cfg.ScriptPath())
	cmd.Stdin = strings.NewReader(stdin)
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	return buf.String(), err
}

func TestNotifyDelivers(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = r.URL.Path + " " + string(b)
	}))
	defer srv.Close()
	if err := Notify(strings.NewReader(`{"hook_event_name":"Stop"}`), portOf(srv), Timeout); err != nil {
		t.Fatal(err)
	}
	if got != `/hook {"hook_event_name":"Stop"}` {
		t.Errorf("got %q", got)
	}
}

func TestNotifyFailuresAreErrorsNotHangs(t *testing.T) {
	// Nothing listening.
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	if Notify(strings.NewReader(`{}`), port, Timeout) == nil {
		t.Error("expected error with no daemon")
	}
	// Garbage stdin never reaches the server.
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit = true }))
	defer srv.Close()
	if Notify(strings.NewReader("garbage"), portOf(srv), Timeout) == nil || hit {
		t.Error("garbage should be dropped")
	}
	// Slow server.
	slow := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { time.Sleep(time.Second) }))
	defer slow.Close()
	start := time.Now()
	if Notify(strings.NewReader(`{}`), portOf(slow), Timeout) == nil {
		t.Error("expected timeout")
	}
	if d := time.Since(start); d > 400*time.Millisecond {
		t.Errorf("took %v", d)
	}
	// Stdin that never closes.
	pr, pw := io.Pipe()
	defer pw.Close()
	start = time.Now()
	if Notify(pr, port, Timeout) == nil || time.Since(start) > 400*time.Millisecond {
		t.Error("blocked stdin not bounded")
	}
}

func portOf(srv *httptest.Server) int {
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

func TestConfigPort(t *testing.T) {
	d := t.TempDir()
	if Port(d) != DefaultPort {
		t.Error("default")
	}
	os.WriteFile(filepath.Join(d, "config.json"), []byte(`{"port": 9000, "other": 1}`), 0o600)
	if Port(d) != 9000 {
		t.Error("configured")
	}
	os.WriteFile(filepath.Join(d, "config.json"), []byte(`nonsense`), 0o600)
	if Port(d) != DefaultPort {
		t.Error("garbage config")
	}
}
