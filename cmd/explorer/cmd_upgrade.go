package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/terek/merlin/internal/claude/hooks"
	"github.com/terek/merlin/internal/config"
	"github.com/terek/merlin/internal/paths"
	"github.com/terek/merlin/internal/release"
)

// installCommand is how merlin is installed, and the fallback when upgrade fails.
const installCommand = "curl -fsSL https://merlin.dev/install.sh | bash"

// Seams for tests: where releases live, which binary to replace, and which host to
// ask whether `merlin serve` is running.
var (
	releasesURL    = "https://github.com/terek/merlin/releases"
	executablePath = os.Executable
	homeDir        = paths.Home
	healthURL      = func() string {
		home, err := paths.Home()
		if err != nil {
			return ""
		}
		return fmt.Sprintf("http://127.0.0.1:%d/healthz", hooks.Port(home))
	}
)

func init() {
	register("upgrade", command{
		usage:   "upgrade [--check] [--force] [--version X]",
		summary: "replace this binary with the latest release (or exactly X)",
		run:     runUpgrade,
	})
}

func runUpgrade(args []string) int {
	fs := flag.NewFlagSet("upgrade", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	check := fs.Bool("check", false, "only report whether a newer release exists")
	force := fs.Bool("force", false, "install the release even if it is not newer (or is already installed)")
	want := fs.String("version", "", "install exactly this release (e.g. 0.6.1), older and pre-releases included")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "merlin upgrade: unexpected arguments")
		return 2
	}
	applyReleasesEnv()
	if err := upgrade(os.Stdout, *check, *force, *want); err != nil {
		fmt.Fprintf(os.Stderr, "merlin upgrade: %v\n\nTo upgrade by hand, run the installer:\n\n  %s\n", err, installCommand)
		return 1
	}
	return 0
}

// applyReleasesEnv honours MERLIN_RELEASES_URL, for testing: a directory laid out like the
// releases page (latest redirecting to tag/vX, download/vX/...) served over HTTP.
func applyReleasesEnv() {
	if u := os.Getenv("MERLIN_RELEASES_URL"); u != "" {
		releasesURL = strings.TrimRight(u, "/")
	}
}

// upgrade replaces this binary with the latest release, or with exactly release want
// when it is set (older and pre-releases included). check reports and installs nothing.
func upgrade(w io.Writer, check, force bool, want string) error {
	want = strings.TrimPrefix(strings.TrimSpace(want), "v")
	if want != "" {
		return upgradeTo(w, check, force, want)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	latest, err := latestVersion(ctx)
	cancel()
	if err != nil {
		return err
	}
	cur, newer := version, compareVersions(latest, version) > 0
	if check {
		if newer {
			fmt.Fprintf(w, "merlin %s is available (this is %s). Run: merlin upgrade\n", latest, cur)
		} else {
			fmt.Fprintf(w, "merlin %s is up to date (latest release: %s).\n", cur, latest)
		}
		if home, err := homeDir(); err == nil {
			if pol, _ := upgradePolicy(home, false); pol == config.UpgradePatch {
				fmt.Fprintln(w, patchReport(cur, home))
			}
		}
		return nil
	}
	if isDevVersion(cur) && !force {
		return fmt.Errorf("this is a development build (%s); use --force to replace it with %s", cur, latest)
	}
	if !newer && !force {
		fmt.Fprintf(w, "merlin %s is up to date.\n", cur)
		return nil
	}
	return install(w, cur, latest)
}

// patchReport says what auto-upgrade under "patch" would follow from cur.
func patchReport(cur, home string) string {
	v, ok := parseVersion(cur)
	if !ok {
		return "auto-upgrade is set to patch releases only."
	}
	line := fmt.Sprintf("%d.%d", v.n[0], v.n[1])
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	p, err := latestPatch(ctx, cur, loadBad(home))
	switch {
	case err != nil:
		return fmt.Sprintf("auto-upgrade is set to patch releases of %s only; looking for them failed: %v", line, err)
	case p == "":
		return fmt.Sprintf("auto-upgrade is set to patch releases of %s only; %s is the latest of that line.", line, cur)
	}
	return fmt.Sprintf("auto-upgrade is set to patch releases of %s only; the latest of that line is %s.", line, p)
}

// upgradeTo installs release want, whether it is newer or older than this binary.
func upgradeTo(w io.Writer, check, force bool, want string) error {
	if _, ok := parseVersion(want); !ok {
		return fmt.Errorf("%q is not a version (want X.Y.Z, e.g. 0.6.1)", want)
	}
	cur := version
	if !check && isDevVersion(cur) && !force {
		return fmt.Errorf("this is a development build (%s); use --force to replace it with %s", cur, want)
	}
	if want == cur && !force {
		fmt.Fprintf(w, "merlin is already %s.\n", cur)
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	status, err := releaseStatus(ctx, want)
	cancel()
	if err != nil {
		return err
	}
	switch status {
	case http.StatusOK:
	case http.StatusNotFound:
		return fmt.Errorf("there is no release %s (%s/download/v%s/SHA256SUMS gave 404)", want, releasesURL, want)
	default:
		return fmt.Errorf("looking for release %s: %s/download/v%s/SHA256SUMS gave HTTP %d", want, releasesURL, want, status)
	}
	home, homeErr := homeDir()
	if homeErr == nil && slices.Contains(loadBad(home), want) {
		fmt.Fprintf(w, "Note: %s is listed in %s as a version that failed to start; installing it because you asked for it.\n", want, upgradeFile)
	}
	if check {
		fmt.Fprintf(w, "merlin %s is available (this is %s). Run: merlin upgrade --version %s\n", want, cur, want)
		return nil
	}
	if err := install(w, cur, want); err != nil {
		return err
	}
	if homeErr == nil {
		if msg := undoWarning(home, want); msg != "" {
			fmt.Fprintln(w, msg)
		}
	}
	return nil
}

// undoWarning says, when auto-upgrade would move the install off the pinned version v,
// that it will and how to stop it; "" when it would not (or cannot be told).
func undoWarning(home, v string) string {
	pol, src := upgradePolicy(home, false)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var next, how string
	switch pol {
	case config.UpgradeOn:
		latest, err := latestVersion(ctx)
		if err != nil || compareVersions(latest, v) <= 0 || slices.Contains(loadBad(home), latest) {
			return ""
		}
		next, how = latest, "auto-upgrade is on"
	case config.UpgradePatch:
		p, err := latestPatch(ctx, v, loadBad(home))
		if err != nil || p == "" {
			return ""
		}
		next, how = p, "auto-upgrade follows patch releases"
	default:
		return ""
	}
	stay := `set "autoUpgrade": false in ~/.merlin/config.json`
	if strings.HasPrefix(src, "MERLIN_AUTO_UPGRADE=") {
		stay = "set MERLIN_AUTO_UPGRADE=0 (it overrides config.json)"
	}
	return fmt.Sprintf("merlin serve will replace it with %s (%s). To stay on %s, %s.", next, how, v, stay)
}

// install replaces the binary with release target and reports it.
func install(w io.Writer, cur, target string) error {
	dest, err := resolveDest()
	if err != nil {
		return err
	}
	verb := "Upgrading"
	if compareVersions(target, cur) < 0 {
		verb = "Downgrading"
	}
	fmt.Fprintf(w, "%s merlin %s to %s...\n", verb, cur, target)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	staged, err := stageRelease(ctx, dest, target)
	if err != nil {
		return err
	}
	defer os.Remove(staged) // a no-op once renamed
	if err := swapBinary(staged, dest); err != nil {
		return err
	}
	fmt.Fprintf(w, "✓ installed %s (merlin %s)\n", dest, target)

	if v := runningServeVersion(); v != "" && v != target {
		fmt.Fprintf(w, "The running merlin serve (%s) switches to %s within a minute.\n", v, target)
	}
	return nil
}

// releaseStatus is the HTTP status of release v's SHA256SUMS: 200 when the release exists.
// It is a GET (the file is tiny and the body is never read) because release hosts redirect
// downloads to a CDN whose signed URLs do not always answer HEAD.
func releaseStatus(ctx context.Context, v string) (int, error) {
	resp, err := get(ctx, releasesURL+"/download/v"+v+"/SHA256SUMS")
	if err != nil {
		return 0, fmt.Errorf("cannot reach the release server to look for %s: %w", v, err)
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

// resolveDest is the file `merlin upgrade` replaces: this binary, symlinks resolved.
func resolveDest() (string, error) {
	dest, err := executablePath()
	if err != nil {
		return "", fmt.Errorf("cannot find this binary: %w", err)
	}
	if dest, err = filepath.EvalSymlinks(dest); err != nil {
		return "", fmt.Errorf("cannot find this binary: %w", err)
	}
	return dest, nil
}

// prevName is the previous binary, kept next to the installed one for rollback.
const prevName = ".merlin.prev"

// stageRelease downloads release latest for this host next to dest, checks its SHA-256
// and proves it runs here (it must print `merlin <latest>`). It returns the staged file;
// the caller removes it (renaming it over dest does that). Staging next to dest keeps the
// final rename atomic and on one filesystem.
func stageRelease(ctx context.Context, dest, latest string) (string, error) {
	target, err := releaseTarget()
	if err != nil {
		return "", err
	}
	asset := "merlin-" + target
	base := releasesURL + "/download/v" + latest
	sums, err := fetchSignedSums(ctx, base, latest)
	if err != nil {
		return "", err
	}
	want, err := checksumFor(sums, asset)
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(dest)
	f, err := os.CreateTemp(dir, ".merlin.upgrade.*")
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return "", fmt.Errorf("cannot write to %s; run: sudo %s upgrade", dir, dest)
		}
		return "", err
	}
	name := f.Name()
	fail := func(err error) (string, error) { os.Remove(name); return "", err }
	if err := download(ctx, f, base+"/"+asset, want); err != nil {
		f.Close()
		return fail(err)
	}
	if err := f.Close(); err != nil {
		return fail(err)
	}
	if err := os.Chmod(name, 0o755); err != nil {
		return fail(err)
	}
	// Before running anything the release host sent: on macOS the binary must carry our
	// Developer ID signature.
	if err := codesignCheck(ctx, name); err != nil {
		return fail(err)
	}
	out, err := exec.CommandContext(ctx, name, "version").Output()
	if err != nil {
		return fail(fmt.Errorf("the downloaded binary does not run on this machine: %w", err))
	}
	if got := strings.TrimSpace(string(out)); got != "merlin "+latest {
		return fail(fmt.Errorf("the downloaded binary reports %q, want %q", got, "merlin "+latest))
	}
	return name, nil
}

// fetchSignedSums downloads release v's SHA256SUMS and SHA256SUMS.sig from base and
// returns the checksums only if a trusted release key signed them. Nothing in an unsigned
// SHA256SUMS is to be believed.
func fetchSignedSums(ctx context.Context, base, v string) ([]byte, error) {
	sums, err := fetch(ctx, base+"/SHA256SUMS", 1<<20)
	if err != nil {
		return nil, err
	}
	refuse := func(why string) error {
		return fmt.Errorf("SHA256SUMS for %s is not signed by a trusted merlin release key; refusing to install (%s)", v, why)
	}
	resp, err := get(ctx, base+"/SHA256SUMS.sig")
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, refuse("the release has no SHA256SUMS.sig; to install an old unsigned release, use the installer: MERLIN_VERSION=" + v + " " + installCommand)
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("download failed: %s/SHA256SUMS.sig gave %s", base, resp.Status)
	}
	sig, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	if err := release.Verify(sums, sig); err != nil {
		return nil, refuse(strings.TrimPrefix(err.Error(), release.ErrUnsigned.Error()+": "))
	}
	return sums, nil
}

// swapBinary installs staged as dest. The current binary is first hard-linked (or, where
// that is impossible, copied) to .merlin.prev beside it, so dest never goes missing and a
// failed start can roll back. Failing to keep that copy does not stop the upgrade.
func swapBinary(staged, dest string) error {
	prev := filepath.Join(filepath.Dir(dest), prevName)
	os.Remove(prev)
	if err := os.Link(dest, prev); err != nil {
		if err := copyFile(dest, prev); err != nil {
			os.Remove(prev)
		}
	}
	// Renaming over a running executable is safe: running processes keep the old file.
	if err := os.Rename(staged, dest); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Errorf("cannot replace %s; run: sudo %s upgrade", dest, dest)
		}
		return err
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// latestVersion follows the /releases/latest redirect to learn the newest tag, as
// install.sh does: no API token, no rate-limited API call. It returns it without the v.
func latestVersion(ctx context.Context) (string, error) {
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, releasesURL+"/latest", nil)
	if err != nil {
		return "", err
	}
	resp, err := c.Do(req)
	if err != nil {
		return "", fmt.Errorf("cannot reach the release server to find the latest release: %w", err)
	}
	resp.Body.Close()
	loc := resp.Header.Get("Location")
	if resp.StatusCode/100 != 3 || loc == "" {
		return "", fmt.Errorf("finding the latest release: %s gave %s", releasesURL+"/latest", resp.Status)
	}
	v := strings.TrimPrefix(path.Base(loc), "v") // .../tag/v0.3.1 -> 0.3.1
	if _, ok := parseVersion(v); !ok {
		return "", fmt.Errorf("finding the latest release: unexpected redirect to %s", loc)
	}
	return v, nil
}

// releaseTarget names this host the way release assets do, e.g. darwin-arm64.
func releaseTarget() (string, error) {
	arch := map[string]string{"arm64": "arm64", "amd64": "x64"}[runtime.GOARCH]
	if (runtime.GOOS != "darwin" && runtime.GOOS != "linux") || arch == "" {
		return "", fmt.Errorf("there is no release for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	return runtime.GOOS + "-" + arch, nil
}

func get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	return http.DefaultClient.Do(req)
}

// fetch GETs a small file whole.
func fetch(ctx context.Context, url string, limit int64) ([]byte, error) {
	resp, err := get(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed: %s gave %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

// download streams url into f and checks its SHA-256 against want.
func download(ctx context.Context, f *os.File, url, want string) error {
	resp, err := get(ctx, url)
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed: %s gave %s", url, resp.Status)
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(f, h), resp.Body); err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("checksum mismatch for %s: refusing to install", path.Base(url))
	}
	return nil
}

// checksumFor finds asset's hash in a SHA256SUMS file ("<hex>  <name>" lines).
func checksumFor(sums []byte, asset string) (string, error) {
	sc := bufio.NewScanner(strings.NewReader(string(sums)))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == asset {
			return strings.ToLower(f[0]), nil
		}
	}
	return "", fmt.Errorf("no checksum for %s in SHA256SUMS", asset)
}

// runningServeVersion asks a local `merlin serve` for its version; "" if none answers.
func runningServeVersion() string {
	u := healthURL()
	if u == "" {
		return ""
	}
	resp, err := (&http.Client{Timeout: time.Second}).Get(u)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var h struct {
		Version string `json:"version"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&h) != nil {
		return ""
	}
	return h.Version
}

// A semver is a release version: three numbers and an optional pre-release tag.
type semver struct {
	n   [3]int
	pre string
}

// parseVersion reads "1.2.3" or "1.2.3-rc1"; a leading v is allowed.
func parseVersion(s string) (semver, bool) {
	var v semver
	s, v.pre, _ = strings.Cut(strings.TrimPrefix(s, "v"), "-")
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return v, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return v, false
		}
		v.n[i] = n
	}
	return v, true
}

// compareVersions orders two versions; a release sorts after its pre-releases, and
// an unparseable version (a local build) sorts before everything.
func compareVersions(a, b string) int {
	va, okA := parseVersion(a)
	vb, okB := parseVersion(b)
	if !okA || !okB {
		return boolInt(okA) - boolInt(okB)
	}
	for i := range va.n {
		if va.n[i] != vb.n[i] {
			if va.n[i] < vb.n[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case va.pre == vb.pre:
		return 0
	case va.pre == "":
		return 1
	case vb.pre == "":
		return -1
	}
	return strings.Compare(va.pre, vb.pre)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// isDevVersion reports a locally built binary (the default version, or no version).
func isDevVersion(v string) bool {
	_, ok := parseVersion(v)
	return !ok || strings.HasSuffix(v, "-dev")
}
