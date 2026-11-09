package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/terek/merlin/internal/config"
)

// pinEnv points the policy lookups at a fresh MERLIN_HOME holding config (and, if bad is
// not empty, upgrade.json), with MERLIN_AUTO_UPGRADE unset. Call it after installed().
func pinEnv(t *testing.T, cfg, bad string) string {
	t.Helper()
	home := quietEnv(t)
	t.Setenv("MERLIN_HOME", home)
	if cfg != "" {
		os.WriteFile(filepath.Join(home, "config.json"), []byte(cfg), 0o644)
	}
	if bad != "" {
		os.WriteFile(filepath.Join(home, upgradeFile), []byte(bad), 0o644)
	}
	return home
}

func TestUpgradeVersionInstallsOlder(t *testing.T) {
	rel := &fakeRelease{latest: "0.7.0", extra: []string{"0.6.1"}}
	rel.start(t)
	real := installed(t, "0.6.3")
	pinEnv(t, "", "")
	var out bytes.Buffer
	if err := upgrade(&out, false, false, "v0.6.1"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.1") {
		t.Errorf("not downgraded: %q", contents(t, real))
	}
	prev := filepath.Join(filepath.Dir(real), prevName)
	if !strings.Contains(contents(t, prev), "merlin 0.6.3") {
		t.Errorf("%s does not hold the old binary", prevName)
	}
	for _, want := range []string{"Downgrading merlin 0.6.3 to 0.6.1", "installed " + real} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out.String())
		}
	}
}

func TestUpgradeVersionWarnsWhenAutoUpgradeWouldUndo(t *testing.T) {
	for _, tc := range []struct {
		name   string
		config string
		env    string
		extra  []string
		want   string // "" = no warning
	}{
		{name: "on", extra: []string{"0.6.1"},
			want: `merlin serve will replace it with 0.7.0 (auto-upgrade is on). To stay on 0.6.1, set "autoUpgrade": false in ~/.merlin/config.json.`},
		{name: "on from env", env: "1", config: `{"autoUpgrade": false}`, extra: []string{"0.6.1"},
			want: "merlin serve will replace it with 0.7.0 (auto-upgrade is on). To stay on 0.6.1, set MERLIN_AUTO_UPGRADE=0"},
		{name: "off", config: `{"autoUpgrade": false}`, extra: []string{"0.6.1"}},
		{name: "off by env", env: "0", extra: []string{"0.6.1"}},
		{name: "patch with newer patch", config: `{"autoUpgrade": "patch"}`, extra: []string{"0.6.1", "0.6.2", "0.6.3"},
			want: `merlin serve will replace it with 0.6.3 (auto-upgrade follows patch releases). To stay on 0.6.1, set "autoUpgrade": false`},
		{name: "patch at the top of its line", config: `{"autoUpgrade": "patch"}`, extra: []string{"0.6.1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rel := &fakeRelease{latest: "0.7.0", extra: tc.extra}
			rel.start(t)
			installed(t, "0.6.3")
			pinEnv(t, tc.config, "")
			if tc.env != "" {
				t.Setenv("MERLIN_AUTO_UPGRADE", tc.env)
			}
			var out bytes.Buffer
			if err := upgrade(&out, false, false, "0.6.1"); err != nil {
				t.Fatal(err)
			}
			if tc.want == "" {
				if strings.Contains(out.String(), "merlin serve will replace") {
					t.Errorf("unexpected warning:\n%s", out.String())
				}
			} else if !strings.Contains(out.String(), tc.want) {
				t.Errorf("output lacks %q:\n%s", tc.want, out.String())
			}
		})
	}
}

func TestUpgradeVersionNoWarningWhenLatestIsPinned(t *testing.T) {
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	installed(t, "0.6.1")
	pinEnv(t, "", "")
	var out bytes.Buffer
	if err := upgrade(&out, false, false, "0.6.3"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "merlin serve will replace") {
		t.Errorf("unexpected warning:\n%s", out.String())
	}
}

func TestUpgradeVersionPrerelease(t *testing.T) {
	rel := &fakeRelease{latest: "0.6.3", extra: []string{"0.7.0-rc1"}}
	rel.start(t)
	real := installed(t, "0.6.3")
	pinEnv(t, "", "")
	if err := upgrade(&bytes.Buffer{}, false, false, "0.7.0-rc1"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(contents(t, real), "merlin 0.7.0-rc1") {
		t.Errorf("pre-release not installed: %q", contents(t, real))
	}
}

func TestUpgradeVersionMissing(t *testing.T) {
	rel := &fakeRelease{latest: "0.7.0"}
	rel.start(t)
	real := installed(t, "0.6.3")
	pinEnv(t, "", "")
	err := upgrade(&bytes.Buffer{}, false, false, "0.6.9")
	if err == nil || !strings.Contains(err.Error(), "no release 0.6.9") {
		t.Fatalf("err = %v, want one naming 0.6.9", err)
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.3") || rel.downloads != 0 {
		t.Error("something was installed")
	}
	if err := upgrade(&bytes.Buffer{}, false, false, "banana"); err == nil || !strings.Contains(err.Error(), "not a version") {
		t.Errorf("err = %v", err)
	}
}

func TestUpgradeVersionSame(t *testing.T) {
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	installed(t, "0.6.3")
	pinEnv(t, "", "")
	var out bytes.Buffer
	if err := upgrade(&out, false, false, "v0.6.3"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "already 0.6.3") || rel.downloads != 0 {
		t.Errorf("output = %q, downloads = %d", out.String(), rel.downloads)
	}
	out.Reset()
	if err := upgrade(&out, false, true, "0.6.3"); err != nil || rel.downloads != 1 {
		t.Errorf("--force: err = %v, downloads = %d", err, rel.downloads)
	}
}

func TestUpgradeVersionDevBuildNeedsForce(t *testing.T) {
	rel := &fakeRelease{latest: "0.7.0", extra: []string{"0.6.1"}}
	rel.start(t)
	real := installed(t, "0.7.0-dev")
	pinEnv(t, "", "")
	if err := upgrade(&bytes.Buffer{}, false, false, "0.6.1"); err == nil || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("err = %v, want a hint to use --force", err)
	}
	if err := upgrade(&bytes.Buffer{}, false, true, "0.6.1"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.1") {
		t.Error("--force did not replace the dev build")
	}
}

func TestUpgradeVersionBadListedIsAllowedWithNote(t *testing.T) {
	rel := &fakeRelease{latest: "0.7.0", extra: []string{"0.6.1"}}
	rel.start(t)
	real := installed(t, "0.6.3")
	pinEnv(t, `{"autoUpgrade": false}`, `{"bad":["0.6.1"]}`)
	var out bytes.Buffer
	if err := upgrade(&out, false, false, "0.6.1"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Note: 0.6.1 is listed in upgrade.json") || !strings.Contains(contents(t, real), "merlin 0.6.1") {
		t.Errorf("output:\n%s", out.String())
	}
}

func TestUpgradeVersionRefusesBadDownload(t *testing.T) {
	rel := &fakeRelease{latest: "0.6.1", reports: "0.6.0", badSum: false}
	rel.start(t)
	real := installed(t, "0.6.3")
	pinEnv(t, "", "")
	if err := upgrade(&bytes.Buffer{}, false, false, "0.6.1"); err == nil {
		t.Fatal("installed a binary that reports the wrong version")
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.3") {
		t.Error("binary was replaced")
	}
}

func TestUpgradeCheckUnderPatch(t *testing.T) {
	rel := &fakeRelease{latest: "0.7.0", extra: []string{"0.6.2", "0.6.3"}}
	rel.start(t)
	installed(t, "0.6.1")
	pinEnv(t, `{"autoUpgrade": "patch"}`, "")
	var out bytes.Buffer
	if err := upgrade(&out, true, false, ""); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"merlin 0.7.0 is available (this is 0.6.1)", "patch releases of 0.6 only; the latest of that line is 0.6.3"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out.String())
		}
	}
	out.Reset()
	pinEnv(t, `{"autoUpgrade": true}`, "")
	if err := upgrade(&out, true, false, ""); err != nil || strings.Contains(out.String(), "patch") {
		t.Errorf("err = %v, output:\n%s", err, out.String())
	}
}

// sumsServer publishes only SHA256SUMS for each version and counts the probes.
func sumsServer(t *testing.T, versions ...string) *int {
	t.Helper()
	have := map[string]bool{}
	for _, v := range versions {
		have["/download/v"+v+"/SHA256SUMS"] = true
	}
	var probes int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probes++
		if !have[r.URL.Path] {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, "x\n")
	}))
	t.Cleanup(srv.Close)
	setVar(t, &releasesURL, srv.URL)
	return &probes
}

func TestLatestPatch(t *testing.T) {
	var many []string
	for z := 2; z < 200; z++ {
		many = append(many, fmt.Sprintf("0.6.%d", z))
	}
	for _, tc := range []struct {
		name string
		cur  string
		have []string
		bad  []string
		want string
	}{
		{name: "highest of a run", cur: "0.6.1", have: []string{"0.6.2", "0.6.3", "0.6.4"}, want: "0.6.4"},
		{name: "stops at a gap", cur: "0.6.1", have: []string{"0.6.2", "0.6.4"}, want: "0.6.2"},
		{name: "nothing newer", cur: "0.6.1", have: []string{"0.6.1"}, want: ""},
		{name: "cap", cur: "0.6.1", have: many, want: "0.6.51"},
		{name: "pre-release starts at its own release", cur: "0.6.1-rc1", have: []string{"0.6.1"}, want: "0.6.1"},
		{name: "pre-release, run", cur: "0.6.1-rc1", have: []string{"0.6.1", "0.6.2"}, want: "0.6.2"},
		{name: "pre-release, only older patches", cur: "0.6.3-rc1", have: []string{"0.6.2"}, want: ""},
		{name: "skips a bad top", cur: "0.6.1", have: []string{"0.6.2", "0.6.3", "0.6.4"}, bad: []string{"0.6.4"}, want: "0.6.3"},
		{name: "probes past a bad middle", cur: "0.6.1", have: []string{"0.6.2", "0.6.3", "0.6.4"}, bad: []string{"0.6.3"}, want: "0.6.4"},
		{name: "all bad", cur: "0.6.1", have: []string{"0.6.2"}, bad: []string{"0.6.2"}, want: ""},
		{name: "never crosses the minor", cur: "0.6.1", have: []string{"0.6.2", "0.7.0", "0.7.1"}, want: "0.6.2"},
		{name: "only a newer minor", cur: "0.6.1", have: []string{"0.7.0", "1.0.0"}, want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			probes := sumsServer(t, tc.have...)
			got, err := latestPatch(context.Background(), tc.cur, tc.bad)
			if err != nil || got != tc.want {
				t.Errorf("latestPatch = %q, %v; want %q", got, err, tc.want)
			}
			if tc.name == "cap" && *probes != maxPatchProbes {
				t.Errorf("probes = %d, want the cap %d", *probes, maxPatchProbes)
			}
		})
	}
	if _, err := latestPatch(context.Background(), "dev", nil); err == nil {
		t.Error("a dev version has no line")
	}
}

func TestUpgradePolicy(t *testing.T) {
	for _, tc := range []struct {
		name   string
		flag   bool
		env    string
		config string
		want   config.UpgradePolicy
	}{
		{name: "default", want: config.UpgradeOn},
		{name: "config false", config: `{"autoUpgrade": false}`, want: config.UpgradeOff},
		{name: "config patch", config: `{"autoUpgrade": "patch"}`, want: config.UpgradePatch},
		{name: "config wrong value", config: `{"autoUpgrade": "minor"}`, want: config.UpgradeOn},
		{name: "env patch beats config false", env: "patch", config: `{"autoUpgrade": false}`, want: config.UpgradePatch},
		{name: "env Patch", env: "Patch", want: config.UpgradePatch},
		{name: "env 0 beats config patch", env: "0", config: `{"autoUpgrade": "patch"}`, want: config.UpgradeOff},
		{name: "env garbage falls to config", env: "maybe", config: `{"autoUpgrade": "patch"}`, want: config.UpgradePatch},
		{name: "flag beats env", flag: true, env: "patch", want: config.UpgradeOff},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := quietEnv(t)
			if tc.env != "" {
				t.Setenv("MERLIN_AUTO_UPGRADE", tc.env)
			}
			if tc.config != "" {
				os.WriteFile(filepath.Join(home, "config.json"), []byte(tc.config), 0o644)
			}
			if got, src := upgradePolicy(home, tc.flag); got != tc.want || src == "" {
				t.Errorf("policy = %q (%s), want %q", got, src, tc.want)
			}
		})
	}
}

func TestAutoUpgradePatchFollowsOnlyItsLine(t *testing.T) {
	for _, tc := range []struct {
		name   string
		env    string
		config string
	}{
		{name: "config", config: `{"autoUpgrade": "patch"}`},
		{name: "env", env: "patch", config: `{"autoUpgrade": false}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := quietEnv(t)
			if tc.env != "" {
				t.Setenv("MERLIN_AUTO_UPGRADE", tc.env)
			}
			os.WriteFile(filepath.Join(home, "config.json"), []byte(tc.config), 0o644)
			rel := &fakeRelease{latest: "0.7.0", extra: []string{"0.6.2", "0.6.3"}}
			rel.start(t)
			real := installed(t, "0.6.1")
			au := newAutoUpgrader(home, false)
			var l logs
			if !au.run(context.Background(), l.logf) {
				t.Fatalf("run = false; log:\n%s", l.text())
			}
			if !strings.Contains(contents(t, real), "merlin 0.6.3") {
				t.Errorf("installed %q, want 0.6.3", contents(t, real))
			}
			for _, want := range []string{"auto-upgrade: patch releases of 0.6 only", "auto-upgrade: 0.6.1 -> 0.6.3 available"} {
				if l.count(want) != 1 {
					t.Errorf("log lacks %q:\n%s", want, l.text())
				}
			}
			if rel.checks != 0 {
				t.Error("patch policy asked for the latest release")
			}
		})
	}
}

func TestAutoUpgradePatchCurrentAndBad(t *testing.T) {
	home := quietEnv(t)
	os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"autoUpgrade": "patch"}`), 0o644)
	os.WriteFile(filepath.Join(home, upgradeFile), []byte(`{"bad":["0.6.3"]}`), 0o644)
	rel := &fakeRelease{latest: "0.7.0", extra: []string{"0.6.2", "0.6.3"}}
	rel.start(t)
	real := installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	var l logs
	for range 2 {
		if au.run(context.Background(), l.logf) {
			t.Fatal("upgraded to a bad version")
		}
	}
	if l.count("0.6.2 is current (no newer patch release)") != 1 || !strings.Contains(contents(t, real), "merlin 0.6.2") {
		t.Errorf("log:\n%s", l.text())
	}
}
