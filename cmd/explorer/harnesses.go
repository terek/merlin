package main

import (
	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/claude"
	"github.com/terek/merlin/internal/codex"
	"github.com/terek/merlin/internal/harness"
	"github.com/terek/merlin/internal/paths"
	"github.com/terek/merlin/internal/pi"
	"github.com/terek/merlin/internal/pricing"
)

// claudeHarness names the harness whose hooks are wired separately (cmd_hooks.go).
const claudeHarness = claude.Name

// harnessEntry is everything that differs per harness in the commands: how it is
// described to people, where its files are and how it is built.
type harnessEntry struct {
	harness.Info
	dir      func() (string, error)                                           // the harness's own directory (its path lookup)
	build    func(dir string, p *pricing.Table) harness.Harness               // the indexer for that directory
	registry func(dir string, alive func(int) bool) (catalog.Registry, error) // running sessions; nil: the harness keeps none
	support  func() harness.Support                                           // what Merlin understands of it, data only (merlin doctor)
}

// harnessList is the one list of harnesses. Adding a harness is one entry here, plus the
// path lookup it needs in internal/paths. A harness that is not in it is still shown (by
// its name, without a resume command), see describeHarness.
var harnessList = []harnessEntry{
	{
		Info:     harness.Info{Name: claudeHarness, Title: "Claude Code", Resume: "claude --resume {id}"},
		dir:      paths.ClaudeConfigDir,
		build:    func(dir string, p *pricing.Table) harness.Harness { return claude.New(dir, p) },
		registry: claude.ReadRegistry,
		support:  claude.Support,
	},
	{
		Info:    harness.Info{Name: "codex", Title: "Codex", Resume: "codex resume {id}", Badge: "codex"},
		dir:     paths.CodexHome,
		build:   func(dir string, p *pricing.Table) harness.Harness { return codex.New(dir, p) },
		support: codex.Support,
	},
	{
		// Resume: Pi's `--session <path|id>` opens a session by file path or full/partial id
		// (packages/coding-agent/src/cli/args.ts at 085c84e). The binary is APP_NAME, "pi" by
		// default; a rebranded build names itself otherwise. dir is the sessions directory.
		Info:    harness.Info{Name: pi.HarnessName, Title: "Pi", Resume: "pi --session {id}", Badge: "pi · preview"},
		dir:     paths.PiSessionsDir,
		build:   func(dir string, p *pricing.Table) harness.Harness { return pi.New(dir, p) },
		support: pi.Support,
	},
}

// harnessInfos is the descriptions of the list, as plain data for the server.
func harnessInfos() []harness.Info {
	out := make([]harness.Info, len(harnessList))
	for i, e := range harnessList {
		out[i] = e.Info
	}
	return out
}

// describeHarness is the entry for a harness name; an unlisted one is named by its name
// and has no resume command.
func describeHarness(name string) harness.Info { return harness.Describe(harnessInfos(), name) }

// buildHarnesses builds every listed harness.
func buildHarnesses(p *pricing.Table) ([]harness.Harness, error) {
	out := make([]harness.Harness, 0, len(harnessList))
	for _, e := range harnessList {
		dir, err := e.dir()
		if err != nil {
			return nil, err
		}
		out = append(out, e.build(dir, p))
	}
	return out, nil
}

// liveRegistry is the sessions running now, from the harnesses that keep a registry.
func liveRegistry() (catalog.Registry, error) {
	reg := catalog.Registry{}
	for _, e := range harnessList {
		if e.registry == nil {
			continue
		}
		dir, err := e.dir()
		if err != nil {
			return nil, err
		}
		r, err := e.registry(dir, aliveFunc())
		if err != nil {
			return nil, err
		}
		for k, v := range r {
			reg[k] = v
		}
	}
	return reg, nil
}
