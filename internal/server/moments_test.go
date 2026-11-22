package server

import (
	"context"
	"sync"
	"testing"

	"github.com/terek/merlin/internal/moments"
)

func TestMoments(t *testing.T) {
	r := newRig(t)
	var rep moments.Report
	if code := r.get("/api/moments", &rep); code != 200 {
		t.Fatal(code)
	}
	if rep.Sessions == 0 || len(rep.Personas) != 3 || len(rep.Moments) != len(moments.Registry()) {
		t.Fatalf("report: %d sessions, %d personas, %d moments", rep.Sessions, len(rep.Personas), len(rep.Moments))
	}
	if !rep.Now.Equal(testNow) || rep.WindowDays != moments.WindowDays {
		t.Errorf("now %v window %d", rep.Now, rep.WindowDays)
	}
	seen := 0
	for _, m := range rep.Moments {
		if m.Status != moments.StatusUnseen {
			seen++
		}
	}
	if seen == 0 {
		t.Error("the fixtures show no moment at all")
	}
}

// Concurrent requests for one catalog state share one report; an abandoned request returns at
// once; a write makes the next report fresh.
func TestMomentsReportShared(t *testing.T) {
	r := newRig(t)
	a := r.api
	first, err := a.report(context.Background(), r.cat)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := a.report(context.Background(), r.cat)
	if again.Sessions != first.Sessions || a.momentsCache.call == nil {
		t.Fatal("no report cached")
	}
	call := a.momentsCache.call
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); a.report(context.Background(), r.cat) }()
	}
	wg.Wait()
	if a.momentsCache.call != call {
		t.Fatal("concurrent requests recomputed the report")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.report(ctx, r.cat); err == nil {
		t.Fatal("a cancelled request got a report")
	}
}
