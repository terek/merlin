package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	"github.com/terek/merlin/internal/server"
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

	nextPrefix = ".merlin.next-" // a release downloaded ahead of time: <dir of the binary>/.merlin.next-<version>
)

// Update states, as the API reports them (server.UpdateEvent.State).
const (
	stateAvailable   = "available"
	stateDownloading = "downloading"
	stateReady       = "ready"
	stateInstalling  = "installing"
	stateBlocked     = "blocked"
)

// prefetches counts the background downloads in flight, for tests to wait on.
var prefetches sync.WaitGroup

// execBinary replaces the process; a seam so tests can capture the call.
var execBinary = syscall.Exec

// autoUpgrader is the policy behind Options.Upgrade and Options.BinaryChanged.
type autoUpgrader struct {
	home string
	off  bool // --no-auto-upgrade

	mu     sync.Mutex
	logged map[string]bool

	avail     string  // a newer release that was found and not installed (guarded by mu)
	state     string  // one of the state constants while avail is set (guarded by mu)
	reason    string  // why blocked, or why the last download failed (guarded by mu)
	installed bool    // this process put a new binary in place (guarded by mu)
	baseline  fileSig // the installed binary as it was when serve started (BinaryChanged only)

	// opMu serializes staging and installing: a release is downloaded by one at a time.
	opMu      sync.Mutex
	logf      func(string, ...any) // the daemon's, from the last run (guarded by mu)
	fetching  string               // the version a background download is for (guarded by mu)
	installOp bool                 // an install is under way or done (guarded by mu)
	stagedV   string               // the version held in .merlin.next-<v>, and its sha256 (guarded by mu)
	stagedSum string
}

type fileSig struct {
	mtime time.Time
	size  int64
}

func newAutoUpgrader(home string, off bool) *autoUpgrader {
	a := &autoUpgrader{home: home, off: off, logged: map[string]bool{}}
	a.baseline, _ = a.sig()
	if dest, err := resolveDest(); err == nil {
		clearNext(filepath.Dir(dest)) // what a previous process left
	}
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
// edit applies without a restart), then the default, which is off. source names where the
// answer came from. Development builds are the caller's business: this is also what
// `merlin upgrade` and `merlin autoupgrade` consult.
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
	switch {
	case !cfg.AutoUpgradeSet:
		return config.UpgradeOff, "off by default; run merlin autoupgrade to turn it on"
	case cfg.AutoUpgrade == config.UpgradeOff:
		return config.UpgradeOff, "autoUpgrade is false in config.json"
	case cfg.AutoUpgrade == config.UpgradePatch:
		return config.UpgradePatch, `autoUpgrade is "patch" in config.json`
	}
	return config.UpgradeOn, "autoUpgrade in config.json"
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

// run is daemon.Options.Upgrade: it checks for a newer release, installs the one the policy
// allows and reports true once a newer binary is in place. What it does not install it
// reports (a log line once per version, and available() for the UI), so a user who has not
// turned auto-upgrade on still learns that a release exists. A development build checks
// nothing.
func (a *autoUpgrader) run(ctx context.Context, logf func(string, ...any)) bool {
	a.mu.Lock()
	a.logf = logf
	a.mu.Unlock()
	if isDevVersion(version) {
		a.once(logf, "auto-upgrade: off (development build "+version+")")
		a.setAvailable("")
		return false
	}
	pol, src := upgradePolicy(a.home, a.off)
	switch cur, ok := parseVersion(version); {
	case pol == config.UpgradeOff:
		a.once(logf, "auto-upgrade: off ("+src+")")
	case pol == config.UpgradePatch && ok:
		a.once(logf, fmt.Sprintf("auto-upgrade: patch releases of %d.%d only", cur.n[0], cur.n[1]))
	}

	// latest is the newest release there is; target is the one policy pol installs ("" for
	// none). Under "patch" the two differ, and the patch probe decides whether the check
	// worked: not knowing the latest release only means there is nothing to report.
	bad := loadBad(a.home)
	cctx, cancel := context.WithTimeout(ctx, startupCheckTimeout)
	latest, err := latestVersion(cctx)
	known := err == nil
	var target string
	switch {
	case pol == config.UpgradePatch:
		target, err = latestPatch(cctx, version, bad)
	case pol == config.UpgradeOn && known && compareVersions(latest, version) > 0:
		target = latest
	}
	cancel()
	if err != nil {
		if ctx.Err() == nil {
			logf("auto-upgrade: check failed: %v", err)
		}
		return false
	}
	if known && slices.Contains(bad, latest) {
		if target == latest {
			a.once(logf, fmt.Sprintf("auto-upgrade: skipping %s (it failed to start before; see %s)", latest, upgradeFile))
			target = ""
		}
		latest = "" // a version that does not start is nothing to announce either
	}

	if target != "" && a.install(ctx, logf, target) {
		return true
	}
	if target == "" && pol != config.UpgradeOff && (pol == config.UpgradePatch || latest != "") {
		if pol == config.UpgradePatch {
			a.once(logf, fmt.Sprintf("auto-upgrade: %s is current (no newer patch release)", version))
		} else if compareVersions(latest, version) <= 0 {
			a.once(logf, fmt.Sprintf("auto-upgrade: %s is current (latest release %s)", version, latest))
		}
	}
	if known {
		a.report(logf, pol, latest)
		if v := a.available(); v != "" {
			a.prefetch(ctx, logf, v)
		}
	}
	return false
}

// install downloads, checks and swaps in release target, and reports whether a new binary
// is in place. Failures are logged and leave the installed binary alone.
func (a *autoUpgrader) install(ctx context.Context, logf func(string, ...any), target string) bool {
	dest, err := resolveDest()
	if err != nil {
		a.once(logf, "auto-upgrade: "+err.Error())
		return false
	}
	if reason := writeProblem(dest); reason != "" {
		a.once(logf, "auto-upgrade: cannot install ("+reason+")")
		return false
	}
	logf("auto-upgrade: %s -> %s available", version, target)

	a.opMu.Lock()
	defer a.opMu.Unlock()
	dctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	staged, err := stageRelease(dctx, dest, target)
	if err != nil {
		logf("auto-upgrade: %v", err)
		return false
	}
	defer os.Remove(staged)
	if err := swapBinary(staged, dest); err != nil {
		logf("auto-upgrade: %v", err)
		return false
	}
	clearNext(filepath.Dir(dest))
	a.mu.Lock()
	a.installed = true
	a.stagedV, a.stagedSum = "", ""
	a.mu.Unlock()
	logf("auto-upgrade: installed %s at %s (previous kept as %s)", target, dest, prevName)
	return true
}

// report makes release latest, when it is newer than this binary, the available one: a log
// line the first time each version is seen, and available() for the UI. Anything else
// ("" included) clears it.
func (a *autoUpgrader) report(logf func(string, ...any), pol config.UpgradePolicy, latest string) {
	if latest == "" || compareVersions(latest, version) <= 0 {
		a.setAvailable("")
		return
	}
	a.setAvailable(latest)
	tail := "merlin upgrade installs it, merlin autoupgrade keeps merlin current"
	if pol == config.UpgradeOn {
		tail = "auto-upgrade could not install it (see above); merlin upgrade installs it"
	}
	a.once(logf, fmt.Sprintf("update: merlin %s is available (running %s); %s", latest, version, tail))
}

func (a *autoUpgrader) setAvailable(v string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.installOp {
		return // an install is under way: the daemon is about to restart
	}
	if v == "" {
		a.avail, a.state, a.reason = "", "", ""
		return
	}
	if v != a.avail {
		a.avail, a.state, a.reason = v, stateAvailable, ""
		if a.stagedV == v {
			a.state = stateReady
		}
	}
}

// available is the newest release, newer than this binary, that the last check found and
// did not install; "" for none.
func (a *autoUpgrader) available() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.avail
}

// update is server.Options.Update: the available release and what can be done with it.
func (a *autoUpgrader) update() server.UpdateEvent {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.avail == "" {
		return server.UpdateEvent{}
	}
	return server.UpdateEvent{Version: a.avail, State: a.state, Reason: a.reason}
}

// writeProblem says why a release cannot be installed next to dest ("" when it can): the
// directory must take a new file, which is how an install and a download begin.
func writeProblem(dest string) string {
	dir := filepath.Dir(dest)
	p, err := os.CreateTemp(dir, ".merlin.probe.*")
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Sprintf("cannot write to %s; run: sudo %s upgrade", dir, dest)
		}
		return err.Error()
	}
	p.Close()
	os.Remove(p.Name())
	return ""
}

// clearNext removes every release downloaded ahead of time from dir.
func clearNext(dir string) {
	m, _ := filepath.Glob(filepath.Join(dir, nextPrefix+"*"))
	for _, f := range m {
		os.Remove(f)
	}
}

func fileSum(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// stage downloads release v next to dest as .merlin.next-<v> and records its sha256; any
// other .merlin.next-* goes. The caller holds opMu.
func (a *autoUpgrader) stage(ctx context.Context, dest, v string) error {
	dctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	staged, err := stageRelease(dctx, dest, v)
	if err != nil {
		return err
	}
	sum, err := fileSum(staged)
	if err != nil {
		os.Remove(staged)
		return err
	}
	dir := filepath.Dir(dest)
	clearNext(dir)
	if err := os.Rename(staged, filepath.Join(dir, nextPrefix+v)); err != nil {
		os.Remove(staged)
		return err
	}
	a.mu.Lock()
	a.stagedV, a.stagedSum = v, sum
	a.mu.Unlock()
	return nil
}

// stagedIntact reports whether .merlin.next-<v> is there and is byte for byte what stage
// recorded. The caller holds opMu.
func (a *autoUpgrader) stagedIntact(dest, v string) bool {
	a.mu.Lock()
	want, ok := a.stagedSum, a.stagedV == v
	a.mu.Unlock()
	if !ok {
		return false
	}
	got, err := fileSum(filepath.Join(filepath.Dir(dest), nextPrefix+v))
	return err == nil && got == want
}

// prefetch gets release v ready to install, in the background (a check must not wait for
// a download): the state becomes "downloading", then "ready", or "blocked" when the
// directory of the binary cannot take a file. A failed download is logged once per version
// and leaves "available", with the reason; the next check, or a click, tries again.
func (a *autoUpgrader) prefetch(ctx context.Context, logf func(string, ...any), v string) {
	if isDevVersion(version) {
		return
	}
	dest, err := resolveDest()
	if err != nil {
		return
	}
	a.mu.Lock()
	if a.installOp || a.avail != v {
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()
	if reason := writeProblem(dest); reason != "" {
		a.mu.Lock()
		if !a.installOp && a.avail == v {
			a.state, a.reason = stateBlocked, reason
		}
		a.mu.Unlock()
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.installOp || a.avail != v || a.fetching != "" {
		return
	}
	if a.state == stateBlocked {
		a.state, a.reason = stateAvailable, ""
	}
	if a.stagedV == v {
		a.state = stateReady
		return
	}
	a.fetching, a.state = v, stateDownloading
	prefetches.Add(1)
	go func() {
		defer prefetches.Done()
		a.opMu.Lock()
		defer a.opMu.Unlock()
		var err error
		a.mu.Lock()
		skip := a.installOp // an install took over while this waited
		a.mu.Unlock()
		if !skip && !a.stagedIntact(dest, v) {
			err = a.stage(ctx, dest, v)
		}
		a.mu.Lock()
		a.fetching = ""
		if !a.installOp && a.avail == v {
			if err != nil {
				a.state, a.reason = stateAvailable, err.Error()
			} else {
				a.state, a.reason = stateReady, ""
			}
		}
		a.mu.Unlock()
		if err != nil {
			a.once(logf, fmt.Sprintf("update: downloading %s failed: %v", v, err))
		}
	}()
}

// installNow is the web UI's install button: put release v, the available one, in place
// and report it; the caller restarts the daemon. It uses the release downloaded ahead of
// time when that is still byte for byte what was downloaded, and downloads again otherwise
// (the request waits). Refusals wrap server.ErrConflict.
func (a *autoUpgrader) installNow(ctx context.Context, v string) error {
	if isDevVersion(version) {
		return server.Conflict("this is a development build (%s); it does not upgrade itself", version)
	}
	a.mu.Lock()
	switch {
	case a.installOp:
		a.mu.Unlock()
		return server.Conflict("an install is already under way")
	case a.avail == "":
		a.mu.Unlock()
		return server.Conflict("nothing to install")
	case a.avail != v:
		avail := a.avail
		a.mu.Unlock()
		return server.Conflict("%s is not the available release (%s is)", v, avail)
	case a.state == stateBlocked:
		reason := a.reason
		a.mu.Unlock()
		return server.Conflict("%s", reason)
	}
	a.installOp = true
	if a.stagedV == v {
		a.state = stateInstalling
	} else {
		a.state = stateDownloading
	}
	a.mu.Unlock()

	fail := func(state string, err error) error {
		a.mu.Lock()
		a.installOp, a.state, a.reason = false, state, err.Error()
		a.mu.Unlock()
		return err
	}
	dest, err := resolveDest()
	if err != nil {
		return fail(stateAvailable, err)
	}
	if reason := writeProblem(dest); reason != "" {
		return fail(stateBlocked, errors.New(reason))
	}
	a.opMu.Lock()
	defer a.opMu.Unlock()
	if !a.stagedIntact(dest, v) {
		if err := a.stage(ctx, dest, v); err != nil {
			return fail(stateAvailable, err)
		}
	}
	a.mu.Lock()
	a.state = stateInstalling
	a.mu.Unlock()
	if err := swapBinary(filepath.Join(filepath.Dir(dest), nextPrefix+v), dest); err != nil {
		return fail(stateAvailable, err)
	}
	a.mu.Lock()
	a.installed = true
	a.stagedV, a.stagedSum = "", ""
	a.mu.Unlock()
	clearNext(filepath.Dir(dest))
	a.mu.Lock()
	logf := a.logf
	a.mu.Unlock()
	if logf == nil {
		logf = func(format string, args ...any) { logLine(a.home, format, args...) }
	}
	logf("upgrade: installing %s (requested from the web UI)", v)
	return nil
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
