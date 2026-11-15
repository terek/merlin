package catalog

import (
	"fmt"
	"testing"

	"github.com/terek/merlin/internal/model"
)

// synthCatalog is the history BenchmarkRebuild uses: 3000 sessions of 37 messages a minute apart.
func synthCatalog() *Catalog {
	c := New()
	for i := 0; i < 3000; i++ {
		var msgs []msgSpec
		for j := 0; j < 37; j++ {
			msgs = append(msgs, msgSpec{fmt.Sprintf("m%d-%d", i, j), j, 0.01, 0})
		}
		d := syn("claude", fmt.Sprintf("s%05d", i), fmt.Sprintf("/p/%d", i%40), i, i+40, []model.Turn{turn(0, fmt.Sprintf("u%d", i), "do a thing", i)}, msgs...)
		c.Upsert(d)
	}
	return c
}

// BenchmarkViewBuild times build() alone and reports the facts it makes.
func BenchmarkViewBuild(b *testing.B) {
	for name, c := range map[string]*Catalog{"fixtures": fixtureCatalog(b), "synthetic": synthCatalog()} {
		b.Run(name, func(b *testing.B) {
			var v *view
			for i := 0; i < b.N; i++ {
				v = build(c.digests, c.zone())
			}
			b.ReportMetric(float64(len(v.facts)), "facts")
		})
	}
}
