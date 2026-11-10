package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// SetKey sets one top-level key of <home>/config.json to the JSON encoding of value and
// keeps every other key and its value. The file (and home, mode 0o700) is created when
// missing; an empty file counts as {}. A file that is not a JSON object is left alone and
// reported. The write is atomic (a temp file in the same directory, renamed over the
// file) and keeps the file's mode; keys come out sorted, indented by two spaces.
func SetKey(home, key string, value any) error {
	path := filepath.Join(home, FileName)
	top := map[string]json.RawMessage{}
	mode := os.FileMode(0o644)
	switch b, err := os.ReadFile(path); {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return err
	default:
		if fi, err := os.Stat(path); err == nil {
			mode = fi.Mode().Perm()
		}
		if len(bytes.TrimSpace(b)) > 0 {
			err := json.Unmarshal(b, &top)
			if err == nil && top == nil {
				err = errors.New("null")
			}
			if err != nil {
				return fmt.Errorf("%s is not a JSON object (%v); fix or remove it, then try again", path, err)
			}
		}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	top[key] = raw
	out, err := json.MarshalIndent(top, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(home, ".config.json.*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once renamed
	if _, err := tmp.Write(append(out, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// SetAutoUpgrade writes the "autoUpgrade" key: true, false or "patch".
func SetAutoUpgrade(home string, p UpgradePolicy) error {
	var v any
	switch p {
	case UpgradeOn:
		v = true
	case UpgradeOff:
		v = false
	case UpgradePatch:
		v = "patch"
	default:
		return fmt.Errorf("unknown auto-upgrade policy %q", p)
	}
	return SetKey(home, "autoUpgrade", v)
}
