package server

import (
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
