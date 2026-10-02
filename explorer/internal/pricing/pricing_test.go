package pricing

import (
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/terek/merlin/explorer/internal/model"
)

func near(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 0.001 {
		t.Fatalf("got %.6f, want %.3f", got, want)
	}
}

func TestWorkedExamples(t *testing.T) {
	tab := Default()
	cases := []struct {
		model string
		tok   model.Tokens
		want  float64
	}{
		{"claude-fable-5-1", model.Tokens{Input: 292, Output: 3398, CacheRead: 441635, CacheWrite1h: 34207}, 0.967},
		// claude-fable-5: one reported window (cost-state totals, 1h cache writes only), $34.3737.
		{"claude-fable-5", model.Tokens{Input: 3232, Output: 88339, CacheRead: 20310869, CacheWrite1h: 480680}, 34.3737},
		{"claude-fable-5", model.Tokens{Input: 1273, Output: 18540, CacheRead: 2385996, CacheWrite1h: 213707}, 7.5999},
		{"claude-opus-5-5", model.Tokens{Input: 3435, Output: 51732, CacheRead: 7532250, CacheWrite1h: 260548}, 4.639},
		{"claude-opus-5", model.Tokens{Input: 2952, Output: 46829, CacheRead: 9279592, CacheWrite1h: 148265}, 7.308},
		{"claude-sonnet-5", model.Tokens{Input: 13124, Output: 54958, CacheRead: 8060953, CacheWrite5m: 252587}, 2.819},
	}
	for _, c := range cases {
		mc, ok := tab.Cost(c.model, c.tok, false)
		if !ok {
			t.Fatalf("%s unpriced", c.model)
		}
		if mc.Tokens != c.tok {
			t.Errorf("%s: tokens changed", c.model)
		}
		t.Logf("%s = %.6f", c.model, mc.USD)
		near(t, mc.USD, c.want)
	}
}

func TestNormalisation(t *testing.T) {
	tab := Default()
	tok := model.Tokens{Input: 1_000_000}
	for _, n := range []string{
		"claude-opus-5-5", "claude-opus-5-5[1m]", "claude-opus-5-5-20260101", "claude-opus-5-5-20260101[1m]",
	} {
		mc, ok := tab.Cost(n, tok, false)
		if !ok || mc.USD != 4 {
			t.Errorf("%s: %v %v", n, mc.USD, ok)
		}
	}
	// dated table entry, either form
	for _, n := range []string{"claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-haiku-4-5-20251001[1m]"} {
		if mc, ok := tab.Cost(n, tok, false); !ok || mc.USD != 1 {
			t.Errorf("%s: %v %v", n, mc.USD, ok)
		}
	}
	// exact match wins over stripping: opus-5 vs opus-5-5 must not be confused
	if mc, _ := tab.Cost("claude-opus-5", tok, false); mc.USD != 5 {
		t.Errorf("opus-5 = %v", mc.USD)
	}
}

func TestCacheWriteMultipliers(t *testing.T) {
	mc, _ := Default().Cost("claude-sonnet-5", model.Tokens{CacheWrite5m: 1e6, CacheWrite1h: 1e6}, false)
	if mc.USD != 2*1.25+2*2 {
		t.Fatalf("got %v", mc.USD)
	}
}

func TestFastMode(t *testing.T) {
	tab := Default()
	tok := model.Tokens{Input: 1e6, Output: 1e6}
	if mc, _ := tab.Cost("claude-opus-5", tok, true); mc.USD != 60 {
		t.Errorf("fast opus-5 = %v", mc.USD)
	}
	if mc, _ := tab.Cost("claude-opus-5", tok, false); mc.USD != 30 {
		t.Errorf("standard opus-5 = %v", mc.USD)
	}
	if mc, _ := tab.Cost("claude-sonnet-5", tok, true); mc.USD != 12 {
		t.Errorf("fast on unlisted model must be ignored, got %v", mc.USD)
	}
}

func TestSyntheticAndUnknown(t *testing.T) {
	tab := Default()
	mc, ok := tab.Cost("<synthetic>", model.Tokens{Input: 5, Output: 5}, false)
	if !ok || mc.USD != 0 || mc.Input != 5 {
		t.Errorf("synthetic: %+v %v", mc, ok)
	}
	if _, ok := tab.Cost("gpt-9", model.Tokens{Input: 1}, false); ok {
		t.Error("unknown model reported priced")
	}
	if _, ok := tab.Cost("", model.Tokens{Input: 1}, false); ok {
		t.Error("empty model reported priced")
	}
	var zero Table
	if _, ok := zero.Cost("claude-opus-5", model.Tokens{}, false); ok {
		t.Error("zero table priced a model")
	}
}

func TestOverrides(t *testing.T) {
	dir := t.TempDir()
	tok := model.Tokens{Input: 1e6, Output: 1e6, CacheRead: 1e6}

	// missing file and empty path: no overrides
	for _, p := range []string{"", filepath.Join(dir, "nope.json")} {
		tab, err := Load(p)
		if err != nil {
			t.Fatal(err)
		}
		if mc, _ := tab.Cost("claude-opus-5", tok, false); mc.USD != 5+25+0.5 {
			t.Errorf("path %q: %v", p, mc.USD)
		}
	}

	path := filepath.Join(dir, "config.json")
	cfg := `{"other": 1, "prices": {
	  "claude-opus-5": {"input": 1, "output": 2, "cacheRead": 3},
	  "my-model[1m]": {"input": 10, "output": 20, "cacheRead": 30, "fast": true},
	  "claude-sonnet-5": {"input": 2, "output": 10, "cacheRead": 0.2, "fast": true}
	}}`
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	tab, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if mc, _ := tab.Cost("claude-opus-5", tok, false); mc.USD != 6 {
		t.Errorf("replaced: %v", mc.USD)
	}
	if mc, ok := tab.Cost("my-model", tok, false); !ok || mc.USD != 60 {
		t.Errorf("added: %v %v", mc.USD, ok)
	}
	if mc, _ := tab.Cost("my-model-20260101", tok, true); mc.USD != 120 {
		t.Errorf("added fast: %v", mc.USD)
	}
	if mc, _ := tab.Cost("claude-sonnet-5", tok, true); mc.USD != 2*(2+10+0.2) {
		t.Errorf("override enabling fast: %v", mc.USD)
	}
	// untouched models and a fresh Default are unaffected
	if mc, _ := tab.Cost("claude-opus-4-6", tok, false); mc.USD != 30.5 {
		t.Errorf("untouched: %v", mc.USD)
	}
	if mc, _ := Default().Cost("claude-opus-5", tok, false); mc.USD != 30.5 {
		t.Errorf("Default mutated: %v", mc.USD)
	}

	bad := filepath.Join(dir, "bad.json")
	os.WriteFile(bad, []byte("{"), 0o600)
	if _, err := Load(bad); err == nil {
		t.Error("malformed override file accepted")
	}
}

func TestFable5Verified(t *testing.T) {
	p := Default().models["claude-fable-5"]
	if p.Status != "verified" || p.CacheRead != 1.0 {
		t.Errorf("claude-fable-5: status %q, cache read %v", p.Status, p.CacheRead)
	}
}

func TestEmbeddedTableStatus(t *testing.T) {
	for n, p := range Default().models {
		if p.Status != "verified" && p.Status != "assumed" {
			t.Errorf("%s: status %q", n, p.Status)
		}
		if p.Input <= 0 || p.Output <= 0 || p.CacheRead <= 0 {
			t.Errorf("%s: incomplete price", n)
		}
	}
}
