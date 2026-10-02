package model

// Tokens is a count of billed tokens, split by price class.
type Tokens struct {
	Input        int64 `json:"input,omitempty"`
	Output       int64 `json:"output,omitempty"` // includes thinking tokens
	CacheRead    int64 `json:"cacheRead,omitempty"`
	CacheWrite5m int64 `json:"cacheWrite5m,omitempty"`
	CacheWrite1h int64 `json:"cacheWrite1h,omitempty"`
}

// Add adds other into t.
func (t *Tokens) Add(other Tokens) {
	t.Input += other.Input
	t.Output += other.Output
	t.CacheRead += other.CacheRead
	t.CacheWrite5m += other.CacheWrite5m
	t.CacheWrite1h += other.CacheWrite1h
}

// ModelCost is the tokens and attributed dollars for one model.
type ModelCost struct {
	Tokens
	USD float64 `json:"usd"`
}

// Cost is an attributed cost: recomputed from token usage with the price table.
type Cost struct {
	USD     float64              `json:"usd"`
	ByModel map[string]ModelCost `json:"byModel,omitempty"`
	// TruncatedMessages is how many of the summed messages were cut short in the transcript
	// (see Message.Truncated). Their output tokens are a partial count, so USD is a lower
	// bound whenever this is non-zero.
	TruncatedMessages int64 `json:"truncatedMessages,omitempty"`
}

// Add adds other into c. It is safe on a zero Cost.
func (c *Cost) Add(other Cost) {
	c.USD += other.USD
	c.TruncatedMessages += other.TruncatedMessages
	for m, oc := range other.ByModel {
		c.addModel(m, oc)
	}
}

// AddMessage adds one priced API message: its model, its tokens and the dollars the
// pricing package computed for them.
func (c *Cost) AddMessage(model string, tokens Tokens, usd float64) {
	c.USD += usd
	c.addModel(model, ModelCost{Tokens: tokens, USD: usd})
}

// AddTruncated counts one message, already added with AddMessage, that was cut short.
func (c *Cost) AddTruncated() { c.TruncatedMessages++ }

func (c *Cost) addModel(model string, add ModelCost) {
	if c.ByModel == nil {
		c.ByModel = make(map[string]ModelCost)
	}
	mc := c.ByModel[model]
	mc.Tokens.Add(add.Tokens)
	mc.USD += add.USD
	c.ByModel[model] = mc
}
