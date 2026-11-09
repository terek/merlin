package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/terek/merlin/internal/release"
)

// fakeRelease serves a release laid out like GitHub's: /latest redirects to the tag,
// /download/v<ver>/ holds SHA256SUMS and the binary for this host. The binary is a
// shell script that prints `merlin <reports>`.
type fakeRelease struct {
	latest    string
	reports   string // what the downloaded binary says it is; default latest
	badSum    bool   // SHA256SUMS lists the wrong hash
	downloads int
	checks    int      // hits on /latest
	extra     []string // more published versions, each with a binary that reports its own version
	probes    int      // hits on any SHA256SUMS
	sig       sigMode  // what SHA256SUMS.sig holds
	sigReqs   int      // hits on any SHA256SUMS.sig
}

// sigMode says how a fake release signs its SHA256SUMS.
type sigMode int

const (
	sigGood     sigMode = iota // signed by the trusted test key
	sigNone                    // no SHA256SUMS.sig published
	sigStranger                // signed by a key nobody trusts
	sigTampered                // valid signature, over different bytes
	sigGarbage                 // not a signature file
)

func (f *fakeRelease) start(t *testing.T) {
	t.Helper()
	target, err := releaseTarget()
	if err != nil {
		t.Skip(err)
	}
	reports := f.reports
	if reports == "" {
		reports = f.latest
	}
	bin := []byte("#!/bin/sh\necho merlin " + reports + "\n")
	sum := sha256.Sum256(bin)
	hash := hex.EncodeToString(sum[:])
	if f.badSum {
		hash = strings.Repeat("0", 64)
	}
	pub, priv, _ := ed25519.GenerateKey(nil)
	_, stranger, _ := ed25519.GenerateKey(nil)
	setVar(t, &release.TrustedKeys, []ed25519.PublicKey{pub})
	setVar(t, &codesignCheck, func(context.Context, string) error { return nil })
	mux := http.NewServeMux()
	mux.HandleFunc("/latest", func(w http.ResponseWriter, r *http.Request) {
		f.checks++
		http.Redirect(w, r, "/tag/v"+f.latest, http.StatusFound)
	})
	publish := func(v string, bin []byte, hash string) {
		dl := "/download/v" + v + "/"
		sums := []byte(fmt.Sprintf("%s  merlin-other-arch\n%s  merlin-%s\n", strings.Repeat("1", 64), hash, target))
		mux.HandleFunc(dl+"SHA256SUMS", func(w http.ResponseWriter, r *http.Request) {
			f.probes++
			w.Write(sums)
		})
		mux.HandleFunc(dl+"SHA256SUMS.sig", func(w http.ResponseWriter, r *http.Request) {
			f.sigReqs++
			switch f.sig {
			case sigNone:
				http.NotFound(w, r)
			case sigStranger:
				w.Write(release.Sign(sums, stranger))
			case sigTampered:
				w.Write(release.Sign(append([]byte("#\n"), sums...), priv))
			case sigGarbage:
				fmt.Fprint(w, "not a signature\n")
			default:
				w.Write(release.Sign(sums, priv))
			}
		})
		mux.HandleFunc(dl+"merlin-"+target, func(w http.ResponseWriter, r *http.Request) {
			f.downloads++
			w.Write(bin)
		})
	}
	publish(f.latest, bin, hash)
	for _, v := range f.extra {
		b := []byte("#!/bin/sh\necho merlin " + v + "\n")
		sum := sha256.Sum256(b)
		publish(v, b, hex.EncodeToString(sum[:]))
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	setVar(t, &releasesURL, srv.URL)
}

// installed puts a fake current binary at <dir>/bin/merlin, reached through a symlink
// the way a Homebrew-style install would be, and points executablePath at the link.
func installed(t *testing.T, current string) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir()) // macOS: /var is /private/var
	if err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(dir, "bin", "merlin")
	if err := os.MkdirAll(filepath.Dir(real), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(real, []byte("#!/bin/sh\necho merlin "+current+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "merlin")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	setVar(t, &version, current)
	setVar(t, &executablePath, func() (string, error) { return link, nil })
	setVar(t, &healthURL, func() string { return "" })
	// Policy lookups read MERLIN_HOME and the environment: keep them off the real machine.
	t.Setenv("MERLIN_HOME", t.TempDir())
	return real
}

func setVar[T any](t *testing.T, p *T, v T) {
	old := *p
	*p = v
	t.Cleanup(func() { *p = old })
}

func contents(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// leftovers lists staged files the upgrade did not clean up.
func leftovers(t *testing.T, dir string) []string {
	t.Helper()
	m, _ := filepath.Glob(filepath.Join(dir, ".merlin.upgrade.*"))
	return m
}

func TestUpgradeReplacesBinary(t *testing.T) {
	rel := &fakeRelease{latest: "0.9.0"}
	rel.start(t)
	real := installed(t, "0.3.0")
	health := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"ok":true,"version":"0.3.0"}`)
	}))
	defer health.Close()
	setVar(t, &healthURL, func() string { return health.URL + "/healthz" })

	var out bytes.Buffer
	if err := upgrade(&out, false, false, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(contents(t, real), "merlin 0.9.0") {
		t.Errorf("binary not replaced: %q", contents(t, real))
	}
	for _, want := range []string{"Upgrading merlin 0.3.0 to 0.9.0", "installed " + real, "The running merlin serve (0.3.0) switches to 0.9.0 within a minute"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out.String())
		}
	}
	if l := leftovers(t, filepath.Dir(real)); len(l) != 0 {
		t.Errorf("staged files left behind: %v", l)
	}
}

func TestUpgradeCheckInstallsNothing(t *testing.T) {
	quietEnv(t)
	rel := &fakeRelease{latest: "0.9.0"}
	rel.start(t)
	real := installed(t, "0.3.0")
	var out bytes.Buffer
	if err := upgrade(&out, true, false, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "merlin 0.9.0 is available (this is 0.3.0)") {
		t.Errorf("output = %q", out.String())
	}
	if rel.downloads != 0 || !strings.Contains(contents(t, real), "merlin 0.3.0") {
		t.Errorf("--check downloaded or changed the binary")
	}
}

func TestUpgradeUpToDate(t *testing.T) {
	rel := &fakeRelease{latest: "0.3.0"}
	rel.start(t)
	installed(t, "0.3.0")
	var out bytes.Buffer
	if err := upgrade(&out, false, false, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "up to date") || rel.downloads != 0 {
		t.Errorf("output = %q, downloads = %d", out.String(), rel.downloads)
	}
}

func TestUpgradeRefusesBadDownloads(t *testing.T) {
	for name, rel := range map[string]*fakeRelease{
		"checksum mismatch": {latest: "0.9.0", badSum: true},
		"wrong version":     {latest: "0.9.0", reports: "0.8.0"},
	} {
		t.Run(name, func(t *testing.T) {
			rel.start(t)
			real := installed(t, "0.3.0")
			if err := upgrade(&bytes.Buffer{}, false, false, ""); err == nil {
				t.Fatal("upgrade succeeded")
			}
			if !strings.Contains(contents(t, real), "merlin 0.3.0") {
				t.Error("binary was replaced")
			}
			if l := leftovers(t, filepath.Dir(real)); len(l) != 0 {
				t.Errorf("staged files left behind: %v", l)
			}
		})
	}
}

func TestUpgradeDevBuildNeedsForce(t *testing.T) {
	rel := &fakeRelease{latest: "0.9.0"}
	rel.start(t)
	real := installed(t, "0.1.0-dev")
	if err := upgrade(&bytes.Buffer{}, false, false, ""); err == nil || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("err = %v, want a hint to use --force", err)
	}
	if err := upgrade(&bytes.Buffer{}, false, true, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(contents(t, real), "merlin 0.9.0") {
		t.Error("--force did not replace the dev build")
	}
}

func TestUpgradeCommandFlags(t *testing.T) {
	if _, ok := commands["upgrade"]; !ok {
		t.Fatal("upgrade is not registered")
	}
	if got := runUpgrade([]string{"extra"}); got != 2 {
		t.Errorf("upgrade extra exit = %d, want 2", got)
	}
}

func TestCompareVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"0.3.1", "0.3.0", 1},
		{"0.3.0", "0.3.0", 0},
		{"0.10.0", "0.9.9", 1},
		{"1.0.0", "0.99.99", 1},
		{"0.3.1-rc1", "0.3.1", -1},
		{"0.3.1-rc2", "0.3.1-rc1", 1},
		{"v0.3.1", "0.3.1", 0},
		{"0.3.0", "dev", 1},
	} {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
		if got := compareVersions(c.b, c.a); got != -c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.b, c.a, got, -c.want)
		}
	}
}
