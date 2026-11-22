package catalog

import (
	"fmt"
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

// An Upsert never waits for a view build, however slow.
func TestUpsertDoesNotWaitForBuild(t *testing.T) {
	c := synthCatalog()
	done := make(chan struct{})
	go func() {
		c.view()
		close(done)
	}()
	time.Sleep(time.Millisecond) // let the build start
	worst := time.Duration(0)
	for i := 0; i < 200; i++ {
		t0 := time.Now()
		c.Upsert(syn("claude", fmt.Sprintf("w%03d", i), "/p/w", i, i+1, nil))
		if d := time.Since(t0); d > worst {
			worst = d
		}
	}
	<-done
	if worst > 50*time.Millisecond {
		t.Fatalf("an Upsert took %v while a view was building", worst)
	}
}

// While writes keep coming, readers see a view at most about the freshness bound old, and
// once the writes stop the next read is fully fresh.
func TestFreshnessBound(t *testing.T) {
	const bound = 100 * time.Millisecond
	c := New()
	c.SetFreshness(bound)
	c.Upsert(syn("claude", "s0", "/p/0", 0, 1, nil))
	c.view()

	stop := time.Now().Add(600 * time.Millisecond)
	n := 1
	builds := 0
	last := c.view()
	for time.Now().Before(stop) {
		c.Upsert(syn("claude", fmt.Sprintf("s%d", n), "/p/0", n, n+1, nil))
		n++
		if v := c.view(); v != last {
			builds++
			last = v
		}
		time.Sleep(2 * time.Millisecond)
	}
	if max := int(600*time.Millisecond/bound) + 2; builds > max {
		t.Fatalf("%d rebuilds in 600ms with a %v bound, want at most %d", builds, bound, max)
	}
	if builds < 2 {
		t.Fatalf("only %d rebuilds: the view never refreshed during the writes", builds)
	}
	time.Sleep(bound) // the writes have stopped
	if got := len(c.view().sessions); got != n {
		t.Fatalf("after the writes stopped the view holds %d sessions, want %d", got, n)
	}
}

// The last write is visible on the next read once writes pause, with no timer to wait for.
func TestLastWriteIsFreshOnNextRead(t *testing.T) {
	c := New()
	c.SetFreshness(time.Hour)
	c.Upsert(syn("claude", "a", "/p/0", 0, 1, nil))
	c.view()
	c.Upsert(syn("claude", "b", "/p/0", 1, 2, nil))
	c.mu.Lock()
	c.lastWrite = time.Now().Add(-2 * time.Hour)
	c.mu.Unlock()
	if got := len(c.view().sessions); got != 2 {
		t.Fatalf("view holds %d sessions, want 2", got)
	}
}

func TestSnapshotIsFrozen(t *testing.T) {
	c := New()
	c.Upsert(syn("claude", "a", "/p/0", 0, 1, nil))
	s := c.Snapshot()
	c.Upsert(syn("claude", "b", "/p/0", 1, 2, nil))
	if _, ok := s.Session(key("b")); ok {
		t.Fatal("the snapshot saw a later write")
	}
	if _, ok := s.Session(key("a")); !ok {
		t.Fatal("the snapshot lost a session")
	}
	if _, ok := s.Places(key("a")); !ok {
		t.Fatal("no places in the snapshot")
	}
	n := 0
	s.Each(func(*model.SessionDigest) { n++ })
	if n != 1 || s.Len() != 1 {
		t.Fatalf("snapshot holds %d digests, want 1", n)
	}
	if _, ok := c.Session(key("b")); !ok {
		t.Fatal("the catalog lost the write")
	}
}
