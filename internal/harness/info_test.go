package harness_test

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/terek/merlin/internal/harness"
)

func TestDescribe(t *testing.T) {
	list := []harness.Info{
		{Name: "claude", Title: "Claude Code", Resume: "claude --resume {id}"},
		{Name: "codex", Title: "Codex", Resume: "codex resume {id}", Badge: "codex"},
	}
	if in := harness.Describe(list, "codex"); in.Title != "Codex" || in.ResumeCommand("x1") != "codex resume x1" {
		t.Errorf("codex = %+v", in)
	}
	pi := harness.Describe(list, "pi")
	if pi.Title != "pi" || pi.Badge != "pi" || pi.Resume != "" || pi.ResumeCommand("x1") != "" {
		t.Errorf("unlisted = %+v", pi)
	}
}

// The harness-neutral packages must not depend on any harness's internals: only
// internal/claude, internal/codex and internal/pi know their harness's files.
func TestNeutralPackagesDoNotImportHarnesses(t *testing.T) {
	for _, name := range []string{"model", "store", "catalog", "engine", "server", "harness", "hookfile"} {
		pkg := "github.com/terek/merlin/internal/" + name
		out, err := exec.Command("go", "list", "-deps", pkg).CombinedOutput()
		if err != nil {
			t.Skipf("go list unavailable: %v: %s", err, out)
		}
		for _, dep := range strings.Fields(string(out)) {
			if strings.HasPrefix(dep, "github.com/terek/merlin/internal/claude") ||
				strings.HasPrefix(dep, "github.com/terek/merlin/internal/codex") ||
				strings.HasPrefix(dep, "github.com/terek/merlin/internal/pi") {
				t.Errorf("%s depends on %s", name, dep)
			}
		}
	}
}
