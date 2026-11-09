package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const refusal = "SHA256SUMS for 0.9.0 is not signed by a trusted merlin release key; refusing to install"

func TestUpgradeRefusesUnsignedReleases(t *testing.T) {
	for name, c := range map[string]struct {
		mode sigMode
		want string
	}{
		"missing .sig":  {sigNone, "MERLIN_VERSION=0.9.0"},
		"untrusted key": {sigStranger, "no signature from a key this merlin trusts"},
		"tampered":      {sigTampered, "does not match"},
		"garbage .sig":  {sigGarbage, "no merlin-sig-v1 signature"},
	} {
		t.Run(name, func(t *testing.T) {
			rel := &fakeRelease{latest: "0.9.0", sig: c.mode}
			rel.start(t)
			real := installed(t, "0.3.0")
			for _, run := range []func() error{
				func() error { return upgrade(&bytes.Buffer{}, false, false, "") },
				func() error { return upgrade(&bytes.Buffer{}, false, false, "0.9.0") },
			} {
				err := run()
				if err == nil || !strings.Contains(err.Error(), refusal) || !strings.Contains(err.Error(), c.want) {
					t.Fatalf("err = %v, want %q and %q", err, refusal, c.want)
				}
			}
			if !strings.Contains(contents(t, real), "merlin 0.3.0") {
				t.Error("binary was replaced")
			}
			if rel.downloads != 0 {
				t.Error("the binary was downloaded although SHA256SUMS was not trusted")
			}
		})
	}
}

func TestAutoUpgradeRefusesUnsignedReleases(t *testing.T) {
	for name, mode := range map[string]sigMode{"missing": sigNone, "stranger": sigStranger, "garbage": sigGarbage} {
		t.Run(name, func(t *testing.T) {
			home := quietEnv(t)
			rel := &fakeRelease{latest: "0.6.3", sig: mode}
			rel.start(t)
			real := installed(t, "0.6.2")
			au := newAutoUpgrader(home, false)
			var l logs
			if au.run(context.Background(), l.logf) || au.wasInstalled() {
				t.Fatal("installed a release whose SHA256SUMS is not signed")
			}
			if !strings.Contains(l.text(), "SHA256SUMS for 0.6.3 is not signed by a trusted merlin release key; refusing to install") {
				t.Errorf("log:\n%s", l.text())
			}
			if !strings.Contains(contents(t, real), "merlin 0.6.2") || rel.downloads != 0 {
				t.Error("binary replaced or downloaded")
			}
		})
	}
}

func TestUpgradeInstallsSigned(t *testing.T) {
	rel := &fakeRelease{latest: "0.9.0"}
	rel.start(t)
	real := installed(t, "0.3.0")
	if err := upgrade(&bytes.Buffer{}, false, false, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(contents(t, real), "merlin 0.9.0") || rel.sigReqs != 1 {
		t.Errorf("binary %q, sig requests %d", contents(t, real), rel.sigReqs)
	}
}

// The whole unattended path: check, download, verify, swap.
func TestAutoUpgradeEndToEndSigned(t *testing.T) {
	home := quietEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	var l logs
	if !au.run(context.Background(), l.logf) {
		t.Fatalf("run = false:\n%s", l.text())
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.3") || rel.sigReqs != 1 {
		t.Errorf("binary %q, sig requests %d", contents(t, real), rel.sigReqs)
	}
}

func TestCodesignChecked(t *testing.T) {
	// The seam is consulted before the binary runs, and its refusal stops the install.
	rel := &fakeRelease{latest: "0.9.0"}
	rel.start(t)
	real := installed(t, "0.3.0")
	setVar(t, &codesignCheck, func(context.Context, string) error { return errors.New("bad signature") })
	err := upgrade(&bytes.Buffer{}, false, false, "")
	if err == nil || !strings.Contains(err.Error(), "bad signature") {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(contents(t, real), "merlin 0.3.0") {
		t.Error("binary replaced")
	}
	if l := leftovers(t, filepath.Dir(real)); len(l) != 0 {
		t.Errorf("staged files left behind: %v", l)
	}
}

func TestVerifyCodesign(t *testing.T) {
	type call = []string
	fake := func(verifyErr error, dv string) (func(context.Context, ...string) ([]byte, error), *[]call) {
		var calls []call
		return func(_ context.Context, args ...string) ([]byte, error) {
			calls = append(calls, args)
			if args[0] == "--verify" {
				return []byte("explanation"), verifyErr
			}
			return []byte(dv), nil
		}, &calls
	}
	const goodDV = "Executable=/x\nIdentifier=merlin\nTeamIdentifier=L258LHG5T6\n"
	ctx := context.Background()

	run, calls := fake(nil, goodDV)
	setVar(t, &runCodesign, run)
	if err := verifyCodesign(ctx, "darwin", "/x"); err != nil {
		t.Errorf("match refused: %v", err)
	}
	if len(*calls) != 2 || (*calls)[0][1] != "--strict" {
		t.Errorf("calls = %v", *calls)
	}

	for name, c := range map[string]struct {
		verifyErr error
		dv        string
		want      string
	}{
		"other team":  {nil, "TeamIdentifier=ABCDE12345\n", `team "ABCDE12345"`},
		"no team":     {nil, "TeamIdentifier=not set\nSignature=adhoc\n", `team "not set"`},
		"no field":    {nil, "Identifier=merlin\n", "no TeamIdentifier"},
		"invalid sig": {errors.New("exit status 1"), goodDV, "no valid macOS code signature"},
	} {
		run, _ := fake(c.verifyErr, c.dv)
		setVar(t, &runCodesign, run)
		err := verifyCodesign(ctx, "darwin", "/x")
		if err == nil || !strings.Contains(err.Error(), c.want) || !strings.Contains(err.Error(), "refusing to install") {
			t.Errorf("%s: err = %v, want %q", name, err, c.want)
		}
	}

	// Other platforms never run codesign.
	setVar(t, &runCodesign, func(context.Context, ...string) ([]byte, error) {
		t.Error("codesign ran on linux")
		return nil, nil
	})
	if err := verifyCodesign(ctx, "linux", "/x"); err != nil {
		t.Error(err)
	}
}

func TestStageReleaseLeavesNoStagedFileOnRefusal(t *testing.T) {
	rel := &fakeRelease{latest: "0.9.0", sig: sigNone}
	rel.start(t)
	real := installed(t, "0.3.0")
	if _, err := stageRelease(context.Background(), real, "0.9.0"); err == nil {
		t.Fatal("staged an unsigned release")
	}
	if l := leftovers(t, filepath.Dir(real)); len(l) != 0 {
		t.Errorf("left %v", l)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(real), prevName)); err == nil {
		t.Error("prev created")
	}
}
