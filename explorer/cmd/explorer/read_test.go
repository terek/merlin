package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/fixtures"
)

var update = flag.Bool("update", false, "rewrite the snapshots under testdata/")

// The read commands are tested against a store built by `merlin scan` over a copy of
// the fixture tree, in New York time (scenario 19 depends on it) with a fixed "now" and
// with the two fixture registry entries (pids 4242 and 4343) treated as alive.
const (
	testNow = "2026-09-22T18:00:00Z"
	testTZ  = "America/New_York"
)

type readEnv struct {
	t           *testing.T
	home, claud string
}

// newReadEnv copies the fixtures and scans them.
func newReadEnv(t *testing.T) *readEnv {
	t.Helper()
	if _, err := time.LoadLocation(testTZ); err != nil {
		t.Skipf("no tzdata for %s: %v", testTZ, err)
	}
	e := &readEnv{t: t, home: t.TempDir(), claud: t.TempDir()}
	src := fixtures.ClaudeDir()
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(e.claud, rel), 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		dst := filepath.Join(e.claud, rel)
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			return err
		}
		// A fixed mtime keeps the digests' source fingerprints, and so the JSON output
		// of show, the same on every run.
		stamp := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)
		return os.Chtimes(dst, stamp, stamp)
	})
	if err != nil {
		t.Fatal(err)
	}
	if out, errs, code := e.run(nil, "scan", "--quiet"); code != 0 {
		t.Fatalf("scan: code %d\n%s\n%s", code, out, errs)
	}
	return e
}

// run executes the CLI and returns stdout, stderr and the exit code. Paths of the
// temporary directories are replaced by $EXPLORER_HOME and $CLAUDE_CONFIG_DIR.
func (e *readEnv) run(extraEnv []string, args ...string) (stdout, stderr string, code int) {
	e.t.Helper()
	cmd := exec.Command(os.Args[0], args...)
	cmd.Env = append([]string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + e.t.TempDir(),
		"EXPLORER_TEST_AS_CLI=1", "EXPLORER_HOME=" + e.home, "CLAUDE_CONFIG_DIR=" + e.claud,
		"TZ=" + testTZ, "EXPLORER_NOW=" + testNow, "EXPLORER_TEST_ALIVE_PIDS=4242,4343",
	}, extraEnv...)
	var o, er bytes.Buffer
	cmd.Stdout, cmd.Stderr = &o, &er
	if err := cmd.Run(); err != nil {
		ee, ok := err.(*exec.ExitError)
		if !ok {
			e.t.Fatal(err)
		}
		code = ee.ExitCode()
	}
	norm := strings.NewReplacer(e.home, "$EXPLORER_HOME", e.claud, "$CLAUDE_CONFIG_DIR")
	return norm.Replace(o.String()), norm.Replace(er.String()), code
}

// snapshot compares got with testdata/<name>; JSON by value, text exactly.
func snapshot(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	wantB, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update to create it)", err)
	}
	want := string(wantB)
	if strings.HasSuffix(name, ".json") {
		var g, w any
		if err := json.Unmarshal([]byte(got), &g); err != nil {
			t.Fatalf("%s: output is not JSON: %v\n%s", name, err, got)
		}
		if err := json.Unmarshal(wantB, &w); err != nil {
			t.Fatalf("%s: snapshot is not JSON: %v", name, err)
		}
		if !reflect.DeepEqual(g, w) {
			t.Errorf("%s differs from the snapshot (run with -update, review the diff):\n%s", name, got)
		}
		return
	}
	if got != want {
		t.Errorf("%s differs from the snapshot (run with -update, review the diff).\n--- got ---\n%s\n--- want ---\n%s", name, got, want)
	}
}

type snapCase struct {
	name string
	env  []string
	args []string
}

func TestReadCommandSnapshots(t *testing.T) {
	e := newReadEnv(t)
	const (
		plain     = "01010101"
		compact   = "05050505-0000-4000-8000-000000000001"
		compactD  = "05050505-0000-4000-8000-000000000004"
		syncAgent = "06060606"
		bgAgent   = "07070707"
		nested    = "08080808"
		team      = "09090909"
		forks     = "10101010"
		linkage   = "11111111"
		orphan    = "12121212"
		contA     = "13131313-0000-4000-8000-000000000001"
		contB     = "13131313-0000-4000-8000-000000000002"
		forkB     = "13131313-0000-4000-8000-000000000004"
		partial   = "13131313-0000-4000-8000-000000000008"
		rewind    = "14141414"
		costState = "16161616"
		cwdChange = "18181818"
		day       = "19191919"
		inner     = "22222222-0000-4000-8000-000000000002"
	)
	cases := []snapCase{
		{name: "sessions", args: []string{"sessions"}},
		{name: "sessions-narrow", env: []string{"COLUMNS=100"}, args: []string{"sessions", "--limit", "12"}},
		{name: "sessions-project", args: []string{"sessions", "--project", "acme/nest"}},
		{name: "sessions-project-last", args: []string{"sessions", "--project", "inner"}},
		{name: "sessions-since", args: []string{"sessions", "--since", "3d"}},
		{name: "sessions-since-date", args: []string{"sessions", "--since", "2026-09-16", "--kind", "interactive", "--limit", "3"}},
		{name: "sessions-background", args: []string{"sessions", "--kind", "background"}},
		{name: "sessions.json", args: []string{"sessions", "--json"}},

		{name: "show-plain", args: []string{"show", plain}},
		{name: "show-compaction", args: []string{"show", compact}},
		{name: "show-compaction-summaries", args: []string{"show", compact, "--summaries"}},
		{name: "show-compaction-agent", args: []string{"show", compactD}},
		{name: "show-sync-agent", args: []string{"show", syncAgent}},
		{name: "show-background-agent-full", args: []string{"show", bgAgent, "--full"}},
		{name: "show-nested-agents", args: []string{"show", nested}},
		{name: "show-teammate", args: []string{"show", team}},
		{name: "show-fork-agents", args: []string{"show", forks}},
		{name: "show-linkage", args: []string{"show", linkage}},
		{name: "show-orphan", args: []string{"show", orphan}},
		{name: "show-continuation-parent", args: []string{"show", contA}},
		{name: "show-continuation-child", args: []string{"show", contB}},
		{name: "show-continuation-child-inherited", args: []string{"show", contB, "--inherited"}},
		{name: "show-fork-child", args: []string{"show", forkB}},
		{name: "show-partial-copy", args: []string{"show", partial, "--summaries"}},
		{name: "show-rewind", args: []string{"show", rewind}},
		{name: "show-cost-state", args: []string{"show", costState}},
		{name: "show-cwd-change", args: []string{"show", cwdChange}},
		{name: "show-day-boundary", args: []string{"show", day}},
		{name: "show-nested-project", args: []string{"show", inner}},
		{name: "show-prefix", args: []string{"show", "0101"}},
		{name: "show-cost-state.json", args: []string{"show", costState, "--json"}},
		{name: "show-continuation-child.json", args: []string{"show", contB, "--json"}},

		{name: "search-terms", args: []string{"search", "search", "box"}},
		{name: "search-continued", args: []string{"search", "style the"}},
		{name: "search-final", args: []string{"search", "added", "--limit", "5"}},
		{name: "search-compaction", args: []string{"search", "seed", "data"}},
		{name: "search-project", args: []string{"search", "session", "--project", "inner"}},
		{name: "search-since", args: []string{"search", "add", "--since", "2d"}},
		{name: "search-none", args: []string{"search", "zzzzqqqq"}},
		{name: "search.json", args: []string{"search", "search", "box", "--limit", "4", "--json"}},

		{name: "cost-project", args: []string{"cost"}},
		{name: "cost-day", args: []string{"cost", "--by", "day"}},
		{name: "cost-day-since", args: []string{"cost", "--by", "day", "--since", "7d"}},
		{name: "cost-model", args: []string{"cost", "--by", "model"}},
		{name: "cost-kind", args: []string{"cost", "--by", "kind"}},
		{name: "cost-session", args: []string{"cost", "--by", "session", "--limit", "6"}},
		{name: "cost-session-since", args: []string{"cost", "--by", "session", "--since", "5d"}},
		{name: "cost-project-filter", args: []string{"cost", "--by", "model", "--project", "coststate"}},
		{name: "cost-project.json", args: []string{"cost", "--json"}},
		{name: "cost-day.json", args: []string{"cost", "--by", "day", "--json"}},
		{name: "cost-model.json", args: []string{"cost", "--by", "model", "--json"}},
		{name: "cost-session.json", args: []string{"cost", "--by", "session", "--limit", "3", "--json"}},

		{name: "doctor", args: []string{"doctor"}},
		{name: "doctor.json", args: []string{"doctor", "--json"}},
		{name: "doctor-all-versions", args: []string{"doctor", "--all-versions"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, errs, code := e.run(c.env, c.args...)
			if code != 0 || errs != "" {
				t.Fatalf("exit %d, stderr %q", code, errs)
			}
			name := c.name
			if !strings.HasSuffix(name, ".json") {
				name += ".txt"
			}
			snapshot(t, name, out)
		})
	}
}

func TestReadCommandErrors(t *testing.T) {
	e := newReadEnv(t)
	cases := []struct {
		name    string
		args    []string
		code    int
		errHas  []string
		outHas  []string
		outNone []string
	}{
		{name: "ambiguous prefix", args: []string{"show", "1313"}, code: 1,
			errHas: []string{`"1313" matches 10 sessions`, "13131313-0000-4000-8000-000000000001", "13131313-0000-4000-8000-000000000010", "s13d-partial-copy"}},
		{name: "unknown id", args: []string{"show", "ffff"}, code: 1, errHas: []string{`no session matches "ffff"`}},
		{name: "show without id", args: []string{"show"}, code: 2, errHas: []string{"expected exactly one session id"}},
		{name: "show two ids", args: []string{"show", "0101", "0202"}, code: 2},
		{name: "unknown flag", args: []string{"sessions", "--bogus"}, code: 2, errHas: []string{"merlin sessions", "--help"}},
		{name: "positional on sessions", args: []string{"sessions", "x"}, code: 2},
		{name: "bad since", args: []string{"sessions", "--since", "yesterday-ish"}, code: 2, errHas: []string{"--since"}},
		{name: "unknown project", args: []string{"sessions", "--project", "nope"}, code: 1, errHas: []string{`no project matches "nope"`}},
		{name: "ambiguous project", args: []string{"cost", "--project", "acme"}, code: 1, errHas: []string{"matches"}},
		{name: "sdk kind", args: []string{"sessions", "--kind", "sdk"}, code: 2, errHas: []string{"aggregate"}},
		{name: "bad kind", args: []string{"sessions", "--kind", "weird"}, code: 2},
		{name: "bad by", args: []string{"cost", "--by", "week"}, code: 2, errHas: []string{`unknown --by "week"`}},
		{name: "search without terms", args: []string{"search"}, code: 2, errHas: []string{"at least one search term"}},
		{name: "flags after the id", args: []string{"show", "0101", "--full"}, code: 0, outHas: []string{"Add login page"}},
		{name: "flags between terms", args: []string{"search", "login", "--limit", "1", "page"}, code: 0, outHas: []string{"1 of "}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, errs, code := e.run(nil, c.args...)
			if code != c.code {
				t.Errorf("exit %d, want %d\nstdout: %s\nstderr: %s", code, c.code, out, errs)
			}
			for _, s := range c.errHas {
				if !strings.Contains(errs, s) {
					t.Errorf("stderr lacks %q:\n%s", s, errs)
				}
			}
			for _, s := range c.outHas {
				if !strings.Contains(out, s) {
					t.Errorf("stdout lacks %q:\n%s", s, out)
				}
			}
			if code != 0 && out != "" {
				t.Errorf("an error left output on stdout: %q", out)
			}
		})
	}
}

func TestReadCommandHelp(t *testing.T) {
	e := newReadEnv(t)
	for _, name := range []string{"sessions", "show", "search", "cost", "doctor"} {
		for _, flagName := range []string{"--help", "-h"} {
			out, errs, code := e.run(nil, name, flagName)
			if code != 0 || errs != "" || !strings.HasPrefix(out, "Usage: merlin "+name) {
				t.Errorf("%s %s: exit %d, stderr %q, stdout %.60q", name, flagName, code, errs, out)
			}
			if !strings.Contains(out, "--json") {
				t.Errorf("%s help does not mention --json", name)
			}
		}
	}
	out, _, _ := e.run(nil, "sessions", "--help")
	snapshot(t, "help-sessions.txt", out)
}

func TestEmptyStore(t *testing.T) {
	e := &readEnv{t: t, home: t.TempDir(), claud: t.TempDir()}
	for _, args := range [][]string{{"sessions"}, {"cost"}, {"search", "x"}, {"doctor"}} {
		out, errs, code := e.run(nil, args...)
		if code != 0 || !strings.Contains(errs, "merlin scan") {
			t.Errorf("%v: exit %d, stderr %q, stdout %q", args, code, errs, out)
		}
	}
	out, _, code := e.run(nil, "sessions", "--json")
	if code != 0 || !strings.Contains(out, `"sessions": []`) {
		t.Errorf("empty --json: exit %d %q", code, out)
	}
}

func TestNoColourEscapes(t *testing.T) {
	e := newReadEnv(t)
	for _, args := range [][]string{{"sessions"}, {"show", "0101"}, {"cost"}, {"doctor"}, {"search", "login"}} {
		out, _, _ := e.run([]string{"NO_COLOR="}, args...)
		if strings.Contains(out, "\x1b[") {
			t.Errorf("%v prints escape codes", args)
		}
	}
}

func TestParseSince(t *testing.T) {
	loc, err := time.LoadLocation(testTZ)
	if err != nil {
		t.Skip(err)
	}
	old := time.Local
	time.Local = loc
	defer func() { time.Local = old }()
	now := time.Date(2026, 9, 22, 18, 0, 0, 0, time.UTC)
	cases := []struct {
		in   string
		want time.Time
		bad  bool
	}{
		{in: "", want: time.Time{}},
		{in: "90m", want: now.Add(-90 * time.Minute)},
		{in: "36h", want: now.Add(-36 * time.Hour)},
		{in: "7d", want: now.AddDate(0, 0, -7)},
		{in: "2w", want: now.AddDate(0, 0, -14)},
		{in: "2026-09-01", want: time.Date(2026, 9, 1, 0, 0, 0, 0, loc)},
		{in: "soon", bad: true},
		{in: "-3d", bad: true},
		{in: "d", bad: true},
	}
	for _, c := range cases {
		got, err := parseSince(c.in, now)
		if (err != nil) != c.bad || !got.Equal(c.want) {
			t.Errorf("parseSince(%q) = %v, %v; want %v (bad=%v)", c.in, got, err, c.want, c.bad)
		}
	}
}

func TestFormatters(t *testing.T) {
	for in, want := range map[float64]string{0: "$0", 0.0056: "$0.0056", 0.0212: "$0.021", 1.5: "$1.50", 2682.894: "$2,682.89", 1234567.1: "$1,234,567.10", -0.5: "-$0.500"} {
		if got := usd(in); got != want {
			t.Errorf("usd(%v) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{"/home/a/b": "/home/a/b", "/home/my dir": "'/home/my dir'", "/it's": `'/it'\''s'`, "": "''"} {
		if got := shellQuote(in); got != want {
			t.Errorf("shellQuote(%q) = %q, want %q", in, got, want)
		}
	}
	labels := projectLabels([]string{"/a/x/app", "/a/y/app", "/a/z/web", "/b/web2"})
	want := map[string]string{"/a/x/app": "x/app", "/a/y/app": "y/app", "/a/z/web": "web", "/b/web2": "web2"}
	if !reflect.DeepEqual(labels, want) {
		t.Errorf("projectLabels = %v, want %v", labels, want)
	}
	if got := resumeCommand("/p q", "id1"); got != "cd '/p q' && claude --resume id1" {
		t.Errorf("resumeCommand = %q", got)
	}
}

func TestWhen(t *testing.T) {
	loc, err := time.LoadLocation(testTZ)
	if err != nil {
		t.Skip(err)
	}
	old := time.Local
	time.Local = loc
	defer func() { time.Local = old }()
	now := time.Date(2026, 9, 22, 18, 0, 0, 0, time.UTC) // 14:00 local
	for _, c := range []struct {
		t    time.Time
		want string
	}{
		{now.Add(-30 * time.Second), "just now"},
		{now.Add(-12 * time.Minute), "12m ago"},
		{now.Add(-3 * time.Hour), "today 11:00"},
		{now.Add(-20 * time.Hour), "yesterday 18:00"},
		{now.Add(-9 * 24 * time.Hour), "Sep 13 14:00"},
		{now.Add(-400 * 24 * time.Hour), "2025 Aug 18"},
		{time.Time{}, "-"},
	} {
		if got := when(c.t, now); got != c.want {
			t.Errorf("when(%v) = %q, want %q", c.t, got, c.want)
		}
	}
}
