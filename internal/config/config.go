// Package config reads <MERLIN_HOME>/config.json, the one file of user preferences.
//
// The file is the user's: it is never written, created or moved. A missing file, a
// malformed one and a key of the wrong type are all survivable: Load returns the default
// for what it could not read, and a warning that names the file, the key and the default.
// Unknown keys are ignored, so a newer or older merlin can share the file.
//
// Precedence everywhere is command-line flag, then environment variable, then this file,
// then the built-in default; Load only knows the last two.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/terek/merlin/internal/pricing"
)

// FileName is the config file in MERLIN_HOME.
const FileName = "config.json"

// Config is the user's preferences. The zero value is not the default; use Default.
type Config struct {
	// Port is the daemon's TCP port, 0 when the file does not set one.
	Port int
	// Prices are the "prices" overrides, by model name (see docs/pricing.md).
	Prices map[string]pricing.Price
	// AutoUpgrade is the "autoUpgrade" key: what the daemon may upgrade itself to.
	// UpgradeOn when the file does not say.
	AutoUpgrade UpgradePolicy
}

// UpgradePolicy says which releases the daemon installs by itself. In config.json it is
// true (UpgradeOn), false (UpgradeOff) or "patch" (UpgradePatch).
type UpgradePolicy string

const (
	UpgradeOn    UpgradePolicy = "on"    // every newer release
	UpgradeOff   UpgradePolicy = "off"   // none
	UpgradePatch UpgradePolicy = "patch" // newer patch releases of the running major.minor only
)

// ParseUpgradePolicy reads an environment value: on/true/1/yes, off/false/0/no or patch,
// in any case. ok is false for anything else.
func ParseUpgradePolicy(s string) (p UpgradePolicy, ok bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return UpgradeOn, true
	case "0", "false", "no", "off":
		return UpgradeOff, true
	case "patch":
		return UpgradePatch, true
	}
	return "", false
}

// Default returns the config of a user with no file.
func Default() Config { return Config{AutoUpgrade: UpgradeOn} }

// Load reads the config file of the MERLIN_HOME directory home. It is cheap (one small
// file) and may be called again to pick up an edit. It never fails: whatever could not be
// read is a warning, and its default.
func Load(home string) (Config, []string) {
	c := Default()
	path := filepath.Join(home, FileName)
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, []string{fmt.Sprintf("%s: %v; using the default settings", path, err)}
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return c, nil
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(b, &top); err != nil {
		return c, []string{fmt.Sprintf("%s: not a JSON object (%v); using the default settings", path, err)}
	}
	var warns []string
	bad := func(key, want, def string, err error) {
		warns = append(warns, fmt.Sprintf("%s: %q must be %s (%v); using %s", path, key, want, err, def))
	}
	if raw, ok := top["port"]; ok {
		var p int
		if err := json.Unmarshal(raw, &p); err != nil {
			bad("port", "an integer", "the default port", err)
		} else if p < 1 || p > 65535 {
			bad("port", "between 1 and 65535", "the default port", fmt.Errorf("got %d", p))
		} else {
			c.Port = p
		}
	}
	if raw, ok := top["autoUpgrade"]; ok {
		var b bool
		var str string
		switch {
		case json.Unmarshal(raw, &b) == nil:
			c.AutoUpgrade = UpgradeOn
			if !b {
				c.AutoUpgrade = UpgradeOff
			}
		case json.Unmarshal(raw, &str) == nil && str == "patch":
			c.AutoUpgrade = UpgradePatch
		default:
			bad("autoUpgrade", `true, false or "patch"`, "true", fmt.Errorf("got %s", bytes.TrimSpace(raw)))
		}
	}
	if raw, ok := top["prices"]; ok {
		var entries map[string]json.RawMessage
		if err := json.Unmarshal(raw, &entries); err != nil {
			bad("prices", "an object of model prices", "the built-in prices", err)
		}
		for name, e := range entries {
			var p pricing.Price
			if err := json.Unmarshal(e, &p); err != nil {
				bad("prices."+name, "a price object", "the built-in price", err)
				continue
			}
			if c.Prices == nil {
				c.Prices = make(map[string]pricing.Price)
			}
			c.Prices[name] = p
		}
	}
	return c, warns
}
