package server

import (
	"io"
	"math"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/terek/merlin/explorer/internal/catalog"
)

func TestCostSplit(t *testing.T) {
	r := newRig(t)
	sawOverhead := false
	for _, by := range []string{"project", "day", "model", "kind"} {
		for _, split := range []string{"project", "model", "kind"} {
			if by == split {
				continue
			}
			for _, extra := range []string{"", "&since=2026-09-20", "&until=2026-09-25&limit=3"} {
				path := "/api/cost?by=" + by + "&split=" + split + "&limit=500" + extra
				var c, plain CostTable
				if code := r.get(path, &c); code != 200 {
					t.Fatalf("%s: %d", path, code)
				}
				r.get("/api/cost?by="+by+"&limit=500"+extra, &plain)
				if c.Split != split || c.By != by || len(c.Rows) == 0 || len(c.Rows) != len(plain.Rows) {
					t.Fatalf("%s: split %q, %d rows (plain %d)", path, c.Split, len(c.Rows), len(plain.Rows))
				}
				for i, row := range c.Rows {
					if len(row.Split) == 0 {
						t.Errorf("%s: row %q has no parts", path, row.Key)
					}
					var sum catalog.Money
					for j, p := range row.Split {
						sum.TotalUSD += p.TotalUSD
						sum.ReportedUSD += p.ReportedUSD
						sum.AttributedUSD += p.AttributedUSD
						if p.Key == catalog.OverheadModel {
							sawOverhead = true
						}
						if j > 0 {
							q := row.Split[j-1]
							if q.TotalUSD < p.TotalUSD || (q.TotalUSD == p.TotalUSD && q.Key >= p.Key) {
								t.Errorf("%s: row %q parts out of order: %v before %v", path, row.Key, q, p)
							}
						}
					}
					if math.Abs(sum.TotalUSD-row.TotalUSD) > 1e-9 || math.Abs(sum.ReportedUSD-row.ReportedUSD) > 1e-9 ||
						math.Abs(sum.AttributedUSD-row.AttributedUSD) > 1e-9 {
						t.Errorf("%s: row %q = %+v, parts add up to %+v", path, row.Key, row.Money, sum)
					}
					// The row itself is what it is without split.
					row.Split = nil
					if !reflect.DeepEqual(row, plain.Rows[i]) {
						t.Errorf("%s: row %d differs from the plain row: %+v vs %+v", path, i, row, plain.Rows[i])
					}
				}
			}
		}
	}
	if !sawOverhead {
		t.Error("the (overhead) model never appeared as a part")
	}
}

func TestCostWithoutSplitIsUnchanged(t *testing.T) {
	r := newRig(t)
	for _, by := range []string{"project", "day", "model", "kind", "session"} {
		resp, err := http.Get(r.srv.URL + "/api/cost?by=" + by)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if strings.Contains(string(b), `"split"`) {
			t.Errorf("by=%s: a response without split mentions it", by)
		}
	}
}

func TestCostSplitRefused(t *testing.T) {
	r := newRig(t)
	for _, q := range []string{
		"by=session&split=model", "by=project&split=project", "by=model&split=model", "by=kind&split=kind",
		"by=project&split=bogus", "by=project&split=day", "by=day&split=day", "by=project&split=session",
	} {
		r.wantError("/api/cost?"+q, 400, CodeInvalidParameter)
	}
	// Both orders are fine when they differ.
	if code := r.get("/api/cost?by=kind&split=model", nil); code != 200 {
		t.Errorf("by=kind&split=model: %d", code)
	}
}
