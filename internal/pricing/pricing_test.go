package pricing

import (
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/terek/merlin/internal/model"
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

func TestCodexModels(t *testing.T) {
	tab := Default()
	// gpt-6.1-sol: $2 input, $0.10 cached, $10 output per million.
	mc, ok := tab.Cost("gpt-6.1-sol", model.Tokens{Input: 1000, CacheRead: 150000, Output: 4000}, false)
	if !ok {
		t.Fatal("gpt-6.1-sol unpriced")
	}
	near(t, mc.USD*1e6, 1000*2+150000*0.1+4000*10)
	// Fast mode (priority tier) doubles every rate.
	fast, _ := tab.Cost("gpt-6.1-sol", model.Tokens{Input: 1000, CacheRead: 150000, Output: 4000}, true)
	near(t, fast.USD, 2*mc.USD)
	// Above 272K input tokens the whole request is billed at the long-context price.
	long, _ := tab.Cost("gpt-6-sol", model.Tokens{Input: 2001, CacheRead: 270000, Output: 100}, false)
	near(t, long.USD*1e6, 2001*4+270000*0.4+100*15)
	short, _ := tab.Cost("gpt-6-sol", model.Tokens{Input: 2000, CacheRead: 270000, Output: 100}, false)
	near(t, short.USD*1e6, 2000*2+270000*0.2+100*10)
	if _, ok := tab.Cost("gpt-6-luna", model.Tokens{Input: 1}, false); !ok {
		t.Error("gpt-6-luna unpriced")
	}
	// The approval reviewer is priced as gpt-6-luna.
	tok := model.Tokens{Input: 3000, CacheRead: 40000, Output: 800}
	luna, _ := tab.Cost("gpt-6-luna", tok, false)
	if rev, ok := tab.Cost("codex-auto-review", tok, false); !ok || rev.USD != luna.USD {
		t.Errorf("codex-auto-review: %v %v, want %v", ok, rev.USD, luna.USD)
	}
}

func TestFable5Verified(t *testing.T) {
	p := Default().models["claude-fable-5"]
	if p.Status != "verified" || p.CacheRead != 1.0 {
		t.Errorf("claude-fable-5: status %q, cache read %v", p.Status, p.CacheRead)
	}
}

// A real Claude Code 2.1.302 window: 18,270 in, 316,518 out, 35,169,671 cache read and
// 1,502,975 5m cache write on Sonnet 5.5, reported as $10.4761246.
func TestSonnet55CacheRead(t *testing.T) {
	tok := model.Tokens{Input: 18270, Output: 316518, CacheRead: 35169671, CacheWrite5m: 1502975}
	mc, _ := Default().Cost("claude-sonnet-5-5", tok, false)
	if math.Abs(mc.USD-10.4761246) > 1e-6 {
		t.Errorf("claude-sonnet-5-5: $%.7f, want $10.4761246", mc.USD)
	}
}

// Haiku 5.5 has two rate cards: a prompt over 100,000 tokens, counting cache reads and
// writes, is billed at the higher one in full.
func TestHaiku55PromptLength(t *testing.T) {
	tab := Default()
	short, _ := tab.Cost("claude-haiku-5-5", model.Tokens{Input: 2000, CacheRead: 90000, CacheWrite5m: 8000, Output: 500}, false)
	near(t, short.USD*1e6, 2000*0.1+90000*0.01+8000*0.125+500*0.5)
	long, _ := tab.Cost("claude-haiku-5-5", model.Tokens{Input: 2000, CacheRead: 90000, CacheWrite1h: 8001, Output: 500}, false)
	near(t, long.USD*1e6, 2000*0.5+90000*0.05+8001*1.0+500*2.5)
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

func TestAliasLookup(t *testing.T) {
	tab := Default()
	for _, c := range []struct{ in, want string }{
		{"claude-opus-4.5", "claude-opus-4-5"},
		{"claude-opus-4.5[1m]", "claude-opus-4-5"},
		{"claude-opus-4.6", "claude-opus-4-6"},
		{"claude-opus-4-5-20251101", "claude-opus-4-5"},
		{"claude-sonnet-4-20250514", "claude-sonnet-4"},
	} {
		got, p, ok := tab.Lookup(c.in)
		if !ok || got != c.want || p.Input != 5 && c.want != "claude-sonnet-4" {
			t.Errorf("Lookup(%q) = %q %v %v, want %q", c.in, got, p.Input, ok, c.want)
		}
	}
	a, _ := tab.Cost("claude-opus-4.5", model.Tokens{Input: 1_000_000}, false)
	b, _ := tab.Cost("claude-opus-4-5", model.Tokens{Input: 1_000_000}, false)
	if a.USD != b.USD || a.USD != 5 {
		t.Errorf("alias cost %v, exact %v", a.USD, b.USD)
	}
}

func TestAliasExactWins(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	// an override adds a model named like the built-in alias: the exact name wins over it
	cfg := `{"prices": {"claude-opus-4.5": {"input": 1, "output": 2, "cacheRead": 0.1}}}`
	if err := os.WriteFile(path, []byte(cfg), 0o644); err == nil {
		_, err = Load(path)
		if err == nil {
			t.Fatal("a model named like another model's alias should be an error at load")
		}
	}
	// the alias keeps working when an override replaces its target without naming aliases
	cfg = `{"prices": {"claude-opus-4-5": {"input": 1, "output": 2, "cacheRead": 0.1}}}`
	if err := os.WriteFile(path, []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	tab, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if n, p, ok := tab.Lookup("claude-opus-4.5"); !ok || n != "claude-opus-4-5" || p.Input != 1 {
		t.Errorf("alias after override: %q %v %v", n, p.Input, ok)
	}
}

func TestAliasExactNameBeatsDateAlias(t *testing.T) {
	tab, err := parse([]byte(`{"cacheWrite5mMultiplier":1.25,"cacheWrite1hMultiplier":2,"fastMultiplier":2,
		"models":{"m-1":{"input":1,"output":1,"cacheRead":1,"aliases":["m.1"]},"m.1-20250101":{"input":2,"output":2,"cacheRead":2}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if n, _, _ := tab.Lookup("m.1"); n != "m-1" {
		t.Errorf("declared alias should come before a date-stripped name, got %q", n)
	}
	if n, _, _ := tab.Lookup("m-1"); n != "m-1" {
		t.Errorf("exact name: %q", n)
	}
}

func TestAliasCollisions(t *testing.T) {
	const head = `{"cacheWrite5mMultiplier":1.25,"cacheWrite1hMultiplier":2,"fastMultiplier":2,"models":{`
	for name, body := range map[string]string{
		"alias is another model's name": `"a":{"input":1,"output":1,"cacheRead":1,"aliases":["b"]},"b":{"input":1,"output":1,"cacheRead":1}`,
		"alias repeats own name":        `"a":{"input":1,"output":1,"cacheRead":1,"aliases":["a"]}`,
		"alias declared twice":          `"a":{"input":1,"output":1,"cacheRead":1,"aliases":["x"]},"b":{"input":1,"output":1,"cacheRead":1,"aliases":["x"]}`,
	} {
		if _, err := parse([]byte(head + body + `}}`)); err == nil {
			t.Errorf("%s: want an error at load", name)
		}
	}
}

func TestEmbeddedAliasesLoad(t *testing.T) {
	// Default panics on a collision in the embedded table; also pin the long tiers added with it.
	tab := Default()
	for _, c := range []struct {
		model string
		tok   model.Tokens
		want  float64
	}{
		{"gpt-5.4", model.Tokens{Input: 100_000, Output: 1_000_000, CacheRead: 100_000}, 0.25 + 15 + 0.025},
		{"gpt-5.4", model.Tokens{Input: 300_000, Output: 1_000_000}, 5*0.3 + 22.5},
		{"gpt-5.3-codex", model.Tokens{Input: 1_000_000, Output: 1_000_000, CacheRead: 1_000_000}, 15.925},
		{"gemini-3.1-pro-preview", model.Tokens{Input: 250_000, Output: 1_000_000}, 4*0.25 + 18},
	} {
		mc, ok := tab.Cost(c.model, c.tok, false)
		if !ok {
			t.Fatalf("%s unpriced", c.model)
		}
		near(t, mc.USD, c.want)
	}
}

func TestVendorNormalisation(t *testing.T) {
	tab := Default()
	for _, c := range []struct{ in, want string }{
		{"anthropic/claude-sonnet-4.6", "claude-sonnet-4-6"},
		{"claude-sonnet-4.6", "claude-sonnet-4-6"},
		{"anthropic/claude-sonnet-4-6", "claude-sonnet-4-6"},
		{"anthropic/claude-opus-4.5", "claude-opus-4-5"},
		{"anthropic/claude-opus-4.5[1m]", "claude-opus-4-5"},
		{"anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"},
		{"anthropic/claude-haiku-4.5-20251001", "claude-haiku-4-5-20251001"},
		{"openai/gpt-5.5", "gpt-5.5"},
		{"openai/gpt-5.3-codex", "gpt-5.3-codex"},
		{"google/gemini-3-flash-preview", "gemini-3-flash-preview"},
	} {
		got, _, ok := tab.Lookup(c.in)
		if !ok || got != c.want {
			t.Errorf("Lookup(%q) = %q %v, want %q", c.in, got, ok, c.want)
		}
	}
	a, _ := tab.Cost("anthropic/claude-sonnet-4.6", model.Tokens{Input: 1_000_000}, false)
	b, _ := tab.Cost("claude-sonnet-4-6", model.Tokens{Input: 1_000_000}, false)
	if a.USD == 0 || a.USD != b.USD {
		t.Errorf("prefixed cost %v, exact %v", a.USD, b.USD)
	}
}

func TestVendorNormalisationStaysUnpriced(t *testing.T) {
	tab := Default()
	for _, n := range []string{
		"z-ai/glm-5.3",
		"moonshotai/kimi-k2",
		"openrouter/anthropic/claude-sonnet-4.6", // one prefix only, and not a vendor's own
		"anthropic/anthropic/claude-sonnet-4-6",
		"anthropic/gpt-5.5", // not that vendor's model
		"openai/claude-sonnet-4-6",
		"google/claude-sonnet-4-6",
		"openrouter/claude-sonnet-4-6",
		"gpt-5-5", // OpenAI names keep their dots
		"openai/gpt-5-5",
		"gemini-3-flash-preview-x",
		"anthropic/claude-sonnet-4.9",
	} {
		if got, _, ok := tab.Lookup(n); ok {
			t.Errorf("Lookup(%q) = %q, want unpriced", n, got)
		}
	}
	if got, _, ok := tab.Lookup("gpt-5.5"); !ok || got != "gpt-5.5" {
		t.Errorf("gpt-5.5 resolved to %q %v", got, ok)
	}
}

func TestNormalisationNeverBeatsExactOrAlias(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	cfg := `{"prices": {
	  "anthropic/claude-sonnet-4.6": {"input": 99, "output": 99, "cacheRead": 99},
	  "claude-opus-4.9": {"input": 7, "output": 7, "cacheRead": 7, "aliases": ["vendor/opus-49"]}
	}}`
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	tab, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	// An exact entry that happens to look like a prefixed name is used as written.
	if got, p, ok := tab.Lookup("anthropic/claude-sonnet-4.6"); !ok || got != "anthropic/claude-sonnet-4.6" || p.Input != 99 {
		t.Errorf("exact entry: %q %v %v", got, p.Input, ok)
	}
	// The unprefixed spelling still reaches the table entry.
	if got, _, ok := tab.Lookup("claude-sonnet-4.6"); !ok || got != "claude-sonnet-4-6" {
		t.Errorf("claude-sonnet-4.6 = %q %v", got, ok)
	}
	// A name stored with a dot is found as written, not rewritten to a dash name.
	if got, p, ok := tab.Lookup("claude-opus-4.9"); !ok || got != "claude-opus-4.9" || p.Input != 7 {
		t.Errorf("dotted entry: %q %v %v", got, p.Input, ok)
	}
}

// docConfig is the example in docs/pricing.md, copied here so the doc cannot drift.
const docConfig = `{
  "prices": {
    "z-ai/glm-5.3": {
      "input": 0.60,
      "output": 2.20,
      "cacheRead": 0.11
    }
  }
}`

func TestDocExampleConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(docConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := Default().Lookup("z-ai/glm-5.3"); ok {
		t.Fatal("the example model is in the embedded table; pick another for the doc")
	}
	tab, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	got, p, ok := tab.Lookup("z-ai/glm-5.3")
	if !ok || got != "z-ai/glm-5.3" || p.Input != 0.60 || p.Output != 2.20 || p.CacheRead != 0.11 {
		t.Fatalf("Lookup = %q %+v %v", got, p, ok)
	}
	mc, ok := tab.Cost("z-ai/glm-5.3", model.Tokens{Input: 1e6, Output: 1e6, CacheRead: 1e6, CacheWrite5m: 1e6}, false)
	if !ok {
		t.Fatal("unpriced")
	}
	w5, _, _ := tab.Multipliers() // cache writes are Input times the table's multiplier
	want := 0.60 + 2.20 + 0.11 + 0.60*w5
	near(t, mc.USD, want)
	// The embedded table is untouched by the override.
	if _, _, ok := Default().Lookup("z-ai/glm-5.3"); ok {
		t.Error("override leaked into the default table")
	}
}
