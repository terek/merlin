package digest

import (
	"math"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/pricing"
)

// A window Claude Code priced with an older Sonnet 5.5 cache-read rate ($0.20 against the
// table's $0.10) has that difference as RateDiffUSD; the haiku line it reports with no
// message, cache writes split as the messages split them and fast-mode calls are priced
// as Merlin would, so they add nothing.
func TestRateDiffs(t *testing.T) {
	t0 := time.Date(2026, 9, 16, 10, 0, 0, 0, time.UTC)
	at := func(min int) time.Time { return t0.Add(time.Duration(min) * time.Minute) }
	win := func(from, to int, total float64, by map[string]model.ReportedModel) model.ReportedWindow {
		return model.ReportedWindow{From: at(from), To: at(to), TotalUSD: total, ByModel: by}
	}
	const sonnet, haiku = "claude-sonnet-5-5", "claude-haiku-4-5-20251001"
	d := &model.SessionDigest{
		Reported: &model.Reported{Windows: []model.ReportedWindow{
			// 1000 in, 500 out, 1M cache read at the old rate: 0.002 + 0.005 + 0.2
			win(0, 10, 0.20715, map[string]model.ReportedModel{
				sonnet: {InputTokens: 1000, OutputTokens: 500, CacheReadTokens: 1_000_000, USD: 0.207},
				haiku:  {InputTokens: 100, OutputTokens: 10, USD: 0.00015},
			}),
			// cache writes: the messages' 300 1h tokens at 1h, the other 3700 at 5m
			win(20, 30, 0.01045, map[string]model.ReportedModel{sonnet: {CacheCreationTokens: 4000, USD: 0.01045}}),
			// a fast-mode call costs twice the standard rates
			win(40, 50, 0.014, map[string]model.ReportedModel{sonnet: {InputTokens: 1000, OutputTokens: 500, USD: 0.014}}),
		}},
		Messages: []model.Message{
			{ID: "m1", At: at(5), Model: sonnet, Tokens: model.Tokens{Input: 1000, Output: 500, CacheRead: 900_000}, USD: 0.097},
			{ID: "m2", At: at(25), Model: sonnet, Tokens: model.Tokens{CacheWrite5m: 100, CacheWrite1h: 300}, USD: 0.00145},
			{ID: "m3", At: at(45), Model: sonnet, Tokens: model.Tokens{Input: 1000, Output: 500}, USD: 0.014, Fast: true},
		},
	}
	rateDiffs(d, pricing.Default())
	for i, want := range []float64{0.1, 0, 0} {
		if got := d.Reported.Windows[i].RateDiffUSD; math.Abs(got-want) > 1e-9 {
			t.Errorf("window %d: rate diff %v, want %v", i, got, want)
		}
	}
}
