package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/claude"
	"github.com/terek/merlin/explorer/internal/claude/hooks"
	"github.com/terek/merlin/explorer/internal/codex"
	"github.com/terek/merlin/explorer/internal/daemon"
	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/hookfile"
	"github.com/terek/merlin/explorer/internal/paths"
	"github.com/terek/merlin/explorer/internal/pricing"
	"github.com/terek/merlin/explorer/internal/server"
	"github.com/terek/merlin/explorer/internal/webui"
)

func init() {
	register("serve", command{
		usage:   "serve [--port 7433] [--no-hooks]",
		summary: "daemon: index, follow, serve",
		run:     runServe,
	})
}

func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	port := fs.Int("port", 0, "TCP port on 127.0.0.1 (default: \"port\" in config.json, else 7433)")
	noHooks := fs.Bool("no-hooks", false, "do not refresh installed Claude Code and Codex hooks")
	rescan := fs.Duration("rescan", daemon.DefaultRescanInterval, "full rescan interval")
	debounce := fs.Duration("debounce", daemon.DefaultDebounce, "at most one build per live session per this")
	workers := fs.Int("workers", 0, "concurrent builders (default: number of CPUs)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "merlin serve: unexpected arguments")
		return 2
	}
	fail := func(err error) int {
		fmt.Fprintf(os.Stderr, "merlin serve: %v\n", err)
		return 1
	}

	home, err := paths.Home()
	if err != nil {
		return fail(err)
	}
	cfg, err := paths.ClaudeConfigDir()
	if err != nil {
		return fail(err)
	}
	codexHome, err := paths.CodexHome()
	if err != nil {
		return fail(err)
	}
	pricer, err := pricing.Load(filepath.Join(home, "config.json"))
	if err != nil {
		return fail(err)
	}
	if *port == 0 {
		*port = hooks.Port(home)
	}
	opts := daemon.Options{
		Home:           home,
		Harnesses:      []harness.Harness{claude.New(cfg, pricer), codex.New(codexHome, pricer)},
		Port:           *port,
		Workers:        *workers,
		RescanInterval: *rescan,
		Debounce:       *debounce,
		Version:        version,
	}
	if !*noHooks {
		// Hooks are opt-in (merlin hooks install). Once any of a harness's are there, serve
		// keeps its set complete and pointing at this binary.
		opts.InstallHooks = func() (string, error) {
			targets, err := hookTargets()
			if err != nil {
				return "", err
			}
			var msgs []string
			for _, t := range targets {
				msg, err := refreshHooks(t)
				if err != nil {
					msg = "refreshing hooks failed (continuing without): " + err.Error()
				}
				msgs = append(msgs, t.name+": "+msg)
			}
			return strings.Join(msgs, "; "), nil
		}
	}
	d, err := daemon.New(opts)
	if err != nil {
		return fail(err)
	}

	d.Handle("/api/", server.New(apiOptions(d, cfg)).Handler())
	d.Handle("/", webui.Handler())
	if webui.Built() {
		fmt.Fprintf(os.Stderr, "merlin: UI at http://127.0.0.1:%d/\n", *port)
	} else {
		fmt.Fprintf(os.Stderr, "merlin: this binary has no UI (make build includes it); the API is at http://127.0.0.1:%d/api/\n", *port)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := d.Run(ctx); err != nil {
		return fail(err)
	}
	return 0
}

// refreshHooks reinstalls a harness's hooks if any of them is installed, and otherwise
// leaves its files alone.
func refreshHooks(t hookTarget) (string, error) {
	sts, err := t.status()
	if err != nil {
		return "", err
	}
	if !slices.ContainsFunc(sts, func(s hookfile.EventStatus) bool { return s.State != hookfile.Missing }) {
		return "hooks not installed (merlin hooks install " + t.name + " adds them for live updates)", nil
	}
	res, err := t.install()
	if err != nil {
		return "", err
	}
	if !res.Changed() {
		return "hooks already installed in " + t.path, nil
	}
	return fmt.Sprintf("installed %d hooks in %s", len(res.Events), t.path), nil
}

// apiOptions wires the JSON API to the daemon: its catalog, its event bus, the indexing
// counters of its engine and the registry of running sessions.
func apiOptions(d *daemon.Daemon, cfg string) server.Options {
	return server.Options{
		Catalog:   d.Catalog,
		Subscribe: d.Events().Subscribe,
		Registry: func() catalog.Registry {
			reg, err := catalog.ReadRegistry(claudeHarness, filepath.Join(cfg, "sessions"), aliveFunc())
			if err != nil {
				return nil
			}
			return reg
		},
		Progress: func() server.ScanProgress {
			e := d.Engine()
			if e == nil {
				return server.ScanProgress{}
			}
			s := e.Stats()
			return server.ScanProgress{Pending: e.Pending(), Seen: s.Seen, Processed: s.Processed,
				Unchanged: s.Unchanged, Failed: s.Failed, Missing: s.Missing}
		},
	}
}
