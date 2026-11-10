package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetKeyKeepsOtherKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	os.WriteFile(path, []byte(`{"port": 8001, "prices": {"m": {"input": 1, "output": 2, "cacheRead": 3}}, "theme": ["dark"]}`), 0o640)
	if err := SetAutoUpgrade(dir, UpgradePatch); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if !strings.HasSuffix(string(b), "}\n") || !strings.Contains(string(b), "\n  \"autoUpgrade\": \"patch\",") {
		t.Errorf("not indented JSON with a trailing newline:\n%s", b)
	}
	c, warns := Load(dir)
	if len(warns) != 0 || c.Port != 8001 || c.AutoUpgrade != UpgradePatch || len(c.Prices) != 1 {
		t.Errorf("%+v %q", c, warns)
	}
	if !strings.Contains(string(b), `"theme": [`) {
		t.Errorf("unknown key lost:\n%s", b)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o640 {
		t.Errorf("mode = %v", fi.Mode())
	}
	for _, p := range []UpgradePolicy{UpgradeOn, UpgradeOff} {
		if err := SetAutoUpgrade(dir, p); err != nil {
			t.Fatal(err)
		}
		if c, _ := Load(dir); c.AutoUpgrade != p {
			t.Errorf("after %q: %q", p, c.AutoUpgrade)
		}
	}
	if b, _ := os.ReadFile(path); !strings.Contains(string(b), `"autoUpgrade": false`) {
		t.Errorf("off is not false:\n%s", b)
	}
	if err := SetAutoUpgrade(dir, "sometimes"); err == nil {
		t.Error("unknown policy accepted")
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".config.json.*")); len(left) != 0 {
		t.Errorf("temp files left: %v", left)
	}
}

func TestSetKeyCreates(t *testing.T) {
	home := filepath.Join(t.TempDir(), "nested", ".merlin")
	if err := SetAutoUpgrade(home, UpgradeOn); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(home); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("home: %v %v", fi, err)
	}
	b, _ := os.ReadFile(filepath.Join(home, FileName))
	if string(b) != "{\n  \"autoUpgrade\": true\n}\n" {
		t.Errorf("file = %q", b)
	}
	// An empty file counts as {}.
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, FileName), []byte("\n"), 0o600)
	if err := SetAutoUpgrade(dir, UpgradeOff); err != nil {
		t.Fatal(err)
	}
}

func TestSetKeyRefusesNonObjects(t *testing.T) {
	for _, body := range []string{`[1]`, `{"port": `, `null`, `"x"`} {
		dir := t.TempDir()
		path := filepath.Join(dir, FileName)
		os.WriteFile(path, []byte(body), 0o600)
		err := SetAutoUpgrade(dir, UpgradeOn)
		if err == nil || !strings.Contains(err.Error(), "not a JSON object") || !strings.Contains(err.Error(), path) {
			t.Errorf("%q: err = %v", body, err)
		}
		if b, _ := os.ReadFile(path); string(b) != body {
			t.Errorf("%q: file changed to %q", body, b)
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 1 {
			t.Errorf("%q: stray files %v", body, entries)
		}
	}
}
