package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/engine"
)

// Defaults for the intervals in Options.
const (
	DefaultHeartbeat        = 15 * time.Second
	DefaultCoalesce         = 250 * time.Millisecond
	DefaultProgressInterval = time.Second
	DefaultStateInterval    = 2 * time.Second
	DefaultWriteTimeout     = 10 * time.Second
	subscriberBuffer        = 256
)

// Options wires the API to the running daemon. Only Catalog and Subscribe are required.
type Options struct {
	// Catalog returns the catalog; nil while the daemon is still starting (the API
	// answers 503 then).
	Catalog func() *catalog.Catalog
	// Subscribe is the daemon's event bus (daemon.Bus.Subscribe).
	Subscribe func(buffer int) (<-chan engine.Event, func())
	// Registry returns the sessions running now; nil means none.
	Registry func() catalog.Registry
	// Progress returns the indexing counters for scan-progress events; nil disables them.
	Progress func() ScanProgress
	// Now is the clock for liveness; nil means time.Now. Handlers read no other clock.
	Now func() time.Time
	// Location buckets days and parses date-only parameters; nil means time.Local.
	Location *time.Location

	Heartbeat        time.Duration // SSE comment interval; default 15 s
	Coalesce         time.Duration // SSE: events of one session within this are sent once; default 250 ms
	ProgressInterval time.Duration // SSE: how often scan progress is looked at; default 1 s
	StateInterval    time.Duration // SSE: how often session liveness is looked at; default 2 s
	WriteTimeout     time.Duration // SSE: a write that takes longer ends the stream; default 10 s
}

// API serves the read-only JSON API and the event stream.
type API struct {
	o   Options
	mux *http.ServeMux
}

// New returns the API. Mount it on the daemon with d.Handle("/api/", api.Handler()).
func New(o Options) *API {
	def := func(p *time.Duration, v time.Duration) {
		if *p <= 0 {
			*p = v
		}
	}
	def(&o.Heartbeat, DefaultHeartbeat)
	def(&o.Coalesce, DefaultCoalesce)
	def(&o.ProgressInterval, DefaultProgressInterval)
	def(&o.StateInterval, DefaultStateInterval)
	def(&o.WriteTimeout, DefaultWriteTimeout)
	if o.Now == nil {
		o.Now = time.Now
	}
	a := &API{o: o, mux: http.NewServeMux()}
	a.route("/api/projects", a.handleProjects)
	a.route("/api/sessions", a.handleSessions)
	a.route("/api/sessions/{harness}/{id}", a.handleSession)
	a.route("/api/search", a.handleSearch)
	a.route("/api/cost", a.handleCost)
	a.route("/api/events", a.handleEvents)
	a.route("/api/", func(w http.ResponseWriter, r *http.Request) {
		a.fail(w, http.StatusNotFound, CodeNotFound, "no such endpoint: "+r.URL.Path)
	})
	return a
}

// Handler is the handler for everything under /api/.
func (a *API) Handler() http.Handler { return a.mux }

func (a *API) loc() *time.Location {
	if a.o.Location != nil {
		return a.o.Location
	}
	return time.Local
}

// route registers h behind the Host guard and the GET-only rule. The method is checked
// here, not in the pattern, so that a wrong method gets the JSON error body.
func (a *API) route(pattern string, h http.HandlerFunc) {
	a.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		if !localHost(r.Host) {
			a.fail(w, http.StatusForbidden, CodeForbiddenHost, "Host must be 127.0.0.1 or localhost")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			a.fail(w, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "the API is read-only: GET only")
			return
		}
		h(w, r)
	})
}

// localHost reports whether a Host header names the loopback interface the daemon listens
// on. Anything else is a request that reached us under another name (DNS rebinding).
func localHost(host string) bool {
	h := host
	if hh, _, err := net.SplitHostPort(host); err == nil {
		h = hh
	} else if strings.Contains(host, ":") {
		return false // a bare IPv6 literal or garbage
	}
	return h == "127.0.0.1" || strings.EqualFold(h, "localhost")
}

// cat returns the catalog, or answers 503 and returns nil.
func (a *API) cat(w http.ResponseWriter) *catalog.Catalog {
	if a.o.Catalog != nil {
		if c := a.o.Catalog(); c != nil {
			return c
		}
	}
	a.fail(w, http.StatusServiceUnavailable, CodeUnavailable, "the catalog is not loaded yet")
	return nil
}

// liveness is the registry and the clock, for the states of sessions.
func (a *API) liveness() catalog.Liveness {
	lv := catalog.Liveness{Now: a.o.Now()}
	if a.o.Registry != nil {
		lv.Registry = a.o.Registry()
	}
	return lv
}

func setCommon(h http.Header) {
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
}

func (a *API) json(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		a.fail(w, http.StatusInternalServerError, CodeInternal, "encoding the response: "+err.Error())
		return
	}
	setCommon(w.Header())
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(buf.Bytes())
}

func (a *API) fail(w http.ResponseWriter, status int, code, msg string) {
	a.failWith(w, status, ErrorInfo{Code: code, Message: msg})
}

func (a *API) failWith(w http.ResponseWriter, status int, e ErrorInfo) {
	setCommon(w.Header())
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(ErrorBody{Error: e})
}

func (a *API) badParam(w http.ResponseWriter, format string, args ...any) {
	a.fail(w, http.StatusBadRequest, CodeInvalidParameter, fmt.Sprintf(format, args...))
}
