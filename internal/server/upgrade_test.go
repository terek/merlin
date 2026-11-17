package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// installer is a recording Options.Install.
type installer struct {
	mu    sync.Mutex
	calls []string
	err   error
}

func (i *installer) install(_ context.Context, v string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.calls = append(i.calls, v)
	return i.err
}

func (i *installer) count() int { i.mu.Lock(); defer i.mu.Unlock(); return len(i.calls) }

// post sends a request to /api/upgrade; origin "auto" is the server's own.
func (r *rig) postUpgrade(method, origin, ctype, body string) (int, ErrorBody, string) {
	r.t.Helper()
	req, err := http.NewRequest(method, r.srv.URL+"/api/upgrade", strings.NewReader(body))
	if err != nil {
		r.t.Fatal(err)
	}
	if origin == "auto" {
		origin = "http://" + req.URL.Host
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var e ErrorBody
	json.Unmarshal(raw, &e)
	return resp.StatusCode, e, string(raw)
}

func TestUpgradeGuards(t *testing.T) {
	in := &installer{}
	r := newRig(t, func(o *Options) { o.Install = in.install })
	const good = `{"version":"1.3.0"}`
	for _, tc := range []struct {
		name                  string
		method, origin, ctype string
		body                  string
		status                int
		code                  string
	}{
		{"no origin", "POST", "", "application/json", good, 403, CodeForbiddenOrigin},
		{"foreign origin", "POST", "http://evil.example", "application/json", good, 403, CodeForbiddenOrigin},
		{"origin with another port", "POST", "http://127.0.0.1:1", "application/json", good, 403, CodeForbiddenOrigin},
		{"form content type", "POST", "auto", "application/x-www-form-urlencoded", good, 415, CodeUnsupportedMedia},
		{"text/plain", "POST", "auto", "text/plain", good, 415, CodeUnsupportedMedia},
		{"no content type", "POST", "auto", "", good, 415, CodeUnsupportedMedia},
		{"GET", "GET", "auto", "application/json", "", 405, CodeMethodNotAllowed},
		{"not json", "POST", "auto", "application/json", "nope", 400, CodeInvalidParameter},
		{"no version", "POST", "auto", "application/json", `{}`, 400, CodeInvalidParameter},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, e, raw := r.postUpgrade(tc.method, tc.origin, tc.ctype, tc.body)
			if status != tc.status || e.Error.Code != tc.code {
				t.Errorf("%d %s, want %d %s", status, raw, tc.status, tc.code)
			}
		})
	}
	if in.count() != 0 {
		t.Errorf("Install called %d times by refused requests", in.count())
	}
}

// A rebound name: a hostile page whose domain now resolves to 127.0.0.1 sends an Origin
// that matches its own Host, so only the Host guard stops it.
func TestUpgradeRefusesReboundHost(t *testing.T) {
	in := &installer{}
	r := newRig(t, func(o *Options) { o.Install = in.install })
	req, err := http.NewRequest("POST", r.srv.URL+"/api/upgrade", strings.NewReader(`{"version":"1.3.0"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "evil.example"
	req.Header.Set("Origin", "http://evil.example")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden || in.count() != 0 {
		t.Errorf("status %d, Install called %d times; want 403 and none", resp.StatusCode, in.count())
	}
}

func TestUpgradeInstalls(t *testing.T) {
	in := &installer{}
	r := newRig(t, func(o *Options) { o.Install = in.install })
	status, _, raw := r.postUpgrade("POST", "auto", "application/json; charset=utf-8", `{"version":"1.3.0"}`)
	var got UpgradeResponse
	if json.Unmarshal([]byte(raw), &got) != nil || status != 200 || got != (UpgradeResponse{Version: "1.3.0", Restarting: true}) {
		t.Errorf("%d %s", status, raw)
	}
	if len(in.calls) != 1 || in.calls[0] != "1.3.0" {
		t.Errorf("calls = %v", in.calls)
	}
}

func TestUpgradeErrors(t *testing.T) {
	in := &installer{err: Conflict("nothing to install")}
	r := newRig(t, func(o *Options) { o.Install = in.install })
	status, e, _ := r.postUpgrade("POST", "auto", "application/json", `{"version":"1.3.0"}`)
	if status != 409 || e.Error.Code != CodeConflict || e.Error.Message != "nothing to install" {
		t.Errorf("conflict: %d %+v", status, e)
	}
	in.err = errors.New("disk full")
	status, e, _ = r.postUpgrade("POST", "auto", "application/json", `{"version":"1.3.0"}`)
	if status != 500 || e.Error.Code != CodeInternal || e.Error.Message != "disk full" {
		t.Errorf("failure: %d %+v", status, e)
	}
}

func TestUpgradeAbsentWithoutInstall(t *testing.T) {
	r := newRig(t)
	// Without Install the route is not there: it answers as any unknown path does.
	status, e, _ := r.postUpgrade("POST", "auto", "application/json", `{"version":"1.3.0"}`)
	req, _ := http.NewRequest("POST", r.srv.URL+"/api/nonesuch", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if status != resp.StatusCode || e.Error.Code == CodeConflict || e.Error.Code == CodeInternal {
		t.Errorf("/api/upgrade %d %+v, unknown path %d", status, e, resp.StatusCode)
	}
}

func TestReadRoutesRefusePost(t *testing.T) {
	r := newRig(t, func(o *Options) { o.Install = (&installer{}).install })
	req, _ := http.NewRequest("POST", r.srv.URL+"/api/sessions", strings.NewReader("{}"))
	req.Header.Set("Origin", "http://"+req.URL.Host)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 405 || resp.Header.Get("Allow") != "GET, HEAD" {
		t.Errorf("%d Allow %q", resp.StatusCode, resp.Header.Get("Allow"))
	}
}
