package transcript

import "github.com/terek/merlin/explorer/internal/model"

// Tokens converts a usage record into the harness-neutral token counts that the pricing
// package prices.
func (u Usage) Tokens() model.Tokens {
	w5m, w1h := u.CacheWrites()
	return model.Tokens{
		Input:        u.InputTokens,
		Output:       u.OutputTokens,
		CacheRead:    u.CacheReadInputTokens,
		CacheWrite5m: w5m,
		CacheWrite1h: w1h,
	}
}

// IsFast reports whether the message was served in fast mode, which is priced higher.
func (u Usage) IsFast() bool { return u.Speed == "fast" }
