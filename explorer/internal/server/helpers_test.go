package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/daemon"
	"github.com/terek/merlin/explorer/internal/fixtures"
	"github.com/terek/merlin/explorer/internal/model"
)

var (
	testZone = time.FixedZone("UTC+2", 2*3600)
	// testNow is after every fixture, so no session is "recent".
	testNow = time.Date(2027, 1, 1, 12, 0, 0, 0, time.UTC)
)

func goldens(t testing.TB) []*model.SessionDigest {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(fixtures.Root(), "golden", "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no golden digests: %v", err)
	}
	sort.Strings(files)
	var out []*model.SessionDigest
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var d model.SessionDigest
		if err := json.Unmarshal(b, &d); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		out = append(out, &d)
	}
	return out
}

func fixtureCatalog(t testing.TB) *catalog.Catalog {
	t.Helper()
	c := catalog.New()
	c.SetLocation(testZone)
	for _, d := range goldens(t) {
		c.Upsert(d)
	}
	return c
}

// rig is an API over the fixture catalog with an injected clock, registry and bus.
type rig struct {
	t        *testing.T
	cat      *catalog.Catalog
	bus      *daemon.Bus
	registry catalog.Registry
	progress ScanProgress
	api      *API
	srv      *httptest.Server
}

func newRig(t *testing.T, tweak ...func(*Options)) *rig {
	t.Helper()
	r := &rig{t: t, cat: fixtureCatalog(t), bus: &daemon.Bus{}}
	o := Options{
		Catalog:          func() *catalog.Catalog { return r.cat },
		Subscribe:        r.bus.Subscribe,
		Registry:         func() catalog.Registry { return r.registry },
		Progress:         func() ScanProgress { progressMu.Lock(); defer progressMu.Unlock(); return r.progress },
		Now:              func() time.Time { return testNow },
		Location:         testZone,
		Heartbeat:        time.Hour,
		Coalesce:         10 * time.Millisecond,
		ProgressInterval: time.Hour,
	}
	for _, f := range tweak {
		f(&o)
	}
	r.api = New(o)
	r.srv = httptest.NewServer(r.api.Handler())
	t.Cleanup(r.srv.Close)
	return r
}

// get fetches path and decodes a JSON body into v (nil: ignore it).
func (r *rig) get(path string, v any) int {
	r.t.Helper()
	resp, err := http.Get(r.srv.URL + path)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		r.t.Errorf("GET %s: Content-Type %q", path, ct)
	}
	if v != nil {
		reflect.ValueOf(v).Elem().SetZero() // decoding into a used value would merge
		if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
			r.t.Fatalf("GET %s: decoding: %v", path, err)
		}
	}
	return resp.StatusCode
}

func (r *rig) wantError(path string, status int, code string) ErrorBody {
	r.t.Helper()
	var e ErrorBody
	if got := r.get(path, &e); got != status {
		r.t.Errorf("GET %s = %d, want %d (%+v)", path, got, status, e)
	}
	if e.Error.Code != code || e.Error.Message == "" {
		r.t.Errorf("GET %s: error %+v, want code %q and a message", path, e.Error, code)
	}
	return e
}

func sid(scenario, variant string) model.SessionKey {
	return model.SessionKey{Harness: "claude", ID: scenario + scenario + scenario + scenario + "-0000-4000-8000-0000000000" + variant}
}

func canceled() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

var progressMu sync.Mutex
