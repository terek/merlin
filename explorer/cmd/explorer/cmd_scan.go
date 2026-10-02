package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"time"

	"github.com/terek/merlin/explorer/internal/claude"
	"github.com/terek/merlin/explorer/internal/engine"
	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/paths"
	"github.com/terek/merlin/explorer/internal/pricing"
	"github.com/terek/merlin/explorer/internal/store"
)

func init() {
	register("scan", command{
		usage:   "scan",
		summary: "index once and exit",
		run:     runScan,
	})
}

func runScan(args []string) int {
	fs := flag.NewFlagSet("scan", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	workers := fs.Int("workers", 0, "concurrent builders (default: number of CPUs)")
	quiet := fs.Bool("quiet", false, "no progress on stderr")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "explorer scan: unexpected arguments")
		return 2
	}

	home, err := paths.ExplorerHome()
	if err != nil {
		fmt.Fprintf(os.Stderr, "explorer scan: %v\n", err)
		return 1
	}
	cfg, err := paths.ClaudeConfigDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "explorer scan: %v\n", err)
		return 1
	}
	pricer, err := pricing.Load(filepath.Join(home, "config.json"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "explorer scan: %v\n", err)
		return 1
	}
	st, err := store.New(home)
	if err != nil {
		fmt.Fprintf(os.Stderr, "explorer scan: %v\n", err)
		return 1
	}
	st.Warn = func(msg string) { fmt.Fprintln(os.Stderr, "explorer scan: "+msg) }

	p := &progressPrinter{w: os.Stderr, enabled: !*quiet}
	eng, err := engine.New(engine.Options{
		Store:      st,
		Harnesses:  []harness.Harness{claude.New(cfg, pricer)},
		Workers:    *workers,
		Logf:       func(format string, a ...any) { fmt.Fprintf(os.Stderr, "explorer scan: "+format+"\n", a...) },
		OnProgress: p.update,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "explorer scan: %v\n", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	sum, err := eng.Scan(ctx)
	p.finish()
	if err != nil {
		fmt.Fprintf(os.Stderr, "explorer scan: %v\n", err)
		return 1
	}
	fmt.Printf("seen %d, processed %d, unchanged %d, failed %d, missing %d, elapsed %s\n",
		sum.Seen, sum.Processed, sum.Unchanged, sum.Failed, sum.Missing, sum.Elapsed.Round(time.Millisecond))
	return 0
}

// progressPrinter writes a progress line to stderr at most once a second, and only once
// a scan has run long enough to be worth reporting.
type progressPrinter struct {
	w       io.Writer
	enabled bool
	mu      sync.Mutex
	last    time.Time
	printed bool
}

func (p *progressPrinter) update(pr engine.Progress) {
	if !p.enabled || pr.Elapsed < 2*time.Second {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if time.Since(p.last) < time.Second {
		return
	}
	p.last, p.printed = time.Now(), true
	fmt.Fprintf(p.w, "\rexplorer scan: %d/%d sessions, %d failed, %.0f MB, %.1f MB/s   ",
		pr.Done, pr.Queued, pr.Failed, float64(pr.Bytes)/1e6, pr.Rate()/1e6)
}

func (p *progressPrinter) finish() {
	if p.printed {
		fmt.Fprintln(p.w)
	}
}
