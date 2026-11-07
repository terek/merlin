package harness_test

import (
	"strings"
	"testing"

	"github.com/terek/merlin/internal/harness"
	"github.com/terek/merlin/internal/model"
)

func TestCapabilityList(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range harness.Capabilities() {
		if seen[c.ID] || c.ID == "" || c.Meaning == "" {
			t.Errorf("bad or duplicate capability %+v", c)
		}
		seen[c.ID] = true
		if c.Seen != nil && c.Seen(&model.SessionDigest{}) {
			t.Errorf("%s is seen in an empty digest", c.ID)
		}
	}
	if n := len(seen); n < 25 || n > 32 {
		t.Errorf("%d capabilities, want about 25-30", n)
	}
}

func TestCheckSupport(t *testing.T) {
	full := harness.Support{}
	for _, id := range harness.CapabilityIDs() {
		full[id] = harness.P("")
	}
	if p := harness.CheckSupport(full); len(p) != 0 {
		t.Fatalf("full table: %v", p)
	}
	bad := harness.Support{}
	for k, v := range full {
		bad[k] = v
	}
	delete(bad, "cost.fast")
	bad["nope"] = harness.P("")
	bad["tools.calls"] = harness.A("")
	bad["links.prs"] = harness.Claim{State: "maybe", Note: "x"}
	got := strings.Join(harness.CheckSupport(bad), "\n")
	for _, want := range []string{"cost.fast: not declared", "nope: not in the capability list", "tools.calls: absent needs a note", `links.prs: state "maybe"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
}
