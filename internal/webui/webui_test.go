package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html><title>Explorer</title>")},
		"assets/index-abc.js":  {Data: []byte("console.log(1)")},
		"assets/index-abc.css": {Data: []byte("body{}")},
		"theme-init.js":        {Data: []byte("//theme")},
	}
}

func do(t *testing.T, h http.Handler, method, target, host string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestMethods(t *testing.T) {
	h := New(testFS())
	for _, m := range []string{http.MethodGet, http.MethodHead} {
		if rec := do(t, h, m, "/", "127.0.0.1:7433"); rec.Code != http.StatusOK {
			t.Errorf("%s /: status %d, want 200", m, rec.Code)
		}
	}
	if rec := do(t, h, http.MethodHead, "/", "127.0.0.1:7433"); rec.Body.Len() != 0 {
		t.Errorf("HEAD / sent a body of %d bytes", rec.Body.Len())
	}
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		rec := do(t, h, m, "/", "127.0.0.1:7433")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s /: status %d, want 405", m, rec.Code)
		}
		if got := rec.Header().Get("Allow"); got != "GET, HEAD" {
			t.Errorf("%s /: Allow = %q", m, got)
		}
	}
}

func TestHostGuard(t *testing.T) {
	h := New(testFS())
	for _, host := range []string{"127.0.0.1", "127.0.0.1:7433", "localhost", "localhost:5181", "LOCALHOST:80"} {
		if rec := do(t, h, "GET", "/", host); rec.Code != http.StatusOK {
			t.Errorf("Host %q: status %d, want 200", host, rec.Code)
		}
	}
	for _, host := range []string{"evil.example", "evil.example:7433", "127.0.0.1.evil.example", "::1", "[::1]:7433", "0.0.0.0:7433", ""} {
		rec := do(t, h, "GET", "/", host)
		if rec.Code != http.StatusForbidden {
			t.Errorf("Host %q: status %d, want 403", host, rec.Code)
		}
		if rec.Header().Get("Content-Security-Policy") == "" {
			t.Errorf("Host %q: the refusal carries no CSP", host)
		}
	}
}

func TestFilesAndFallback(t *testing.T) {
	h := New(testFS())
	const host = "127.0.0.1:7433"

	// A file is served as itself.
	rec := do(t, h, "GET", "/assets/index-abc.js", host)
	if rec.Code != 200 || rec.Body.String() != "console.log(1)" {
		t.Errorf("asset: %d %q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Errorf("asset content type = %q", ct)
	}
	if rec := do(t, h, "GET", "/theme-init.js", host); rec.Code != 200 || rec.Body.String() != "//theme" {
		t.Errorf("theme-init.js: %d %q", rec.Code, rec.Body.String())
	}

	// A path without an extension is the app (a reload on /s/claude/x).
	for _, p := range []string{"/", "/cost", "/s/claude/16161616", "/s/claude/x/", "/dev/ui", "/assets", "/s/claude/../cost"} {
		rec := do(t, h, "GET", p, host)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<title>Explorer</title>") {
			t.Errorf("%s: %d %q, want index.html", p, rec.Code, rec.Body.String())
		}
	}
	if rec := do(t, h, "GET", "/index.html", host); rec.Code != 200 {
		t.Errorf("/index.html: %d", rec.Code)
	}

	// A missing file with an extension is 404, not the app.
	for _, p := range []string{"/assets/missing.js", "/favicon.ico", "/robots.txt", "/s/claude/x.json"} {
		if rec := do(t, h, "GET", p, host); rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, rec.Code)
		}
	}
}

func TestNeverAnswersForTheDaemonsPaths(t *testing.T) {
	h := New(testFS())
	for _, p := range []string{
		"/api", "/api/", "/api/sessions", "/api/sessoins", "/api/sessions/claude/x", "/api/x/../sessions",
		"/hook", "/hook/", "/hook/x", "/healthz", "/healthz/", "/healthz/x",
		"//api/sessions", "/./api/sessions", "/s/../api/sessions",
	} {
		rec := do(t, h, "GET", p, "127.0.0.1:7433")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "<title>") {
			t.Errorf("%s: answered with the app", p)
		}
	}
	// A path that merely starts with the same letters is the app.
	if rec := do(t, h, "GET", "/apiary", "127.0.0.1:7433"); rec.Code != 200 {
		t.Errorf("/apiary: %d, want 200", rec.Code)
	}
}

func TestCacheHeaders(t *testing.T) {
	h := New(testFS())
	const host = "127.0.0.1:7433"
	want := map[string]string{
		"/assets/index-abc.js":  "public, max-age=31536000, immutable",
		"/assets/index-abc.css": "public, max-age=31536000, immutable",
		"/":                     "no-cache",
		"/index.html":           "no-cache",
		"/cost":                 "no-cache",
		"/s/claude/x":           "no-cache",
		"/theme-init.js":        "no-cache",
	}
	for p, cc := range want {
		if got := do(t, h, "GET", p, host).Header().Get("Cache-Control"); got != cc {
			t.Errorf("%s: Cache-Control = %q, want %q", p, got, cc)
		}
	}
}

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	h := New(testFS())
	for _, tc := range []struct{ method, path, host string }{
		{"GET", "/", "127.0.0.1"},
		{"GET", "/assets/index-abc.js", "127.0.0.1"},
		{"GET", "/cost", "localhost"},
		{"GET", "/missing.js", "127.0.0.1"},
		{"GET", "/api/sessions", "127.0.0.1"},
		{"POST", "/", "127.0.0.1"},
		{"GET", "/", "evil.example"},
		{"HEAD", "/", "127.0.0.1"},
	} {
		rec := do(t, h, tc.method, tc.path, tc.host)
		if got := rec.Header().Get("Content-Security-Policy"); got != CSP {
			t.Errorf("%s %s (%s): CSP = %q", tc.method, tc.path, tc.host, got)
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s %s: X-Content-Type-Options = %q", tc.method, tc.path, got)
		}
		if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
			t.Errorf("%s %s: Referrer-Policy = %q", tc.method, tc.path, got)
		}
	}
}

func TestCSPText(t *testing.T) {
	// The policy of docs/ui.md section 1, verbatim.
	const want = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
		"connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	if CSP != want {
		t.Errorf("CSP = %q", CSP)
	}
}

func TestNotBuilt(t *testing.T) {
	// Without the embedui tag (and so in these tests) Handler explains how to build the UI.
	if Built() {
		t.Skip("built with embedui")
	}
	rec := do(t, Handler(), "GET", "/cost", "127.0.0.1:7433")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, "make build") || !strings.Contains(body, "not built") {
		t.Errorf("body does not say how to build the UI: %q", body)
	}
	if rec.Header().Get("Content-Security-Policy") != CSP {
		t.Error("the placeholder page carries no CSP")
	}
	if rec := do(t, Handler(), "GET", "/assets/x.js", "127.0.0.1"); rec.Code != http.StatusNotFound {
		t.Errorf("asset without a UI: %d, want 404", rec.Code)
	}
}

func TestEmptyIndexIsNotBuilt(t *testing.T) {
	rec := do(t, New(fstest.MapFS{}), "GET", "/", "127.0.0.1")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503", rec.Code)
	}
}
