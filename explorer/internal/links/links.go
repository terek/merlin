// Package links keeps Merlin's two lookups of where sessions worked up to date: the
// repository cache (internal/repos, <MERLIN_HOME>/repos.json) and the bead registry
// (internal/beads, <MERLIN_HOME>/beads/). The daemon and `merlin scan` call Refresh with the
// directories their digests name. Harness-neutral. Design: docs/beads-and-repos.md §4.4.
package links

import (
	"errors"
	"io/fs"
	"path/filepath"
	"slices"
	"time"

	"github.com/terek/merlin/explorer/internal/beads"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/repos"
)

// RecheckAfter is how long a resolved directory is trusted before it is looked at again (a
// worktree may have been removed, a .beads directory added).
const RecheckAfter = time.Hour

// Index is the repository cache and the bead registry together.
type Index struct {
	Repos *repos.Cache
	Beads *beads.Registry
}

// Open loads both from MERLIN_HOME.
func Open(home string) *Index {
	return &Index{Repos: repos.Open(home), Beads: beads.OpenRegistry(home)}
}

// Dirs returns the directories a digest names: where the session started, every working
// directory it had, where its bd calls ran, and the directories of the files it changed.
func Dirs(d *model.SessionDigest) []string {
	var out []string
	add := func(p string) {
		if p != "" && filepath.IsAbs(p) {
			out = append(out, filepath.Clean(p))
		}
	}
	add(d.Project)
	add(d.Cwd)
	for _, c := range d.Cwds {
		add(c)
	}
	for _, e := range d.Beads {
		add(e.Cwd)
	}
	for _, t := range d.Turns {
		for _, f := range t.FilesTouched {
			if filepath.IsAbs(f) {
				add(filepath.Dir(f))
			}
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// Result says what a Refresh did.
type Result struct {
	Resolved  int // repository entries added or changed
	Databases int // bead snapshots written
}

// Refresh resolves the directories not looked at within RecheckAfter, then brings the
// snapshot of every beads database known to the cache up to date (a database whose export is
// unchanged costs a stat), and saves the cache. Errors of single databases are returned joined;
// the rest of the work is still done.
func (x *Index) Refresh(dirs []string, now time.Time) (Result, error) {
	var res Result
	res.Resolved = x.Repos.Refresh(dirs, RecheckAfter, now)
	seen := map[string]bool{}
	var dbs []string
	for _, r := range x.Repos.All() {
		if r.Beads != "" && !seen[r.Beads] {
			seen[r.Beads] = true
			dbs = append(dbs, r.Beads)
		}
	}
	slices.Sort(dbs)
	var errs []error
	for _, b := range dbs {
		changed, err := x.Beads.Refresh(b)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			// The database went away (a deleted repository): its snapshot stays as it was.
		case err != nil:
			errs = append(errs, err)
		case changed:
			res.Databases++
		}
	}
	if err := x.Repos.Save(); err != nil {
		errs = append(errs, err)
	}
	return res, errors.Join(errs...)
}
