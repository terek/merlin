package server

import (
	"testing"

	"github.com/terek/merlin/internal/harness"
	"github.com/terek/merlin/internal/model"
)

func TestHarnesses(t *testing.T) {
	r := newRig(t, func(o *Options) {
		o.Harnesses = []harness.Info{{Name: "claude", Title: "Claude Code", Resume: "claude --resume {id}"}}
	})
	r.cat.Upsert(&model.SessionDigest{Harness: "pi", ID: "pi-1"})
	var hl HarnessList
	if code := r.get("/api/harnesses", &hl); code != 200 {
		t.Fatalf("status %d", code)
	}
	byName := map[string]harness.Info{}
	for _, h := range hl.Harnesses {
		byName[h.Name] = h
	}
	if c := byName["claude"]; c.Title != "Claude Code" || c.Resume != "claude --resume {id}" || c.Badge != "" {
		t.Errorf("claude = %+v", c)
	}
	// a harness this list does not describe is named by its own name, with no resume
	// command and nothing taken from Claude
	if c, ok := byName["pi"]; !ok || c.Title != "pi" || c.Badge != "pi" || c.Resume != "" {
		t.Errorf("unlisted pi = %+v (present %v)", c, ok)
	}
}
