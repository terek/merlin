package server

import (
	"net/http"
	"testing"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/pricing"
)

func TestPrices(t *testing.T) {
	r := newRig(t)
	var pl PriceList
	if code := r.get("/api/prices", &pl); code != 200 {
		t.Fatalf("status %d", code)
	}
	want, _, ok := pricing.Default().Lookup("claude-opus-5-5")
	e, got := pl.Models[want]
	if !ok || !got || e.Input <= 0 || e.Output <= e.Input || e.CacheRead <= 0 {
		t.Fatalf("claude-opus-5-5 = %+v (present %v)", e, got)
	}
	if pl.Unit == "" || pl.CacheWrite5mMultiplier <= 0 || pl.CacheWrite1hMultiplier <= 0 || pl.FastMultiplier <= 0 {
		t.Errorf("table fields = %+v", pl)
	}
	if len(pl.Models) != len(pricing.Default().Models()) {
		t.Errorf("%d models, table has %d", len(pl.Models), len(pricing.Default().Models()))
	}
}

func TestPricesInjectedAndReadOnly(t *testing.T) {
	tab, err := pricing.Load("")
	if err != nil {
		t.Fatal(err)
	}
	r := newRig(t, func(o *Options) { o.Prices = tab; o.Catalog = func() *catalog.Catalog { return nil } })
	if code := r.get("/api/prices", nil); code != 200 { // needs no catalog
		t.Errorf("status %d without a catalog", code)
	}
	resp, err := http.Post(r.srv.URL+"/api/prices", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", resp.StatusCode)
	}
}
