package server

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/model"
)

// liveFake is a registry and a clock the test can move while streams are open.
type liveFake struct {
	mu  sync.Mutex
	reg catalog.Registry
	now time.Time
}

func (l *liveFake) set(reg catalog.Registry, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.reg, l.now = reg, now
}

func (l *liveFake) options(o *Options) {
	o.StateInterval = 10 * time.Millisecond
	o.Registry = func() catalog.Registry { l.mu.Lock(); defer l.mu.Unlock(); return l.reg }
	o.Now = func() time.Time { l.mu.Lock(); defer l.mu.Unlock(); return l.now }
}

func running(key model.SessionKey, status string) catalog.Registry {
	return catalog.Registry{key: {PID: 7, SessionID: key.ID, Status: status}}
}

// newestKey is the session last active, and when.
func newestKey(r *rig) (model.SessionKey, time.Time) {
	in := r.cat.List(catalog.Filter{}, catalog.Liveness{}).Sessions[0]
	return in.Key, in.LastActivityAt
}

// stateOf waits for the next session-state event of key (events of other sessions are
// skipped) and returns it.
func stateOf(t *testing.T, c *sseConn, key model.SessionKey) SessionStateEvent {
	t.Helper()
	for {
		f := c.next(t)
		if f.event == "" {
			continue
		}
		if f.event != EventSessionState {
			t.Fatalf("event %q (%s), want %s", f.event, f.data, EventSessionState)
		}
		var ev SessionStateEvent
		if err := json.Unmarshal([]byte(f.data), &ev); err != nil {
			t.Fatal(err)
		}
		if ev.Key == key {
			return ev
		}
	}
}

func wantState(t *testing.T, ev SessionStateEvent, state, prev catalog.State) {
	t.Helper()
	if ev.State != state || ev.Previous != prev {
		t.Errorf("session-state %s -> %s, want %s -> %s", ev.Previous, ev.State, prev, state)
	}
}

func TestSessionStateBusyIdleEnded(t *testing.T) {
	live := &liveFake{now: testNow}
	r := newRig(t, live.options)
	key, _ := newestKey(r)
	live.set(running(key, "busy"), testNow)
	c := r.events()
	c.nextEvent(t, EventScanProgress)
	c.quiet(t, 80*time.Millisecond) // the first look sends nothing, whatever the states are

	live.set(running(key, "idle"), testNow)
	wantState(t, stateOf(t, c, key), catalog.StateIdle, catalog.StateBusy)
	live.set(running(key, "busy"), testNow)
	wantState(t, stateOf(t, c, key), catalog.StateBusy, catalog.StateIdle)
	live.set(running(key, "idle"), testNow)
	wantState(t, stateOf(t, c, key), catalog.StateIdle, catalog.StateBusy)
	live.set(nil, testNow)
	wantState(t, stateOf(t, c, key), catalog.StateEnded, catalog.StateIdle)
	c.quiet(t, 80*time.Millisecond) // nothing changes any more: nothing is sent
}

func TestSessionStateRecentToEndedByTimeAlone(t *testing.T) {
	live := &liveFake{}
	r := newRig(t, live.options)
	key, last := newestKey(r)
	live.set(nil, last.Add(time.Minute))
	c := r.events()
	c.nextEvent(t, EventScanProgress)
	c.quiet(t, 80*time.Millisecond)

	live.set(nil, last.Add(11*time.Minute))
	wantState(t, stateOf(t, c, key), catalog.StateEnded, catalog.StateRecent)

	live.set(running(key, "busy"), last.Add(11*time.Minute))
	wantState(t, stateOf(t, c, key), catalog.StateBusy, catalog.StateEnded)
}

func TestSessionStateNewSessionIsAnnouncedByUpdated(t *testing.T) {
	live := &liveFake{now: testNow}
	r := newRig(t, live.options)
	c := r.events()
	c.nextEvent(t, EventScanProgress)
	c.quiet(t, 50*time.Millisecond)

	d := r.digest(sid("01", "01").ID)
	d.ID = "99999999-0000-4000-8000-000000000001"
	key := d.Key()
	live.set(running(key, "busy"), testNow)
	r.write(d)
	f := c.nextEvent(t, EventSessionUpdated)
	var up SessionUpdatedEvent
	if err := json.Unmarshal([]byte(f.data), &up); err != nil {
		t.Fatal(err)
	}
	if up.Key != key || up.Session.State != catalog.StateBusy {
		t.Errorf("session-updated %+v", up)
	}
	c.quiet(t, 100*time.Millisecond) // no session-state for a session first seen, nor beside its update

	live.set(nil, testNow)
	wantState(t, stateOf(t, c, key), catalog.StateEnded, catalog.StateBusy)
}

func TestSessionStateNotSentBesideUpdated(t *testing.T) {
	live := &liveFake{now: testNow}
	r := newRig(t, live.options, func(o *Options) { o.Coalesce = 150 * time.Millisecond })
	key, _ := newestKey(r)
	live.set(running(key, "busy"), testNow)
	c := r.events()
	c.nextEvent(t, EventScanProgress)
	c.quiet(t, 50*time.Millisecond)

	// A write queues a session-updated; the state changes before it is sent.
	r.write(r.digest(key.ID))
	live.set(running(key, "idle"), testNow)
	f := c.nextEvent(t, EventSessionUpdated)
	var up SessionUpdatedEvent
	json.Unmarshal([]byte(f.data), &up)
	if up.Key != key || up.Session.State != catalog.StateIdle {
		t.Errorf("session-updated %+v, want state idle", up)
	}
	c.quiet(t, 100*time.Millisecond)
}

func TestSessionStateTwoStreams(t *testing.T) {
	live := &liveFake{now: testNow}
	r := newRig(t, live.options)
	key, _ := newestKey(r)
	live.set(running(key, "busy"), testNow)
	a, b := r.events(), r.events()
	a.nextEvent(t, EventScanProgress)
	b.nextEvent(t, EventScanProgress)
	a.quiet(t, 50*time.Millisecond)
	b.quiet(t, 50*time.Millisecond)

	live.set(running(key, "idle"), testNow)
	wantState(t, stateOf(t, a, key), catalog.StateIdle, catalog.StateBusy)
	wantState(t, stateOf(t, b, key), catalog.StateIdle, catalog.StateBusy)
	a.quiet(t, 100*time.Millisecond)
	b.quiet(t, 100*time.Millisecond)

	// A stream opened later starts from what is true now: no event for it.
	late := r.events()
	late.nextEvent(t, EventScanProgress)
	late.quiet(t, 100*time.Millisecond)
}
