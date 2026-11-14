package catalog

import (
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/repos"
)

// folderFixture: /box is a container (a bare repository with a worktree /box/seat, and an
// inferred /box/src that was once a subfolder of a plain checkout), /home/dev is in no
// repository, /home/dev/proj is a clone, /w is a clone with a sibling worktree /w-b.
func folderFixture() Places {
	const bare = "/box/.bare"
	return Places{Repos: map[string]repos.Repo{
		"/box":           {GitCommonDir: bare},
		"/box/seat":      {Checkout: "/box/seat", GitCommonDir: bare, Worktree: true},
		"/box/src":       {Checkout: "/box/src", GitCommonDir: bare, Inferred: true, Gone: true},
		"/home/dev":      {},
		"/home/dev/proj": {Checkout: "/home/dev/proj", GitCommonDir: "/home/dev/proj/.git"},
		"/w":             {Checkout: "/w", GitCommonDir: "/w/.git"},
		"/w/web":         {Checkout: "/w", GitCommonDir: "/w/.git"},
		"/w-b":           {Checkout: "/w-b", GitCommonDir: "/w/.git", Worktree: true},
	}}
}

func TestFolderFollowsTheWork(t *testing.T) {
	cases := []struct {
		name, start         string
		work                []model.WorkDir
		repo, checkout, dir string
	}{
		{"container root", "/box", []model.WorkDir{wd("/box/src", 2, 0)}, "/box/.bare", "", "/box"},
		{"started in home", "/home/dev", []model.WorkDir{wd("/home/dev/proj", 2, 0)},
			"/home/dev/proj/.git", "/home/dev/proj", "/home/dev/proj"},
		{"started nowhere", "/nowhere", []model.WorkDir{wd("/home/dev/proj", 2, 0)},
			"/home/dev/proj/.git", "/home/dev/proj", "/home/dev/proj"},
		{"commands only", "/home/dev", []model.WorkDir{wd("/home/dev/proj", 0, 5)},
			"/home/dev/proj/.git", "/home/dev/proj", "/home/dev"},
		{"sibling worktree", "/w", []model.WorkDir{wd("/w-b", 3, 0)}, "/w/.git", "/w-b", "/w"},
		{"subfolder", "/w/web", []model.WorkDir{wd("/w", 3, 0)}, "/w/.git", "/w", "/w/web"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := locSession("s", tc.start, tc.work...)
			p, c := primary(t, folderFixture(), d)
			if repoOf(p) != tc.repo || p.Checkout != tc.checkout {
				t.Errorf("repo %q checkout %q, want %q %q", repoOf(p), p.Checkout, tc.repo, tc.checkout)
			}
			gs, err := c.Groups(GroupDir, Filter{})
			if err != nil || len(gs) != 1 || gs[0].Key != tc.dir {
				t.Errorf("by dir = %+v, %v; want %q", gs, err, tc.dir)
			}
			oc := ovCatalog(d)
			oc.SetPlaces(folderFixture())
			ov, err := oc.Overview(ovQuery(time.Hour, 3))
			if err != nil {
				t.Fatal(err)
			}
			if l := laneOf(t, ov, "s"); l.Dir != tc.dir || l.Project != tc.start {
				t.Errorf("lane dir %q project %q, want %q %q", l.Dir, l.Project, tc.dir, tc.start)
			}
		})
	}
}

func TestFolderRollupAgrees(t *testing.T) {
	c := New()
	c.Upsert(locSession("a", "/home/dev", wd("/home/dev/proj", 2, 0)))
	c.Upsert(locSession("b", "/home/dev", wd("/home/dev/proj", 0, 2)))
	c.Upsert(locSession("c", "/w", wd("/w-b", 1, 0)))
	c.SetPlaces(folderFixture())
	total := c.Total(Filter{}).TotalUSD
	gs, _ := c.Groups(GroupDir, Filter{})
	byGroup := map[string]float64{}
	var sumG, sumR float64
	for _, g := range gs {
		byGroup[g.Key] += g.Money.TotalUSD
		sumG += g.Money.TotalUSD
	}
	for _, r := range c.Rollup(Filter{}, ByDir) {
		sumR += r.TotalUSD
		wantNear(t, "dir "+r.Dir, r.TotalUSD, byGroup[r.Dir])
	}
	wantNear(t, "groups", sumG, total)
	wantNear(t, "rollup", sumR, total)
	if len(byGroup) != 3 || byGroup["/home/dev/proj"] == 0 || byGroup["/home/dev"] == 0 || byGroup["/w"] == 0 {
		t.Errorf("by dir = %v", byGroup)
	}
}

// A session that started in no repository and stopped inside the checkout it edited: the start
// directory decides, not where it stopped (Cwd), so the folder still follows the work.
func TestFolderStartedOutsideStoppedInside(t *testing.T) {
	d := locSession("s", "/home/dev", wd("/home/dev/proj", 2, 0))
	d.Cwd = "/home/dev/proj"
	p, c := primary(t, folderFixture(), d)
	if p.Checkout != "/home/dev/proj" {
		t.Errorf("checkout %q, want /home/dev/proj", p.Checkout)
	}
	gs, err := c.Groups(GroupDir, Filter{})
	if err != nil || len(gs) != 1 || gs[0].Key != "/home/dev/proj" {
		t.Errorf("by dir = %+v, %v; want /home/dev/proj", gs, err)
	}
}
