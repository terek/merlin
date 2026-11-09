// Package release verifies that a release's SHA256SUMS was signed by a trusted merlin
// release key. The checksums only prove integrity; the signature proves that someone
// holding the release key published them.
//
// A signature file (SHA256SUMS.sig) has one line per signature, so keys can rotate:
//
//	merlin-sig-v1 <keyid> <base64 Ed25519 signature>
//
// where keyid is the first 8 bytes of the SHA-256 of the public key, in hex, and the
// signature covers the exact bytes of SHA256SUMS. Verification passes when any line
// verifies with any trusted key whose keyid matches.
package release

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// Magic starts every line of a signature file.
const Magic = "merlin-sig-v1"

// AppleTeamID is the Developer ID team that signs the macOS binaries; `merlin upgrade`
// refuses a staged darwin binary signed by anyone else.
const AppleTeamID = "L258LHG5T6"

// productionKeys are the base64 Ed25519 public keys merlin releases are signed with.
// To rotate: ship old and new here for a release or two (see PLAN.md, Releasing).
var productionKeys = []string{
	"Y3cj3HdZ00ELApb05xkyhQ+gYWEmiaoyAVHFRDG04s4=",
}

// TrustedKeys is what Verify trusts. It is a variable only as a seam for tests.
var TrustedKeys = mustParseKeys(productionKeys)

func mustParseKeys(b64 []string) []ed25519.PublicKey {
	keys := make([]ed25519.PublicKey, 0, len(b64))
	for _, s := range b64 {
		k, err := ParsePublicKey(s)
		if err != nil {
			panic("release: bad built-in key: " + err.Error())
		}
		keys = append(keys, k)
	}
	return keys
}

// ParsePublicKey reads a base64 Ed25519 public key.
func ParsePublicKey(s string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("not a base64 32-byte Ed25519 public key")
	}
	return ed25519.PublicKey(b), nil
}

// KeyID names a public key: the first 8 bytes of its SHA-256, hex.
func KeyID(pub ed25519.PublicKey) string {
	h := sha256.Sum256(pub)
	return hex.EncodeToString(h[:8])
}

// Sign returns a signature file for sums, signed by priv.
func Sign(sums []byte, priv ed25519.PrivateKey) []byte {
	sig := ed25519.Sign(priv, sums)
	pub := priv.Public().(ed25519.PublicKey)
	return []byte(Magic + " " + KeyID(pub) + " " + base64.StdEncoding.EncodeToString(sig) + "\n")
}

// ErrUnsigned means no signature line verified; it wraps the specific reason.
var ErrUnsigned = errors.New("not signed by a trusted merlin release key")

// Verify checks sums against the signature file sig using TrustedKeys.
func Verify(sums, sig []byte) error { return VerifyWith(TrustedKeys, sums, sig) }

// VerifyWith checks sums against sig using the given keys: one valid line is enough. A line
// that is not a well-formed merlin-sig-v1 line is skipped, not fatal, so that a later
// release can add another format beside v1 without breaking the merlins already installed.
func VerifyWith(keys []ed25519.PublicKey, sums, sig []byte) error {
	lines := 0 // well-formed v1 lines
	known := 0 // of those, lines naming a trusted key
	for _, line := range bytes.Split(sig, []byte("\n")) {
		f := strings.Fields(string(line))
		if len(f) != 3 || f[0] != Magic {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(f[2])
		if err != nil || len(raw) != ed25519.SignatureSize {
			continue
		}
		lines++
		for _, k := range keys {
			if KeyID(k) != f[1] {
				continue
			}
			known++
			if ed25519.Verify(k, sums, raw) {
				return nil
			}
		}
	}
	switch {
	case lines == 0:
		return fmt.Errorf("%w: the signature file has no %s signature", ErrUnsigned, Magic)
	case known == 0:
		return fmt.Errorf("%w: no signature from a key this merlin trusts", ErrUnsigned)
	}
	return fmt.Errorf("%w: the signature does not match SHA256SUMS", ErrUnsigned)
}

func trunc(s string) string {
	if len(s) > 60 {
		return s[:60] + "..."
	}
	return s
}
