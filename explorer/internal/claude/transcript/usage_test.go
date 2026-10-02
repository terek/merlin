package transcript

import (
	"testing"

	"github.com/terek/merlin/explorer/internal/model"
)

func TestUsageTokens(t *testing.T) {
	tests := []struct {
		name string
		u    Usage
		want model.Tokens
	}{
		{"no breakdown: all 5m", Usage{InputTokens: 1, OutputTokens: 2, CacheReadInputTokens: 3, CacheCreationInputTokens: 40},
			model.Tokens{Input: 1, Output: 2, CacheRead: 3, CacheWrite5m: 40}},
		{"all 1h", Usage{CacheCreationInputTokens: 40, CacheCreation: &CacheCreation{Ephemeral1hInputTokens: 40}},
			model.Tokens{CacheWrite1h: 40}},
		{"mixed", Usage{CacheCreationInputTokens: 40, CacheCreation: &CacheCreation{Ephemeral5mInputTokens: 10, Ephemeral1hInputTokens: 30}},
			model.Tokens{CacheWrite5m: 10, CacheWrite1h: 30}},
		{"breakdown short of total: remainder is 5m", Usage{CacheCreationInputTokens: 40, CacheCreation: &CacheCreation{Ephemeral1hInputTokens: 25}},
			model.Tokens{CacheWrite5m: 15, CacheWrite1h: 25}},
		{"breakdown over total: capped", Usage{CacheCreationInputTokens: 40, CacheCreation: &CacheCreation{Ephemeral1hInputTokens: 99}},
			model.Tokens{CacheWrite1h: 40}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.u.Tokens(); got != tc.want {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
	if !(Usage{Speed: "fast"}).IsFast() || (Usage{Speed: "standard"}).IsFast() || (Usage{}).IsFast() {
		t.Fatal("IsFast")
	}
}
