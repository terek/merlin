package pi

import (
	"reflect"
	"testing"
	"time"
)

func TestPiHints(t *testing.T) {
	cases := []struct {
		cmd     string
		dir     string
		prompts [][]string // one entry per hint; nil: no hint
	}{
		{`pi -p "x"`, "/home/dev/proj", [][]string{{"x"}}},
		{`pi -p --model z-ai/glm-5.3-flash "Write hello.py that prints the first 10 primes"`, "/home/dev/proj",
			[][]string{{"Write hello.py that prints the first 10 primes"}}},
		{`cd sub && pi -p --model a/b "x"`, "/home/dev/proj/sub", [][]string{{"x"}}},
		{`cd /tmp/w; pi -p 'it'"'"'s'`, "/tmp/w", [][]string{{"it's"}}},
		{`pi -p "one" && pi -p "two"`, "/home/dev/proj", [][]string{{"one"}, {"two"}}},
		{`FOO=1 pi --model=a/b --thinking high --name n -e ext.ts @notes.md -p "go"`, "/home/dev/proj", [][]string{{"go"}}},
		{`pi -p --provider acme --tools read,bash --append-system-prompt "be brief" "real prompt"`, "/home/dev/proj", [][]string{{"real prompt"}}},
		{`pi -p --no-session "x"`, "", nil},
		{`pi -c -p "x"`, "", nil},
		{`pi --continue -p "x"`, "", nil},
		{`pi -r -p "x"`, "", nil},
		{`pi --session abc -p "x"`, "", nil},
		{`pi --session=abc -p "x"`, "", nil},
		{`pi --fork f -p "x"`, "", nil},
		{`pi --session-id abc -p "x"`, "", nil},
		{`echo pi -p x`, "", nil},
		{`pip install x`, "", nil},
	}
	for _, c := range cases {
		got := piHints(c.cmd, "/home/dev/proj")
		var prompts [][]string
		for _, h := range got {
			prompts = append(prompts, h.prompts)
			if h.dir != c.dir {
				t.Errorf("%q: dir %q, want %q", c.cmd, h.dir, c.dir)
			}
		}
		if !reflect.DeepEqual(prompts, c.prompts) {
			t.Errorf("%q: prompts %q, want %q", c.cmd, prompts, c.prompts)
		}
	}
}

func TestSpawnHintInDigest(t *testing.T) {
	dir := t.TempDir()
	d := bashSession(t, dir, "h1", `cd sub && pi -p --model a/b "x" ; pi -p "y"`)
	if len(d.SpawnedSessions) != 2 || len(d.Agents) != 0 {
		t.Fatalf("hints %+v agents %d", d.SpawnedSessions, len(d.Agents))
	}
	h := d.SpawnedSessions[0]
	if h.ToolUseID != "b1" || h.Turn == nil || *h.Turn != 0 || h.AgentID != "" || h.Harness != "pi" ||
		h.Dir != "/home/dev/proj/sub" || !reflect.DeepEqual(h.Prompts, []string{"x"}) ||
		!h.At.Equal(t0.Add(2*time.Second)) || !h.EndedAt.Equal(t0.Add(20*time.Second)) {
		t.Errorf("hint %+v", h)
	}
	if d.SpawnedSessions[1].Dir != "/home/dev/proj/sub" || d.SpawnedSessions[1].Prompts[0] != "y" {
		t.Errorf("second %+v", d.SpawnedSessions[1])
	}
	// a pi with --no-session is an unrecorded agent and no hint
	if d := bashSession(t, dir, "h2", `pi -p --no-session "z"`); len(d.SpawnedSessions) != 0 || len(d.Agents) != 1 {
		t.Errorf("no-session: %+v", d.SpawnedSessions)
	}
}
