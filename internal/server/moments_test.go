package server

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/terek/merlin/internal/moments"
)

func TestMoments(t *testing.T) {
	r := newRig(t)
	var rep moments.Report
	if code := r.get("/api/moments", &rep); code != 200 {
		t.Fatal(code)
	}
	if rep.Sessions == 0 || len(rep.Personas) != 3 || len(rep.Moments) != len(moments.Registry()) {
		t.Fatalf("report: %d sessions, %d personas, %d moments", rep.Sessions, len(rep.Personas), len(rep.Moments))
	}
	if !rep.Now.Equal(testNow) || rep.WindowDays != moments.WindowDays {
		t.Errorf("now %v window %d", rep.Now, rep.WindowDays)
	}
	seen := 0
	for _, m := range rep.Moments {
		if m.Status != moments.StatusUnseen {
			seen++
		}
	}
	if seen == 0 {
		t.Error("the fixtures show no moment at all")
	}
}

// Concurrent requests for one catalog state share one report; an abandoned request returns at
// once; a write makes the next report fresh.
func TestMomentsReportShared(t *testing.T) {
	r := newRig(t)
	a := r.api
	first, err := a.report(context.Background(), r.cat)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := a.report(context.Background(), r.cat)
	if again.Sessions != first.Sessions || a.momentsCache.call == nil {
		t.Fatal("no report cached")
	}
	call := a.momentsCache.call
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); a.report(context.Background(), r.cat) }()
	}
	wg.Wait()
	if a.momentsCache.call != call {
		t.Fatal("concurrent requests recomputed the report")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.report(ctx, r.cat); err == nil {
		t.Fatal("a cancelled request got a report")
	}
}

func TestMomentsEngage(t *testing.T) {
	home := t.TempDir()
	r := newRig(t, func(o *Options) { o.MomentsHome = home })
	post := func(origin, body string) int {
		req, err := http.NewRequest("POST", r.srv.URL+"/api/moments/engage", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if origin == "auto" {
			origin = "http://" + req.URL.Host
		}
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	for _, c := range []struct {
		origin, body string
		want         int
	}{
		{"http://evil.example", `{"moment":"clean-slate","action":"open"}`, 403},
		{"auto", `{"moment":"nope","action":"open"}`, 400},
		{"auto", `{"moment":"clean-slate","action":"bogus"}`, 400},
		{"auto", `not json`, 400},
		{"auto", `{"moment":"clean-slate","action":"open"}`, 200},
		{"auto", `{"moment":"clean-slate","action":"copy"}`, 200},
	} {
		if got := post(c.origin, c.body); got != c.want {
			t.Errorf("%s: %d, want %d", c.body, got, c.want)
		}
	}
	got := moments.LoadEngaged(home)
	if len(got) != 1 || got[0].Moment != "clean-slate" || !got[0].OpenedAt.Equal(testNow) || !got[0].CopiedAt.Equal(testNow) {
		t.Errorf("recorded: %+v", got)
	}
	// without a home the route is absent
	r2 := newRig(t)
	resp, err := http.Post(r2.srv.URL+"/api/moments/engage", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 && resp.StatusCode != 405 {
		t.Errorf("no home: %d", resp.StatusCode)
	}
}

// A copy changes the report, so the cached one is not served: the clock shows at once.
func TestMomentsReportSeesEngagement(t *testing.T) {
	home := t.TempDir()
	r := newRig(t, func(o *Options) { o.MomentsHome = home })
	before, err := r.api.report(context.Background(), r.cat)
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Suggestions) == 0 {
		t.Fatal("the fixtures suggest nothing")
	}
	id := before.Suggestions[0].Moment
	if err := moments.RecordEngagement(home, id, moments.ActionOpen, testNow); err != nil {
		t.Fatal(err)
	}
	after, err := r.api.report(context.Background(), r.cat)
	if err != nil {
		t.Fatal(err)
	}
	engaged := func(rep moments.Report) bool {
		for _, s := range rep.Suggestions {
			if s.Moment == id && s.Engaged != nil {
				return true
			}
		}
		return false
	}
	if engaged(before) || !engaged(after) {
		t.Errorf("engaged before %v, after %v", engaged(before), engaged(after))
	}
}
