package server

import (
	"net/http"

	"github.com/terek/merlin/internal/pricing"
)

// PriceList is the body of GET /api/prices: the table the daemon prices messages with.
type PriceList struct {
	// Unit is "USD per million tokens".
	Unit string `json:"unit"`
	// CacheWrite5mMultiplier and CacheWrite1hMultiplier are the factors of a model's input
	// price that a cache write costs; FastMultiplier applies to fast-mode calls of the
	// models whose entry says fast.
	CacheWrite5mMultiplier float64 `json:"cacheWrite5mMultiplier"`
	CacheWrite1hMultiplier float64 `json:"cacheWrite1hMultiplier"`
	FastMultiplier         float64 `json:"fastMultiplier"`
	// Models are the table's entries by exact name, with the user's overrides applied.
	Models map[string]PriceEntry `json:"models"`
}

// PriceEntry is one model's price.
type PriceEntry struct {
	Input     float64 `json:"input"`
	Output    float64 `json:"output"`
	CacheRead float64 `json:"cacheRead"`
	// Status is "verified" or "assumed".
	Status string `json:"status,omitempty"`
	// Aliases are other spellings of the model's name.
	Aliases []string `json:"aliases,omitempty"`
	// Long, when set, replaces the three prices for a request whose input is above it.
	Long *pricing.LongPrice `json:"long,omitempty"`
}

// handlePrices serves the price table. It reads no catalog: it answers while indexing.
func (a *API) handlePrices(w http.ResponseWriter, r *http.Request) {
	t := a.o.Prices
	if t == nil {
		t = pricing.Default()
	}
	w5, w1, fast := t.Multipliers()
	out := PriceList{Unit: "USD per million tokens", CacheWrite5mMultiplier: w5, CacheWrite1hMultiplier: w1,
		FastMultiplier: fast, Models: map[string]PriceEntry{}}
	for n, p := range t.Models() {
		out.Models[n] = PriceEntry{Input: p.Input, Output: p.Output, CacheRead: p.CacheRead, Status: p.Status,
			Aliases: p.Aliases, Long: p.Long}
	}
	a.json(w, http.StatusOK, out)
}
