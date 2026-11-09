package main

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"

	"github.com/terek/merlin/internal/release"
)

// codesignCheck is the extra check on a staged binary before anything runs it or swaps it
// in. Seam: tests replace it, so they need no signed binary and run on any OS.
var codesignCheck = checkCodesign

// runCodesign runs codesign and returns its combined output; a seam for tests.
var runCodesign = func(ctx context.Context, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, "codesign", args...).CombinedOutput()
}

// checkCodesign, on macOS, requires path to have a valid code signature made by our
// Developer ID team. Elsewhere it does nothing.
func checkCodesign(ctx context.Context, path string) error {
	return verifyCodesign(ctx, runtime.GOOS, path)
}

func verifyCodesign(ctx context.Context, goos, path string) error {
	if goos != "darwin" {
		return nil
	}
	if out, err := runCodesign(ctx, "--verify", "--strict", path); err != nil {
		return fmt.Errorf("the downloaded binary has no valid macOS code signature; refusing to install: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	out, err := runCodesign(ctx, "-dv", path)
	if err != nil {
		return fmt.Errorf("cannot read the code signature of the downloaded binary; refusing to install: %w", err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		if id, ok := strings.CutPrefix(strings.TrimSpace(line), "TeamIdentifier="); ok {
			if id == release.AppleTeamID {
				return nil
			}
			return fmt.Errorf("the downloaded binary is signed by team %q, not %s; refusing to install", id, release.AppleTeamID)
		}
	}
	return fmt.Errorf("the downloaded binary is not signed by team %s (no TeamIdentifier); refusing to install", release.AppleTeamID)
}
