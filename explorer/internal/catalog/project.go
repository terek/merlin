package catalog

import (
	"sort"

	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/store"
)

// ProjectFile is the content of project.json: the listing of one harness project
// directory, derived from the digests and rebuildable at any time. It holds no clock
// dependent field (no liveness).
type ProjectFile struct {
	Harness    string         `json:"harness"`
	ProjectKey string         `json:"projectKey"`
	Project    string         `json:"project"`
	Sessions   []SessionInfo  `json:"sessions"`
	Scripted   []ScriptedLine `json:"scripted,omitempty"`
}

// ProjectFiles returns the project.json content for every harness project key, ordered
// by harness then key.
func (c *Catalog) ProjectFiles() []ProjectFile {
	v := c.view()
	type key struct{ harness, projectKey string }
	files := make(map[key]*ProjectFile)
	var keys []key
	for _, s := range v.sessions {
		k := key{s.key.Harness, s.d.ProjectKey}
		pf := files[k]
		if pf == nil {
			pf = &ProjectFile{Harness: k.harness, ProjectKey: k.projectKey, Project: s.project}
			files[k] = pf
			keys = append(keys, k)
		}
		if s.d.Kind != model.KindSDK {
			pf.Sessions = append(pf.Sessions, s.info)
		}
	}
	for _, k := range keys {
		pf := files[k]
		sort.SliceStable(pf.Sessions, func(i, j int) bool {
			a, b := pf.Sessions[i], pf.Sessions[j]
			if !a.LastActivityAt.Equal(b.LastActivityAt) {
				return a.LastActivityAt.After(b.LastActivityAt)
			}
			return a.Key.ID < b.Key.ID
		})
		pf.Scripted = v.scripted(Filter{Harness: k.harness, Project: k.projectKey})
	}
	out := make([]ProjectFile, len(keys))
	for i, k := range keys {
		out[i] = *files[k]
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Harness != out[j].Harness {
			return out[i].Harness < out[j].Harness
		}
		return out[i].ProjectKey < out[j].ProjectKey
	})
	return out
}

// WriteProjects writes project.json for every project key in the catalog.
func (c *Catalog) WriteProjects(st *store.Store) error {
	for _, pf := range c.ProjectFiles() {
		if err := st.WriteProject(pf.Harness, pf.ProjectKey, pf); err != nil {
			return err
		}
	}
	return nil
}
