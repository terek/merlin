package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/terek/merlin/internal/config"
)

// How `merlin serve` keeps itself on the latest release. The daemon package only asks
// (Options.Upgrade, Options.BinaryChanged) and returns daemon.ErrRestart; the policy and
// the exec live here.

const (
	upgradedFromEnv = "MERLIN_UPGRADED_FROM" // set for the process that follows an auto-upgrade
	upgradeFile     = "upgrade.json"         // under MERLIN_HOME: versions that failed to start

	defaultUpgradeInterval = 4 * time.Hour
	startupCheckTimeout    = 5 * time.Second // the version check; a missing network must not hold up startup
	downloadTimeout        = 2 * time.Minute
)

// execBinary replaces the process; a seam so tests can capture the call.
var execBinary = syscall.Exec

// autoUpgrader is the policy behind Options.Upgrade and Options.BinaryChanged.
type autoUpgrader struct {
	home string
	off  bool // --no-auto-upgrade

	mu     sync.Mutex
	logged map[string]bool

	installed bool    // this process put a new binary in place (guarded by mu)
	baseline  fileSig // the installed binary as it was when serve started (BinaryChanged only)
}

type fileSig struct {
	mtime time.Time
	size  int64
}

func newAutoUpgrader(home string, off bool) *autoUpgrader {
	a := &autoUpgrader{home: home, off: off, logged: map[string]bool{}}
	a.baseline, _ = a.sig()
	return a
}

func (a *autoUpgrader) sig() (fileSig, error) {
	p, err := resolveDest()
	if err != nil {
		return fileSig{}, err
	}
	fi, err := os.Stat(p)
	if err != nil {
		return fileSig{}, err
	}
	return fileSig{fi.ModTime(), fi.Size()}, nil
}

// once logs msg the first time only, so a standing reason does not repeat every check.
func (a *autoUpgrader) once(logf func(string, ...any), msg string) {
	a.mu.Lock()
	seen := a.logged[msg]
	a.logged[msg] = true
	a.mu.Unlock()
	if !seen {
		logf("%s", msg)
	}
}

func (a *autoUpgrader) wasInstalled() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.installed
}

// upgradePolicy resolves what auto-upgrade may install. Precedence: the flag, then
// MERLIN_AUTO_UPGRADE (an unrecognised value is ignored), then config.json (re-read, so an
// edit applies without a restart). source names where the answer came from. Development
// builds are the caller's business: this is also what `merlin upgrade` consults.
func upgradePolicy(home string, flagOff bool) (p config.UpgradePolicy, source string) {
	if flagOff {
		return config.UpgradeOff, "--no-auto-upgrade"
	}
	if v, ok := os.LookupEnv("MERLIN_AUTO_UPGRADE"); ok {
		if p, ok := config.ParseUpgradePolicy(v); ok {
			return p, "MERLIN_AUTO_UPGRADE=" + v
		}
	}
	cfg, _ := config.Load(home)
	switch cfg.AutoUpgrade {
	case config.UpgradeOff:
		return config.UpgradeOff, "autoUpgrade is false in config.json"
	case config.UpgradePatch:
		return config.UpgradePatch, `autoUpgrade is "patch" in config.json`
	}
	return config.UpgradeOn, "autoUpgrade in config.json"
}

// policy is upgradePolicy for this process, where a development build never upgrades.
func (a *autoUpgrader) policy() (config.UpgradePolicy, string) {
	if isDevVersion(version) {
		return config.UpgradeOff, "development build " + version
	}
	return upgradePolicy(a.home, a.off)
}

// maxPatchProbes caps how many consecutive patch releases latestPatch looks for.
const maxPatchProbes = 50

// latestPatch finds the newest release of cur's major.minor line without the release
// host's API (rate limits; it must work against MERLIN_RELEASES_URL): it asks for
// download/vX.Y.(z+1)/SHA256SUMS, then z+2, and so on until one is not there. For a
// pre-release X.Y.Z-rc1 the first candidate is X.Y.Z itself. Versions in bad are probed
// past but never returned. It returns "" when there is nothing newer.
func latestPatch(ctx context.Context, cur string, bad []string) (string, error) {
	v, ok := parseVersion(cur)
	if !ok {
		return "", fmt.Errorf("%q is not a release version", cur)
	}
	z := v.n[2] + 1
	if v.pre != "" {
		z = v.n[2]
	}
	best := ""
	for i := 0; i < maxPatchProbes; i++ {
		cand := fmt.Sprintf("%d.%d.%d", v.n[0], v.n[1], z+i)
		status, err := releaseStatus(ctx, cand)
		if err != nil {
			return "", err
		}
		if status != http.StatusOK {
			break
		}
		if !slices.Contains(bad, cand) {
			best = cand
		}
	}
	return best, nil
}

// run is daemon.Options.Upgrade: it reports true once a newer binary is installed.
func (a *autoUpgrader) run(ctx context.Context, logf func(string, ...any)) bool {
	pol, src := a.policy()
	if pol == config.UpgradeOff {
		a.once(logf, "auto-upgrade: off ("+src+")")
		return false
	}
	patch := pol == config.UpgradePatch
	if cur, ok := parseVersion(version); patch && ok {
		a.once(logf, fmt.Sprintf("auto-upgrade: patch releases of %d.%d only", cur.n[0], cur.n[1]))
	}
	dest, err := resolveDest()
	if err != nil {
		a.once(logf, "auto-upgrade: "+err.Error())
		return false
	}
	if p, err := os.CreateTemp(filepath.Dir(dest), ".merlin.probe.*"); err != nil {
		if errors.Is(err, os.ErrPermission) {
			a.once(logf, fmt.Sprintf("auto-upgrade: off (cannot write to %s; run: sudo %s upgrade)", filepath.Dir(dest), dest))
		} else {
			a.once(logf, "auto-upgrade: off ("+err.Error()+")")
		}
		return false
	} else {
		p.Close()
		os.Remove(p.Name())
	}

	cctx, cancel := context.WithTimeout(ctx, startupCheckTimeout)
	var latest string
	if patch {
		latest, err = latestPatch(cctx, version, loadBad(a.home))
		if err == nil && latest == "" {
			latest = version // nothing newer in this line
		}
	} else {
		latest, err = latestVersion(cctx)
	}
	cancel()
	if err != nil {
		if ctx.Err() == nil {
			logf("auto-upgrade: check failed: %v", err)
		}
		return false
	}
	if compareVersions(latest, version) <= 0 {
		if patch {
			a.once(logf, fmt.Sprintf("auto-upgrade: %s is current (no newer patch release)", version))
		} else {
			a.once(logf, fmt.Sprintf("auto-upgrade: %s is current (latest release %s)", version, latest))
		}
		return false
	}
	if slices.Contains(loadBad(a.home), latest) {
		a.once(logf, fmt.Sprintf("auto-upgrade: skipping %s (it failed to start before; see %s)", latest, upgradeFile))
		return false
	}
	logf("auto-upgrade: %s -> %s available", version, latest)

	dctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	staged, err := stageRelease(dctx, dest, latest)
	if err != nil {
		logf("auto-upgrade: %v", err)
		return false
	}
	defer os.Remove(staged)
	if err := swapBinary(staged, dest); err != nil {
		logf("auto-upgrade: %v", err)
		return false
	}
	a.mu.Lock()
	a.installed = true
	a.mu.Unlock()
	logf("auto-upgrade: installed %s at %s (previous kept as %s)", latest, dest, prevName)
	return true
}

// binaryChanged is daemon.Options.BinaryChanged: the installed file changed (merlin
// upgrade, install.sh) and now reports a different version than this process.
func (a *autoUpgrader) binaryChanged() bool {
	cur, err := a.sig()
	if err != nil || cur == a.baseline {
		return false
	}
	dest, err := resolveDest()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, dest, "version").Output()
	if err != nil {
		return false // maybe mid-write; the baseline stays, so the next check looks again
	}
	a.baseline = cur
	return strings.TrimSpace(string(out)) != "merlin "+version
}

// upgradeState is $MERLIN_HOME/upgrade.json.
type upgradeState struct {
	Bad []string `json:"bad,omitempty"`
}

func loadBad(home string) []string {
	b, err := os.ReadFile(filepath.Join(home, upgradeFile))
	if err != nil {
		return nil
	}
	var st upgradeState
	if json.Unmarshal(b, &st) != nil {
		return nil
	}
	return st.Bad
}

// markBad records that version v failed to start after an auto-upgrade.
func markBad(home, v string) error {
	bad := loadBad(home)
	if slices.Contains(bad, v) {
		return nil
	}
	b, err := json.Marshal(upgradeState{Bad: append(bad, v)})
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(home, ".upgrade.json.*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(home, upgradeFile))
}

// logLine appends a line to merlin.log after the daemon has closed it.
func logLine(home, format string, args ...any) {
	line := time.Now().Format(time.RFC3339) + " " + fmt.Sprintf(format, args...) + "\n"
	fmt.Fprint(os.Stderr, line)
	f, err := os.OpenFile(filepath.Join(home, "merlin.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	f.WriteString(line)
}

// envWith returns env with key set to val (or removed, if val is "").
func envWith(env []string, key, val string) []string {
	out := slices.DeleteFunc(slices.Clone(env), func(e string) bool { return strings.HasPrefix(e, key+"=") })
	if val != "" {
		out = append(out, key+"="+val)
	}
	return out
}

// restartSelf re-execs the installed binary with the same arguments, in this process, so
// the PID stays. Only a failed exec returns. upgraded is true when this process installed
// the binary itself: the next process then watches for a failed start (see rollback).
func restartSelf(home string, upgraded bool) error {
	dest, err := resolveDest()
	if err != nil {
		return err
	}
	env := envWith(os.Environ(), upgradedFromEnv, "")
	if upgraded {
		env = envWith(env, upgradedFromEnv, version)
	}
	logLine(home, "auto-upgrade: re-exec %s (was %s)", dest, version)
	return execBinary(dest, os.Args, env)
}

// rollback runs in the process that follows an auto-upgrade when it fails to start: it puts
// .merlin.prev back, records this version as bad, and re-execs the restored binary without
// upgradedFromEnv (so it cannot loop). Only a failure returns.
func rollback(home string, cause error) error {
	dest, err := resolveDest()
	if err != nil {
		return err
	}
	if err := markBad(home, version); err != nil {
		logLine(home, "auto-upgrade: cannot record %s as bad: %v", version, err)
	}
	prev := filepath.Join(filepath.Dir(dest), prevName)
	if err := os.Rename(prev, dest); err != nil {
		return fmt.Errorf("cannot roll back %s: %w", version, err)
	}
	logLine(home, "auto-upgrade: rolled back %s (%v) to the previous binary, was %s", version, cause, os.Getenv(upgradedFromEnv))
	return execBinary(dest, os.Args, envWith(os.Environ(), upgradedFromEnv, ""))
}
