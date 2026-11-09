package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNoFile(t *testing.T) {
	dir := t.TempDir()
	c, warns := Load(dir)
	if c.Port != 0 || c.AutoUpgrade != UpgradeOn || len(c.Prices) != 0 || len(warns) != 0 {
		t.Errorf("%+v %q", c, warns)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("Load created files: %v", entries)
	}
}

func TestValues(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		port      int
		auto      UpgradePolicy
		prices    []string // model names expected in Prices
		warnParts []string
	}{
		{"empty file", " \n", 0, UpgradeOn, nil, nil},
		{"port", `{"port": 8001}`, 8001, UpgradeOn, nil, nil},
		{"autoUpgrade false", `{"autoUpgrade": false}`, 0, UpgradeOff, nil, nil},
		{"autoUpgrade true", `{"autoUpgrade": true}`, 0, UpgradeOn, nil, nil},
		{"unknown keys ignored", `{"theme": "dark", "nested": {"a": 1}, "port": 9000}`, 9000, UpgradeOn, nil, nil},
		{"prices", `{"prices": {"m": {"input": 1, "output": 2, "cacheRead": 3}}}`, 0, UpgradeOn, []string{"m"}, nil},
		{"malformed JSON", `{"port": `, 0, UpgradeOn, nil, []string{"config.json", "default settings"}},
		{"not an object", `[1, 2]`, 0, UpgradeOn, nil, []string{"not a JSON object"}},
		{"port is a string", `{"port": "80", "autoUpgrade": false}`, 0, UpgradeOff, nil, []string{`"port"`, "default port"}},
		{"port out of range", `{"port": 70000}`, 0, UpgradeOn, nil, []string{`"port"`, "1 and 65535"}},
		{"port fractional", `{"port": 80.5}`, 0, UpgradeOn, nil, []string{`"port"`}},
		{"autoUpgrade patch", `{"autoUpgrade": "patch"}`, 0, UpgradePatch, nil, nil},
		{"autoUpgrade other string", `{"autoUpgrade": "minor"}`, 0, UpgradeOn, nil, []string{`"autoUpgrade"`, `"patch"`, "using true"}},
		{"autoUpgrade number", `{"autoUpgrade": 1}`, 0, UpgradeOn, nil, []string{`"autoUpgrade"`, "using true"}},
		{"autoUpgrade wrong type", `{"autoUpgrade": "no", "port": 9000}`, 9000, UpgradeOn, nil, []string{`"autoUpgrade"`, "using true"}},
		{"prices wrong type", `{"prices": [1]}`, 0, UpgradeOn, nil, []string{`"prices"`, "built-in prices"}},
		{"one bad price entry", `{"prices": {"bad": 5, "ok": {"input": 1, "output": 1, "cacheRead": 1}}}`, 0, UpgradeOn,
			[]string{"ok"}, []string{`"prices.bad"`}},
		{"price field wrong type", `{"prices": {"bad": {"input": "x"}}}`, 0, UpgradeOn, nil, []string{`"prices.bad"`}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(tc.body), 0o600); err != nil {
				t.Fatal(err)
			}
			c, warns := Load(dir)
			if c.Port != tc.port || c.AutoUpgrade != tc.auto {
				t.Errorf("port %d autoUpgrade %v, want %d %v", c.Port, c.AutoUpgrade, tc.port, tc.auto)
			}
			if len(c.Prices) != len(tc.prices) {
				t.Errorf("prices %v, want %v", c.Prices, tc.prices)
			}
			for _, n := range tc.prices {
				if _, ok := c.Prices[n]; !ok {
					t.Errorf("price %q missing", n)
				}
			}
			all := strings.Join(warns, "\n")
			if len(tc.warnParts) == 0 && all != "" {
				t.Errorf("unexpected warnings %q", warns)
			}
			for _, part := range tc.warnParts {
				if !strings.Contains(all, part) {
					t.Errorf("no warning with %q in %q", part, warns)
				}
			}
			if len(tc.warnParts) > 0 && !strings.Contains(all, filepath.Join(dir, "config.json")) {
				t.Errorf("warning does not name the file: %q", warns)
			}
			if b, _ := os.ReadFile(filepath.Join(dir, "config.json")); string(b) != tc.body {
				t.Error("the file was changed")
			}
		})
	}
}

func TestParseUpgradePolicy(t *testing.T) {
	for in, want := range map[string]UpgradePolicy{"1": UpgradeOn, "True": UpgradeOn, "off": UpgradeOff, "0": UpgradeOff, " patch ": UpgradePatch, "PATCH": UpgradePatch} {
		if got, ok := ParseUpgradePolicy(in); !ok || got != want {
			t.Errorf("%q = %q %v, want %q", in, got, ok, want)
		}
	}
	if _, ok := ParseUpgradePolicy("minor"); ok {
		t.Error("minor accepted")
	}
}
