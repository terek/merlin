package webui

import (
	"bytes"
	"io"
	"io/fs"
	"net"
	"net/http"
	"path"
	"strings"
	"time"
)

// CSP is the Content-Security-Policy of every response (docs/ui.md section 1): nothing is
// loaded from the network, and session texts, which are untrusted, cannot run script.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
	"connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const (
	cacheImmutable = "public, max-age=31536000, immutable"
	cacheNone      = "no-cache"
)

// reserved are the paths mounted elsewhere on the daemon. The SPA fallback must never answer
// for them: a mistyped /api/sessoins is a 404, not index.html.
var reserved = []string{"/api", "/hook", "/healthz"}

// New returns the handler for a built UI: fsys holds index.html and assets/ at its root.
//
//   - GET and HEAD only, and only for a Host of 127.0.0.1 or localhost (the API's guard);
//   - a path that names a file serves it; any other path without a file extension serves
//     index.html (the SPA fallback, for /s/claude/x on a reload); a missing file with an
//     extension is 404;
//   - /assets/* is immutable (the build hashes the names), everything else must be revalidated;
//   - it never answers under /api, /hook or /healthz.
func New(fsys fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w.Header())
		if !localHost(r.Host) {
			plain(w, http.StatusForbidden, "forbidden host: use 127.0.0.1 or localhost\n")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			plain(w, http.StatusMethodNotAllowed, "method not allowed\n")
			return
		}
		p := path.Clean("/" + r.URL.Path)
		for _, res := range reserved {
			if p == res || strings.HasPrefix(p, res+"/") {
				plain(w, http.StatusNotFound, "not found\n")
				return
			}
		}
		name := strings.TrimPrefix(p, "/")
		if name == "" {
			name = "index.html"
		}
		if info, err := fs.Stat(fsys, name); err == nil && !info.IsDir() {
			serveFile(w, r, fsys, name)
			return
		}
		if path.Ext(name) != "" && name != "index.html" {
			plain(w, http.StatusNotFound, "not found\n")
			return
		}
		serveFile(w, r, fsys, "index.html")
	})
}

func serveFile(w http.ResponseWriter, r *http.Request, fsys fs.FS, name string) {
	f, err := fsys.Open(name)
	if err != nil {
		if name == "index.html" {
			notBuilt(w)
			return
		}
		plain(w, http.StatusNotFound, "not found\n")
		return
	}
	defer f.Close()
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		b, err := io.ReadAll(f)
		if err != nil {
			plain(w, http.StatusInternalServerError, "cannot read the file\n")
			return
		}
		rs = bytes.NewReader(b)
	}
	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", cacheImmutable)
	} else {
		w.Header().Set("Cache-Control", cacheNone)
	}
	// A zero modtime sends no Last-Modified: the embedded files have none, and the hashed
	// names make validators unnecessary where caching matters.
	http.ServeContent(w, r, name, time.Time{}, rs)
}

func setSecurityHeaders(h http.Header) {
	h.Set("Content-Security-Policy", CSP)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
}

func plain(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", cacheNone)
	w.WriteHeader(status)
	_, _ = io.WriteString(w, msg)
}

const notBuiltPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Explorer</title></head>
<body><h1>Explorer</h1>
<p>The web UI is not built into this binary. Run <code>make build</code> in <code>explorer/</code> (it needs bun), or <code>bun run dev</code> in <code>explorer/web</code> for the development server.</p>
<p>The JSON API is at <code>/api/</code>.</p></body></html>
`

func notBuilt(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", cacheNone)
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = io.WriteString(w, notBuiltPage)
}

// localHost reports whether a Host header names the loopback interface the daemon listens on;
// the same rule as the API's guard (DNS-rebinding protection).
func localHost(host string) bool {
	h := host
	if hh, _, err := net.SplitHostPort(host); err == nil {
		h = hh
	} else if strings.Contains(host, ":") {
		return false
	}
	return h == "127.0.0.1" || strings.EqualFold(h, "localhost")
}

// Handler returns the UI embedded in this binary, or, when it was built without the embedui
// tag, a handler that explains how to build it.
func Handler() http.Handler {
	if embedded == nil {
		return New(emptyFS{})
	}
	return New(embedded)
}

// Built reports whether a UI is embedded in this binary.
func Built() bool { return embedded != nil }

// emptyFS is a filesystem with no files: every request ends in the "not built" page (index.html
// is missing) or a 404.
type emptyFS struct{}

func (emptyFS) Open(string) (fs.File, error) { return nil, fs.ErrNotExist }
