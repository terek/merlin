package daemon

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SweepTemp removes the temp files that a killed process can leave behind under root: the
// store writes "<dot><name>.<random>.tmp" next to the final file and renames it. Only files
// older than minAge are removed, so a write in flight in another process (explorer scan)
// is left alone. It returns the number of files removed.
func SweepTemp(root string, minAge time.Duration, now time.Time) (int, error) {
	var n int
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == root {
				return err
			}
			return nil // vanished or unreadable: not worth stopping for
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		name := d.Name()
		if !strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".tmp") {
			return nil
		}
		info, err := d.Info()
		if err != nil || now.Sub(info.ModTime()) < minAge {
			return nil
		}
		if os.Remove(p) == nil {
			n++
		}
		return nil
	})
	return n, err
}
