package digest

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/terek/merlin/explorer/internal/claude/transcript"
	"github.com/terek/merlin/explorer/internal/fixtures"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/pricing"
)

// --- tiny hand-written transcript builder -------------------------------------------

type L map[string]any

func ts(sec int) string { return fmt.Sprintf("2026-09-30T10:%02d:%02dZ", sec/60, sec%60) }

func parent(p string) any {
	if p == "" {
		return nil
	}
	return p
}

func prompt(uuid, par string, sec int, text string) L {
	return L{"type": "user", "uuid": uuid, "parentUuid": parent(par), "timestamp": ts(sec),
		"message": L{"role": "user", "content": text}, "origin": L{"kind": "human"}, "promptSource": "typed"}
}

func toolResult(uuid, par string, sec int, toolUseID string) L {
	return L{"type": "user", "uuid": uuid, "parentUuid": parent(par), "timestamp": ts(sec),
		"message": L{"role": "user", "content": []L{{"type": "tool_result", "tool_use_id": toolUseID, "content": "ok"}}}}
}

func attach(uuid, par string, sec int) L {
	return L{"type": "attachment", "uuid": uuid, "parentUuid": parent(par), "timestamp": ts(sec), "attachment": L{"type": "x"}}
}

func text(s string) L { return L{"type": "text", "text": s} }
func tool(id, name string, in L) L {
	return L{"type": "tool_use", "id": id, "name": name, "input": in}
}

func usage(in, out int) L {
	return L{"input_tokens": in, "output_tokens": out, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
}

// assistant is one line of API message msgID.
func assistant(uuid, par string, sec int, msgID string, u L, blocks ...L) L {
	return L{"type": "assistant", "uuid": uuid, "parentUuid": parent(par), "timestamp": ts(sec),
		"message": L{"id": msgID, "role": "assistant", "model": "claude-sonnet-5-5", "content": blocks, "usage": u}}
}

func boundary(uuid, logical string, sec int) L {
	return L{"type": "system", "subtype": "compact_boundary", "uuid": uuid, "parentUuid": nil, "logicalParentUuid": parent(logical),
		"timestamp": ts(sec), "compactMetadata": L{"trigger": "auto", "preTokens": 1000, "postTokens": 100, "durationMs": 5}}
}

func summary(uuid, par string, sec int, body string) L {
	return L{"type": "user", "uuid": uuid, "parentUuid": parent(par), "timestamp": ts(sec), "isCompactSummary": true,
		"message": L{"role": "user", "content": body}}
}

func decode(t testing.TB, lines ...L) []*transcript.Record {
	t.Helper()
	var out []*transcript.Record
	for _, l := range lines {
		b, err := json.Marshal(l)
		if err != nil {
			t.Fatal(err)
		}
		r, err := transcript.Decode(b)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func reduce(t testing.TB, lines ...L) *FileResult {
	t.Helper()
	b := NewBuilder(pricing.Default())
	for _, r := range decode(t, lines...) {
		b.Apply(r)
	}
	return b.Result()
}

func abandonedFlags(res *FileResult) string {
	var sb strings.Builder
	for _, tn := range res.Turns {
		if tn.Abandoned {
			sb.WriteByte('A')
		} else {
			sb.WriteByte('.')
		}
	}
	return sb.String()
}

// --- tests --------------------------------------------------------------------------

func TestActivityBeforeFirstPromptKeepsItsCost(t *testing.T) {
	res := reduce(t,
		assistant("a1", "", 1, "m1", usage(1000, 100), text("resumed work")),
		prompt("p1", "a1", 5, "now what"),
		assistant("a2", "p1", 6, "m2", usage(1000, 100), text("ok")),
	)
	if len(res.Turns) != 2 {
		t.Fatalf("turns = %d", len(res.Turns))
	}
	t0 := res.Turns[0]
	if t0.Origin != model.OriginContinuation || t0.UserText != "" || t0.UUID != "" || t0.AssistantMessages != 1 || t0.FinalText != "resumed work" {
		t.Errorf("turn 0 = %+v", t0)
	}
	near(t, "turn 0", t0.Cost.USD, 0.003)
	near(t, "turn 1", res.Turns[1].Cost.USD, 0.003)
	near(t, "total", res.Cost.USD, 0.006)
	if res.Turns[1].Index != 1 || res.Turns[1].UserText != "now what" || res.Turns[0].Abandoned || res.Turns[1].Abandoned {
		t.Errorf("turn 1 = %+v", res.Turns[1])
	}
}

func TestFinalTextRule(t *testing.T) {
	long := strings.Repeat("x", 80)
	res := reduce(t,
		prompt("p1", "", 0, "q1"),
		assistant("a1", "p1", 1, "m1", usage(1, 1), text("first thought")),
		assistant("a2", "a1", 2, "m2", usage(1, 1), tool("t1", "Read", L{"file_path": "/x"})), // no text: skipped
		assistant("a3", "a2", 3, "m3", usage(1, 1), text("short")),
		prompt("p2", "a3", 4, "q2"),
		assistant("b1", "p2", 5, "m4", usage(1, 1), text("early")),
		assistant("b2", "b1", 6, "m5", usage(1, 1), text(long)), // 80 chars: stands alone
		prompt("p3", "b2", 7, "q3"),
		assistant("c1", "p3", 8, "m6", usage(1, 1), text("only one")), // short but nothing earlier
	)
	want := []string{"first thought\n\nshort", long, "only one"}
	for i, w := range want {
		if res.Turns[i].FinalText != w {
			t.Errorf("turn %d finalText = %q, want %q", i, res.Turns[i].FinalText, w)
		}
	}
}

func TestMessageTextAcrossLinesAndToolDedup(t *testing.T) {
	// Lines of one message may repeat a block; tool_use ids count once, text blocks join in order.
	res := reduce(t,
		prompt("p1", "", 0, "go"),
		assistant("a1", "p1", 1, "m1", usage(1, 5), L{"type": "thinking", "thinking": "hmm"}),
		assistant("a2", "a1", 2, "m1", usage(1, 6), text("part one")),
		assistant("a3", "a2", 3, "m1", usage(1, 7), tool("t1", "Edit", L{"file_path": "/a.go"}), text("part two")),
		assistant("a4", "a3", 4, "m1", usage(1, 8), tool("t1", "Edit", L{"file_path": "/a.go"})),
		toolResult("r1", "a4", 5, "t1"),
		assistant("a5", "r1", 6, "m2", usage(1, 9), tool("t2", "Write", L{"file_path": "/b.go"}), tool("t3", "NotebookEdit", L{"notebook_path": "/c.ipynb"}), tool("t4", "Edit", L{"file_path": "/a.go"})),
	)
	tn := res.Turns[0]
	if tn.AssistantMessages != 2 || tn.ToolCalls != 4 || tn.ToolsByName["Edit"] != 2 {
		t.Errorf("turn = %+v", tn)
	}
	if !equal(tn.FilesTouched, []string{"/a.go", "/b.go", "/c.ipynb"}) {
		t.Errorf("filesTouched = %v", tn.FilesTouched)
	}
	if tn.Cost.ByModel["claude-sonnet-5-5"].Output != 8+9 {
		t.Errorf("output = %d: last line of a message must win", tn.Cost.ByModel["claude-sonnet-5-5"].Output)
	}
}

func TestTextsAreWhole(t *testing.T) {
	big := strings.Repeat("0123456789", 30000) // 300 kB
	res := reduce(t,
		boundary("b1", "", 0),
		summary("s1", "b1", 1, big),
		prompt("p1", "s1", 2, big),
		assistant("a1", "p1", 3, "m1", usage(1, 1), text(big)),
	)
	if res.Compactions[0].Summary != big || res.Turns[0].UserText != big || res.Turns[0].FinalText != big {
		t.Error("a text was truncated")
	}
}

func TestCompactionEdgeCases(t *testing.T) {
	// Boundary in the middle of a turn: the turn is not split and keeps the epoch it started in.
	// A boundary without a summary: Summary stays empty and the next prompt is not mistaken for one.
	res := reduce(t,
		prompt("p1", "", 0, "q1"),
		assistant("a1", "p1", 1, "m1", usage(1, 1), text("working")),
		boundary("b1", "a1", 2),
		summary("s1", "b1", 3, "SUMMARY ONE"),
		assistant("a2", "s1", 4, "m2", usage(1, 1), text("still the same turn, long enough to stand on its own: "+strings.Repeat("y", 40))),
		prompt("p2", "a2", 5, "q2"),
		assistant("a3", "p2", 6, "m3", usage(1, 1), text("done")),
		boundary("b2", "a3", 7),
		prompt("p3", "b2", 8, "q3"),
	)
	if len(res.Turns) != 3 {
		t.Fatalf("turns = %d", len(res.Turns))
	}
	if res.Turns[0].Epoch != 0 || res.Turns[0].AssistantMessages != 2 || res.Turns[1].Epoch != 1 || res.Turns[2].Epoch != 2 {
		t.Errorf("epochs/messages: %+v %+v %+v", res.Turns[0], res.Turns[1], res.Turns[2])
	}
	c := res.Compactions
	if len(c) != 2 || c[0].Turn != 0 || c[0].Summary != "SUMMARY ONE" || c[1].Turn != 1 || c[1].Summary != "" {
		t.Errorf("compactions = %+v", c)
	}
	if res.Turns[0].Abandoned || res.Turns[1].Abandoned || res.Turns[2].Abandoned {
		t.Error("abandoned flags set on a linear chain across boundaries")
	}
	if res.Counters.UnattachedSummaries != 0 {
		t.Errorf("unattached = %d", res.Counters.UnattachedSummaries)
	}

	// A summary far from any boundary is counted, not attached to an earlier compaction.
	res = reduce(t,
		boundary("b1", "", 0),
		prompt("p1", "b1", 1, "q"), assistant("a1", "p1", 2, "m1", usage(1, 1), text("a")),
		prompt("p2", "a1", 3, "q"), assistant("a2", "p2", 4, "m2", usage(1, 1), text("a")),
		summary("s1", "a2", 5, "LATE"),
	)
	if res.Compactions[0].Summary != "" || res.Counters.UnattachedSummaries != 1 || len(res.Turns) != 2 {
		t.Errorf("compactions %+v counters %+v turns %d", res.Compactions, res.Counters, len(res.Turns))
	}
}

func TestAbandonedDanglingParentFlagsNothingBeforeBreak(t *testing.T) {
	// X is a separate earlier tree; the live chain starts at Y1, whose parent is missing.
	res := reduce(t,
		prompt("x1", "", 0, "old history one"),
		assistant("xa", "x1", 1, "m0", usage(1, 1), text("old")),
		prompt("x2", "xa", 2, "old history two"),
		prompt("y1", "gone", 3, "first after the break"),
		assistant("ya", "y1", 4, "m1", usage(1, 1), text("a")),
		prompt("y2", "ya", 5, "second"),
		assistant("yb", "y2", 6, "m2", usage(1, 1), text("b")),
	)
	if got := abandonedFlags(res); got != "...." {
		t.Errorf("flags = %s, want nothing flagged", got)
	}
	// After the break a real side branch is still found: y2' is a replaced sibling of y2.
	res = reduce(t,
		prompt("x1", "", 0, "old"),
		prompt("y1", "gone", 1, "head"),
		assistant("ya", "y1", 2, "m1", usage(1, 1), text("a")),
		prompt("y2", "ya", 3, "replaced"),
		prompt("y3", "ya", 4, "final"),
		assistant("yb", "y3", 5, "m2", usage(1, 1), text("b")),
	)
	if got := abandonedFlags(res); got != "..A." {
		t.Errorf("flags = %s, want ..A.", got)
	}
}

func TestAbandonedRewindAndParallelResults(t *testing.T) {
	res := reduce(t,
		prompt("p1", "", 0, "first"),
		assistant("a1", "p1", 1, "m1", usage(1, 1), text("one")),
		prompt("p2", "a1", 2, "replaced"),
		assistant("a2", "p2", 3, "m2", usage(1, 1), text("on the dead branch")),
		prompt("p3", "a1", 4, "retry"),
		assistant("a3", "p3", 5, "m3", usage(1, 1), tool("ta", "Read", L{}), tool("tb", "Read", L{})),
		toolResult("ra", "a3", 6, "ta"), // parallel results: siblings
		toolResult("rb", "a3", 7, "tb"),
		assistant("a4", "rb", 8, "m4", usage(1, 1), text("fin")),
	)
	if got := abandonedFlags(res); got != ".A." {
		t.Errorf("flags = %s, want .A.", got)
	}
	near(t, "abandoned cost still counts", res.Cost.USD, 4*(1*2+1*10)/1e6)

	// Only parallel results, no rewinds: nothing flagged.
	res = reduce(t,
		prompt("p1", "", 0, "go"),
		assistant("a1", "p1", 1, "m1", usage(1, 1), tool("ta", "Read", L{}), tool("tb", "Read", L{})),
		toolResult("ra", "a1", 2, "ta"),
		toolResult("rb", "a1", 3, "tb"),
		assistant("a2", "ra", 4, "m2", usage(1, 1), text("x")), // continues from the FIRST result
		prompt("p2", "a2", 5, "next"),
		assistant("a3", "p2", 6, "m3", usage(1, 1), text("y")),
	)
	if got := abandonedFlags(res); got != ".." {
		t.Errorf("flags = %s", got)
	}
}

func TestBrokenChainsNeverFlag(t *testing.T) {
	// Every record's parent is missing: the walk stops at once, and with nothing before it
	// nothing can be flagged. A parent cycle must terminate.
	res := reduce(t,
		prompt("p1", "ghost1", 0, "q1"),
		assistant("a1", "p1", 1, "m1", usage(1, 1), text("a")),
		prompt("p2", "ghost2", 2, "q2"),
		assistant("a2", "p2", 3, "m2", usage(1, 1), text("b")),
	)
	if got := abandonedFlags(res); got != ".." {
		t.Errorf("flags = %s", got)
	}
	res = reduce(t,
		prompt("p1", "p2", 0, "q1"),
		prompt("p2", "p1", 1, "q2"),
		assistant("a1", "p2", 2, "m1", usage(1, 1), text("a")),
	)
	if len(res.Turns) != 2 {
		t.Fatalf("turns = %d", len(res.Turns))
	}
	if got := abandonedFlags(res); got != ".." {
		t.Errorf("cycle flags = %s", got)
	}
	// No parent links at all (e.g. a very old format): nothing flagged.
	res = reduce(t,
		prompt("p1", "", 0, "q1"), assistant("a1", "", 1, "m1", usage(1, 1), text("a")),
		prompt("p2", "", 2, "q2"), assistant("a2", "", 3, "m2", usage(1, 1), text("b")),
	)
	if got := abandonedFlags(res); got != ".." {
		t.Errorf("flags = %s", got)
	}
}

func TestOrderIsByPositionNotTimestamp(t *testing.T) {
	// The second prompt carries an earlier timestamp: turn order is still file order.
	res := reduce(t,
		prompt("p1", "", 50, "first in file"),
		assistant("a1", "p1", 51, "m1", usage(1, 1), text("a")),
		prompt("p2", "a1", 10, "second in file"),
		assistant("a2", "p2", 11, "m2", usage(1, 1), text("b")),
	)
	if res.Turns[0].UserText != "first in file" || res.Turns[1].UserText != "second in file" {
		t.Errorf("turns = %+v", res.Turns)
	}
	if res.FirstTimestamp.Format("15:04:05") != "10:00:10" || res.LastTimestamp.Format("15:04:05") != "10:00:51" {
		t.Errorf("first/last = %v %v", res.FirstTimestamp, res.LastTimestamp)
	}
}

func TestInterruptionFlagsOnlyPreviousTurn(t *testing.T) {
	marker := L{"type": "user", "uuid": "m1", "parentUuid": "a1", "timestamp": ts(2),
		"message": L{"role": "user", "content": []L{text("[Request interrupted by user for tool use]")}}}
	res := reduce(t,
		prompt("p1", "", 0, "q1"),
		assistant("a1", "p1", 1, "m1", usage(1, 1), text("partial")),
		marker,
		prompt("p2", "m1", 3, "q2"),
	)
	if len(res.Turns) != 2 || !res.Turns[0].Interrupted || res.Turns[1].Interrupted {
		t.Errorf("turns = %+v", res.Turns)
	}
	// A marker before any turn starts nothing and flags nothing.
	res = reduce(t, marker)
	if len(res.Turns) != 0 {
		t.Errorf("turns = %+v", res.Turns)
	}
}

func TestMessageWithoutID(t *testing.T) {
	res := reduce(t,
		prompt("p1", "", 0, "q"),
		assistant("a1", "p1", 1, "", usage(1000, 100), text("one")),
		assistant("a2", "a1", 2, "", usage(1000, 100), text("two")),
	)
	if len(res.Messages) != 2 || res.Messages[0].ID != "uuid:a1" {
		t.Errorf("messages = %+v", res.Messages)
	}
}

func TestIgnoredAndMalformedRecords(t *testing.T) {
	b := NewBuilder(pricing.Default())
	for _, l := range []string{
		`{"type":"hologram","uuid":"u1"}`,
		`{"type":"assistant","uuid":"a1","timestamp":"2026-09-30T10:00:00Z","message":"not an object"}`,
		`{"type":"file-history-snapshot","messageId":"x"}`,
		`{"type":"queue-operation","operation":"enqueue"}`,
		`{"type":"user","uuid":"p1","timestamp":"bad time","message":{"content":[]}}`,
	} {
		r, err := transcript.Decode([]byte(l))
		if err != nil {
			t.Fatal(err)
		}
		b.Apply(r)
	}
	b.Apply(nil)
	res := b.Result()
	if res.Diagnostics.UnknownTypes["hologram"] != 1 || len(res.Diagnostics.UnknownTypes) != 1 {
		t.Errorf("unknown = %v", res.Diagnostics.UnknownTypes)
	}
	if res.Counters.MalformedRecords != 1 || len(res.Turns) != 1 || res.Turns[0].UserText != "" {
		t.Errorf("counters %+v turns %+v", res.Counters, res.Turns)
	}
}

func TestEmptyBuilder(t *testing.T) {
	res := NewBuilder(pricing.Default()).Result()
	if len(res.Turns) != 0 || res.Cost.USD != 0 || !res.FirstTimestamp.IsZero() {
		t.Errorf("result = %+v", res)
	}
}

// --- reducer property ---------------------------------------------------------------

// allFixtureFiles lists every transcript file in the fixture tree (main and agent files).
func allFixtureFiles(t testing.TB) []string {
	t.Helper()
	var out []string
	root := filepath.Join(fixtures.ClaudeDir(), "projects")
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(p, ".jsonl") {
			return nil
		}
		base := filepath.Base(p)
		isMain := len(base) == len("00000000-0000-0000-0000-000000000000.jsonl") && strings.Count(base, "-") == 4
		if isMain || strings.HasPrefix(base, "agent-") {
			out = append(out, p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) < 40 {
		t.Fatalf("only %d fixture files found", len(out))
	}
	return out
}

func TestReducerHalvesEqualWhole(t *testing.T) {
	for _, path := range allFixtureFiles(t) {
		recs, bad := readAll(t, path)
		whole := NewBuilder(pricing.Default())
		for _, r := range recs {
			whole.Apply(r)
		}
		whole.AddBadLines(bad)
		want := whole.Result()

		n := len(recs)
		for _, k := range []int{0, 1, n / 3, n / 2, n - 1, n} {
			if k < 0 || k > n {
				continue
			}
			b := NewBuilder(pricing.Default())
			for _, r := range recs[:k] {
				b.Apply(r)
			}
			_ = b.Result() // finalising mid-way must not disturb the state
			_ = b.Result()
			for _, r := range recs[k:] {
				b.Apply(r)
			}
			b.AddBadLines(bad)
			got := b.Result()
			if !reflect.DeepEqual(got, want) {
				t.Errorf("%s split at %d/%d: result differs from the whole-file result", filepath.Base(path), k, n)
			}
		}
		if again := whole.Result(); !reflect.DeepEqual(again, want) {
			t.Errorf("%s: Result() is not repeatable", filepath.Base(path))
		}
	}
}

func TestResultIsDeterministicAndIndependent(t *testing.T) {
	recs, _ := readAll(t, fixturePath(t, "16161616-0000-4000-8000-000000000001"))
	var first *FileResult
	for i := 0; i < 20; i++ { // map iteration order must not leak
		b := NewBuilder(pricing.Default())
		for _, r := range recs {
			b.Apply(r)
		}
		res := b.Result()
		if first == nil {
			first = res
			continue
		}
		if !reflect.DeepEqual(first, res) {
			t.Fatal("results differ between runs")
		}
	}
	b := NewBuilder(pricing.Default())
	for _, r := range recs {
		b.Apply(r)
	}
	r1 := b.Result()
	r1.Turns[0].UserText = "mutated"
	r1.Compactions = append(r1.Compactions, model.Compaction{})
	r1.Messages[0].USD = 99
	if r2 := b.Result(); r2.Turns[0].UserText == "mutated" || r2.Messages[0].USD == 99 {
		t.Error("mutating a Result changed the Builder")
	}
}

func TestAgentFilesReduceLikeMainFiles(t *testing.T) {
	// Agent files use the same segmentation: first prompt, tool-heavy work, later inbox prompts.
	root := filepath.Join(fixtures.ClaudeDir(), "projects", "-home-dev-acme-team")
	var path string
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err == nil && strings.HasSuffix(p, "agent-areviewer-09e0c0de00000001.jsonl") {
			path = p
		}
		return nil
	})
	if path == "" {
		t.Fatal("teammate fixture not found")
	}
	recs, _ := readAll(t, path)
	b := NewBuilder(pricing.Default())
	for _, r := range recs {
		b.Apply(r)
	}
	res := b.Result()
	if len(res.Turns) != 2 || res.Turns[1].Origin != model.OriginPeer || res.Turns[1].UserText != "" ||
		len(res.Turns[1].Inbox) != 1 || res.Turns[1].Inbox[0].Text != "Please also check the tests." {
		t.Fatalf("turns = %+v", res.Turns)
	}
	if !equal(res.AgentIDs, []string{"areviewer-09e0c0de00000001"}) {
		t.Errorf("agentIds = %v", res.AgentIDs)
	}
	near(t, "cost", res.Cost.USD, 0.0071+0.0021+0.00185)
}

func TestFeedReader(t *testing.T) {
	r, err := transcript.Open(fixturePath(t, "17171717-0000-4000-8000-000000000001"))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	b := NewBuilder(pricing.Default())
	if err := b.Feed(r); err != nil {
		t.Fatal(err)
	}
	res := b.Result()
	if res.Diagnostics.BadLines != 1 || len(res.Turns) != 3 || res.Diagnostics.UnknownTypes["hologram-state"] != 1 {
		t.Errorf("diagnostics %+v turns %d", res.Diagnostics, len(res.Turns))
	}
	if !reflect.DeepEqual(res, build(t, "17171717-0000-4000-8000-000000000001")) {
		t.Error("Feed differs from Apply")
	}
}
