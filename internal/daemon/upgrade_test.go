package daemon_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/terek/merlin/internal/daemon"
)

func waitRun(t *testing.T, r *rig, what string) error {
	t.Helper()
	select {
	case err := <-r.done:
		r.cancel = nil // Run is over; the cleanup's stop has nothing to wait for
		return err
	case <-time.After(15 * time.Second):
		t.Fatalf("Run did not return: %s", what)
		return nil
	}
}

func TestUpgradeAtStartRestartsBeforeIndexing(t *testing.T) {
	var calls atomic.Int64
	r := newRig(t, "", "", func(o *daemon.Options) {
		o.Upgrade = func(context.Context, func(string, ...any)) bool { calls.Add(1); return true }
	})
	go func() { r.done <- r.d.Run(context.Background()) }()
	if err := waitRun(t, r, "startup upgrade"); !errors.Is(err, daemon.ErrRestart) {
		t.Fatalf("Run = %v, want ErrRestart", err)
	}
	if calls.Load() != 1 {
		t.Errorf("Upgrade called %d times", calls.Load())
	}
	if r.d.Engine() != nil || r.d.Catalog() != nil || r.d.Addr() != "" {
		t.Error("the daemon started things before restarting")
	}
	if r.h.builds.Load() != 0 {
		t.Error("something was indexed")
	}
	if _, err := os.Stat(filepath.Join(r.home, "claude")); err == nil {
		t.Error("the store was created")
	}
	// The lock is released, so the next process can take it.
	r2 := newRig(t, r.home, r.cfg, nil)
	r2.start()
	r2.stop()
}

func TestUpgradeAtStartFalseRunsNormally(t *testing.T) {
	r := newRig(t, "", "", func(o *daemon.Options) {
		o.Upgrade = func(context.Context, func(string, ...any)) bool { return false }
	})
	r.start()
	eventually(t, "initial index", r.indexed)
	if err := r.stop(); err != nil {
		t.Fatal(err)
	}
}

func TestPeriodicUpgradeWaitsForBuilds(t *testing.T) {
	var ready atomic.Bool
	r := newRig(t, "", "", func(o *daemon.Options) {
		o.UpgradeInterval = 20 * time.Millisecond
		o.IdlePoll = 5 * time.Millisecond
		o.Upgrade = func(context.Context, func(string, ...any)) bool { return ready.Load() }
	})
	r.h.gate = make(chan struct{})
	r.start()
	eventually(t, "builds in flight", func() bool { return r.d.Engine().Pending() > 0 })
	ready.Store(true)
	select {
	case err := <-r.done:
		t.Fatalf("Run returned %v while builds were in flight", err)
	case <-time.After(300 * time.Millisecond):
	}
	close(r.h.gate)
	if err := waitRun(t, r, "idle restart"); !errors.Is(err, daemon.ErrRestart) {
		t.Fatalf("Run = %v, want ErrRestart", err)
	}
	if r.d.Engine().Pending() != 0 {
		t.Error("restarted with builds in flight")
	}
}

func TestRestartGivesUpWaitingForBuilds(t *testing.T) {
	var n atomic.Int64
	r := newRig(t, "", "", func(o *daemon.Options) {
		o.UpgradeInterval = 20 * time.Millisecond
		o.IdlePoll, o.IdleMax = 5*time.Millisecond, 100*time.Millisecond
		o.ShutdownTimeout = 50 * time.Millisecond
		// false at startup; true on the first periodic call
		o.Upgrade = func(context.Context, func(string, ...any)) bool { return n.Add(1) > 1 }
	})
	r.h.gate = make(chan struct{})
	r.start()
	err := waitRun(t, r, "restart after IdleMax")
	close(r.h.gate)                    // let the abandoned builds finish before the temp dir goes
	time.Sleep(300 * time.Millisecond) // the engine is stopped; in-flight builds write and end
	if !errors.Is(err, daemon.ErrRestart) {
		t.Fatalf("Run = %v, want ErrRestart", err)
	}
}

func TestBinaryChangedRestarts(t *testing.T) {
	var changed atomic.Bool
	var upgrades atomic.Int64
	r := newRig(t, "", "", func(o *daemon.Options) {
		o.BinaryCheckInterval = 10 * time.Millisecond
		o.BinaryChanged = changed.Load
		o.Upgrade = func(context.Context, func(string, ...any)) bool { upgrades.Add(1); return false }
	})
	r.start()
	eventually(t, "initial index", r.indexed)
	time.Sleep(50 * time.Millisecond)
	select {
	case err := <-r.done:
		t.Fatalf("Run returned %v before the binary changed", err)
	default:
	}
	changed.Store(true)
	if err := waitRun(t, r, "binary changed"); !errors.Is(err, daemon.ErrRestart) {
		t.Fatalf("Run = %v, want ErrRestart", err)
	}
	if upgrades.Load() != 1 {
		t.Errorf("Upgrade ran %d times, want only the startup call", upgrades.Load())
	}
}

func TestNoUpgradeCallbacksUnchanged(t *testing.T) {
	r := newRig(t, "", "", nil)
	r.start()
	eventually(t, "initial index", r.indexed)
	if err := r.stop(); err != nil {
		t.Fatalf("Run = %v, want nil", err)
	}
}
