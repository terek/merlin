package main

import (
	"bufio"
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
	"strconv"
	"strings"
	"time"

	"github.com/terek/merlin/explorer/internal/claude/hooks"
	"github.com/terek/merlin/explorer/internal/paths"
)

// installCommand is how merlin is installed, and the fallback when upgrade fails.
const installCommand = "curl -fsSL https://merlin.dev/install.sh | bash"

// Seams for tests: where releases live, which binary to replace, and which host to
// ask whether `merlin serve` is running.
var (
	releasesURL    = "https://github.com/terek/merlin/releases"
	executablePath = os.Executable
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
		usage:   "upgrade [--check] [--force]",
		summary: "replace this binary with the latest release",
		run:     runUpgrade,
	})
}

func runUpgrade(args []string) int {
	fs := flag.NewFlagSet("upgrade", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	check := fs.Bool("check", false, "only report whether a newer release exists")
	force := fs.Bool("force", false, "install the latest release even if it is not newer")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "merlin upgrade: unexpected arguments")
		return 2
	}
	if err := upgrade(os.Stdout, *check, *force); err != nil {
		fmt.Fprintf(os.Stderr, "merlin upgrade: %v\n\nTo upgrade by hand, run the installer:\n\n  %s\n", err, installCommand)
		return 1
	}
	return 0
}

func upgrade(w io.Writer, check, force bool) error {
	latest, err := latestVersion()
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
		return nil
	}
	if isDevVersion(cur) && !force {
		return fmt.Errorf("this is a development build (%s); use --force to replace it with %s", cur, latest)
	}
	if !newer && !force {
		fmt.Fprintf(w, "merlin %s is up to date.\n", cur)
		return nil
	}

	target, err := releaseTarget()
	if err != nil {
		return err
	}
	dest, err := executablePath()
	if err != nil {
		return fmt.Errorf("cannot find this binary: %w", err)
	}
	if dest, err = filepath.EvalSymlinks(dest); err != nil {
		return fmt.Errorf("cannot find this binary: %w", err)
	}

	asset := "merlin-" + target
	base := releasesURL + "/download/v" + latest
	fmt.Fprintf(w, "Upgrading merlin %s to %s (%s)...\n", cur, latest, asset)
	sums, err := fetch(base+"/SHA256SUMS", 1<<20)
	if err != nil {
		return err
	}
	want, err := checksumFor(sums, asset)
	if err != nil {
		return err
	}

	// Stage next to the destination so the final rename is atomic and stays on one
	// filesystem, and prove the binary runs here before it replaces anything.
	dir := filepath.Dir(dest)
	staged, err := os.CreateTemp(dir, ".merlin.upgrade.*")
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Errorf("cannot write to %s; run: sudo %s upgrade", dir, dest)
		}
		return err
	}
	defer os.Remove(staged.Name()) // a no-op once renamed
	if err := download(staged, base+"/"+asset, want); err != nil {
		staged.Close()
		return err
	}
	if err := staged.Close(); err != nil {
		return err
	}
	if err := os.Chmod(staged.Name(), 0o755); err != nil {
		return err
	}
	out, err := exec.Command(staged.Name(), "version").Output()
	if err != nil {
		return fmt.Errorf("the downloaded binary does not run on this machine: %w", err)
	}
	if got := strings.TrimSpace(string(out)); got != "merlin "+latest {
		return fmt.Errorf("the downloaded binary reports %q, want %q", got, "merlin "+latest)
	}
	// Renaming over a running executable is safe: running processes keep the old file.
	if err := os.Rename(staged.Name(), dest); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Errorf("cannot replace %s; run: sudo %s upgrade", dest, dest)
		}
		return err
	}
	fmt.Fprintf(w, "✓ installed %s (merlin %s)\n", dest, latest)

	if v := runningServeVersion(); v != "" && v != latest {
		fmt.Fprintf(w, "merlin serve %s is still running; restart it to run %s.\n", v, latest)
	}
	return nil
}

// latestVersion follows the /releases/latest redirect to learn the newest tag, as
// install.sh does: no API token, no rate-limited API call. It returns it without the v.
func latestVersion() (string, error) {
	c := &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := c.Head(releasesURL + "/latest")
	if err != nil {
		return "", fmt.Errorf("cannot reach GitHub to find the latest release: %w", err)
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

// fetch GETs a small file whole.
func fetch(url string, limit int64) ([]byte, error) {
	resp, err := (&http.Client{Timeout: time.Minute}).Get(url)
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
func download(f *os.File, url, want string) error {
	resp, err := (&http.Client{Timeout: 10 * time.Minute}).Get(url)
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
