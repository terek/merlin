package pricing

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"strings"

	"github.com/terek/merlin/explorer/internal/model"
)

//go:embed prices.json
var defaultJSON []byte

// Synthetic is the model name of locally generated messages. It costs nothing.
const Synthetic = "<synthetic>"

// Price is one model's price in USD per million tokens.
type Price struct {
	Input     float64 `json:"input"`
	Output    float64 `json:"output"`
	CacheRead float64 `json:"cacheRead"`
	// Status is "verified" or "assumed" (informational).
	Status string `json:"status,omitempty"`
	Note   string `json:"note,omitempty"`
	// Fast, in an override entry only, sets whether fast mode applies to the model.
	// Absent leaves the table's fastModels list in charge.
	Fast *bool `json:"fast,omitempty"`
}

// tableFile is the shape of the embedded prices.json.
type tableFile struct {
	Unit                   string           `json:"unit,omitempty"`
	CacheWrite5mMultiplier float64          `json:"cacheWrite5mMultiplier"`
	CacheWrite1hMultiplier float64          `json:"cacheWrite1hMultiplier"`
	FastMultiplier         float64          `json:"fastMultiplier"`
	FastModels             []string         `json:"fastModels"`
	FastStatus             string           `json:"fastStatus,omitempty"`
	Models                 map[string]Price `json:"models"`
}

// overrideFile is the shape of a config file: only its "prices" section is read.
// Each entry replaces the table entry of that name or adds a model.
type overrideFile struct {
	Prices map[string]Price `json:"prices"`
}

// Table is an immutable price table. The zero value prices nothing.
type Table struct {
	w5m, w1h, fastMult float64
	models             map[string]Price  // exact names, normalised
	alias              map[string]string // date-stripped name -> exact name
	fast               map[string]bool
}

var dateSuffix = regexp.MustCompile(`-\d{8}$`)

// Default returns the embedded table.
func Default() *Table {
	t, err := parse(defaultJSON)
	if err != nil {
		panic("pricing: embedded prices.json: " + err.Error())
	}
	return t
}

// Load returns the embedded table with the "prices" section of the JSON file at path
// applied. An empty path or a missing file means no overrides.
func Load(path string) (*Table, error) {
	t := Default()
	if path == "" {
		return t, nil
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return t, nil
	}
	if err != nil {
		return nil, fmt.Errorf("pricing: read %s: %w", path, err)
	}
	var o overrideFile
	if err := json.Unmarshal(b, &o); err != nil {
		return nil, fmt.Errorf("pricing: parse %s: %w", path, err)
	}
	for name, p := range o.Prices {
		name = strip1m(name)
		if name == "" {
			return nil, fmt.Errorf("pricing: %s: empty model name in prices", path)
		}
		if p.Fast != nil {
			t.fast[name] = *p.Fast
		}
		p.Fast = nil
		t.models[name] = p
	}
	t.reindex()
	return t, nil
}

func parse(b []byte) (*Table, error) {
	var f tableFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	if f.CacheWrite5mMultiplier <= 0 || f.CacheWrite1hMultiplier <= 0 || f.FastMultiplier <= 0 {
		return nil, errors.New("multipliers must be positive")
	}
	t := &Table{
		w5m: f.CacheWrite5mMultiplier, w1h: f.CacheWrite1hMultiplier, fastMult: f.FastMultiplier,
		models: make(map[string]Price, len(f.Models)),
		fast:   make(map[string]bool, len(f.FastModels)),
	}
	for n, p := range f.Models {
		t.models[n] = p
	}
	for _, n := range f.FastModels {
		t.fast[n] = true
	}
	t.reindex()
	return t, nil
}

// reindex rebuilds the date-stripped aliases so a table entry stored with a date
// ("claude-haiku-4-5-20251001") is also found without it. Exact names always win.
func (t *Table) reindex() {
	t.alias = make(map[string]string)
	for n := range t.models {
		if s := dateSuffix.ReplaceAllString(n, ""); s != n {
			if _, exact := t.models[s]; !exact {
				t.alias[s] = n
			}
		}
	}
}

func strip1m(name string) string { return strings.TrimSuffix(strings.TrimSpace(name), "[1m]") }

// Lookup resolves a model name to its table name and price: it strips a "[1m]" suffix,
// then tries the exact name, then the name without a trailing -YYYYMMDD. ok is false for
// an unknown model, and for Synthetic, which is free rather than priced.
func (t *Table) Lookup(name string) (resolved string, p Price, ok bool) {
	n := strip1m(name)
	if p, ok := t.models[n]; ok {
		return n, p, true
	}
	if s := dateSuffix.ReplaceAllString(n, ""); s != n {
		if p, ok := t.models[s]; ok {
			return s, p, true
		}
	}
	if full, ok := t.alias[n]; ok {
		return full, t.models[full], true
	}
	return "", Price{}, false
}

// Cost prices one API message. fast applies the fast-mode multiplier when the model is
// listed for it. ok is false when the model is unknown (the result is then zero and the
// caller must report the model as unpriced); Synthetic returns zero cost with ok true.
// The returned ModelCost carries the tokens as given.
func (t *Table) Cost(name string, tok model.Tokens, fast bool) (model.ModelCost, bool) {
	mc := model.ModelCost{Tokens: tok}
	if strip1m(name) == Synthetic {
		return mc, true
	}
	resolved, p, ok := t.Lookup(name)
	if !ok {
		return model.ModelCost{}, false
	}
	usd := float64(tok.Input)*p.Input +
		float64(tok.Output)*p.Output +
		float64(tok.CacheRead)*p.CacheRead +
		float64(tok.CacheWrite5m)*p.Input*t.w5m +
		float64(tok.CacheWrite1h)*p.Input*t.w1h
	if fast && t.fast[resolved] {
		usd *= t.fastMult
	}
	mc.USD = usd / 1e6
	return mc, true
}
