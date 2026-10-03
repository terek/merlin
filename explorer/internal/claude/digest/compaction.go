package digest

import (
	"strconv"
	"strings"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

// A compaction is one API call that reads the whole context and writes the summary. Claude
// Code does not write that call to the transcript: the boundary record has preTokens,
// postTokens and durationMs, but no usage. Its cost is estimated here from what the
// boundary says and the price table (format notes §6a), and kept apart from the
// recomputed totals.
//
// What the call pays for its input depends on the cache. When the main agent's previous
// call is older than the cache lifetime, the context is read again at full price: as a
// cache write up to Claude Code 2.1.26x, as plain input from 2.1.269 on (both seen in the
// harness's own totals). Within the lifetime it is a cache read.

const (
	cacheLifetime5m = 5 * time.Minute
	cacheLifetime1h = time.Hour
	// inputBilledFrom is the first Claude Code version seen to bill a cold compaction as
	// plain input rather than as a cache write.
	inputBilledFrom = "2.1.269"
	// charsPerToken turns the summary's length into output tokens.
	charsPerToken = 4
)

// compactionCalls fills Compaction.Call for every compaction of the file that has a
// context size and a priced model.
func (b *Builder) compactionCalls(res *FileResult) {
	for i := range res.Compactions {
		c := &res.Compactions[i]
		if c.PreTokens == 0 {
			continue
		}
		prev, lifetime := b.lastCallBefore(c.At)
		if prev == nil {
			continue
		}
		call := model.CompactionCall{
			Model:        prev.model,
			IdleMs:       c.At.Sub(prev.firstTS).Milliseconds(),
			InputTokens:  c.PreTokens,
			OutputTokens: int64(len(c.Summary) / charsPerToken),
		}
		version := ""
		if i < len(b.compVersions) {
			version = b.compVersions[i]
		}
		cold := c.At.Sub(prev.firstTS) > lifetime
		switch {
		case !cold:
			call.Cache, call.Billing = model.CacheWarm, model.BillingCacheRead
		case versionAtLeast(version, inputBilledFrom):
			call.Cache, call.Billing = model.CacheCold, model.BillingInput
		case lifetime == cacheLifetime1h:
			call.Cache, call.Billing = model.CacheCold, model.BillingCacheWrite1h
		default:
			call.Cache, call.Billing = model.CacheCold, model.BillingCacheWrite5m
		}
		usd, ok := b.callCost(prev.model, call.Billing, c.PreTokens, call.OutputTokens)
		if !ok {
			continue
		}
		call.USD = usd
		call.WarmUSD, _ = b.callCost(prev.model, model.BillingCacheRead, c.PreTokens, call.OutputTokens)
		c.Call = &call
	}
}

// lastCallBefore returns the file's last API message started at or before at, with the
// cache lifetime in use then: an hour when the latest message that wrote to the cache
// wrote with the one-hour lifetime, else five minutes.
func (b *Builder) lastCallBefore(at time.Time) (*msgState, time.Duration) {
	var last *msgState
	lifetime := cacheLifetime5m
	decided := false
	for i := len(b.msgs) - 1; i >= 0; i-- {
		m := b.msgs[i]
		if m.synthetic || m.model == "" || m.firstTS.After(at) {
			continue
		}
		if last == nil {
			last = m
		}
		if !decided {
			tok := m.usage.Tokens()
			if tok.CacheWrite1h > 0 {
				lifetime, decided = cacheLifetime1h, true
			} else if tok.CacheWrite5m > 0 {
				decided = true
			}
		}
		if decided {
			break
		}
	}
	return last, lifetime
}

// callCost prices a compaction call: the context at the given billing, the summary as
// output.
func (b *Builder) callCost(name string, billing model.CallBilling, in, out int64) (float64, bool) {
	tok := model.Tokens{Output: out}
	switch billing {
	case model.BillingCacheRead:
		tok.CacheRead = in
	case model.BillingInput:
		tok.Input = in
	case model.BillingCacheWrite1h:
		tok.CacheWrite1h = in
	case model.BillingCacheWrite5m:
		tok.CacheWrite5m = in
	}
	mc, ok := b.pricer.Cost(name, tok, false)
	return mc.USD, ok
}

// versionAtLeast compares dotted numeric versions ("2.1.269"); an unparsable or empty
// version counts as older.
func versionAtLeast(v, min string) bool {
	a, b := strings.Split(v, "."), strings.Split(min, ".")
	for i := range b {
		if i >= len(a) {
			return false
		}
		x, errX := strconv.Atoi(a[i])
		y, errY := strconv.Atoi(b[i])
		if errX != nil || errY != nil {
			return false
		}
		if x != y {
			return x > y
		}
	}
	return true
}
