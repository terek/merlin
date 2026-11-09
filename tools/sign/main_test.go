package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/terek/merlin/internal/release"
)

func TestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "key")
	var out bytes.Buffer
	if err := run([]string{"keygen", keyFile}, &out, ""); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(keyFile); fi == nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("private key mode: %v", fi)
	}
	if err := run([]string{"keygen", keyFile}, &out, ""); err == nil {
		t.Error("keygen overwrote an existing key")
	}
	seedB, _ := os.ReadFile(keyFile)
	seed := strings.TrimSpace(string(seedB))
	raw, err := base64.StdEncoding.DecodeString(seed)
	if err != nil {
		t.Fatal(err)
	}
	pub := ed25519.NewKeyFromSeed(raw).Public().(ed25519.PublicKey)
	if !strings.Contains(out.String(), base64.StdEncoding.EncodeToString(pub)) || !strings.Contains(out.String(), release.KeyID(pub)) {
		t.Errorf("keygen output lacks the public key: %s", out.String())
	}

	sums := filepath.Join(dir, "SHA256SUMS")
	os.WriteFile(sums, []byte("abc  merlin-linux-x64\n"), 0o644)
	var sig bytes.Buffer
	if err := run([]string{"sign", sums}, &sig, seed); err != nil {
		t.Fatal(err)
	}
	sigFile := filepath.Join(dir, "SHA256SUMS.sig")
	os.WriteFile(sigFile, sig.Bytes(), 0o644)

	// The production keys do not trust this test key ...
	if err := run([]string{"verify", sums, sigFile}, &out, ""); err == nil {
		t.Fatal("verify accepted an untrusted key")
	}
	// ... until the test trusts it.
	old := release.TrustedKeys
	release.TrustedKeys = []ed25519.PublicKey{pub}
	defer func() { release.TrustedKeys = old }()
	if err := run([]string{"verify", sums, sigFile}, &out, ""); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(sums, []byte("abd  merlin-linux-x64\n"), 0o644)
	if err := run([]string{"verify", sums, sigFile}, &out, ""); err == nil {
		t.Fatal("verify accepted tampered sums")
	}
}

func TestSignNeedsKey(t *testing.T) {
	sums := filepath.Join(t.TempDir(), "SHA256SUMS")
	os.WriteFile(sums, []byte("x"), 0o644)
	for _, seed := range []string{"", "  ", "!!!", base64.StdEncoding.EncodeToString([]byte("short"))} {
		err := run([]string{"sign", sums}, &bytes.Buffer{}, seed)
		if err == nil || !strings.Contains(err.Error(), keyEnv) {
			t.Errorf("seed %q: err = %v", seed, err)
		}
	}
}

func TestUsage(t *testing.T) {
	for _, a := range [][]string{nil, {"nope"}, {"sign"}, {"verify", "a"}, {"keygen"}} {
		if run(a, &bytes.Buffer{}, "") == nil {
			t.Errorf("%v accepted", a)
		}
	}
}
