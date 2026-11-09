// Command sign is the maintainer's release-signing tool. It is not part of merlin:
// nothing under cmd/ imports it.
//
//	go run ./tools/sign keygen <private-out>               new key; prints the public key and keyid
//	go run ./tools/sign sign SHA256SUMS > SHA256SUMS.sig   (base64 seed in $MERLIN_SIGNING_KEY)
//	go run ./tools/sign verify SHA256SUMS SHA256SUMS.sig   (against the embedded trusted keys)
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/terek/merlin/internal/release"
)

const keyEnv = "MERLIN_SIGNING_KEY"

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Getenv(keyEnv)); err != nil {
		fmt.Fprintln(os.Stderr, "sign:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer, seedEnv string) error {
	if len(args) == 0 {
		return errors.New("usage: sign keygen <private-out> | sign sign <SHA256SUMS> | sign verify <SHA256SUMS> <SHA256SUMS.sig>")
	}
	switch args[0] {
	case "keygen":
		if len(args) != 2 {
			return errors.New("usage: sign keygen <private-out>")
		}
		return keygen(args[1], out)
	case "sign":
		if len(args) != 2 {
			return errors.New("usage: sign sign <SHA256SUMS> > SHA256SUMS.sig")
		}
		return sign(args[1], seedEnv, out)
	case "verify":
		if len(args) != 3 {
			return errors.New("usage: sign verify <SHA256SUMS> <SHA256SUMS.sig>")
		}
		return verify(args[1], args[2], out)
	}
	return fmt.Errorf("unknown command %q", args[0])
}

func keygen(path string, out io.Writer) error {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(base64.StdEncoding.EncodeToString(priv.Seed()) + "\n"); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	fmt.Fprintf(out, "public key: %s\nkeyid:      %s\nprivate key (base64 seed) written to %s\n",
		base64.StdEncoding.EncodeToString(pub), release.KeyID(pub), path)
	return nil
}

func sign(sumsPath, seedEnv string, out io.Writer) error {
	seedEnv = strings.TrimSpace(seedEnv)
	if seedEnv == "" {
		return errors.New(keyEnv + " is not set (want the base64 32-byte seed)")
	}
	seed, err := base64.StdEncoding.DecodeString(seedEnv)
	if err != nil || len(seed) != ed25519.SeedSize {
		return errors.New(keyEnv + " is not a base64 32-byte Ed25519 seed")
	}
	sums, err := os.ReadFile(sumsPath)
	if err != nil {
		return err
	}
	_, err = out.Write(release.Sign(sums, ed25519.NewKeyFromSeed(seed)))
	return err
}

func verify(sumsPath, sigPath string, out io.Writer) error {
	sums, err := os.ReadFile(sumsPath)
	if err != nil {
		return err
	}
	sig, err := os.ReadFile(sigPath)
	if err != nil {
		return err
	}
	if err := release.Verify(sums, sig); err != nil {
		return err
	}
	fmt.Fprintln(out, "ok: SHA256SUMS is signed by a trusted merlin release key")
	return nil
}
