package main

import (
	"fmt"
	"os"

	"github.com/terek/merlin/explorer/internal/claude/hooks"
	"github.com/terek/merlin/explorer/internal/paths"
)

func init() {
	register("hooks", command{
		usage:   "hooks install|uninstall|status",
		summary: "manage Claude Code hooks",
		run:     runHooks,
	})
}

func runHooks(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: explorer hooks install|uninstall|status")
		return 2
	}
	claudeDir, err := paths.ClaudeConfigDir()
	if err == nil {
		var home string
		if home, err = paths.ExplorerHome(); err == nil {
			return runHooksIn(args[0], hooks.Config{ClaudeConfigDir: claudeDir, ExplorerHome: home})
		}
	}
	fmt.Fprintln(os.Stderr, "explorer hooks:", err)
	return 1
}

func runHooksIn(action string, cfg hooks.Config) int {
	fail := func(err error) int {
		fmt.Fprintln(os.Stderr, "explorer hooks:", err)
		return 1
	}
	switch action {
	case "install":
		res, err := hooks.Install(cfg)
		if err != nil {
			return fail(err)
		}
		if !res.Changed() {
			fmt.Printf("hooks already installed in %s\n", cfg.SettingsPath())
			return 0
		}
		fmt.Printf("installed %d hooks in %s\n", len(res.Events), cfg.SettingsPath())
		if res.BackupPath != "" {
			fmt.Printf("backup: %s\n", res.BackupPath)
		}
	case "uninstall":
		res, err := hooks.Uninstall(cfg)
		if err != nil {
			return fail(err)
		}
		fmt.Printf("removed %d hooks from %s\n", len(res.Events), cfg.SettingsPath())
	case "status":
		sts, err := hooks.Status(cfg)
		if err != nil {
			return fail(err)
		}
		for _, s := range sts {
			if s.Detail != "" {
				fmt.Printf("%-18s %s (%s)\n", s.Event, s.State, s.Detail)
			} else {
				fmt.Printf("%-18s %s\n", s.Event, s.State)
			}
		}
	default:
		fmt.Fprintf(os.Stderr, "explorer hooks: unknown action %q\n", action)
		return 2
	}
	return 0
}
