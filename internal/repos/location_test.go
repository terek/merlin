package repos

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const head = "ref: refs/heads/main\n"

func origin(url string) string {
	return "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = " + url + "\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n"
}

// locations builds one fixture per row of the layout table of docs/location.md §2, copying what
// git writes (relative gitdir paths, core.worktree in a submodule's config, a bare repository's
// shared config saying bare = true). Everything is below the returned root.
func locations(t *testing.T) string {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	j := func(p ...string) string { return filepath.Join(append([]string{root}, p...)...) }
	const url = "git@github.com:acme/app.git"

	// plain clone with a beads database, a subdirectory, a tool-made worktree inside it
	write(t, j("plain/.git/HEAD"), head)
	write(t, j("plain/.git/config"), origin(url))
	write(t, j("plain/.beads/metadata.json"), `{}`)
	mkdir(t, j("plain/sub/deep"))

	// git worktree add, absolute and relative paths; the first has its own checked-out .beads
	write(t, j("plain/.git/worktrees/wt-abs/commondir"), "../..\n")
	write(t, j("wt-abs/.git"), "gitdir: "+j("plain/.git/worktrees/wt-abs")+"\n")
	write(t, j("wt-abs/.beads/metadata.json"), `{}`)
	write(t, j("plain/.git/worktrees/wt-rel/commondir"), "../..\n")
	write(t, j("wt-rel/.git"), "gitdir: ../plain/.git/worktrees/wt-rel\n")

	// tool-made worktree inside the main checkout
	write(t, j("plain/.git/worktrees/tool/commondir"), "../..\n")
	write(t, j("plain/.claude/worktrees/tool/.git"), "gitdir: "+j("plain/.git/worktrees/tool")+"\n")
	mkdir(t, j("plain/.claude/worktrees/tool/src"))

	// submodule, with core.worktree as git writes it; and one inside a linked worktree
	write(t, j("plain/.git/modules/lib/HEAD"), head)
	write(t, j("plain/.git/modules/lib/config"), "[core]\n\tworktree = ../../../vendor/lib\n"+
		"[remote \"origin\"]\n\turl = https://github.com/acme/lib.git\n")
	write(t, j("plain/vendor/lib/.git"), "gitdir: ../../.git/modules/lib\n")
	write(t, j("plain/.git/worktrees/wt-abs/modules/lib/HEAD"), head)
	write(t, j("plain/.git/worktrees/wt-abs/modules/lib/config"), "[core]\n\tworktree = ../../../../../../wt-abs/vendor/lib\n"+
		"[remote \"origin\"]\n\turl = https://github.com/acme/lib.git\n")
	write(t, j("wt-abs/vendor/lib/.git"), "gitdir: ../../../plain/.git/worktrees/wt-abs/modules/lib\n")

	// bare + worktrees: <root>/.bare, a .git file in <root>, a worktree "main"
	write(t, j("bw/.bare/HEAD"), head)
	mkdir(t, j("bw/.bare/objects"))
	mkdir(t, j("bw/.bare/refs"))
	mkdir(t, j("bw/.bare/hooks"))
	write(t, j("bw/.bare/config"), "[core]\n\trepositoryformatversion = 0\n\tbare = true\n[remote \"origin\"]\n\turl = "+url+"\n")
	write(t, j("bw/.git"), "gitdir: ./.bare\n")
	write(t, j("bw/.bare/worktrees/main/commondir"), "../..\n")
	write(t, j("bw/.bare/worktrees/main/HEAD"), head)
	write(t, j("bw/main/.git"), "gitdir: "+j("bw/.bare/worktrees/main")+"\n")
	mkdir(t, j("bw/main/src"))
	mkdir(t, j("bw/scratch"))
	write(t, j("bw/.beads/metadata.json"), `{}`)

	// pure bare repository, no .git entry
	write(t, j("x.git/HEAD"), head)
	mkdir(t, j("x.git/objects"))
	mkdir(t, j("x.git/refs/heads"))
	write(t, j("x.git/config"), "[core]\n\tbare = true\n[remote \"origin\"]\n\turl = https://example.com/own/x.git\n")

	// a clone with core.bare = true in its own .git
	write(t, j("barehere/.git/HEAD"), head)
	write(t, j("barehere/.git/config"), "[core]\n\tbare = true\n")

	// two clones of one remote; the second redirects its beads; a worktree of the first
	// (no database in the main checkout) with its own
	for _, c := range []string{"clone-a", "clone-b"} {
		write(t, j(c, ".git/HEAD"), head)
		write(t, j(c, ".git/config"), origin(url))
	}
	write(t, j("clone-b/.beads/redirect"), "../plain/.beads\n")
	write(t, j("clone-a/.git/worktrees/wt/commondir"), "../..\n")
	write(t, j("wt-a/.git"), "gitdir: "+j("clone-a/.git/worktrees/wt")+"\n")
	write(t, j("wt-a/.beads/metadata.json"), `{}`)

	// git init --separate-git-dir
	write(t, j("store/sep.git/HEAD"), head)
	mkdir(t, j("store/sep.git/objects"))
	mkdir(t, j("store/sep.git/refs"))
	write(t, j("store/sep.git/config"), "[core]\n\tbare = false\n\tworktree = "+j("sep/work")+"\n[remote \"origin\"]\n\turl = "+url+"\n")
	write(t, j("sep/work/.git"), "gitdir: "+j("store/sep.git")+"\n")

	// vendored clone inside another checkout, origin a local path
	write(t, j("plain/third/vend/.git/HEAD"), head)
	write(t, j("plain/third/vend/.git/config"), origin("../local.git"))

	// worktree whose main repository was deleted; a gitdir pointing nowhere
	write(t, j("orphan/.git"), "gitdir: "+j("gone-main/.git/worktrees/orphan")+"\n")
	write(t, j("lost/.git"), "gitdir: "+j("nowhere/x")+"\n")

	// invalid .git entries inside plain: skipped, the walk continues
	mkdir(t, j("plain/emptygit/.git"))
	write(t, j("plain/nogitdir/.git"), "hello\n")

	// no git at all, and a symlinked route
	mkdir(t, j("nogit/sub"))
	if err := os.Symlink(j("plain"), j("link")); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestLayouts(t *testing.T) {
	root := locations(t)
	j := func(p string) string {
		if p == "" {
			return ""
		}
		return filepath.Join(root, filepath.FromSlash(p))
	}
	const github = "github.com/acme/app"
	tests := []struct {
		name, dir                string
		checkout, common, remote string
		worktree                 bool
		beads                    string
	}{
		{"plain clone", "plain", "plain", "plain/.git", github, false, "plain/.beads"},
		{"plain, subdirectory", "plain/sub/deep", "plain", "plain/.git", github, false, "plain/.beads"},
		{"worktree, absolute", "wt-abs", "wt-abs", "plain/.git", github, true, "plain/.beads"},
		{"worktree, relative", "wt-rel", "wt-rel", "plain/.git", github, true, "plain/.beads"},
		{"tool-made worktree", "plain/.claude/worktrees/tool/src", "plain/.claude/worktrees/tool", "plain/.git", github, true, "plain/.beads"},
		{"bare layout, worktree", "bw/main", "bw/main", "bw/.bare", github, true, "bw/.beads"},
		{"bare layout, worktree subdirectory", "bw/main/src", "bw/main", "bw/.bare", github, true, "bw/.beads"},
		{"bare layout, root", "bw", "", "bw/.bare", github, false, "bw/.beads"},
		{"bare layout, plain directory under root", "bw/scratch", "", "bw/.bare", github, false, "bw/.beads"},
		{"inside the bare store", "bw/.bare/hooks", "", "bw/.bare", github, false, "bw/.beads"},
		{"admin directory of a worktree", "bw/.bare/worktrees/main", "", "bw/.bare", github, false, "bw/.beads"},
		{"pure bare repository", "x.git", "", "x.git", "example.com/own/x", false, ""},
		{"inside a pure bare repository", "x.git/refs/heads", "", "x.git", "example.com/own/x", false, ""},
		{"core.bare in the clone's own config", "barehere", "", "barehere/.git", "", false, ""},
		{"clone a", "clone-a", "clone-a", "clone-a/.git", github, false, ""},
		{"clone b, beads redirect", "clone-b", "clone-b", "clone-b/.git", github, false, "plain/.beads"},
		{"worktree with its own beads, main has none", "wt-a", "wt-a", "clone-a/.git", github, true, "wt-a/.beads"},
		{"submodule", "plain/vendor/lib", "plain/vendor/lib", "plain/.git/modules/lib", "github.com/acme/lib", false, "plain/.beads"},
		{"submodule in a linked worktree", "wt-abs/vendor/lib", "wt-abs/vendor/lib", "plain/.git/worktrees/wt-abs/modules/lib", "github.com/acme/lib", false, "wt-abs/.beads"},
		{"separate git dir", "sep/work", "sep/work", "store/sep.git", github, false, ""},
		{"vendored clone, local origin", "plain/third/vend", "plain/third/vend", "plain/third/vend/.git", "plain/third/local", false, "plain/.beads"},
		{"worktree whose main is gone", "orphan", "orphan", "gone-main/.git", "", true, ""},
		{"gitdir pointing nowhere", "lost", "lost", "", "", false, ""},
		{"empty .git directory", "plain/emptygit", "plain", "plain/.git", github, false, "plain/.beads"},
		{".git file without gitdir", "plain/nogitdir", "plain", "plain/.git", github, false, "plain/.beads"},
		{"no git", "nogit/sub", "", "", "", false, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := Resolve(j(tc.dir))
			if !ok {
				t.Fatal("did not resolve")
			}
			want := Repo{Checkout: j(tc.checkout), GitCommonDir: j(tc.common), Worktree: tc.worktree, Remote: tc.remote, Beads: j(tc.beads)}
			if tc.remote != "" && !strings.HasPrefix(tc.remote, "github.com") && !strings.HasPrefix(tc.remote, "example.com") {
				want.Remote = j(tc.remote) // a local path
			}
			if got != want {
				t.Errorf("Resolve(%s)\n got %+v\nwant %+v", tc.dir, got, want)
			}
		})
	}
}

// The reported bug: the root of a bare layout and its worktrees are one repository.
func TestBareLayoutIsOneRepository(t *testing.T) {
	root := locations(t)
	rootR, _ := Resolve(filepath.Join(root, "bw"))
	wtR, _ := Resolve(filepath.Join(root, "bw", "main"))
	if rootR.GitCommonDir == "" || rootR.GitCommonDir != wtR.GitCommonDir || rootR.Remote == "" || rootR.Remote != wtR.Remote {
		t.Errorf("root %+v, worktree %+v", rootR, wtR)
	}
	// The shared config says bare = true; the live worktree still has its checkout.
	if wtR.Checkout != filepath.Join(root, "bw", "main") {
		t.Errorf("worktree checkout = %q", wtR.Checkout)
	}
}

func TestSymlinkedRoute(t *testing.T) {
	root := locations(t)
	direct, _ := Resolve(filepath.Join(root, "plain", "sub"))
	via, ok := Resolve(filepath.Join(root, "link", "sub", "deep"))
	if !ok || via.GitCommonDir != direct.GitCommonDir || via.Checkout != direct.Checkout || via.GitCommonDir == "" {
		t.Errorf("direct %+v, via symlink %+v", direct, via)
	}
	// A checkout reached through a symlink to a subdirectory still finds its own parents.
	if err := os.Symlink(filepath.Join(root, "plain", "sub"), filepath.Join(root, "sublink")); err != nil {
		t.Fatal(err)
	}
	if r, _ := Resolve(filepath.Join(root, "sublink")); r.Checkout != filepath.Join(root, "plain") {
		t.Errorf("through a symlink to a subdirectory: %+v", r)
	}
}

func TestNormalizeRemote(t *testing.T) {
	tests := map[string]string{
		"git@github.com:acme/app.git":                      "github.com/acme/app",
		"ssh://git@github.com/acme/app.git":                "github.com/acme/app",
		"https://github.com/acme/app":                      "github.com/acme/app",
		"https://user:token@GitHub.com/acme/app.git/":      "github.com/acme/app",
		"ssh://git@host.example:2222/acme/app.git":         "host.example:2222/acme/app",
		"ssh://git@host.example:22/acme/app.git":           "host.example/acme/app",
		"https://host.example:443/Acme/App.git":            "host.example/Acme/App",
		"http://host.example:80/a/b":                       "host.example/a/b",
		"https://host.example:8443/a/b":                    "host.example:8443/a/b",
		"/srv/git/app.git":                                 "/srv/git/app",
		"file:///srv/git/app.git":                          "/srv/git/app",
		"  https://github.com/acme/app.git  ":              "github.com/acme/app",
		"https://x-access-token:ghp_secret@github.com/a/b": "github.com/a/b",
		"https://h.example/a/b.git?token=abc":              "h.example/a/b",
		"https://u:p@h.example?x=1":                        "h.example",
		"https://u:p@h.example#frag":                       "h.example",
		"ssh://git@h.example:2222/a/b.git#x?y":             "h.example:2222/a/b",
		"git@h.example:2222/a/b.git":                       "h.example/2222/a/b",
		"":                                                 "",
	}
	for in, want := range tests {
		if got := NormalizeRemote(in); got != want {
			t.Errorf("NormalizeRemote(%q) = %q, want %q", in, got, want)
		}
	}
	if got := normalizeIn("../app.git", "/srv/repos/x"); got != "/srv/repos/app" {
		t.Errorf("relative origin = %q", got)
	}
}

func TestName(t *testing.T) {
	tests := map[string]string{
		"/w/app/.git":                         "app",
		"/w/app/.bare":                        "app",
		"/w/x.git":                            "x",
		"/w/app/.git/modules/lib":             "lib",
		"/w/app/.git/modules/a/lib":           "lib",
		"/w/app/.git/worktrees/w/modules/lib": "lib",
		"/w/plain":                            "plain",
		"":                                    "",
	}
	for in, want := range tests {
		if got := Name(in); got != want {
			t.Errorf("Name(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestConfigParsing(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	mk := func(name, config string) string {
		dir := filepath.Join(root, name)
		write(t, filepath.Join(dir, ".git", "HEAD"), head)
		write(t, filepath.Join(dir, ".git", "config"), config)
		return dir
	}
	long := strings.Repeat("x", 200_000)
	tests := map[string]struct{ config, remote string }{
		"case":         {"[REMOTE \"origin\"]\n\tURL = https://example.com/a/b.git\n", "example.com/a/b"},
		"subsection":   {"[remote \"Origin\"]\n\turl = https://example.com/a/b.git\n", ""},
		"other":        {"[remote \"upstream\"]\n\turl = https://example.com/a/b.git\n", ""},
		"comment":      {"[remote \"origin\"] # c\n\turl = https://example.com/a/b.git # c2\n", "example.com/a/b"},
		"long line":    {"[alias]\n\tx = " + long + "\n[remote \"origin\"]\n\turl = https://example.com/a/b.git\n", "example.com/a/b"},
		"first url":    {"[remote \"origin\"]\n\turl = https://example.com/1\n\turl = https://example.com/2\n", "example.com/1"},
		"inline other": {"[remote \"upstream\"]\n\turl = https://example.com/u\n[remote \"origin\"]\n\turl = https://example.com/o\n", "example.com/o"},
	}
	for name, tc := range tests {
		got, _ := Resolve(mk(name, tc.config))
		if got.Remote != tc.remote {
			t.Errorf("%s: remote = %q, want %q", name, got.Remote, tc.remote)
		}
	}
	if r, _ := Resolve(mk("boolkey", "[core]\n\tbare\n")); r.Checkout != "" {
		t.Errorf("a bare key means true: %+v", r)
	}
}

// A worktree gets the same beads database as before: the main directory is the common dir's
// parent when that is named .git, else the common dir itself, and only through commondir.
func TestBeadsDirUnchanged(t *testing.T) {
	root := locations(t)
	j := func(p ...string) string { return filepath.Join(append([]string{root}, p...)...) }
	// A bare layout whose common dir is not named .git and holds a database itself.
	write(t, j("bw/.bare/.beads/metadata.json"), `{}`)
	if r, _ := Resolve(j("bw/main")); r.Beads != j("bw/.bare/.beads") {
		t.Errorf("bare layout worktree: %q", r.Beads)
	}
	// A worktree with a checked-out copy uses the main repository's database.
	if r, _ := Resolve(j("wt-abs")); r.Beads != j("plain/.beads") {
		t.Errorf("worktree with its own copy: %q", r.Beads)
	}
	// A redirect in the main repository is followed.
	write(t, j("plain/.beads/redirect"), "../clone-b/.beads-real\n")
	if r, _ := Resolve(j("wt-rel")); r.Beads != j("clone-b/.beads-real") {
		t.Errorf("worktree, redirect: %q", r.Beads)
	}
}

func TestMigrateVersion1(t *testing.T) {
	home := t.TempDir()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	withHead := filepath.Join(root, "store")
	write(t, filepath.Join(withHead, "HEAD"), head)
	v1 := `{"version":1,"paths":{
	  "/g/plain":     {"top":"/g/plain","repo":"/g/plain","remote":"https://user:secret@GitHub.com/acme/app.git","beads":"/g/plain/.beads","gone":true},
	  "/g/plain/sub": {"top":"/g/plain","repo":"/g/plain","gone":true},
	  "/g/wt":        {"top":"/g/wt","repo":"/g/plain","worktree":true,"remote":"git@github.com:acme/app.git","gone":true},
	  "/g/bare/main": {"top":"/g/bare/main","repo":"/g/bare/.bare","worktree":true,"gone":true},
	  "/g/x":         {"repo":"/g/x.git"},
	  "/g/store":     {"repo":"` + withHead + `"},
	  "/g/none":      {}
	}}`
	write(t, filepath.Join(home, FileName), v1)
	c := Open(home)
	want := map[string]Repo{
		"/g/plain":     {Checkout: "/g/plain", GitCommonDir: "/g/plain/.git", Remote: "github.com/acme/app", Beads: "/g/plain/.beads", Gone: true},
		"/g/plain/sub": {Checkout: "/g/plain", GitCommonDir: "/g/plain/.git", Gone: true},
		"/g/wt":        {Checkout: "/g/wt", GitCommonDir: "/g/plain/.git", Worktree: true, Remote: "github.com/acme/app", Gone: true},
		"/g/bare/main": {Checkout: "/g/bare/main", GitCommonDir: "/g/bare/.bare", Worktree: true, Gone: true},
		"/g/x":         {GitCommonDir: "/g/x.git"},
		"/g/store":     {GitCommonDir: withHead},
		"/g/none":      {},
	}
	for dir, w := range want {
		if got, ok := c.Lookup(dir); !ok || got != w {
			t.Errorf("%s = %+v, %v\nwant %+v", dir, got, ok, w)
		}
	}
	if err := c.Save(); err != nil { // the migrated cache is dirty without any refresh
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(home, FileName))
	s := string(b)
	if !strings.Contains(s, `"version": 2`) || strings.Contains(s, "secret") || strings.Contains(s, `"top"`) || strings.Contains(s, `"repo"`) {
		t.Errorf("saved file:\n%s", s)
	}
	// And it reads back as version 2 without being dirty again.
	c2 := Open(home)
	if got, _ := c2.Lookup("/g/wt"); got != want["/g/wt"] {
		t.Errorf("reload = %+v", got)
	}
	if c2.dirty {
		t.Error("a version 2 file loaded dirty")
	}
}

// A URL with credentials in a repository's config never reaches repos.json.
func TestCredentialsNeverStored(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	write(t, filepath.Join(root, "r", ".git", "HEAD"), head)
	write(t, filepath.Join(root, "r", ".git", "config"), origin("https://alice:hunter2@example.com/acme/app.git?token=abc123"))
	home := t.TempDir()
	c := Open(home)
	c.Refresh([]string{filepath.Join(root, "r")}, 0, time.Time{})
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(home, FileName))
	if strings.Contains(string(b), "hunter2") || strings.Contains(string(b), "alice") || strings.Contains(string(b), "abc123") || !strings.Contains(string(b), "example.com/acme/app") {
		t.Errorf("repos.json:\n%s", b)
	}
}

// A remote with a port survives Save, Open, Save unchanged, on a live and a gone entry.
func TestPortRemoteSurvivesReload(t *testing.T) {
	home := t.TempDir()
	c := Open(home)
	c.mu.Lock()
	c.paths["/g/live"] = Repo{Checkout: "/g/live", GitCommonDir: "/g/live/.git", Remote: "h.example:2222/a/b"}
	c.paths["/g/gone"] = Repo{Checkout: "/g/gone", GitCommonDir: "/g/gone/.git", Remote: "h.example:2222/a/b", Gone: true}
	c.dirty = true
	c.mu.Unlock()
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(filepath.Join(home, FileName))
	c2 := Open(home)
	for _, d := range []string{"/g/live", "/g/gone"} {
		if r, _ := c2.Lookup(d); r.Remote != "h.example:2222/a/b" {
			t.Errorf("%s: remote = %q after reload", d, r.Remote)
		}
	}
	c2.mu.Lock()
	c2.dirty = true
	c2.mu.Unlock()
	if err := c2.Save(); err != nil {
		t.Fatal(err)
	}
	if second, _ := os.ReadFile(filepath.Join(home, FileName)); string(second) != string(first) {
		t.Errorf("file changed across a reload:\n%s\nvs\n%s", first, second)
	}
}
