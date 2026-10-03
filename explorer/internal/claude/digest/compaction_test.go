package digest

import (
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/pricing"
)

func TestVersionAtLeast(t *testing.T) {
	for v, want := range map[string]bool{"2.1.269": true, "2.1.270": true, "2.2.0": true, "3.0.0": true,
		"2.1.268": false, "2.0.999": false, "1.9.9": false, "": false, "x.y": false, "2.1": false} {
		if got := versionAtLeast(v, "2.1.269"); got != want {
			t.Errorf("versionAtLeast(%q) = %v", v, got)
		}
	}
}

// usageWrite is a usage with a cache write of the given lifetime.
func usageWrite(in, out int, write1h bool) L {
	u := usage(in, out)
	if write1h {
		u["cache_creation_input_tokens"] = 5000
		u["cache_creation"] = L{"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 5000}
	}
	return u
}

func boundaryAt(uuid, logical string, sec int, pre int, version string) L {
	b := boundary(uuid, logical, sec)
	b["compactMetadata"] = L{"trigger": "manual", "preTokens": pre, "postTokens": 20000, "durationMs": 90000}
	b["version"] = version
	return b
}

// The call that writes a summary is priced from the context size and the summary. With the
// previous call inside the cache lifetime it reads from the cache; after the lifetime it
// pays full price: as a cache write on older harness versions, as input from 2.1.269 on.
func TestCompactionCallEstimate(t *testing.T) {
	const pre = 200_000
	sum := func(n int) string { // a summary of n*4 bytes
		b := make([]byte, n*4)
		for i := range b {
			b[i] = 'x'
		}
		return string(b)
	}
	cases := []struct {
		name            string
		idleSec         int
		write1h         bool
		version         string
		cache           model.CacheState
		billing         model.CallBilling
		tokens          model.Tokens // what the context side is billed as
		warmIsSameAsUSD bool
	}{
		{"within an hour with the one-hour cache", 1800, true, "2.1.287", model.CacheWarm, model.BillingCacheRead, model.Tokens{CacheRead: pre}, true},
		{"after an hour, recent harness", 4000, true, "2.1.287", model.CacheCold, model.BillingInput, model.Tokens{Input: pre}, false},
		{"after an hour, older harness", 4000, true, "2.1.263", model.CacheCold, model.BillingCacheWrite1h, model.Tokens{CacheWrite1h: pre}, false},
		{"after six minutes with the five-minute cache", 360, false, "2.1.263", model.CacheCold, model.BillingCacheWrite5m, model.Tokens{CacheWrite5m: pre}, false},
		{"within five minutes with the five-minute cache", 200, false, "2.1.263", model.CacheWarm, model.BillingCacheRead, model.Tokens{CacheRead: pre}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// ts() only reaches 59 minutes; stamp the records after the idle gap by hand
			at := 100 + c.idleSec
			stamp := func(l L, sec int) L {
				l["timestamp"] = time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC).Add(time.Duration(sec) * time.Second).Format(time.RFC3339)
				return l
			}
			res := reduce(t,
				prompt("u1", "", 0, "hello"),
				assistant("a1", "u1", 100, "msg_1", usageWrite(100, 10, c.write1h), text("Hi.")),
				stamp(boundaryAt("b1", "a1", 0, pre, c.version), at),
				stamp(summary("s1", "b1", 0, sum(3000)), at+1),
				stamp(prompt("u2", "s1", 0, "go on"), at+2),
				stamp(assistant("a2", "u2", 0, "msg_2", usage(100, 10), text("On.")), at+3),
			)
			if len(res.Compactions) != 1 || res.Compactions[0].Call == nil {
				t.Fatalf("compactions = %+v", res.Compactions)
			}
			call := res.Compactions[0].Call
			if call.Cache != c.cache || call.Billing != c.billing || call.InputTokens != pre || call.OutputTokens != 3000 ||
				call.IdleMs != int64(c.idleSec)*1000 || call.Model != "claude-sonnet-5-5" {
				t.Errorf("call = %+v", call)
			}
			tok := c.tokens
			tok.Output = 3000
			want, _ := pricing.Default().Cost("claude-sonnet-5-5", tok, false)
			near(t, "usd", call.USD, want.USD)
			warm, _ := pricing.Default().Cost("claude-sonnet-5-5", model.Tokens{CacheRead: pre, Output: 3000}, false)
			near(t, "warm usd", call.WarmUSD, warm.USD)
			if (call.USD == call.WarmUSD) != c.warmIsSameAsUSD {
				t.Errorf("usd %v warm %v", call.USD, call.WarmUSD)
			}
			if call.Cache == model.CacheCold && call.USD < 5*call.WarmUSD {
				t.Errorf("a cold call should cost far more than a warm one: %v vs %v", call.USD, call.WarmUSD)
			}
			// the estimate is not in the recomputed total
			near(t, "file cost", res.Cost.USD, res.Messages[0].USD+res.Messages[1].USD)
		})
	}
}

// Without a priced model before it, a compaction has no estimate.
func TestCompactionCallNeedsAModel(t *testing.T) {
	res := reduce(t,
		boundaryAt("b1", "", 10, 1000, "2.1.287"),
		summary("s1", "b1", 11, "short"),
		prompt("u1", "s1", 12, "hello"),
		assistant("a1", "u1", 13, "msg_1", usage(100, 10), text("Hi.")),
	)
	if len(res.Compactions) != 1 || res.Compactions[0].Call != nil {
		t.Errorf("compactions = %+v", res.Compactions)
	}
}
