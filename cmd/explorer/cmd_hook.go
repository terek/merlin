package main

import (
	"os"

	"github.com/terek/merlin/internal/claude/hooks"
	"github.com/terek/merlin/internal/paths"
)

// merlin hook is run by Claude Code on each event (merlin hook codex by Codex).
// It must print nothing and exit 0 whatever happens: SessionStart stdout is
// injected into the model's context and a failing hook is shown to the user.
func init() {
	register("hook", command{
		usage:   "hook [codex]",
		summary: "called by Claude Code or Codex",
		run:     runHook,
	})
}

func runHook(args []string) (code int) {
	defer func() { _ = recover(); code = 0 }()
	port := hooks.DefaultPort
	if home, err := paths.Home(); err == nil {
		port = hooks.Port(home)
	}
	harness := ""
	if len(args) > 0 {
		harness = args[0]
	}
	_ = hooks.NotifyFor(harness, os.Stdin, port, hooks.Timeout)
	return 0
}
