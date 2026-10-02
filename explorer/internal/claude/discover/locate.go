package discover

import (
	"os"
	"path/filepath"
)

// ScanSession lists one session: the same Source Scan would give for it, found by walking
// only its project directory. An empty projectKey is searched for among the project
// directories (a stat of <project>/<id>.jsonl and <project>/<id> in each), and failing that
// by a full Scan. found is false
// when the session has no files. When the id exists in several places inside the project
// directory the first by main transcript path is returned.
func ScanSession(projectsDir, projectKey, id string) (src Source, found bool, warnings []Warning, err error) {
	if id == "" || filepath.Base(id) != id {
		return Source{}, false, nil, nil
	}
	if projectKey == "" {
		entries, err := os.ReadDir(projectsDir)
		if err != nil {
			return Source{}, false, nil, err
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			base := filepath.Join(projectsDir, e.Name())
			if exists(filepath.Join(base, id+".jsonl")) || exists(filepath.Join(base, id)) {
				projectKey = e.Name()
				break
			}
		}
		if projectKey == "" {
			// Not directly under a project directory: either nested deeper (Claude Code
			// does this for some working directories) or not there at all. Only a full
			// walk can tell; it costs a few tens of milliseconds.
			res, err := Scan(projectsDir)
			if err != nil {
				return Source{}, false, nil, err
			}
			for _, s := range res.Sessions {
				if s.ID == id {
					return s, true, res.Warnings, nil
				}
			}
			return Source{}, false, res.Warnings, nil
		}
	} else if filepath.Base(projectKey) != projectKey {
		return Source{}, false, nil, nil
	}
	dir := filepath.Join(projectsDir, projectKey)
	if _, err := os.Stat(dir); err != nil {
		if os.IsNotExist(err) {
			return Source{}, false, nil, nil
		}
		return Source{}, false, nil, err
	}
	w := &walker{}
	w.dir(dir, projectKey)
	for _, s := range w.out {
		if s.ID != id {
			continue
		}
		if !found || locus(s) < locus(src) {
			src, found = s, true
		}
	}
	return src, found, w.warnings, nil
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
