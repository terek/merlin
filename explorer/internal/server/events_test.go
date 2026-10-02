package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/engine"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/store"
)

type frame struct {
	event   string
	data    string
	comment string
}

// sseConn is a client of /api/events. Frames arrive on C until the stream ends.
type sseConn struct {
	C      chan frame
	cancel context.CancelFunc
	resp   *http.Response
	done   chan struct{}
}

func (r *rig) events() *sseConn {
	r.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, r.srv.URL+"/api/events", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		r.t.Fatal(err)
	}
	c := &sseConn{C: make(chan frame, 1024), cancel: cancel, resp: resp, done: make(chan struct{})}
	go func() {
		defer close(c.done)
		defer close(c.C)
		sc := bufio.NewReader(resp.Body)
		var f frame
		for {
			line, err := sc.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			switch {
			case line == "":
				if f != (frame{}) {
					c.C <- f
				}
				f = frame{}
			case strings.HasPrefix(line, "event: "):
				f.event = line[len("event: "):]
			case strings.HasPrefix(line, "data: "):
				f.data = line[len("data: "):]
			case strings.HasPrefix(line, ":"):
				f.comment = strings.TrimSpace(line[1:])
			}
		}
	}()
	r.t.Cleanup(c.close)
	return c
}

func (c *sseConn) close() {
	c.cancel()
	c.resp.Body.Close()
	<-c.done
}

// next returns the next frame, or fails after a second.
func (c *sseConn) next(t *testing.T) frame {
	t.Helper()
	select {
	case f, ok := <-c.C:
		if !ok {
			t.Fatal("stream ended")
		}
		return f
	case <-time.After(2 * time.Second):
		t.Fatal("no event within 2 s")
	}
	return frame{}
}

// nextEvent skips comments and returns the next named event.
func (c *sseConn) nextEvent(t *testing.T, name string) frame {
	t.Helper()
	for {
		f := c.next(t)
		if f.event == "" {
			continue
		}
		if f.event != name {
			t.Fatalf("event %q (%s), want %q", f.event, f.data, name)
		}
		return f
	}
}

// quiet fails if an event arrives within d.
func (c *sseConn) quiet(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case f, ok := <-c.C:
		if ok && f.event != "" {
			t.Fatalf("unexpected event %q: %s", f.event, f.data)
		}
	case <-time.After(d):
	}
}

// write mimics the daemon: the catalog first, then the bus.
func (r *rig) write(d *model.SessionDigest) {
	r.cat.Upsert(d)
	r.bus.Publish(engine.Event{Kind: engine.Written, Ref: store.Ref{Harness: d.Harness, ProjectKey: d.ProjectKey, SessionID: d.ID}, Digest: d})
}

func (r *rig) digest(id string) *model.SessionDigest {
	d, ok := r.cat.Digest(model.SessionKey{Harness: "claude", ID: id})
	if !ok {
		r.t.Fatalf("no digest %s", id)
	}
	cp := *d
	return &cp
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for end := time.Now().Add(2 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestEventsHeadersAndGreeting(t *testing.T) {
	r := newRig(t)
	c := r.events()
	if ct := c.resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type %q", ct)
	}
	if cc := c.resp.Header.Get("Cache-Control"); !strings.Contains(cc, "no-cache") {
		t.Errorf("Cache-Control %q", cc)
	}
	for k := range c.resp.Header {
		if strings.HasPrefix(strings.ToLower(k), "access-control-") {
			t.Errorf("CORS header %s", k)
		}
	}
	// the first frame is the connect comment and arrives before any event
	if f := c.next(t); f.comment != "connected" && f.event == "" {
		t.Errorf("first frame %+v", f)
	}
	c.nextEvent(t, EventScanProgress) // the initial state
}

func TestEventsSessionUpdated(t *testing.T) {
	r := newRig(t)
	c := r.events()
	c.nextEvent(t, EventScanProgress)
	waitFor(t, "subscription", func() bool { return r.bus.Subscribers() == 1 })

	d := r.digest(costStateID)
	d.Title = "renamed by an upsert"
	r.write(d)
	f := c.nextEvent(t, EventSessionUpdated)
	var ev SessionUpdatedEvent
	if err := json.Unmarshal([]byte(f.data), &ev); err != nil {
		t.Fatalf("%v: %s", err, f.data)
	}
	if ev.Key.ID != costStateID || ev.Session.Title != "renamed by an upsert" || ev.Session.Key != ev.Key {
		t.Errorf("event: %+v", ev)
	}
	if ev.Session.Cost.BestUSD <= 0 || ev.Session.State != "ended" {
		t.Errorf("summary: %+v", ev.Session)
	}
	// the same shape as the list endpoint
	var l SessionList
	r.get("/api/sessions?limit=500", &l)
	for _, s := range l.Sessions {
		if s.Key == ev.Key {
			a, _ := json.Marshal(s)
			b, _ := json.Marshal(ev.Session)
			if string(a) != string(b) {
				t.Errorf("list and event differ:\n%s\n%s", a, b)
			}
		}
	}
	if strings.Contains(f.data, "\n") {
		t.Errorf("data must be one line")
	}
}

func TestEventsCoalesceAndSkip(t *testing.T) {
	r := newRig(t, func(o *Options) { o.Coalesce = 100 * time.Millisecond })
	c := r.events()
	c.nextEvent(t, EventScanProgress)
	waitFor(t, "subscription", func() bool { return r.bus.Subscribers() == 1 })

	// five writes of one session within the window: one event, the latest state
	for i := 0; i < 5; i++ {
		d := r.digest(subNestID)
		d.Title = "rev " + string(rune('a'+i))
		r.write(d)
	}
	// a scripted run and an unknown session produce nothing
	r.bus.Publish(engine.Event{Kind: engine.Written, Ref: store.Ref{Harness: "claude", SessionID: sdkID}})
	r.bus.Publish(engine.Event{Kind: engine.Failed, Ref: store.Ref{Harness: "claude", SessionID: "no-such-session"}})
	var ev SessionUpdatedEvent
	json.Unmarshal([]byte(c.nextEvent(t, EventSessionUpdated).data), &ev)
	if ev.Key.ID != subNestID || ev.Session.Title != "rev e" {
		t.Errorf("event: %+v", ev.Session.Title)
	}
	c.quiet(t, 300*time.Millisecond)
}

func TestEventsSessionMissing(t *testing.T) {
	r := newRig(t)
	c := r.events()
	c.nextEvent(t, EventScanProgress)
	waitFor(t, "subscription", func() bool { return r.bus.Subscribers() == 1 })

	key := model.SessionKey{Harness: "claude", ID: costStateID}
	r.cat.MarkMissing(key)
	r.bus.Publish(engine.Event{Kind: engine.SourceMissing, Ref: store.Ref{Harness: "claude", SessionID: costStateID}})
	f := c.nextEvent(t, EventSessionMissing)
	var ev SessionMissingEvent
	if err := json.Unmarshal([]byte(f.data), &ev); err != nil || ev.Key != key {
		t.Errorf("%v %s", err, f.data)
	}
	var d SessionDetail
	r.get("/api/sessions/claude/"+costStateID, &d)
	if !d.Summary.SourceMissing {
		t.Errorf("summary does not say the source is missing")
	}
}

func TestEventsScanProgress(t *testing.T) {
	r := newRig(t, func(o *Options) { o.ProgressInterval = 10 * time.Millisecond })
	c := r.events()
	var first ScanProgress
	json.Unmarshal([]byte(c.nextEvent(t, EventScanProgress).data), &first)
	if first.Pending != 0 {
		t.Errorf("initial: %+v", first)
	}
	// idle counters changing (a rescan resetting them) are not news
	r.setProgress(ScanProgress{Seen: 35, Unchanged: 35})
	c.quiet(t, 100*time.Millisecond)

	r.setProgress(ScanProgress{Pending: 20, Seen: 35, Processed: 15})
	var p ScanProgress
	json.Unmarshal([]byte(c.nextEvent(t, EventScanProgress).data), &p)
	if p.Pending != 20 || p.Processed != 15 {
		t.Errorf("progress: %+v", p)
	}
	c.quiet(t, 100*time.Millisecond) // unchanged: nothing more
	r.setProgress(ScanProgress{Pending: 5, Seen: 35, Processed: 30})
	c.nextEvent(t, EventScanProgress)
	r.setProgress(ScanProgress{Seen: 35, Processed: 35}) // done: reported once
	json.Unmarshal([]byte(c.nextEvent(t, EventScanProgress).data), &p)
	if p.Pending != 0 || p.Processed != 35 {
		t.Errorf("final: %+v", p)
	}
	c.quiet(t, 100*time.Millisecond)
}

func (r *rig) setProgress(p ScanProgress) {
	progressMu.Lock()
	r.progress = p
	progressMu.Unlock()
}

func TestEventsHeartbeat(t *testing.T) {
	r := newRig(t, func(o *Options) { o.Heartbeat = 20 * time.Millisecond })
	c := r.events()
	for n := 0; n < 3; {
		if f := c.next(t); f.comment == "heartbeat" {
			n++
		}
	}
}

func TestEventsEndsWhenClientLeaves(t *testing.T) {
	r := newRig(t)
	c := r.events()
	c.nextEvent(t, EventScanProgress)
	waitFor(t, "subscription", func() bool { return r.bus.Subscribers() == 1 })
	c.close()
	waitFor(t, "unsubscribe", func() bool { return r.bus.Subscribers() == 0 })
}

func TestEventsMany(t *testing.T) {
	r := newRig(t)
	cs := []*sseConn{r.events(), r.events(), r.events()}
	waitFor(t, "subscriptions", func() bool { return r.bus.Subscribers() == 3 })
	d := r.digest(costStateID)
	d.Title = "to all"
	r.write(d)
	for _, c := range cs {
		c.nextEvent(t, EventScanProgress)
		c.nextEvent(t, EventSessionUpdated)
	}
	cs[0].close()
	waitFor(t, "one left", func() bool { return r.bus.Subscribers() == 2 })
}

// stuckWriter is a response writer whose client has stopped reading: Write blocks until
// released.
type stuckWriter struct {
	h       http.Header
	release chan struct{}
	once    sync.Once
	writes  int
	failing bool
}

func (w *stuckWriter) Header() http.Header { return w.h }
func (w *stuckWriter) WriteHeader(int)     {}
func (w *stuckWriter) Flush()              {}
func (w *stuckWriter) Write(b []byte) (int, error) {
	w.writes++
	if w.writes > 2 { // the greeting and the first progress go through
		if w.failing {
			return 0, context.Canceled
		}
		<-w.release
	}
	return len(b), nil
}
func (w *stuckWriter) unstick() { w.once.Do(func() { close(w.release) }) }

func TestEventsSlowClientNeverBlocksTheEngine(t *testing.T) {
	r := newRig(t)
	w := &stuckWriter{h: http.Header{}, release: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	handled := make(chan struct{})
	go func() {
		defer close(handled)
		r.api.Handler().ServeHTTP(w, localReq("/api/events").WithContext(ctx))
	}()
	waitFor(t, "subscription", func() bool { return r.bus.Subscribers() == 1 })

	d := r.digest(costStateID)
	r.write(d) // the handler will block writing this one
	time.Sleep(50 * time.Millisecond)

	// Far more events than the subscriber's buffer, while its goroutine is stuck: the
	// publisher must not wait for it.
	start := time.Now()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 20000; i++ {
			r.bus.Publish(engine.Event{Kind: engine.Written, Ref: store.Ref{Harness: "claude", SessionID: costStateID}})
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Publish blocked on a slow subscriber")
	}
	t.Logf("20000 publishes in %v", time.Since(start))

	// and the rest of the API is unaffected
	var l ProjectList
	if code := r.get("/api/projects", &l); code != 200 {
		t.Errorf("projects while a client is stuck: %d", code)
	}

	cancel()
	w.unstick()
	select {
	case <-handled:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not end after the client left")
	}
	waitFor(t, "unsubscribe", func() bool { return r.bus.Subscribers() == 0 })
}

func TestEventsWriteErrorEndsStream(t *testing.T) {
	r := newRig(t)
	w := &stuckWriter{h: http.Header{}, release: make(chan struct{}), failing: true}
	handled := make(chan struct{})
	go func() {
		defer close(handled)
		r.api.Handler().ServeHTTP(w, localReq("/api/events"))
	}()
	waitFor(t, "subscription", func() bool { return r.bus.Subscribers() == 1 })
	r.write(r.digest(costStateID))
	select {
	case <-handled:
	case <-time.After(2 * time.Second):
		t.Fatal("a failing write did not end the stream")
	}
	waitFor(t, "unsubscribe", func() bool { return r.bus.Subscribers() == 0 })
}

func TestEventsBusClosed(t *testing.T) {
	// The bus closing the channel ends the stream.
	ch := make(chan engine.Event)
	r := newRig(t, func(o *Options) {
		o.Subscribe = func(int) (<-chan engine.Event, func()) { return ch, func() {} }
	})
	c := r.events()
	c.nextEvent(t, EventScanProgress)
	close(ch)
	select {
	case <-c.done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream still open")
	}
}

func localReq(path string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "127.0.0.1:7433"
	return req
}
