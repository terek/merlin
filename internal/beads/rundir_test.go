package beads

import "testing"

func TestRunDir(t *testing.T) {
	for _, tc := range []struct {
		name, script, cwd, want string
	}{
		{"no cd", "make test", "/home/dev/acme", "/home/dev/acme"},
		{"no cd, no cwd", "make test", "", ""},
		{"leading absolute cd", "cd /home/dev/acme-w && bd show x-1", "/home/dev/acme", "/home/dev/acme-w"},
		{"absolute cd is cleaned", "cd /home/dev/acme-w/ && ls", "", "/home/dev/acme-w"},
		{"relative cd from a known cwd", "cd sub/dir && go test ./...", "/home/dev/acme", "/home/dev/acme/sub/dir"},
		{"relative cd, unknown cwd", "cd sub && ls", "", ""},
		{"tilde", "cd ~/acme && ls", "/home/dev/other", "/home/dev/acme"},
		{"tilde, unknown home", "cd ~/acme && ls", "/srv/x", ""},
		{"cd with nothing after it", "cd /home/dev/acme", "/srv/x", ""},
		{"cd to a variable", "cd $DIR && ls", "/srv/x", ""},
		{"substitution after cd", "cd /home/dev/acme && echo $(date)", "/srv/x", "/home/dev/acme"},
		{"substitution without cd", "echo $(date)", "/srv/x", "/srv/x"},
		{"cd inside a later command does not move the first", "ls && cd /home/dev/acme && ls", "/srv/x", "/srv/x"},
		{"assignment and wrapper first", "FOO=1 env go test", "/srv/x", "/srv/x"},
		{"empty script", "", "/srv/x", ""},
	} {
		if got := RunDir(tc.script, tc.cwd); got != tc.want {
			t.Errorf("%s: RunDir(%q, %q) = %q, want %q", tc.name, tc.script, tc.cwd, got, tc.want)
		}
	}
}
