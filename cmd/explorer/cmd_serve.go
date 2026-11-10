package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/claude/hooks"
	"github.com/terek/merlin/internal/daemon"
	"github.com/terek/merlin/internal/engine"
	"github.com/terek/merlin/internal/hookfile"
	"github.com/terek/merlin/internal/paths"
	"github.com/terek/merlin/internal/pricing"
	"github.com/terek/merlin/internal/server"
	"github.com/terek/merlin/internal/term"
	"github.com/terek/merlin/internal/webui"
)

func init() {
	register("serve", command{
		usage:   "serve [--port 7433] [--no-hooks] [--no-auto-upgrade]",
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
	noUpgrade := fs.Bool("no-auto-upgrade", false, "do not install new releases by itself, whatever MERLIN_AUTO_UPGRADE and config.json say (it is off unless \"merlin autoupgrade\" turned it on; new releases are still reported)")
	upgradeEvery := fs.Duration("upgrade-interval", defaultUpgradeInterval, "how often to check for a new release (for testing)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "merlin serve: unexpected arguments")
		return 2
	}
	pe := term.Detect(os.Stderr)
	fancy := pe.Fancy()
	fail := func(err error) int {
		if fancy {
			fmt.Fprintln(os.Stderr, failLine(pe, "serve", err))
		} else {
			fmt.Fprintf(os.Stderr, "merlin serve: %v\n", err)
		}
		return 1
	}
	var con *term.Console

	home, err := paths.Home()
	if err != nil {
		return fail(err)
	}
	cfg, pricer := loadConfig(home, "merlin serve")
	applyReleasesEnv()
	harnesses, err := buildHarnesses(pricer)
	if err != nil {
		return fail(err)
	}
	if *port == 0 { // flag, then config.json, then the default
		*port = hooks.DefaultPort
		if cfg.Port > 0 {
			*port = cfg.Port
		}
	}
	opts := daemon.Options{
		Home:           home,
		Harnesses:      harnesses,
		Port:           *port,
		Workers:        *workers,
		PricesVersion:  pricer.Version(),
		RescanInterval: *rescan,
		Debounce:       *debounce,
		Version:        version,
	}
	if fancy {
		con = term.NewConsole(os.Stderr, pe)
		opts.Stderr = con.LogWriter()
		opts.OnProgress = func(pr engine.Progress) { con.SetProgress(progressOf(pr)) }
	}
	au := newAutoUpgrader(home, *noUpgrade)
	opts.Upgrade, opts.UpgradeInterval = au.run, *upgradeEvery
	opts.BinaryChanged = au.binaryChanged
	opts.Available = au.available
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

	d.Handle("/api/", server.New(apiOptions(d, pricer)).Handler())
	d.Handle("/", webui.Handler())
	if fancy {
		printServeBanner(pe, *port, home)
	} else if webui.Built() {
		fmt.Fprintf(os.Stderr, "merlin: UI at http://127.0.0.1:%d/\n", *port)
	} else {
		fmt.Fprintf(os.Stderr, "merlin: this binary has no UI (make build includes it); the API is at http://127.0.0.1:%d/api/\n", *port)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var watched chan struct{}
	runDone := make(chan struct{})
	if fancy {
		watched = make(chan struct{})
		go func() { defer close(watched); watchFirstIndex(d, con, pe, runDone) }()
	}
	err = d.Run(ctx)
	close(runDone)
	if watched != nil {
		<-watched
	}
	switch {
	case err == nil:
		return 0
	case errors.Is(err, daemon.ErrRestart):
		// Run has shut down: the lock and the listener are released. Exec keeps the PID.
		if err := restartSelf(home, au.wasInstalled()); err != nil {
			return fail(fmt.Errorf("restarting after an upgrade: %w", err))
		}
	case os.Getenv(upgradedFromEnv) != "" && !started(d) && !isLocked(err):
		// The binary we just upgraded to cannot start: go back to the one that could.
		if rerr := rollback(home, err); rerr != nil {
			if fancy {
				fmt.Fprintln(os.Stderr, failLine(pe, "serve", rerr))
			} else {
				fmt.Fprintf(os.Stderr, "merlin serve: %v\n", rerr)
			}
		}
	}
	return fail(err)
}

// printServeBanner is the styled start-up banner (stderr is a terminal).
func printServeBanner(p term.Profile, port int, home string) {
	url := fmt.Sprintf("http://127.0.0.1:%d/", port)
	lines := []term.BannerLine{{Label: "ui", Value: p.Link(url, url)}}
	if !webui.Built() {
		lines = []term.BannerLine{
			{Label: "api", Value: p.Link(url+"api/", url+"api/")},
			{Label: "note", Value: "this binary has no UI (make build includes it)"},
		}
	}
	lines = append(lines,
		term.BannerLine{Label: "home", Value: tilde(home)},
		term.BannerLine{Label: "log", Value: tilde(filepath.Join(home, "merlin.log"))})
	fmt.Fprint(os.Stderr, term.Banner(p, term.BannerInfo{
		Version: version,
		Tagline: "what your agents did, and what it cost",
		Lines:   lines,
	}))
}

// watchFirstIndex shows a progress bar from when the daemon is listening until its first
// index is complete (a reconcile has queued everything and the queue has drained), prints
// the summary, and returns. Later rescans show nothing. It also returns when runDone closes.
func watchFirstIndex(d *daemon.Daemon, con *term.Console, p term.Profile, runDone <-chan struct{}) {
	select {
	case <-d.Ready():
	case <-runDone:
		return
	}
	con.StartProgress("indexing")
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-runDone:
			con.StopProgress()
			return
		case <-t.C:
		}
		if h := d.Health(); h.Rescans >= 1 && h.QueueDepth == 0 {
			break
		}
	}
	con.StopProgress()
	e := d.Engine()
	if e == nil {
		return
	}
	con.Println(indexSummary(p, e.Stats()))
	con.Println(p.Fg(term.Green, "◉") + p.Dim(" watching for changes") + p.Dim(" — Ctrl+C to stop"))
}

// started reports whether the daemon got as far as listening.
func started(d *daemon.Daemon) bool {
	select {
	case <-d.Ready():
		return true
	default:
		return false
	}
}

// isLocked reports that another merlin serve holds the lock: not a sign of a bad binary.
func isLocked(err error) bool {
	var l *daemon.LockedError
	return errors.As(err, &l)
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
func apiOptions(d *daemon.Daemon, pricer *pricing.Table) server.Options {
	return server.Options{
		Prices:    pricer,
		Version:   version,
		Available: d.Available,
		Catalog:   d.Catalog,
		Subscribe: d.Events().Subscribe,
		Harnesses: harnessInfos(),
		Registry: func() catalog.Registry {
			reg, err := liveRegistry()
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
