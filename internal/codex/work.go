package codex

import (
	"path"
	"slices"
	"strings"

	"github.com/terek/merlin/internal/model"
)

// workCall is one FileChange path (edit) or shell command, and the directory it worked in. A
// call in a relative or unknown directory is not counted.
type workCall struct {
	dir  string
	edit bool
}

// workDirs counts the calls per directory, sorted by directory; nil when there are none.
func workDirs(calls []workCall) []model.WorkDir {
	by := map[string]*model.WorkDir{}
	for _, c := range calls {
		if !path.IsAbs(c.dir) {
			continue
		}
		dir := path.Clean(c.dir)
		e := by[dir]
		if e == nil {
			e = &model.WorkDir{Dir: dir}
			by[dir] = e
		}
		if c.edit {
			e.Edits++
		} else {
			e.Commands++
		}
	}
	if len(by) == 0 {
		return nil
	}
	out := make([]model.WorkDir, 0, len(by))
	for _, e := range by {
		out = append(out, *e)
	}
	slices.SortFunc(out, func(a, b model.WorkDir) int { return strings.Compare(a.Dir, b.Dir) })
	return out
}
