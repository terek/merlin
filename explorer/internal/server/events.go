package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/engine"
	"github.com/terek/merlin/explorer/internal/model"
)

// stream writes Server-Sent Events to one client. Every write gets a deadline, so a client
// that stops reading ends its own stream instead of holding a goroutine for ever.
type stream struct {
	w       http.ResponseWriter
	rc      *http.ResponseController
	timeout time.Duration
}

func (s *stream) write(b []byte) error {
	s.rc.SetWriteDeadline(time.Now().Add(s.timeout)) // unsupported writers: no deadline
	if _, err := s.w.Write(b); err != nil {
		return err
	}
	return s.rc.Flush()
}

func (s *stream) event(name string, data any) error {
	var buf bytes.Buffer
	buf.WriteString("event: " + name + "\ndata: ")
	enc := json.NewEncoder(&buf) // one line: Encode ends with a newline and escapes none
	enc.SetEscapeHTML(false)
	if err := enc.Encode(data); err != nil {
		return nil // cannot happen for these types; skip the event rather than the stream
	}
	buf.WriteString("\n")
	return s.write(buf.Bytes())
}

// handleEvents is GET /api/events. The stream carries:
//
//	session-updated  a digest was written: key and summary
//	session-missing  a session's files are gone
//	scan-progress    indexing is under way (throttled; sent when it changes)
//	session-state    a listed session changed between busy, idle, recent and ended
//
// Liveness is looked at every StateInterval. The first look after the stream opens sends
// nothing, and neither does a session first seen later (its session-updated announces it).
// A change in the same tick as a pending session-updated is left to that event, which
// carries the state.
//
// plus a comment line every Heartbeat. Events of one session within Coalesce are sent
// once, with the state after the last of them. The engine is never held up: the bus drops
// events for a subscriber whose buffer is full, and a client that cannot keep up simply
// misses some (it should re-read the list after reconnecting).
func (a *API) handleEvents(w http.ResponseWriter, r *http.Request) {
	if a.o.Subscribe == nil {
		a.fail(w, http.StatusServiceUnavailable, CodeUnavailable, "no event source")
		return
	}
	rc := http.NewResponseController(w)
	h := w.Header()
	setCommon(h)
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	s := &stream{w: w, rc: rc, timeout: a.o.WriteTimeout}
	if s.write([]byte("retry: 3000\n: connected\n\n")) != nil {
		return
	}

	// Subscribe before reading the first progress, so that nothing slips in between.
	ch, unsub := a.o.Subscribe(subscriberBuffer)
	defer unsub()

	var last ScanProgress
	sendProgress := func(force bool) error {
		if a.o.Progress == nil {
			return nil
		}
		p := a.o.Progress()
		// Idle rescans reset the counters every few seconds; only report change while
		// there is work, and the moment the work ends.
		if !force && (p == last || (p.Pending == 0 && last.Pending == 0)) {
			return nil
		}
		last = p
		return s.event(EventScanProgress, p)
	}
	if sendProgress(true) != nil {
		return
	}

	type pending struct {
		missing bool
	}
	queued := map[model.SessionKey]pending{}
	var order []model.SessionKey
	// states is the liveness last told to the client, by session-updated or session-state.
	states := map[model.SessionKey]catalog.State{}
	flush := func() error {
		cat := a.o.Catalog()
		keys := order
		order = nil
		for _, k := range keys {
			p := queued[k]
			delete(queued, k)
			if cat == nil {
				continue
			}
			in, ok := cat.Session(k)
			if !ok || in.Kind == model.KindSDK {
				continue // an error stub, or a scripted run: only in aggregate
			}
			var err error
			if p.missing {
				err = s.event(EventSessionMissing, SessionMissingEvent{Key: k})
			} else {
				state := a.liveness().StateOf(k, in.LastActivityAt)
				states[k] = state // the update carries the state: no session-state for it
				err = s.event(EventSessionUpdated, SessionUpdatedEvent{Key: k, Session: summarize(cat, in, state)})
			}
			if err != nil {
				return err
			}
		}
		return nil
	}

	look := func(first bool) error {
		cat := a.o.Catalog()
		if cat == nil {
			return nil
		}
		now := cat.States(a.liveness())
		for k, st := range now {
			prev, known := states[k]
			states[k] = st
			if first || !known || prev == st {
				continue
			}
			if _, pend := queued[k]; pend {
				continue
			}
			if err := s.event(EventSessionState, SessionStateEvent{Key: k, State: st, Previous: prev}); err != nil {
				return err
			}
		}
		for k := range states {
			if _, ok := now[k]; !ok {
				delete(states, k)
			}
		}
		return nil
	}
	if look(true) != nil {
		return
	}

	heartbeat := time.NewTicker(a.o.Heartbeat)
	defer heartbeat.Stop()
	progress := time.NewTicker(a.o.ProgressInterval)
	defer progress.Stop()
	stateTick := time.NewTicker(a.o.StateInterval)
	defer stateTick.Stop()
	coalesce := time.NewTimer(time.Hour)
	coalesce.Stop()
	armed := false

	enqueue := func(ev engine.Event) {
		k := model.SessionKey{Harness: ev.Ref.Harness, ID: ev.Ref.SessionID}
		if _, seen := queued[k]; !seen {
			order = append(order, k)
		}
		queued[k] = pending{missing: ev.Kind == engine.SourceMissing}
		if !armed {
			coalesce.Reset(a.o.Coalesce)
			armed = true
		}
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			enqueue(ev)
		case <-coalesce.C:
			armed = false
			if flush() != nil {
				return
			}
		case <-progress.C:
			if sendProgress(false) != nil {
				return
			}
		case <-stateTick.C:
			// Take in the writes already published first: a session with an update on
			// its way is left to that update.
			for more := true; more; {
				select {
				case ev, ok := <-ch:
					if !ok {
						return
					}
					enqueue(ev)
				default:
					more = false
				}
			}
			if look(false) != nil {
				return
			}
		case <-heartbeat.C:
			if s.write([]byte(": heartbeat\n\n")) != nil {
				return
			}
		}
	}
}
