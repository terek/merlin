package main

import (
	"fmt"
	"os"

	"github.com/terek/merlin/internal/claude/hooks"
	codexhooks "github.com/terek/merlin/internal/codex/hooks"
	"github.com/terek/merlin/internal/hookfile"
	"github.com/terek/merlin/internal/paths"
)

func init() {
	register("hooks", command{
		usage:   "hooks <action> [harness]",
		summary: "install|uninstall|status hooks: claude (default), codex or all",
		run:     runHooks,
	})
}

const hooksUsage = "usage: merlin hooks install|uninstall|status [claude|codex|all]"

// hookTarget is one harness's hooks as the CLI manages them.
type hookTarget struct {
	name      string
	path      string // the file edited
	install   func() (hookfile.Result, error)
	uninstall func() (hookfile.Result, error)
	status    func() ([]hookfile.EventStatus, error)
	note      string // printed after a change by install
}

func hookTargets() ([]hookTarget, error) {
	home, err := paths.Home()
	if err != nil {
		return nil, err
	}
	claudeDir, err := paths.ClaudeConfigDir()
	if err != nil {
		return nil, err
	}
	codexHome, err := paths.CodexHome()
	if err != nil {
		return nil, err
	}
	cc := hooks.Config{ClaudeConfigDir: claudeDir, ExplorerHome: home}
	cx := codexhooks.Config{CodexHome: codexHome, ExplorerHome: home}
	return []hookTarget{
		{
			name: claudeHarness, path: cc.SettingsPath(),
			install:   func() (hookfile.Result, error) { return hooks.Install(cc) },
			uninstall: func() (hookfile.Result, error) { return hooks.Uninstall(cc) },
			status:    func() ([]hookfile.EventStatus, error) { return hooks.Status(cc) },
		},
		{
			name: "codex", path: cx.HooksPath(),
			install:   func() (hookfile.Result, error) { return codexhooks.Install(cx) },
			uninstall: func() (hookfile.Result, error) { return codexhooks.Uninstall(cx) },
			status:    func() ([]hookfile.EventStatus, error) { return codexhooks.Status(cx) },
			note:      "Codex runs new hooks only once you trust them: open /hooks in Codex and trust the merlin entries.",
		},
	}, nil
}

func runHooks(args []string) int {
	if len(args) < 1 || len(args) > 2 {
		fmt.Fprintln(os.Stderr, hooksUsage)
		return 2
	}
	targets, err := hookTargets()
	if err != nil {
		fmt.Fprintln(os.Stderr, "merlin hooks:", err)
		return 1
	}
	which := ""
	if len(args) == 2 {
		which = args[1]
	}
	return runHooksIn(args[0], which, targets)
}

// runHooksIn runs action on the targets which names: one harness, or "all". Without a
// name, install and uninstall act on Claude Code (as before Codex hooks existed) and
// status reports every harness.
func runHooksIn(action, which string, targets []hookTarget) int {
	if which == "" {
		which = claudeHarness
		if action == "status" {
			which = "all"
		}
	}
	var picked []hookTarget
	for _, t := range targets {
		if which == "all" || which == t.name {
			picked = append(picked, t)
		}
	}
	if len(picked) == 0 {
		fmt.Fprintf(os.Stderr, "merlin hooks: unknown harness %q\n%s\n", which, hooksUsage)
		return 2
	}
	fail := func(t hookTarget, err error) int {
		fmt.Fprintf(os.Stderr, "merlin hooks: %s: %v\n", t.name, err)
		return 1
	}
	code := 0
	for _, t := range picked {
		switch action {
		case "install":
			res, err := t.install()
			if err != nil {
				code = fail(t, err)
				continue
			}
			if !res.Changed() {
				fmt.Printf("%s: hooks already installed in %s\n", t.name, t.path)
				continue
			}
			fmt.Printf("%s: installed %d hooks in %s\n", t.name, len(res.Events), t.path)
			if res.BackupPath != "" {
				fmt.Printf("%s: backup: %s\n", t.name, res.BackupPath)
			}
			if t.note != "" {
				fmt.Printf("%s: %s\n", t.name, t.note)
			}
		case "uninstall":
			res, err := t.uninstall()
			if err != nil {
				code = fail(t, err)
				continue
			}
			fmt.Printf("%s: removed %d hooks from %s\n", t.name, len(res.Events), t.path)
		case "status":
			sts, err := t.status()
			if err != nil {
				code = fail(t, err)
				continue
			}
			fmt.Printf("%s (%s)\n", t.name, t.path)
			for _, s := range sts {
				if s.Detail != "" {
					fmt.Printf("  %-18s %s (%s)\n", s.Event, s.State, s.Detail)
				} else {
					fmt.Printf("  %-18s %s\n", s.Event, s.State)
				}
			}
		default:
			fmt.Fprintf(os.Stderr, "merlin hooks: unknown action %q\n%s\n", action, hooksUsage)
			return 2
		}
	}
	return code
}
