package catalog

import (
	"math"
	"testing"
)

// A float sum depends on its order, so share must not sum in map order: the same weights have to
// give the same shares, to the last bit, however often it runs.
func TestShareIsDeterministic(t *testing.T) {
	// Weights whose sum really does differ with the order: summed in map order they fail this test.
	w := map[string]float64{"a": 0.1, "b": 0.2, "c": 0.3, "d": 0.7, "e": 1.1, "f": 2.3, "g": 3.7, "h": 0.013, "i": 5.9, "j": 0.17}
	run := func() map[string]uint64 {
		out := map[string]uint64{}
		share(w, 3.3, NoBead, func(k string, x float64) { out[k] = math.Float64bits(x) })
		return out
	}
	first := run()
	if len(first) != len(w) {
		t.Fatalf("shares = %v", first)
	}
	for range 500 {
		for k, x := range run() {
			if x != first[k] {
				t.Fatalf("share of %s changed between runs: %x, then %x", k, first[k], x)
			}
		}
	}
}

func TestShareOfNothingGoesToNone(t *testing.T) {
	var got string
	share(nil, 2, NoBead, func(k string, x float64) {
		if x != 2 {
			t.Errorf("amount = %v", x)
		}
		got = k
	})
	if got != NoBead {
		t.Errorf("key = %q", got)
	}
}
