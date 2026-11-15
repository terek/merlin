package catalog

import (
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

func ctxTok(n int64) model.Tokens {
	return model.Tokens{Input: 10, CacheRead: n - 30, CacheWrite5m: 10, CacheWrite1h: 10}
}

// peakSession: the main thread peaks at 150k, a subagent at 260k; a call of exactly 200000 is
// deep; a call outside the range does not count; an agent that started before the range counts
// only its calls inside it; a compact agent's call is the main thread's; a review agent has no span.
func peakSession() *model.SessionDigest {
	zero := 0
	p := syn("claude", "p", "/w", 0, 60, []model.Turn{turn(0, "u0", "go", 0)}, msgSpec{"m0", 0, 0.5, 0})
	p.Messages = nil
	p.Agents = []model.Agent{
		ovAgent("a1", model.AgentSubagent, 8, 20, &zero),
		ovAgent("a2", model.AgentSubagent, -100, 30, &zero), // started before the range
	}
	msg(p, "m1", 5, 1, "", ctxTok(150000))
	msg(p, "m2", 6, 0.25, "", ctxTok(50000))
	msg(p, "a1-1", 9, 0.5, "a1", ctxTok(120000))
	msg(p, "a1-2", 10, 2, "a1", ctxTok(260000))
	msg(p, "a1-3", 12, 4, "a1", ctxTok(200000))   // exactly the deep threshold
	msg(p, "a1-4", 400, 8, "a1", ctxTok(900000))  // outside the range
	msg(p, "a2-0", -60, 16, "a2", ctxTok(700000)) // before the range
	msg(p, "a2-1", 15, 3, "a2", ctxTok(210000))
	return p
}

func TestOverviewPeakAndDeep(t *testing.T) {
	o, err := ovCatalog(peakSession()).Overview(ovQuery(time.Hour, 3))
	if err != nil {
		t.Fatal(err)
	}
	l := laneOf(t, o, "p")
	if l.Peak != 260000 || l.PeakAgentID != "a1" || l.PeakAgentKind != "" || !l.PeakAt.Equal(at(10)) {
		t.Errorf("lane peak %d at %v by %q (%q), want 260000 at %v by a1", l.Peak, l.PeakAt, l.PeakAgentID, l.PeakAgentKind, at(10))
	}
	wantNear(t, "lane deepUSD", l.DeepUSD, 2+4+3)
	byAgent := map[string]OverviewSpan{}
	for _, s := range l.Spans {
		byAgent[s.AgentID] = s
	}
	if s := byAgent["a1"]; s.Peak != 260000 || !near(s.DeepUSD, 6) {
		t.Errorf("span a1: %+v, want peak 260000 deepUSD 6 (the call at 400 min is outside)", s)
	}
	// Started before the range, listed because it overlaps: counted in range only.
	if s := byAgent["a2"]; s.Peak != 210000 || !near(s.DeepUSD, 3) {
		t.Errorf("span a2: %+v, want peak 210000 deepUSD 3 (the 700k call is before the range)", s)
	}
}

func TestOverviewPeakCompactAndReviewAgents(t *testing.T) {
	zero := 0
	d := syn("claude", "c", "/w", 0, 60, []model.Turn{turn(0, "u0", "go", 0)})
	d.Agents = []model.Agent{ovAgent("k1", model.AgentCompact, 20, 21, &zero), ovAgent("r1", model.AgentReview, 30, 31, &zero)}
	msg(d, "m1", 5, 1, "", ctxTok(180000))
	msg(d, "k1-1", 20, 7, "k1", ctxTok(310000))
	o, err := ovCatalog(d).Overview(ovQuery(time.Hour, 3))
	if err != nil {
		t.Fatal(err)
	}
	l := laneOf(t, o, "c")
	if l.Peak != 310000 || l.PeakAgentID != "" || l.PeakAgentKind != "" || !near(l.DeepUSD, 7) {
		t.Errorf("compaction peak: %d by %q (%q), deepUSD %v; want 310000, main thread, 7", l.Peak, l.PeakAgentID, l.PeakAgentKind, l.DeepUSD)
	}
	msg(d, "r1-1", 30, 5, "r1", ctxTok(400000)) // a review agent has no span
	o, _ = ovCatalog(d).Overview(ovQuery(time.Hour, 3))
	l = laneOf(t, o, "c")
	if l.Peak != 400000 || l.PeakAgentID != "r1" || l.PeakAgentKind != "review" || !near(l.DeepUSD, 12) {
		t.Errorf("review peak: %d by %q (%q), deepUSD %v", l.Peak, l.PeakAgentID, l.PeakAgentKind, l.DeepUSD)
	}
}

func TestOverviewPeakTieTakesTheEarliest(t *testing.T) {
	d := syn("claude", "t", "/w", 0, 60, []model.Turn{turn(0, "u0", "go", 0)})
	msg(d, "m2", 9, 1, "", ctxTok(1000))
	msg(d, "m1", 5, 1, "", ctxTok(1000))
	o, _ := ovCatalog(d).Overview(ovQuery(time.Hour, 3))
	if l := laneOf(t, o, "t"); !l.PeakAt.Equal(at(5)) || l.DeepUSD != 0 {
		t.Errorf("tie: %v deep %v", l.PeakAt, l.DeepUSD)
	}
}

func depthRows(c *Catalog, f Filter, dims ...Dim) map[string]Row {
	out := map[string]Row{}
	for _, r := range c.Rollup(f, append([]Dim{ByDepth}, dims...)...) {
		k := r.Depth
		if len(dims) > 0 {
			k += "/" + r.Key(dims[0])
		}
		out[k] = r
	}
	return out
}

// depthCatalog: a session with calls in three bands, one at exactly 200000, inside a window that
// reports more than they cost; a second one without windows with a subagent; a codex one.
func depthCatalog() *Catalog {
	a := syn("claude", "a", "/w", 0, 60, []model.Turn{turn(0, "ua", "go", 0)})
	msg(a, "a1", 1, 1, "", ctxTok(50000))
	msg(a, "a2", 2, 2, "", ctxTok(150000))
	msg(a, "a3", 3, 4, "", ctxTok(200000))
	msg(a, "a4", 4, 8, "", ctxTok(600000))
	withWindows(a, window(0, 10, 20)) // 15 covered, 5 overhead
	b := syn("claude", "b", "/w", 0, 60, []model.Turn{turn(0, "ub", "go", 0)})
	b.Agents = []model.Agent{ovAgent("g1", model.AgentSubagent, 1, 9, nil)}
	msg(b, "b1", 1, 0.5, "", ctxTok(99999))
	msg(b, "b2", 2, 0.25, "g1", ctxTok(499999))
	msg(b, "b3", 3, 0.125, "g1", ctxTok(500000))
	x := syn("codex", "x", "/w", 0, 60, []model.Turn{turn(0, "ux", "go", 0)})
	msg(x, "x1", 1, 100, "", ctxTok(300000))
	// Compaction calls: the band of the call's context, none without a count.
	b.Compactions = []model.Compaction{
		{At: at(5), Call: &model.CompactionCall{Model: "sonnet", InputTokens: 250000, USD: 1}},
		{At: at(6), Call: &model.CompactionCall{Model: "sonnet", USD: 1}},
	}
	return ovCatalog(a, b, x)
}

func TestRollupByDepth(t *testing.T) {
	c := depthCatalog()
	rows := depthRows(c, Filter{})
	want := map[string]float64{"0-100k": 1 + 0.5, "100k-200k": 2, "200k-500k": 4 + 0.25 + 100, "500k+": 8 + 0.125, OverheadDepth: 5}
	if len(rows) != len(want) {
		t.Errorf("rows %v", rows)
	}
	for k, w := range want {
		wantNear(t, k, rows[k].TotalUSD, w)
	}
	if rows["200k-500k"].Compactions.Calls != 1 || rows[OverheadDepth].Compactions.Calls != 1 {
		t.Errorf("compaction tallies: %+v %+v", rows["200k-500k"].Compactions, rows[OverheadDepth].Compactions)
	}
	// Totals equal those of by=model, whatever the filter.
	for _, f := range []Filter{{}, {Harness: "claude"}, {Harness: "codex"}, {From: at(2), To: at(4)}} {
		sum, byModel := 0.0, 0.0
		for _, r := range c.Rollup(f, ByDepth) {
			sum += r.TotalUSD
		}
		for _, r := range c.Rollup(f, ByModel) {
			byModel += r.TotalUSD
		}
		wantNear(t, "sum by depth vs model", sum, byModel)
		wantNear(t, "total", c.Total(f).TotalUSD, byModel)
	}
	// The harness filter.
	h := depthRows(c, Filter{Harness: "codex"})
	if len(h) != 1 || !near(h["200k-500k"].TotalUSD, 100) {
		t.Errorf("codex: %v", h)
	}
	// A deep lane over the same scope equals the two deep rows.
	o, _ := c.Overview(ovQuery(time.Hour, 3))
	deep := 0.0
	for _, l := range o.Lanes {
		deep += l.DeepUSD
	}
	wantNear(t, "deepUSD", deep, rows["200k-500k"].TotalUSD+rows["500k+"].TotalUSD)
}

func TestRollupByDepthSplit(t *testing.T) {
	c := depthCatalog()
	rows := depthRows(c, Filter{}, ByAgent)
	wantNear(t, "200k-500k/agents", rows["200k-500k/agents"].TotalUSD, 0.25)
	wantNear(t, "200k-500k/main", rows["200k-500k/main"].TotalUSD, 104)
	wantNear(t, "500k+/agents", rows["500k+/agents"].TotalUSD, 0.125)
	wantNear(t, "overhead/(unsplit)", rows[OverheadDepth+"/(unsplit)"].TotalUSD, 5)
	// split=depth works from the other side too.
	sp := depthRows(c, Filter{}, ByModel)
	wantNear(t, "sonnet 500k+", sp["500k+/sonnet"].TotalUSD, 8.125)
}
