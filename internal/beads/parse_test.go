package beads

import (
	"reflect"
	"testing"

	"github.com/terek/merlin/internal/model"
)

func ev(op model.BeadOp, outcome model.BeadOutcome, ids ...string) model.BeadEvent {
	return model.BeadEvent{Op: op, IDs: ids, Outcome: outcome}
}

func TestParse(t *testing.T) {
	ok, failed, unknown := model.BeadOK, model.BeadFailed, model.BeadUnknown
	with := func(e model.BeadEvent, f func(*model.BeadEvent)) model.BeadEvent { f(&e); return e }

	tests := []struct {
		name   string
		script string
		cwd    string
		res    *Result
		want   []model.BeadEvent
	}{
		{
			name:   "claim confirmed",
			script: "bd update acme-x1y --claim",
			res:    &Result{Output: "✓ Updated issue: acme-x1y — Fix the login form\n"},
			want: []model.BeadEvent{with(ev(model.BeadClaim, ok, "acme-x1y"), func(e *model.BeadEvent) {
				e.Status, e.Title = "in_progress", "Fix the login form"
			})},
		},
		{
			name:   "close with reason, title split from the reason",
			script: `bd close acme-x1y --reason "Done; tests pass"`,
			res:    &Result{Output: "✓ Closed acme-x1y — Fix: the login form: Done; tests pass\n"},
			want: []model.BeadEvent{with(ev(model.BeadClose, ok, "acme-x1y"), func(e *model.BeadEvent) {
				e.Status, e.Reason, e.Title = "closed", "Done; tests pass", "Fix: the login form"
			})},
		},
		{
			name:   "close several, reason file",
			script: "bd close acme-a1.1 acme-a1.2 --reason-file /tmp/r.md",
			res:    &Result{Output: "✓ Closed acme-a1.1 — One: why\n✓ Closed acme-a1.2 — Two: why\n"},
			want: []model.BeadEvent{with(ev(model.BeadClose, ok, "acme-a1.1", "acme-a1.2"), func(e *model.BeadEvent) {
				e.Status = "closed"
			})},
		},
		{
			name:   "chain with cd, claim then close",
			script: "cd /work/acme && bd update acme-x1y --claim && make test && bd close acme-x1y -r 'shipped'",
			cwd:    "/home/u",
			res:    &Result{Output: "✓ Updated issue: acme-x1y — T\nok\n✓ Closed acme-x1y — T: shipped\n"},
			want: []model.BeadEvent{
				with(ev(model.BeadClaim, ok, "acme-x1y"), func(e *model.BeadEvent) {
					e.Status, e.Title, e.Cwd = "in_progress", "T", "/work/acme"
				}),
				with(ev(model.BeadClose, ok, "acme-x1y"), func(e *model.BeadEvent) {
					e.Status, e.Reason, e.Title, e.Cwd = "closed", "shipped", "T", "/work/acme"
				}),
			},
		},
		{
			name:   "relative cd from a known directory",
			script: "cd sub && bd show acme-x1y",
			cwd:    "/work/acme",
			res:    &Result{Output: "○ acme-x1y · T\n"},
			want: []model.BeadEvent{with(ev(model.BeadShow, ok, "acme-x1y"), func(e *model.BeadEvent) {
				e.Cwd = "/work/acme/sub"
			})},
		},
		{
			name:   "cd ~ expands to the home the working directory is under",
			script: "cd ~/work/acme; bd show acme-x1y",
			cwd:    "/Users/dev/other",
			res:    &Result{Output: "○ acme-x1y · T\n"},
			want:   []model.BeadEvent{with(ev(model.BeadShow, ok, "acme-x1y"), func(e *model.BeadEvent) { e.Cwd = "/Users/dev/work/acme" })},
		},
		{
			name:   "create: id from the output, title and parent from the flags",
			script: `bd create --title="Add a widget" --type task -p 2 --parent acme-e1`,
			cwd:    "/w",
			res:    &Result{Output: "✓ Created issue: acme-e1.3 — Add a widget\n  Priority: P2\n  Status: open\n"},
			want: []model.BeadEvent{with(ev(model.BeadCreate, ok, "acme-e1.3"), func(e *model.BeadEvent) {
				e.Title, e.Parent, e.Cwd = "Add a widget", "acme-e1", "/w"
			})},
		},
		{
			name:   "create with --json",
			script: "bd create --title='Cards' --description='x y' --json",
			res: &Result{Output: "{\n  \"created_at\": \"2026-01-01T00:00:00Z\",\n  \"id\": \"cards-b2d\",\n  \"title\": \"Cards\"\n}\n" +
				"beads: auto-export warning: no Dolt remote configured.\n"},
			want: []model.BeadEvent{with(ev(model.BeadCreate, ok, "cards-b2d"), func(e *model.BeadEvent) { e.Title = "Cards" })},
		},
		{
			name:   "create captured in a variable, then used",
			script: "A=$(bd q \"First thing\")\nbd dep add $A acme-z9",
			res:    &Result{Output: "✓ Added dependency: acme-n3w (First thing) depends on acme-z9 (Other) (blocks)\n"},
			want: []model.BeadEvent{
				with(ev(model.BeadCreate, unknown), func(e *model.BeadEvent) { e.Title = "First thing" }),
				with(ev(model.BeadDep, ok, "acme-n3w", "acme-z9"), func(e *model.BeadEvent) { e.DepType = "blocks" }),
			},
		},
		{
			name:   "bd q prints the bare id",
			script: `bd q "Quick one"`,
			res:    &Result{Output: "acme-q7r\n"},
			want:   []model.BeadEvent{with(ev(model.BeadCreate, ok, "acme-q7r"), func(e *model.BeadEvent) { e.Title = "Quick one" })},
		},
		{
			name:   "a bare word is not a new id when the script's ids use another prefix",
			script: "bd update acme-e1 --design-file d.md >/dev/null && echo epic-ok\nc() { bd create --parent acme-e1 \"$@\" | grep -o 'acme-e1\\.[0-9]*'; }\nH=$(c --title A)\necho $H",
			res:    &Result{Output: "epic-ok\nacme-e1.1\n"},
			want: []model.BeadEvent{
				ev(model.BeadUpdate, unknown, "acme-e1"),
				with(ev(model.BeadCreate, ok, "acme-e1.1"), func(e *model.BeadEvent) { e.Parent = "acme-e1" }),
			},
		},
		{
			name:   "indented ids are a listing, not a new id",
			script: "bd memories logs | head -3; bd create --title 'Tier check' --silent",
			res:    &Result{Output: "Memories matching \"logs\":\n\n  convex-int-encoding\n"},
			want:   []model.BeadEvent{with(ev(model.BeadCreate, unknown), func(e *model.BeadEvent) { e.Title = "Tier check" })},
		},
		{
			name:   "show of something that is not an issue",
			script: "bd show app-store-shots 2>&1 | head -5",
			res:    &Result{Output: "Issue app-store-shots not found\nHint: this ID may have never existed\n"},
			want:   []model.BeadEvent{ev(model.BeadShow, failed, "app-store-shots")},
		},
		{
			name:   "dep add with type from the output",
			script: "bd dep add acme-a acme-b",
			res:    &Result{Output: "✓ Added dependency: acme-a (A) depends on acme-b (B) (parent-child)\n"},
			want:   []model.BeadEvent{with(ev(model.BeadDep, ok, "acme-a", "acme-b"), func(e *model.BeadEvent) { e.DepType = "parent-child" })},
		},
		{
			name:   "output suppressed",
			script: "bd update acme-x1y --claim >/dev/null 2>&1 && echo claimed",
			res:    &Result{Output: "claimed\n"},
			want:   []model.BeadEvent{with(ev(model.BeadClaim, unknown, "acme-x1y"), func(e *model.BeadEvent) { e.Status = "in_progress" })},
		},
		{
			name:   "claim refused",
			script: "bd update acme-x1y --claim 2>&1 | tail -3",
			res:    &Result{Output: "Error claiming acme-x1y: already claimed by someone\n"},
			want:   []model.BeadEvent{with(ev(model.BeadClaim, failed, "acme-x1y"), func(e *model.BeadEvent) { e.Status = "in_progress" })},
		},
		{
			name:   "epic close refused",
			script: `bd close acme-e1 --reason="all done"`,
			res:    &Result{Output: "cannot close epic acme-e1: 1 open child issue(s)\n", Failed: true},
			want: []model.BeadEvent{with(ev(model.BeadClose, failed, "acme-e1"), func(e *model.BeadEvent) {
				e.Status, e.Reason = "closed", "all done"
			})},
		},
		{
			name:   "unknown flag, single call failed",
			script: "bd update acme-x1y --bogus",
			res:    &Result{Output: "Error: unknown flag: --bogus\n", Failed: true},
			want:   []model.BeadEvent{ev(model.BeadUpdate, failed, "acme-x1y")},
		},
		{
			name:   "an error naming no id fails the script's only bd call",
			script: "bd close acme-x1y --notes \"$(cat <<'EOF'\nlong ) text\nEOF\n)\"",
			res:    &Result{Output: "Error: unknown flag: --notes\n"},
			want:   []model.BeadEvent{with(ev(model.BeadClose, failed, "acme-x1y"), func(e *model.BeadEvent) { e.Status = "closed" })},
		},
		{
			name:   "comment line without the check mark (older bd)",
			script: "bd comments add acme-x1y \"$(cat note.md)\"",
			res:    &Result{Output: "Comment added to acme-x1y\n"},
			want:   []model.BeadEvent{ev(model.BeadComment, ok, "acme-x1y")},
		},
		{
			name:   "no result yet",
			script: "bd close acme-x1y",
			want:   []model.BeadEvent{with(ev(model.BeadClose, unknown, "acme-x1y"), func(e *model.BeadEvent) { e.Status = "closed" })},
		},
		{
			name:   "global flag before the subcommand; status closed is a close",
			script: "bd --actor emma update acme-x1y --status closed",
			res:    &Result{Output: "✓ Updated issue: acme-x1y — T\n"},
			want: []model.BeadEvent{with(ev(model.BeadClose, ok, "acme-x1y"), func(e *model.BeadEvent) {
				e.Status, e.Title = "closed", "T"
			})},
		},
		{
			name:   "status in progress",
			script: "bd update acme-x1y -s in_progress --append-notes 'started on it'",
			res:    &Result{Output: "✓ Updated issue: acme-x1y — T\n"},
			want: []model.BeadEvent{with(ev(model.BeadUpdate, ok, "acme-x1y"), func(e *model.BeadEvent) {
				e.Status, e.Title = "in_progress", "T"
			})},
		},
		{
			name:   "comments",
			script: "bd comment acme-x1y \"re-run it\"; bd comments add acme-x2 'note'; bd comments acme-x3",
			res:    &Result{Output: "✓ Comment added to acme-x1y\n✓ Comment added to acme-x2\nacme-x3 has 0 comments\n"},
			want: []model.BeadEvent{
				ev(model.BeadComment, ok, "acme-x1y"),
				ev(model.BeadComment, ok, "acme-x2"),
				ev(model.BeadShow, ok, "acme-x3"),
			},
		},
		{
			name:   "loop over literal words, output suppressed",
			script: "for b in 470.1 470.2; do bd close acme-$b --reason \"done\" >/dev/null 2>&1; done; bd close acme-470 -r 'all'",
			res:    &Result{Output: "✓ Closed acme-470 — Epic: all\n"},
			want: []model.BeadEvent{
				with(ev(model.BeadClose, unknown, "acme-470.1"), func(e *model.BeadEvent) { e.Status, e.Reason = "closed", "done" }),
				with(ev(model.BeadClose, unknown, "acme-470.2"), func(e *model.BeadEvent) { e.Status, e.Reason = "closed", "done" }),
				with(ev(model.BeadClose, ok, "acme-470"), func(e *model.BeadEvent) { e.Status, e.Reason, e.Title = "closed", "all", "Epic" }),
			},
		},
		{
			name:   "loop over a substitution: ids from the output",
			script: "for X in $(cat ids.txt); do bd close acme-$X.1; done",
			res:    &Result{Output: "✓ Closed acme-a.1 — A\n✓ Closed acme-b.1 — B\n"},
			want:   []model.BeadEvent{with(ev(model.BeadClose, ok, "acme-a.1", "acme-b.1"), func(e *model.BeadEvent) { e.Status = "closed" })},
		},
		{
			name:   "wrapper script that closes a bead",
			script: "tools/land.sh feature-x",
			cwd:    "/work/acme",
			res:    &Result{Output: "landed feature-x\n✓ Closed acme-k4.2 — The feature: merged\n"},
			want: []model.BeadEvent{with(ev(model.BeadClose, ok, "acme-k4.2"), func(e *model.BeadEvent) {
				e.Status, e.Cwd = "closed", "/work/acme"
			})},
		},
		{
			name:   "not bd: quoted text, heredoc body, commit message",
			script: "echo \"run bd close acme-x1y\"\ngit commit -F - <<'EOF'\nbd close acme-x1y\nEOF\ngit commit -m 'fix (acme-x1y)'",
			res:    &Result{Output: "[main 1234567] fix (acme-x1y)\n"},
		},
		{
			name:   "reads that name no bead, and dry runs, are ignored",
			script: "bd ready && bd list --status open && bd prime && bd show; bd create 'probe' --dry-run; bd close acme-x1y --dry-run",
			res:    &Result{Output: "○ acme-x1y · T\n"},
		},
		{
			name:   "xargs",
			script: "echo acme-a acme-b | xargs -n1 bd close",
			res:    &Result{Output: "✓ Closed acme-a — A\n✓ Closed acme-b — B\n"},
			want:   []model.BeadEvent{with(ev(model.BeadClose, ok, "acme-a", "acme-b"), func(e *model.BeadEvent) { e.Status = "closed" })},
		},
		{
			name:   "absolute bd path, prefix with dashes",
			script: "/usr/local/bin/bd reopen my-app-k2",
			res:    &Result{Output: "✓ Reopened my-app-k2 — Thing\n"},
			want: []model.BeadEvent{with(ev(model.BeadReopen, ok, "my-app-k2"), func(e *model.BeadEvent) {
				e.Status, e.Title = "open", "Thing"
			})},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Parse(tt.script, tt.cwd, tt.res)
			for i := range tt.want {
				if tt.want[i].Cwd == "" {
					tt.want[i].Cwd = tt.cwd
				}
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Parse(%q)\n got %+v\nwant %+v", tt.script, got, tt.want)
			}
		})
	}
}

func TestCommands(t *testing.T) {
	got := commands("A=1 env B=2 bd show x-1 2>/dev/null | head -1 && (cd /a; bd list) # bd close x-2\nif bd ready; then echo \"$(bd show x-3)\"; fi", "/w")
	var words [][]string
	var cwds []string
	for _, c := range got {
		words = append(words, c.words)
		cwds = append(cwds, c.cwd)
	}
	want := [][]string{
		{"bd", "show", "x-1"}, {"head", "-1"}, {"bd", "list"}, {"bd", "ready"}, {"bd", "show", "x-3"}, {"echo", "$"}, {"fi"},
	}
	if !reflect.DeepEqual(words, want) {
		t.Errorf("words\n got %q\nwant %q", words, want)
	}
	if wantCwd := []string{"/w", "/w", "/a", "/a", "/a", "/a", "/a"}; !reflect.DeepEqual(cwds, wantCwd) {
		t.Errorf("cwds %q, want %q", cwds, wantCwd)
	}
}

func TestIsID(t *testing.T) {
	for s, want := range map[string]bool{
		"merlin-t8s": true, "merlin-t8s.48.1": true, "my-app-k2": true, "yimple-gd87.4": true,
		"merlin": false, "in_progress": false, "--claim": false, "acme-$X": false, "Fix-it": false,
	} {
		if IsID(s) != want {
			t.Errorf("IsID(%q) = %v", s, !want)
		}
	}
}
