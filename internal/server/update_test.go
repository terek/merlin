package server

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// avail is a settable Options.Update.
type avail struct {
	mu sync.Mutex
	u  UpdateEvent
}

func (a *avail) set(v string) {
	a.setEvent(UpdateEvent{Version: v})
}
func (a *avail) setEvent(u UpdateEvent) { a.mu.Lock(); a.u = u; a.mu.Unlock() }
func (a *avail) get() UpdateEvent       { a.mu.Lock(); defer a.mu.Unlock(); return a.u }

func updateEvent(t *testing.T, f frame) UpdateEvent {
	t.Helper()
	var u UpdateEvent
	if f.event != EventUpdate || json.Unmarshal([]byte(f.data), &u) != nil {
		t.Fatalf("frame %q %s is not an update", f.event, f.data)
	}
	return u
}

func updateVersion(t *testing.T, f frame) string { return updateEvent(t, f).Version }

func TestEventsUpdateCarriesStateAndReason(t *testing.T) {
	a := &avail{u: UpdateEvent{Version: "1.3.0", State: "available"}}
	r := newRig(t, func(o *Options) {
		o.Update = a.get
		o.StateInterval = 10 * time.Millisecond
	})
	c := r.events()
	if u := updateEvent(t, c.nextEvent(t, EventUpdate)); u.State != "available" || u.Reason != "" {
		t.Errorf("first = %+v", u)
	}
	c.nextEvent(t, EventScanProgress)
	// Only the state changes: the same version is sent again.
	for _, want := range []UpdateEvent{
		{Version: "1.3.0", State: "downloading"},
		{Version: "1.3.0", State: "blocked", Reason: "cannot write to /usr/local/bin"},
		{Version: "1.3.0", State: "ready"},
	} {
		a.setEvent(want)
		if got := updateEvent(t, c.nextEvent(t, EventUpdate)); got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	}
}

func TestEventsUpdateAfterHello(t *testing.T) {
	a := &avail{u: UpdateEvent{Version: "1.3.0"}}
	r := newRig(t, func(o *Options) {
		o.Version = "1.2.3"
		o.Update = a.get
		o.StateInterval = 10 * time.Millisecond
	})
	c := r.events()
	c.nextEvent(t, EventHello)
	if v := updateVersion(t, c.nextEvent(t, EventUpdate)); v != "1.3.0" {
		t.Errorf("version = %q", v)
	}
	c.nextEvent(t, EventScanProgress)
	c.quiet(t, 100*time.Millisecond) // the same answer is not sent again
}

func TestEventsUpdateFollowsChanges(t *testing.T) {
	a := &avail{}
	r := newRig(t, func(o *Options) {
		o.Version = "1.2.3"
		o.Update = a.get
		o.StateInterval = 10 * time.Millisecond
	})
	c := r.events() // a stream opened before anything was found
	c.nextEvent(t, EventHello)
	c.nextEvent(t, EventScanProgress) // nothing to report: no update
	c.quiet(t, 50*time.Millisecond)

	for _, v := range []string{"1.3.0", "1.4.0", ""} {
		a.set(v)
		if got := updateVersion(t, c.nextEvent(t, EventUpdate)); got != v {
			t.Errorf("version = %q, want %q", got, v)
		}
	}
	c.quiet(t, 50*time.Millisecond)

	// A stream opened later hears only the current answer.
	a.set("1.5.0")
	c2 := r.events()
	c2.nextEvent(t, EventHello)
	if v := updateVersion(t, c2.nextEvent(t, EventUpdate)); v != "1.5.0" {
		t.Errorf("late stream: %q", v)
	}
}

func TestEventsNoUpdateWithoutAvailable(t *testing.T) {
	r := newRig(t, func(o *Options) { o.StateInterval = 10 * time.Millisecond })
	c := r.events()
	c.nextEvent(t, EventScanProgress)
	c.quiet(t, 100*time.Millisecond)
}
