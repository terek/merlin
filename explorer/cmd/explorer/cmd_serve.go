package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/claude"
	"github.com/terek/merlin/explorer/internal/claude/hooks"
	"github.com/terek/merlin/explorer/internal/daemon"
	"github.com/terek/merlin/explorer/internal/harness"
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
	noHooks := fs.Bool("no-hooks", false, "do not install the Claude Code hooks")
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

	home, err := paths.ExplorerHome()
	if err != nil {
		return fail(err)
	}
	cfg, err := paths.ClaudeConfigDir()
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
		Harnesses:      []harness.Harness{claude.New(cfg, pricer)},
		Port:           *port,
		Workers:        *workers,
		RescanInterval: *rescan,
		Debounce:       *debounce,
		Version:        version,
	}
	if !*noHooks {
		opts.InstallHooks = func() (string, error) {
			res, err := hooks.Install(hooks.Config{ClaudeConfigDir: cfg, ExplorerHome: home})
			if err != nil {
				return "", err
			}
			if !res.Changed() {
				return "hooks already installed in " + filepath.Join(cfg, "settings.json"), nil
			}
			return fmt.Sprintf("installed %d hooks in %s", len(res.Events), filepath.Join(cfg, "settings.json")), nil
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
