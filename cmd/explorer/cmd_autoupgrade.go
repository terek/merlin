package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/terek/merlin/internal/config"
)

func init() {
	register("autoupgrade", command{
		usage:   "autoupgrade [on|patch|off|status]",
		summary: "install new releases by itself (opt-in; bare: on)",
		run:     runAutoupgrade,
	})
}

func runAutoupgrade(args []string) int {
	arg := "on"
	switch {
	case len(args) > 1:
		fmt.Fprintln(os.Stderr, "merlin autoupgrade: unexpected arguments")
		return 2
	case len(args) == 1:
		arg = args[0]
	}
	if arg != "status" {
		if _, ok := autoupgradeArgs[arg]; !ok {
			fmt.Fprintf(os.Stderr, "merlin autoupgrade: %q is not on, patch, off or status\n", arg)
			return 2
		}
	}
	applyReleasesEnv()
	home, err := homeDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "merlin autoupgrade: %v\n", err)
		return 1
	}
	if arg == "status" {
		autoupgradeStatus(os.Stdout, home)
		return 0
	}
	return autoupgradeSet(os.Stdout, os.Stderr, home, autoupgradeArgs[arg])
}

var autoupgradeArgs = map[string]config.UpgradePolicy{
	"on":    config.UpgradeOn,
	"patch": config.UpgradePatch,
	"off":   config.UpgradeOff,
}

// autoupgradeSet writes the setting and, for on and patch, installs the newest release it
// allows at once, as `merlin upgrade` would. The setting is the point: once it is saved,
// a failed install is only a warning (serve tries again), and the exit code stays 0.
func autoupgradeSet(out, errw io.Writer, home string, pol config.UpgradePolicy) int {
	if err := config.SetAutoUpgrade(home, pol); err != nil {
		fmt.Fprintf(errw, "merlin autoupgrade: %v\n", err)
		return 1
	}
	cfgPath := filepath.Join(home, config.FileName)
	switch pol {
	case config.UpgradeOn:
		fmt.Fprintf(out, "Auto-upgrade is on (\"autoUpgrade\": true in %s): merlin serve installs every new release.\n", cfgPath)
	case config.UpgradePatch:
		fmt.Fprintf(out, "Auto-upgrade is on for patch releases (\"autoUpgrade\": \"patch\" in %s): merlin serve installs new releases of this major.minor line only.\n", cfgPath)
	default:
		fmt.Fprintf(out, "Auto-upgrade is off (\"autoUpgrade\": false in %s). merlin serve keeps reporting new releases; merlin upgrade installs one.\n", cfgPath)
	}
	if v, ok := os.LookupEnv("MERLIN_AUTO_UPGRADE"); ok {
		if _, ok := config.ParseUpgradePolicy(v); ok {
			fmt.Fprintf(errw, "Warning: MERLIN_AUTO_UPGRADE=%s is set in the environment and overrides %s for merlin serve.\n", v, config.FileName)
		}
	}
	if pol == config.UpgradeOff {
		return 0
	}
	if isDevVersion(version) {
		fmt.Fprintf(out, "This is a development build (%s): not installing anything now, and merlin serve never upgrades one.\n", version)
		return 0
	}
	if err := installNewest(out, home, pol); err != nil {
		fmt.Fprintf(errw, "Warning: could not install the newest release now: %v\nThe setting is saved; merlin serve tries again at its next check.\n", err)
		return 0
	}
	fmt.Fprintln(out, "A running merlin serve switches to a new binary within a minute and reads this setting at its next check.")
	return 0
}

// installNewest installs the newest release that policy pol allows, or says that this one
// is current.
func installNewest(out io.Writer, home string, pol config.UpgradePolicy) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var target string
	if pol == config.UpgradePatch {
		p, err := latestPatch(ctx, version, loadBad(home))
		if err != nil {
			return err
		}
		target = p
	} else {
		latest, err := latestVersion(ctx)
		if err != nil {
			return err
		}
		if compareVersions(latest, version) > 0 {
			target = latest
		}
	}
	if target == "" {
		fmt.Fprintf(out, "merlin %s is up to date.\n", version)
		return nil
	}
	return install(out, version, target)
}

// autoupgradeStatus prints the effective policy and where it comes from, the running
// version and, if it can be asked quickly, the latest release.
func autoupgradeStatus(w io.Writer, home string) {
	pol, src := upgradePolicy(home, false)
	state := string(pol)
	if pol == config.UpgradePatch {
		state = "on, patch releases only"
	}
	fmt.Fprintf(w, "auto-upgrade: %s (%s)\n", state, src)
	fmt.Fprintf(w, "running:      merlin %s\n", version)
	if isDevVersion(version) {
		fmt.Fprintln(w, "This is a development build: merlin serve neither checks for nor installs releases.")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), startupCheckTimeout)
	defer cancel()
	latest, err := latestVersion(ctx)
	switch {
	case err != nil:
		fmt.Fprintf(w, "latest:       unknown (%v)\n", err)
	case compareVersions(latest, version) > 0:
		fmt.Fprintf(w, "latest:       %s, newer than this one (merlin upgrade installs it)\n", latest)
	default:
		fmt.Fprintf(w, "latest:       %s, this one is current\n", latest)
	}
}
