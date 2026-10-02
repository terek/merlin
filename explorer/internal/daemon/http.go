package daemon

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"time"
)

const maxHookBody = 1 << 20

// handleHook accepts a hook notification and answers at once: the work happens later, on
// the live loop. Anything it cannot use is accepted and ignored; a hook must never make
// Claude Code wait or fail.
func (d *Daemon) handleHook(w http.ResponseWriter, r *http.Request) {
	if !isLoopback(r.RemoteAddr) {
		http.Error(w, "loopback only", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, maxHookBody))
	d.hooksSeen.Add(1)
	select {
	case d.hookCh <- body:
	default:
		d.hooksDropped.Add(1) // a rescan catches up
	}
	w.WriteHeader(http.StatusAccepted)
}

func isLoopback(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Health is the body of GET /healthz.
type Health struct {
	OK           bool   `json:"ok"`
	Version      string `json:"version"`
	Uptime       string `json:"uptime"`
	Sessions     int    `json:"sessions"`   // digests in the catalog
	Live         int    `json:"live"`       // sessions being followed
	QueueDepth   int    `json:"queueDepth"` // sessions queued or being built
	Rescans      int64  `json:"rescans"`    // completed full reconciles
	LastRescan   string `json:"lastRescan,omitempty"`
	HooksSeen    int64  `json:"hooksSeen"`    // POSTs to /hook
	HooksDropped int64  `json:"hooksDropped"` // of those, dropped because the live loop was behind
	Subscribers  int    `json:"subscribers"`  // event bus subscribers
}

// Health returns the current counts.
func (d *Daemon) Health() Health {
	h := Health{
		OK:           true,
		Version:      d.opts.Version,
		Uptime:       time.Since(d.start).Round(time.Second).String(),
		Live:         int(d.liveCount.Load()),
		Rescans:      d.rescans.Load(),
		HooksSeen:    d.hooksSeen.Load(),
		HooksDropped: d.hooksDropped.Load(),
		Subscribers:  d.bus.Subscribers(),
	}
	if c := d.cat.Load(); c != nil {
		h.Sessions = c.Len()
	}
	if e := d.eng.Load(); e != nil {
		h.QueueDepth = e.Pending()
	}
	if ns := d.lastRescan.Load(); ns != 0 {
		h.LastRescan = time.Unix(0, ns).UTC().Format(time.RFC3339)
	}
	return h
}

func (d *Daemon) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(d.Health())
}
