package server

import (
	"math"
	"testing"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/repos"
)

func TestGroupingEndpoints(t *testing.T) {
	r := newRig(t)
	acme := repos.Repo{Top: "/home/dev/acme", Repo: "/home/dev/acme", Remote: "git@example.com:acme.git"}
	r.cat.SetPlaces(catalog.Places{Repos: map[string]repos.Repo{
		"/home/dev/acme/fork": acme, "/home/dev/acme/nest": acme,
	}})

	var rl RepoList
	if code := r.get("/api/repos", &rl); code != 200 {
		t.Fatalf("repos: %d", code)
	}
	if len(rl.Repos) != 2 || rl.Repos[0].Repo != "/home/dev/acme" || rl.Repos[0].Name != "acme" || rl.Repos[1].Repo != "" {
		t.Fatalf("repos = %+v", rl.Repos)
	}
	var l SessionList
	r.get("/api/sessions?repo=/home/dev/acme", &l)
	if l.Total != rl.Repos[0].Sessions || l.Total == 0 {
		t.Errorf("sessions in acme = %d, the repository lists %d", l.Total, rl.Repos[0].Sessions)
	}
	for _, s := range l.Sessions {
		if s.Repo == nil || s.Repo.Repo != "/home/dev/acme" {
			t.Errorf("%s: repo = %+v", s.Key, s.Repo)
		}
	}
	var none SessionList
	r.get("/api/sessions?repo=-", &none)
	if none.Total != rl.Repos[1].Sessions {
		t.Errorf("sessions in no repository = %d, want %d", none.Total, rl.Repos[1].Sessions)
	}

	var d SessionDetail
	r.get("/api/sessions/"+l.Sessions[0].Key.Harness+"/"+l.Sessions[0].Key.ID, &d)
	if d.Places.Repo == nil || d.Places.Repo.Remote != acme.Remote {
		t.Errorf("detail places = %+v", d.Places)
	}

	var bl BeadList
	if code := r.get("/api/beads", &bl); code != 200 || len(bl.Families) != 0 || bl.Databases != 0 {
		t.Errorf("beads: %d %+v", code, bl)
	}

	var byProject CostTable
	r.get("/api/cost?by=project", &byProject)
	for _, by := range []string{"repo", "branch", "bead", "family"} {
		var ct CostTable
		if code := r.get("/api/cost?by="+by, &ct); code != 200 {
			t.Fatalf("cost by %s: %d", by, code)
		}
		var sum float64
		for _, row := range ct.Rows {
			sum += row.TotalUSD
		}
		if math.Abs(sum-byProject.Total.TotalUSD) > 1e-6 {
			t.Errorf("cost by %s adds up to %.6f, by project to %.6f", by, sum, byProject.Total.TotalUSD)
		}
	}
	var bead CostTable
	r.get("/api/cost?by=bead", &bead)
	if len(bead.Rows) != 1 || bead.Rows[0].Key != "" || bead.Rows[0].Label != "no bead" {
		t.Errorf("by bead with no databases = %+v", bead.Rows)
	}
	r.wantError("/api/cost?by=repo&split=day", 400, CodeInvalidParameter)
}
