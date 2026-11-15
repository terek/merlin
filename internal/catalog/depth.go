package catalog

import "github.com/terek/merlin/internal/model"

// Context depth: how much context a call carried (model.Tokens.Context). The bands are fixed
// for every model and harness; a call whose context is DeepContext or more is deep: it read a
// long history again at every call.
const DeepContext = 200_000

// The bands of a fact's depth. depthNone is a fact no call explains (overhead).
const (
	depthNone = iota
	depth0k
	depth100k
	depth200k
	depth500k
	numDepths
)

// OverheadDepth is the row of by=depth for spend no call explains.
const OverheadDepth = "(overhead)"

// DepthNames are the row keys of by=depth, in band order.
var DepthNames = [numDepths]string{OverheadDepth, "0-100k", "100k-200k", "200k-500k", "500k+"}

// depthBand is the band of a context size.
func depthBand(ctx int64) int8 {
	switch {
	case ctx < 100_000:
		return depth0k
	case ctx < 200_000:
		return depth100k
	case ctx < 500_000:
		return depth200k
	}
	return depth500k
}

// callDepth is the band of a message's call.
func callDepth(t model.Tokens) int8 { return depthBand(t.Context()) }
