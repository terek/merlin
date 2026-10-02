package main

import (
	"os"

	"github.com/terek/merlin/explorer/internal/claude/hooks"
	"github.com/terek/merlin/explorer/internal/paths"
)

// explorer hook is run by Claude Code on each event. It must print nothing and
// exit 0 whatever happens: SessionStart stdout is injected into the model's
// context and a failing hook is shown to the user.
func init() {
	register("hook", command{
		usage:   "hook",
		summary: "called by Claude Code",
		run:     runHook,
	})
}

func runHook([]string) (code int) {
	defer func() { _ = recover(); code = 0 }()
	port := hooks.DefaultPort
	if home, err := paths.ExplorerHome(); err == nil {
		port = hooks.Port(home)
	}
	_ = hooks.Notify(os.Stdin, port, hooks.Timeout)
	return 0
}
