package catalog

import (
	"maps"
	"slices"
	"sync"

	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/pricing"
)

// How a fact's spend splits over the price classes and over the main thread and the agents
// (GET /api/cost, by=class and by=agent). Each is a fixed-size array whose entries add up to the
// fact's total spend.

// The price classes of a fact's class array. ClassUnsplit takes the spend no tokens explain.
const (
	ClassInput = iota
	ClassOutput
	ClassCacheRead
	ClassCacheWrite
	ClassUnsplit
	numClasses
)

// The parts of a fact's agent array.
const (
	AgentMain = iota
	AgentSub
	AgentUnsplit
	numAgents
)

// ClassNames and AgentNames are the row keys of by=class and by=agent, in array order.
var (
	ClassNames = [numClasses]string{"input", "output", "cacheRead", "cacheWrite", "(unsplit)"}
	AgentNames = [numAgents]string{"main", "agents", "(unsplit)"}
)

type (
	classSplit [numClasses]float64
	agentSplit [numAgents]float64
)

var (
	priceOnce  sync.Once
	priceTable *pricing.Table
)

// classShares prices tokens by class with the embedded table: only the proportions matter (the
// amounts are scaled to the spend they explain), so a user's price overrides do not change the shape.
func classShares(modelName string, t model.Tokens, fast bool) (c classSplit, sum float64) {
	priceOnce.Do(func() { priceTable = pricing.Default() })
	price := func(tok model.Tokens) float64 {
		mc, ok := priceTable.Cost(modelName, tok, fast)
		if !ok {
			return 0
		}
		return mc.USD
	}
	c[ClassInput] = price(model.Tokens{Input: t.Input})
	c[ClassOutput] = price(model.Tokens{Output: t.Output})
	c[ClassCacheRead] = price(model.Tokens{CacheRead: t.CacheRead})
	c[ClassCacheWrite] = price(model.Tokens{CacheWrite5m: t.CacheWrite5m, CacheWrite1h: t.CacheWrite1h})
	for _, x := range c {
		sum += x
	}
	return c, sum
}

// addScaled adds amount to c in the proportions of shares (all of it to ClassUnsplit when the
// shares are empty).
func (c *classSplit) addScaled(amount float64, shares classSplit, sum float64) {
	if amount == 0 {
		return
	}
	if sum <= 0 {
		c[ClassUnsplit] += amount
		return
	}
	for i := range ClassUnsplit {
		c[i] += amount * shares[i] / sum
	}
}

// windowShares are the class proportions of a reported window: its models' tokens, priced.
func windowShares(w model.ReportedWindow) (c classSplit, sum float64) {
	for _, name := range slices.Sorted(maps.Keys(w.ByModel)) { // in name order: a float sum depends on it
		m := w.ByModel[name]
		cs, _ := classShares(name, model.Tokens{Input: m.InputTokens, Output: m.OutputTokens + m.ThinkingTokens,
			CacheRead: m.CacheReadTokens, CacheWrite5m: m.CacheCreationTokens}, false)
		for i := range c {
			c[i] += cs[i]
		}
	}
	for _, x := range c {
		sum += x
	}
	return c, sum
}

func (c classSplit) sum() (s float64) {
	for _, x := range c {
		s += x
	}
	return s
}

func (a agentSplit) sum() (s float64) {
	for _, x := range a {
		s += x
	}
	return s
}
