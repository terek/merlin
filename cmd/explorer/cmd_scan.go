package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync"
	"time"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/engine"
	"github.com/terek/merlin/internal/links"
	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/paths"
	"github.com/terek/merlin/internal/store"
	"github.com/terek/merlin/internal/term"
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
		fmt.Fprintln(os.Stderr, "merlin scan: unexpected arguments")
		return 2
	}

	pe, po := term.Detect(os.Stderr), term.Detect(os.Stdout)
	fail := func(err error) int {
		if pe.Fancy() {
			fmt.Fprintln(os.Stderr, failLine(pe, "scan", err))
		} else {
			fmt.Fprintf(os.Stderr, "merlin scan: %v\n", err)
		}
		return 1
	}

	home, err := paths.Home()
	if err != nil {
		return fail(err)
	}
	_, pricer := loadConfig(home, "merlin scan")
	harnesses, err := buildHarnesses(pricer)
	if err != nil {
		return fail(err)
	}
	st, err := store.New(home)
	if err != nil {
		return fail(err)
	}
	// say writes a line to stderr; with a bar showing it goes through the console, above the bar.
	say := func(s string) { fmt.Fprintln(os.Stderr, s) }
	st.Warn = func(msg string) { say("merlin scan: " + msg) }

	p := &progressPrinter{w: os.Stderr, enabled: !*quiet}
	onProgress := p.update
	var con *term.Console
	if !*quiet && pe.Fancy() {
		con = term.NewConsole(os.Stderr, pe)
		say = con.Println
		onProgress = func(pr engine.Progress) { con.SetProgress(progressOf(pr)) }
	}
	eng, err := engine.New(engine.Options{
		Store:         st,
		Harnesses:     harnesses,
		Workers:       *workers,
		PricesVersion: pricer.Version(),
		Logf:          func(format string, a ...any) { say(fmt.Sprintf("merlin scan: "+format, a...)) },
		OnProgress:    onProgress,
	})
	if err != nil {
		return fail(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if con != nil {
		con.StartProgress("indexing")
	}
	sum, err := eng.Scan(ctx)
	if con != nil {
		con.StopProgress()
	}
	p.finish()
	if err != nil {
		return fail(err)
	}
	if po.Fancy() {
		fmt.Println(indexSummary(po, sum))
	} else {
		fmt.Printf("seen %d, processed %d, unchanged %d, failed %d, missing %d, elapsed %s\n",
			sum.Seen, sum.Processed, sum.Unchanged, sum.Failed, sum.Missing, sum.Elapsed.Round(time.Millisecond))
	}

	// Where the sessions worked: repositories and bead databases.
	cat, err := catalog.Load(st, "")
	if err != nil {
		return fail(err)
	}
	var dirs []string
	cat.Each(func(d *model.SessionDigest) { dirs = append(dirs, links.Dirs(d)...) })
	res, err := links.Open(home).Refresh(dirs, time.Now())
	if err != nil {
		fmt.Fprintf(os.Stderr, "merlin scan: links: %v\n", err)
	}
	if po.Fancy() {
		fmt.Println(po.Fg(term.Green, "✔") + " linked " + po.Bold(thousands(res.Resolved)) + " directories, " +
			po.Bold(thousands(res.Databases)) + " bead databases")
	}
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
	fmt.Fprintf(p.w, "\rmerlin scan: %d/%d sessions, %d failed, %.0f MB, %.1f MB/s   ",
		pr.Done, pr.Queued, pr.Failed, float64(pr.Bytes)/1e6, pr.Rate()/1e6)
}

func (p *progressPrinter) finish() {
	if p.printed {
		fmt.Fprintln(p.w)
	}
}
