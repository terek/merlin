package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/terek/merlin/internal/config"
)

// The default is off, and off still looks and tells.

func TestAutoUpgradeOffByDefaultReportsEachVersionOnce(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	var l logs
	for range 3 {
		if au.run(context.Background(), l.logf) {
			t.Fatal("run = true with auto-upgrade off")
		}
	}
	if !strings.Contains(l.text(), "auto-upgrade: off (off by default; run merlin autoupgrade to turn it on)") {
		t.Errorf("log lacks the default reason:\n%s", l.text())
	}
	line := "update: merlin 0.6.3 is available (running 0.6.2); merlin upgrade installs it, merlin autoupgrade keeps merlin current"
	if l.count(line) != 1 {
		t.Errorf("want %q once, log:\n%s", line, l.text())
	}
	if au.available() != "0.6.3" {
		t.Errorf("available = %q", au.available())
	}
	if rel.downloads != 0 || !strings.Contains(contents(t, real), "merlin 0.6.2") {
		t.Error("something was installed")
	}

	// A newer release is a new line; the one before it is not repeated.
	rel.latest = "0.6.4"
	au.run(context.Background(), l.logf)
	if l.count("update: merlin 0.6.4 is available") != 1 || l.count("update: merlin 0.6.3 is available") != 1 || au.available() != "0.6.4" {
		t.Errorf("available %q, log:\n%s", au.available(), l.text())
	}

	// Once nothing is newer (the user installed it, or the release was pulled), nothing is available.
	rel.latest = "0.6.2"
	au.run(context.Background(), l.logf)
	if au.available() != "" {
		t.Errorf("available = %q after a current check", au.available())
	}
}

func TestAutoUpgradeReportsWhenSwitchedOff(t *testing.T) {
	for _, tc := range []struct {
		name   string
		flag   bool
		env    string
		config string
	}{
		{name: "flag", flag: true, config: `{"autoUpgrade": true}`},
		{name: "env", env: "0", config: `{"autoUpgrade": true}`},
		{name: "config false", config: `{"autoUpgrade": false}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := cleanEnv(t)
			os.WriteFile(filepath.Join(home, "config.json"), []byte(tc.config), 0o644)
			if tc.env != "" {
				t.Setenv("MERLIN_AUTO_UPGRADE", tc.env)
			}
			rel := &fakeRelease{latest: "0.6.3"}
			rel.start(t)
			installed(t, "0.6.2")
			au := newAutoUpgrader(home, tc.flag)
			var l logs
			if au.run(context.Background(), l.logf) || rel.downloads != 0 {
				t.Fatal("installed with auto-upgrade off")
			}
			if au.available() != "0.6.3" || l.count("update: merlin 0.6.3 is available") != 1 {
				t.Errorf("available %q, log:\n%s", au.available(), l.text())
			}
		})
	}
}

func TestAutoUpgradeDevBuildChecksNothing(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	installed(t, "0.6.2-dev")
	au := newAutoUpgrader(home, false)
	var l logs
	au.run(context.Background(), l.logf)
	if rel.checks != 0 || au.available() != "" || strings.Contains(l.text(), "update:") {
		t.Errorf("a development build looked: checks %d, available %q, log:\n%s", rel.checks, au.available(), l.text())
	}
}

func TestAutoUpgradeCheckFailureKeepsAvailable(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	var l logs
	au.run(context.Background(), l.logf)
	setVar(t, &releasesURL, "http://127.0.0.1:1") // nothing listens there
	au.run(context.Background(), l.logf)
	if au.available() != "0.6.3" || l.count("auto-upgrade: check failed") != 1 {
		t.Errorf("available %q, log:\n%s", au.available(), l.text())
	}
}

func TestAutoUpgradeDoesNotReportBadVersions(t *testing.T) {
	home := cleanEnv(t)
	os.WriteFile(filepath.Join(home, upgradeFile), []byte(`{"bad":["0.6.3"]}`), 0o644)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	var l logs
	au.run(context.Background(), l.logf)
	if au.available() != "" || strings.Contains(l.text(), "update:") {
		t.Errorf("reported a version that failed to start: %q\n%s", au.available(), l.text())
	}
}

func TestAutoUpgradePatchReportsTheNextLine(t *testing.T) {
	home := cleanEnv(t)
	os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"autoUpgrade": "patch"}`), 0o644)
	rel := &fakeRelease{latest: "0.7.0", extra: []string{"0.6.2"}}
	rel.start(t)
	installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	var l logs
	if au.run(context.Background(), l.logf) {
		t.Fatal("run = true")
	}
	if au.available() != "0.7.0" || l.count("update: merlin 0.7.0 is available (running 0.6.2)") != 1 {
		t.Errorf("available %q, log:\n%s", au.available(), l.text())
	}
}

func TestAutoUpgradeFailedInstallIsReported(t *testing.T) {
	home := quietEnv(t)
	rel := &fakeRelease{latest: "0.6.3", badSum: true}
	rel.start(t)
	installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	var l logs
	if au.run(context.Background(), l.logf) {
		t.Fatal("installed a binary with a bad checksum")
	}
	if au.available() != "0.6.3" || l.count("update: merlin 0.6.3 is available") != 1 {
		t.Errorf("available %q, log:\n%s", au.available(), l.text())
	}
}

func TestAutoUpgradeInstalledIsNotAvailable(t *testing.T) {
	home := quietEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	var l logs
	if !au.run(context.Background(), l.logf) || au.available() != "" || strings.Contains(l.text(), "update:") {
		t.Errorf("available %q, log:\n%s", au.available(), l.text())
	}
}

// merlin autoupgrade

func runSet(t *testing.T, home string, pol config.UpgradePolicy) (code int, out, errw string) {
	t.Helper()
	var o, e bytes.Buffer
	code = autoupgradeSet(&o, &e, home, pol)
	return code, o.String(), e.String()
}

func TestAutoupgradeOnWritesAndInstalls(t *testing.T) {
	home := cleanEnv(t)
	os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"port": 8123}`), 0o600)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2")
	code, out, errw := runSet(t, home, config.UpgradeOn)
	if code != 0 || errw != "" {
		t.Fatalf("code %d, stderr %q", code, errw)
	}
	if c, _ := config.Load(home); c.AutoUpgrade != config.UpgradeOn || c.Port != 8123 {
		t.Errorf("config = %+v", c)
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.3") {
		t.Errorf("not installed: %q", contents(t, real))
	}
	for _, want := range []string{"Auto-upgrade is on", "Upgrading merlin 0.6.2 to 0.6.3", "installed", "within a minute"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if p, _ := upgradePolicy(home, false); p != config.UpgradeOn {
		t.Errorf("policy = %q", p)
	}
}

func TestAutoupgradeCreatesTheConfig(t *testing.T) {
	home := filepath.Join(cleanEnv(t), "new-home")
	rel := &fakeRelease{latest: "0.6.2"}
	rel.start(t)
	installed(t, "0.6.2")
	code, out, _ := runSet(t, home, config.UpgradeOn)
	if code != 0 || !strings.Contains(out, "merlin 0.6.2 is up to date.") {
		t.Errorf("code %d, output:\n%s", code, out)
	}
	if b := contents(t, filepath.Join(home, "config.json")); b != "{\n  \"autoUpgrade\": true\n}\n" {
		t.Errorf("config = %q", b)
	}
}

func TestAutoupgradePatchInstallsWithinTheLine(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.7.0", extra: []string{"0.6.2", "0.6.3"}}
	rel.start(t)
	real := installed(t, "0.6.1")
	code, out, errw := runSet(t, home, config.UpgradePatch)
	if code != 0 || errw != "" {
		t.Fatalf("code %d, stderr %q", code, errw)
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.3") || !strings.Contains(contents(t, filepath.Join(home, "config.json")), `"autoUpgrade": "patch"`) {
		t.Errorf("binary %q", contents(t, real))
	}
	if !strings.Contains(out, "patch releases") {
		t.Errorf("output:\n%s", out)
	}
}

func TestAutoupgradeOffOnlyWrites(t *testing.T) {
	home := quietEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2")
	code, out, _ := runSet(t, home, config.UpgradeOff)
	if code != 0 || rel.checks != 0 || rel.downloads != 0 || !strings.Contains(contents(t, real), "merlin 0.6.2") {
		t.Errorf("code %d, checks %d, downloads %d", code, rel.checks, rel.downloads)
	}
	if !strings.Contains(out, "keeps reporting new releases") {
		t.Errorf("output:\n%s", out)
	}
	if p, src := upgradePolicy(home, false); p != config.UpgradeOff || src != "autoUpgrade is false in config.json" {
		t.Errorf("policy = %q (%s)", p, src)
	}
}

func TestAutoupgradeFailedInstallStillSaves(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3", badSum: true}
	rel.start(t)
	real := installed(t, "0.6.2")
	code, _, errw := runSet(t, home, config.UpgradeOn)
	if code != 0 || !strings.Contains(errw, "Warning: could not install") || !strings.Contains(errw, "checksum mismatch") {
		t.Errorf("code %d, stderr:\n%s", code, errw)
	}
	if p, _ := upgradePolicy(home, false); p != config.UpgradeOn {
		t.Errorf("setting not saved: %q", p)
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.2") {
		t.Error("binary replaced")
	}

	// Unreachable network: also a warning.
	setVar(t, &releasesURL, "http://127.0.0.1:1")
	if code, _, errw := runSet(t, home, config.UpgradePatch); code != 0 || !strings.Contains(errw, "Warning: could not install") {
		t.Errorf("code %d, stderr:\n%s", code, errw)
	}
}

func TestAutoupgradeDevBuildSkipsInstall(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	installed(t, "0.6.2-dev")
	code, out, _ := runSet(t, home, config.UpgradeOn)
	if code != 0 || rel.checks != 0 || !strings.Contains(out, "development build") {
		t.Errorf("code %d, checks %d, output:\n%s", code, rel.checks, out)
	}
	if p, _ := upgradePolicy(home, false); p != config.UpgradeOn {
		t.Error("setting not saved")
	}
}

func TestAutoupgradeRefusesMalformedConfig(t *testing.T) {
	home := cleanEnv(t)
	path := filepath.Join(home, "config.json")
	os.WriteFile(path, []byte(`{"port": `), 0o600)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	installed(t, "0.6.2")
	code, _, errw := runSet(t, home, config.UpgradeOn)
	if code != 1 || !strings.Contains(errw, "not a JSON object") || rel.checks != 0 {
		t.Errorf("code %d, checks %d, stderr:\n%s", code, rel.checks, errw)
	}
	if contents(t, path) != `{"port": ` {
		t.Error("the malformed file was changed")
	}
}

func TestAutoupgradeWarnsWhenEnvOverrides(t *testing.T) {
	home := cleanEnv(t)
	t.Setenv("MERLIN_AUTO_UPGRADE", "0")
	rel := &fakeRelease{latest: "0.6.2"}
	rel.start(t)
	installed(t, "0.6.2")
	_, _, errw := runSet(t, home, config.UpgradeOn)
	if !strings.Contains(errw, "MERLIN_AUTO_UPGRADE=0") || !strings.Contains(errw, "overrides config.json") {
		t.Errorf("stderr:\n%s", errw)
	}
}

func TestAutoupgradeStatus(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	installed(t, "0.6.2")
	var out bytes.Buffer
	autoupgradeStatus(&out, home)
	for _, want := range []string{"auto-upgrade: off (off by default; run merlin autoupgrade to turn it on)", "running:      merlin 0.6.2", "latest:       0.6.3, newer"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("status lacks %q:\n%s", want, out.String())
		}
	}

	config.SetAutoUpgrade(home, config.UpgradePatch)
	setVar(t, &releasesURL, "http://127.0.0.1:1")
	out.Reset()
	autoupgradeStatus(&out, home)
	for _, want := range []string{`auto-upgrade: on, patch releases only (autoUpgrade is "patch" in config.json)`, "latest:       unknown"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("status lacks %q:\n%s", want, out.String())
		}
	}
}

func TestRunAutoupgradeArguments(t *testing.T) {
	cleanEnv(t)
	if runAutoupgrade([]string{"sometimes"}) != 2 || runAutoupgrade([]string{"on", "off"}) != 2 {
		t.Error("bad arguments accepted")
	}
}
