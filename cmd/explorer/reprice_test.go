package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

var scanLineRe = regexp.MustCompile(`processed (\d+), unchanged (\d+)`)

func scanCounts(t *testing.T, e *readEnv) (processed, unchanged int) {
	t.Helper()
	out, errs, code := e.run(nil, "scan", "--quiet")
	if code != 0 {
		t.Fatalf("scan: code %d\n%s\n%s", code, out, errs)
	}
	m := scanLineRe.FindStringSubmatch(out)
	if m == nil {
		t.Fatalf("no summary line in %q", out)
	}
	processed, _ = strconv.Atoi(m[1])
	unchanged, _ = strconv.Atoi(m[2])
	return processed, unchanged
}

// modelUSD returns the total cost the cost command reports for one model.
func modelUSD(t *testing.T, e *readEnv, name string) float64 {
	t.Helper()
	out, errs, code := e.run(nil, "cost", "--by", "model", "--json")
	if code != 0 {
		t.Fatalf("cost: code %d\n%s", code, errs)
	}
	var r struct {
		Rows []struct {
			Key      string  `json:"key"`
			TotalUSD float64 `json:"totalUSD"`
		} `json:"rows"`
	}
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		t.Fatal(err)
	}
	for _, row := range r.Rows {
		if row.Key == name {
			return row.TotalUSD
		}
	}
	t.Fatalf("model %s not in cost output", name)
	return 0
}

// A changed price reaches sessions that are already indexed, and only once.
func TestScanRebuildsWhenPricesChange(t *testing.T) {
	e := newReadEnv(t) // scans once, with the fixtures' prices in config.json
	const unpriced = "claude-nova-9-9"
	if got := modelUSD(t, e, unpriced); got != 0 {
		t.Fatalf("%s costs %v before it has a price", unpriced, got)
	}
	if p, u := scanCounts(t, e); p != 0 || u == 0 {
		t.Fatalf("scan with nothing changed: processed %d, unchanged %d", p, u)
	}

	cfgPath := filepath.Join(e.home, "config.json")
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(b, &cfg); err != nil {
		t.Fatal(err)
	}
	prices, _ := cfg["prices"].(map[string]any)
	if prices == nil {
		prices = map[string]any{}
		cfg["prices"] = prices
	}
	prices[unpriced] = map[string]any{"input": 1000, "output": 1000, "cacheRead": 100}
	nb, _ := json.Marshal(cfg)
	if err := os.WriteFile(cfgPath, nb, 0o644); err != nil {
		t.Fatal(err)
	}

	if p, _ := scanCounts(t, e); p == 0 {
		t.Fatal("scan after a price was added rebuilt nothing")
	}
	if got := modelUSD(t, e, unpriced); got <= 0 {
		t.Errorf("%s still costs %v after a price was added", unpriced, got)
	}
	if p, u := scanCounts(t, e); p != 0 || u == 0 {
		t.Errorf("third scan, nothing changed: processed %d, unchanged %d", p, u)
	}
}

// A machine without Claude Code (no CLAUDE_CONFIG_DIR on disk) scans cleanly.
func TestScanWithoutClaudeDir(t *testing.T) {
	e := &readEnv{t: t, home: t.TempDir(), claud: filepath.Join(t.TempDir(), "nonexistent")}
	out, errs, code := e.run(nil, "scan")
	if code != 0 || strings.Contains(errs, "claude") || strings.Contains(out, "claude: discover") {
		t.Fatalf("scan: code %d\n%s\n%s", code, out, errs)
	}
	if !strings.Contains(out, "seen 0") {
		t.Errorf("no summary line in %q", out)
	}
}
