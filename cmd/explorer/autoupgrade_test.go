package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// logs collects the daemon's log lines.
type logs struct {
	mu    sync.Mutex
	lines []string
}

func (l *logs) logf(format string, a ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, a...))
}

func (l *logs) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

func (l *logs) count(sub string) int { return strings.Count(l.text(), sub) }

// quietEnv clears every switch that could leak in from the machine running the tests.
func quietEnv(t *testing.T) string {
	t.Helper()
	t.Setenv("MERLIN_AUTO_UPGRADE", "")
	os.Unsetenv("MERLIN_AUTO_UPGRADE")
	t.Setenv(upgradedFromEnv, "")
	os.Unsetenv(upgradedFromEnv)
	return t.TempDir()
}

func TestAutoUpgradeInstalls(t *testing.T) {
	home := quietEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	var l logs
	if !au.run(context.Background(), l.logf) {
		t.Fatalf("run = false; log:\n%s", l.text())
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.3") {
		t.Errorf("binary not replaced: %q", contents(t, real))
	}
	prev := filepath.Join(filepath.Dir(real), prevName)
	if !strings.Contains(contents(t, prev), "merlin 0.6.2") {
		t.Errorf("%s does not hold the old binary", prevName)
	}
	if fi, err := os.Stat(prev); err != nil || fi.Mode()&0o111 == 0 {
		t.Errorf("prev not executable: %v %v", fi, err)
	}
	if !au.wasInstalled() {
		t.Error("wasInstalled = false")
	}
	for _, want := range []string{"auto-upgrade: 0.6.2 -> 0.6.3 available", "auto-upgrade: installed 0.6.3"} {
		if l.count(want) != 1 {
			t.Errorf("log lacks %q:\n%s", want, l.text())
		}
	}
	if l := leftovers(t, filepath.Dir(real)); len(l) != 0 {
		t.Errorf("staged files left: %v", l)
	}
}

func TestAutoUpgradeSkips(t *testing.T) {
	for _, tc := range []struct {
		name    string
		current string
		latest  string
		flag    bool
		env     string // MERLIN_AUTO_UPGRADE, "" = unset
		config  string
		bad     string
		want    string // log line
	}{
		{name: "dev build", current: "0.6.2-dev", latest: "0.6.3", want: "development build"},
		{name: "no version", current: "dev", latest: "0.6.3", want: "development build"},
		{name: "flag", current: "0.6.2", latest: "0.6.3", flag: true, want: "--no-auto-upgrade"},
		{name: "env 0", current: "0.6.2", latest: "0.6.3", env: "0", want: "MERLIN_AUTO_UPGRADE=0"},
		{name: "env false", current: "0.6.2", latest: "0.6.3", env: "false", want: "MERLIN_AUTO_UPGRADE=false"},
		{name: "config", current: "0.6.2", latest: "0.6.3", config: `{"autoUpgrade": false}`, want: "autoUpgrade is false"},
		{name: "flag beats env on", current: "0.6.2", latest: "0.6.3", flag: true, env: "1", want: "--no-auto-upgrade"},
		{name: "env 0 beats config on", current: "0.6.2", latest: "0.6.3", env: "0", config: `{"autoUpgrade": true}`, want: "MERLIN_AUTO_UPGRADE=0"},
		{name: "bad version", current: "0.6.2", latest: "0.6.3", bad: `{"bad":["0.6.3"]}`, want: "skipping 0.6.3"},
		{name: "not newer", current: "0.6.3", latest: "0.6.3", want: "is current"},
		{name: "older latest", current: "0.7.0", latest: "0.6.3", want: "is current"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := quietEnv(t)
			if tc.env != "" {
				t.Setenv("MERLIN_AUTO_UPGRADE", tc.env)
			}
			if tc.config != "" {
				os.WriteFile(filepath.Join(home, "config.json"), []byte(tc.config), 0o644)
			}
			if tc.bad != "" {
				os.WriteFile(filepath.Join(home, upgradeFile), []byte(tc.bad), 0o644)
			}
			rel := &fakeRelease{latest: tc.latest}
			rel.start(t)
			real := installed(t, tc.current)
			au := newAutoUpgrader(home, tc.flag)
			var l logs
			for range 3 { // a standing reason is logged once, not at every check
				if au.run(context.Background(), l.logf) {
					t.Fatal("run = true")
				}
			}
			if l.count(tc.want) != 1 {
				t.Errorf("want one %q line, log:\n%s", tc.want, l.text())
			}
			if rel.downloads != 0 || au.wasInstalled() || !strings.Contains(contents(t, real), "merlin "+tc.current) {
				t.Error("something was installed")
			}
		})
	}
}

func TestAutoUpgradeEnvAndConfigPrecedence(t *testing.T) {
	home := quietEnv(t)
	os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"autoUpgrade": false}`), 0o644)
	t.Setenv("MERLIN_AUTO_UPGRADE", "1")
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	installed(t, "0.6.2")
	var l logs
	if !newAutoUpgrader(home, false).run(context.Background(), l.logf) {
		t.Fatalf("env 1 should beat config false; log:\n%s", l.text())
	}
}

func TestAutoUpgradeSeesConfigEdits(t *testing.T) {
	home := quietEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	var l logs
	os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"autoUpgrade": false}`), 0o644)
	if au.run(context.Background(), l.logf) {
		t.Fatal("upgraded with autoUpgrade false")
	}
	os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"autoUpgrade": true}`), 0o644)
	if !au.run(context.Background(), l.logf) {
		t.Fatalf("did not upgrade after the edit; log:\n%s", l.text())
	}
}

func TestAutoUpgradeUnwritableDestination(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can write anywhere")
	}
	home := quietEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2")
	dir := filepath.Dir(real)
	os.Chmod(dir, 0o555)
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
	au := newAutoUpgrader(home, false)
	var l logs
	for range 2 {
		if au.run(context.Background(), l.logf) {
			t.Fatal("run = true")
		}
	}
	if l.count("sudo ") != 1 || !strings.Contains(l.text(), "cannot write to "+dir) {
		t.Errorf("want the sudo hint once, log:\n%s", l.text())
	}
	if rel.checks != 0 {
		t.Error("asked the network although the directory is not writable")
	}
}

func TestAutoUpgradeNetworkError(t *testing.T) {
	home := quietEnv(t)
	installed(t, "0.6.2")
	setVar(t, &releasesURL, "http://127.0.0.1:1") // nothing listens there
	var l logs
	if newAutoUpgrader(home, false).run(context.Background(), l.logf) {
		t.Fatal("run = true")
	}
	if l.count("auto-upgrade: check failed") != 1 {
		t.Errorf("log:\n%s", l.text())
	}
}

func TestAutoUpgradeRefusesBadDownload(t *testing.T) {
	home := quietEnv(t)
	rel := &fakeRelease{latest: "0.6.3", badSum: true}
	rel.start(t)
	real := installed(t, "0.6.2")
	var l logs
	au := newAutoUpgrader(home, false)
	if au.run(context.Background(), l.logf) || au.wasInstalled() {
		t.Fatal("installed a binary with a bad checksum")
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.2") {
		t.Error("binary replaced")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(real), prevName)); err == nil {
		t.Error("prev created without a swap")
	}
}

func TestBinaryChanged(t *testing.T) {
	home := quietEnv(t)
	real := installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	if au.binaryChanged() {
		t.Fatal("changed with nothing touched")
	}
	// Rewritten but the same version: no restart, and not asked again.
	os.WriteFile(real, []byte("#!/bin/sh\n# padded\necho merlin 0.6.2\n"), 0o755)
	if au.binaryChanged() || au.binaryChanged() {
		t.Fatal("changed for the same version")
	}
	// A different version.
	os.WriteFile(real, []byte("#!/bin/sh\n# padded more\necho merlin 0.7.0\n"), 0o755)
	if !au.binaryChanged() {
		t.Fatal("not changed for a new version")
	}
	// A broken file (mid-write) is looked at again next time rather than trusted.
	os.WriteFile(real, []byte("#!/bin/sh\nexit 1\n"), 0o755)
	if au.binaryChanged() || au.binaryChanged() {
		t.Fatal("changed for a binary that does not run")
	}
	os.WriteFile(real, []byte("#!/bin/sh\n# fixed up\necho merlin 0.8.0\n"), 0o755)
	if !au.binaryChanged() {
		t.Fatal("missed the finished file")
	}
}

// captureExec replaces execBinary with a recorder.
type execCall struct {
	path string
	argv []string
	env  []string
}

func captureExec(t *testing.T) *[]execCall {
	t.Helper()
	var calls []execCall
	setVar(t, &execBinary, func(p string, argv, env []string) error {
		calls = append(calls, execCall{p, argv, env})
		return errors.New("exec captured")
	})
	return &calls
}

func envHas(env []string, kv string) bool {
	for _, e := range env {
		if e == kv {
			return true
		}
	}
	return false
}

func TestRestartSelf(t *testing.T) {
	home := quietEnv(t)
	real := installed(t, "0.6.2")
	calls := captureExec(t)

	if err := restartSelf(home, true); err == nil || err.Error() != "exec captured" {
		t.Fatalf("err = %v", err)
	}
	c := (*calls)[0]
	if c.path != real {
		t.Errorf("exec path = %s, want the resolved binary %s", c.path, real)
	}
	if strings.Join(c.argv, " ") != strings.Join(os.Args, " ") {
		t.Errorf("argv = %v, want %v", c.argv, os.Args)
	}
	if !envHas(c.env, upgradedFromEnv+"=0.6.2") {
		t.Errorf("env lacks %s=0.6.2", upgradedFromEnv)
	}
	if !strings.Contains(contents(t, filepath.Join(home, "merlin.log")), "auto-upgrade: re-exec "+real) {
		t.Error("re-exec not logged")
	}

	// A restart for a binary someone else installed carries no rollback marker, even if
	// this process itself was one that followed an upgrade.
	t.Setenv(upgradedFromEnv, "0.5.0")
	restartSelf(home, false)
	for _, e := range (*calls)[1].env {
		if strings.HasPrefix(e, upgradedFromEnv+"=") {
			t.Errorf("env carries %s", e)
		}
	}
}

func TestRollbackRestoresPreviousBinary(t *testing.T) {
	home := quietEnv(t)
	real := installed(t, "0.6.3") // this process is the new version
	prev := filepath.Join(filepath.Dir(real), prevName)
	os.WriteFile(prev, []byte("#!/bin/sh\necho merlin 0.6.2\n"), 0o755)
	t.Setenv(upgradedFromEnv, "0.6.2")
	calls := captureExec(t)

	if err := rollback(home, errors.New("cannot listen")); err == nil || err.Error() != "exec captured" {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.2") {
		t.Errorf("binary not restored: %q", contents(t, real))
	}
	if _, err := os.Stat(prev); err == nil {
		t.Error("prev still there")
	}
	if got := loadBad(home); len(got) != 1 || got[0] != "0.6.3" {
		t.Errorf("bad = %v", got)
	}
	c := (*calls)[0]
	if c.path != real {
		t.Errorf("exec path = %s", c.path)
	}
	for _, e := range c.env {
		if strings.HasPrefix(e, upgradedFromEnv+"=") {
			t.Errorf("restored binary inherits %s: no loops allowed", e)
		}
	}
	log := contents(t, filepath.Join(home, "merlin.log"))
	if !strings.Contains(log, "rolled back 0.6.3 (cannot listen)") {
		t.Errorf("log = %q", log)
	}

	// The version recorded as bad is not tried again.
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	setVar(t, &version, "0.6.2")
	var l logs
	if newAutoUpgrader(home, false).run(context.Background(), l.logf) || rel.downloads != 0 {
		t.Error("tried the bad version again")
	}
}

func TestRollbackWithoutPrevious(t *testing.T) {
	home := quietEnv(t)
	real := installed(t, "0.6.3")
	calls := captureExec(t)
	if err := rollback(home, errors.New("boom")); err == nil || !strings.Contains(err.Error(), "cannot roll back") {
		t.Fatalf("err = %v", err)
	}
	if len(*calls) != 0 {
		t.Error("exec'd although nothing was restored")
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.3") {
		t.Error("binary changed")
	}
	if got := loadBad(home); len(got) != 1 {
		t.Errorf("bad = %v; the version should still be recorded", got)
	}
}

func TestMarkBadIsIdempotent(t *testing.T) {
	home := t.TempDir()
	markBad(home, "0.7.0")
	markBad(home, "0.7.0")
	markBad(home, "0.8.0")
	if got := loadBad(home); len(got) != 2 {
		t.Errorf("bad = %v", got)
	}
	if b := contents(t, filepath.Join(home, upgradeFile)); !strings.Contains(b, `"bad":["0.7.0","0.8.0"]`) {
		t.Errorf("file = %s", b)
	}
}

func TestReleasesEnvOverride(t *testing.T) {
	setVar(t, &releasesURL, "x")
	t.Setenv("MERLIN_RELEASES_URL", "http://127.0.0.1:9/")
	applyReleasesEnv()
	if releasesURL != "http://127.0.0.1:9" {
		t.Errorf("releasesURL = %q", releasesURL)
	}
}
