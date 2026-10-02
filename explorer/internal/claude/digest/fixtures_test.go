package digest

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

const eps = 1e-9

func near(t testing.TB, what string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > eps {
		t.Errorf("%s = %.12f, want %.12f", what, got, want)
	}
}

// wantTurn is the expected shape of one turn. Cost is hand-computed from testdata/README.md.
type wantTurn struct {
	origin      model.TurnOrigin
	text        string // userText (prefix match when it ends with "...")
	final       string
	cost        float64
	msgs        int64
	interrupted bool
	abandoned   bool
	epoch       int
	command     string
}

func checkTurns(t *testing.T, res *FileResult, want []wantTurn) {
	t.Helper()
	if len(res.Turns) != len(want) {
		t.Fatalf("turns = %d, want %d", len(res.Turns), len(want))
	}
	var sum float64
	for i, w := range want {
		g := res.Turns[i]
		if g.Index != i {
			t.Errorf("turn %d: Index = %d", i, g.Index)
		}
		if g.Origin != w.origin {
			t.Errorf("turn %d: origin = %q, want %q", i, g.Origin, w.origin)
		}
		if strings.HasSuffix(w.text, "...") {
			if !strings.HasPrefix(g.UserText, strings.TrimSuffix(w.text, "...")) {
				t.Errorf("turn %d: userText = %q, want prefix %q", i, g.UserText, w.text)
			}
		} else if g.UserText != w.text {
			t.Errorf("turn %d: userText = %q, want %q", i, g.UserText, w.text)
		}
		if g.FinalText != w.final {
			t.Errorf("turn %d: finalText = %q, want %q", i, g.FinalText, w.final)
		}
		if g.Interrupted != w.interrupted {
			t.Errorf("turn %d: interrupted = %v", i, g.Interrupted)
		}
		if g.Abandoned != w.abandoned {
			t.Errorf("turn %d: abandoned = %v", i, g.Abandoned)
		}
		if g.Epoch != w.epoch {
			t.Errorf("turn %d: epoch = %d, want %d", i, g.Epoch, w.epoch)
		}
		if g.Command != w.command {
			t.Errorf("turn %d: command = %q, want %q", i, g.Command, w.command)
		}
		if g.AssistantMessages != w.msgs {
			t.Errorf("turn %d: assistantMessages = %d, want %d", i, g.AssistantMessages, w.msgs)
		}
		near(t, "turn cost", g.Cost.USD, w.cost)
		near(t, "turn costWithAgents", g.CostWithAgents, w.cost)
		sum += g.Cost.USD
	}
	near(t, "sum of turn costs", sum, res.Cost.USD)
	var msgSum float64
	for _, m := range res.Messages {
		msgSum += m.USD
	}
	near(t, "sum of message costs", msgSum, res.Cost.USD)
}

func TestPlain(t *testing.T) {
	res := build(t, "01010101-0000-4000-8000-000000000001")
	checkTurns(t, res, []wantTurn{
		{origin: model.OriginHuman, text: "add a login page", final: "Done, 3 files changed", cost: 0.011 + 0.0046 + 0.0012, msgs: 3},
		{origin: model.OriginHuman, text: "now add a logout button", final: "Logout button added", cost: 0.0031 + 0.00134, msgs: 2},
	})
	near(t, "total", res.Cost.USD, 0.02124)
	if len(res.Messages) != 5 || res.AITitle != "Add login page" {
		t.Errorf("messages = %d, title = %q", len(res.Messages), res.AITitle)
	}
	t0 := res.Turns[0]
	if t0.ToolCalls != 2 || t0.ToolsByName["Edit"] != 1 || t0.ToolsByName["Read"] != 1 {
		t.Errorf("tools = %d %v", t0.ToolCalls, t0.ToolsByName)
	}
	if len(t0.FilesTouched) != 1 || t0.FilesTouched[0] != "/home/dev/acme/plain/login.tsx" {
		t.Errorf("filesTouched = %v", t0.FilesTouched)
	}
	if t0.DurationMs != 12000 || res.Turns[1].DurationMs != 8000 {
		t.Errorf("durations = %d, %d (turn_duration records)", t0.DurationMs, res.Turns[1].DurationMs)
	}
	// Context of the turn = input + cache read + cache creation of its last billed message (msg_plain_03).
	if t0.ContextTokens != 100+2500 {
		t.Errorf("contextTokens = %d", t0.ContextTokens)
	}
	if !t0.EndedAt.After(t0.StartedAt) || t0.StartedAt.Format(time.RFC3339) != "2026-09-01T10:00:00Z" {
		t.Errorf("turn times = %v .. %v", t0.StartedAt, t0.EndedAt)
	}
	if res.Counters.DuplicateUUIDs != 0 || res.Diagnostics.BadLines != 0 {
		t.Errorf("counters = %+v diag = %+v", res.Counters, res.Diagnostics)
	}
	for _, m := range res.Messages {
		if m.AgentID != "" || m.Turn == nil {
			t.Errorf("message %s: agent %q turn %v", m.ID, m.AgentID, m.Turn)
		}
	}
}

func TestMultiLineMessageCountedOnceWithLastUsage(t *testing.T) {
	res := build(t, "02020202-0000-4000-8000-000000000001")
	if len(res.Messages) != 2 {
		t.Fatalf("messages = %d, want 2 (5 assistant lines)", len(res.Messages))
	}
	if res.Messages[0].ID != "msg_multi_01" || res.Messages[0].Output != 120 {
		t.Errorf("first message = %+v: usage must come from the last line", res.Messages[0])
	}
	near(t, "msg_multi_01", res.Messages[0].USD, 0.0112)
	near(t, "msg_multi_02", res.Messages[1].USD, 0.00165)
	checkTurns(t, res, []wantTurn{{
		origin: model.OriginHuman, text: "list the exported functions in utils.ts", msgs: 2, cost: 0.01285,
		// the last message's text is 40 chars: the previous text message is prepended
		final: "Let me look at the file.\n\nutils.ts exports two functions:\nslugify and clamp.",
	}})
	if res.Turns[0].ToolCalls != 1 {
		t.Errorf("toolCalls = %d, want 1", res.Turns[0].ToolCalls)
	}
}

func TestSlashCommandsAndLocalOutput(t *testing.T) {
	res := build(t, "03030303-0000-4000-8000-000000000001")
	checkTurns(t, res, []wantTurn{
		// Command turns store what the user typed, not the harness's tag wrapping.
		{origin: model.OriginCommand, text: "/model sonnet", command: "model"},
		{origin: model.OriginHuman, text: "add a logout button", final: "Added the logout button.", cost: 0.0108, msgs: 1},
		{origin: model.OriginCommand, text: "/review the login page", command: "review", final: "Review: the login page looks fine.", cost: 0.0024, msgs: 1},
		{origin: model.OriginCommand, text: "!ls src", command: "!"},
	})
	near(t, "total", res.Cost.USD, 0.0132)
	if res.CustomTitle != "My logout work" || res.AITitle != "Logout and review" {
		t.Errorf("titles: custom %q ai %q (last of each kind wins)", res.CustomTitle, res.AITitle)
	}
	if strings.Contains(res.Turns[2].UserText, "<command-") {
		t.Errorf("command text must not keep the tag wrapping: %q", res.Turns[2].UserText)
	}
	if !strings.Contains(res.Versions[0], "2.1.150") {
		t.Errorf("versions = %v", res.Versions)
	}
}

func TestInterruption(t *testing.T) {
	res := build(t, "04040404-0000-4000-8000-000000000001")
	h := model.OriginHuman
	checkTurns(t, res, []wantTurn{
		{origin: h, text: "refactor the router", final: "Starting the refactor of router.ts.", cost: 0.0104, msgs: 1, interrupted: true},
		{origin: h, text: "actually, rename router.ts to routes.ts", final: "Renamed router.ts to routes.ts", cost: 0.0026 + 0.00098, msgs: 2},
		{origin: h, text: "add tests for routes.ts", cost: 0.0017, msgs: 1, interrupted: true},
		{origin: h, text: "use the built-in runner instead", final: "Added routes.test.ts using the built-in runner", cost: 0.00124, msgs: 1},
		{origin: h, text: "rename routes.ts to paths.ts", final: "Renaming now", cost: 0.00096, msgs: 1, interrupted: true},
		{origin: h, text: "stop, keep the old name", final: "Okay, keeping routes.ts", cost: 0.00098, msgs: 1},
		{origin: h, text: "add a changelog entry", final: "Drafting the entry", cost: 0.001, msgs: 1, interrupted: true},
		{origin: h, text: "use tabs not spaces", final: "Switched to tabs", cost: 0.00102, msgs: 1},
	})
	near(t, "total", res.Cost.USD, 0.02088)
}

func TestCompactionTwoPairs(t *testing.T) {
	res := build(t, "05050505-0000-4000-8000-000000000001")
	h := model.OriginHuman
	checkTurns(t, res, []wantTurn{
		{origin: h, text: "set up the database layer", final: "Database layer created", cost: 0.011 + 0.003, msgs: 2},
		{origin: h, text: "add migrations", final: "Migrations added", cost: 0.0015, msgs: 1},
		{origin: h, text: "add seed data", final: "Seed data added", cost: 0.0012, msgs: 1, epoch: 1},
		{origin: h, text: "add an index on email", final: "Index added", cost: 0.00126, msgs: 1, epoch: 2},
	})
	near(t, "total", res.Cost.USD, 0.01796)
	if len(res.Compactions) != 2 {
		t.Fatalf("compactions = %d", len(res.Compactions))
	}
	c0, c1 := res.Compactions[0], res.Compactions[1]
	if c0.Turn != 1 || c0.Trigger != model.TriggerAuto || c0.PreTokens != 150000 || c0.PostTokens != 12000 || c0.DurationMs != 8000 {
		t.Errorf("compaction 0 = %+v", c0)
	}
	if !strings.HasSuffix(c0.Summary, "The database layer and migrations exist.") || !strings.HasPrefix(c0.Summary, "This session is being continued") {
		t.Errorf("summary 0 not whole: %q", c0.Summary)
	}
	// Second boundary: logicalParentUuid not in the file, no postTokens, summary at +2.
	if c1.Turn != 2 || c1.Trigger != model.TriggerManual || c1.PreTokens != 90000 || c1.PostTokens != 0 || c1.DurationMs != 5000 {
		t.Errorf("compaction 1 = %+v", c1)
	}
	if !strings.HasSuffix(c1.Summary, "Seed data was added after the first compaction.") {
		t.Errorf("summary 1 = %q (dangling logicalParentUuid, summary two records later)", c1.Summary)
	}
	if !c0.At.Before(c1.At) || c0.At.IsZero() {
		t.Errorf("compaction times: %v %v", c0.At, c1.At)
	}
	for _, tn := range res.Turns {
		if tn.Abandoned {
			t.Errorf("turn %d abandoned: a dangling logicalParentUuid must not flag history", tn.Index)
		}
	}
	// A compaction summary is not a turn: 4 prompts, 4 turns.
	if res.Counters.UnattachedSummaries != 0 {
		t.Errorf("unattached summaries = %d", res.Counters.UnattachedSummaries)
	}
}

func TestCompactionFileBeginsWithBoundary(t *testing.T) {
	res := build(t, "05050505-0000-4000-8000-000000000002")
	if len(res.Compactions) != 1 {
		t.Fatalf("compactions = %d", len(res.Compactions))
	}
	c := res.Compactions[0]
	if c.Turn != -1 || c.Trigger != model.TriggerManual || c.PreTokens != 70000 || c.PostTokens != 9000 || c.DurationMs != 4000 {
		t.Errorf("compaction = %+v", c)
	}
	if !strings.HasSuffix(c.Summary, "A repository layer was planned in an earlier session.") {
		t.Errorf("summary = %q", c.Summary)
	}
	// Epoch is "number of compactions before this turn" (digest-schema.md): 1.
	checkTurns(t, res, []wantTurn{{origin: model.OriginHuman, text: "continue with the repository layer",
		final: "Repository layer continued", cost: 0.0056, msgs: 1, epoch: 1}})
}

func TestRepeatedUUIDsSkipped(t *testing.T) {
	res := build(t, "05050505-0000-4000-8000-000000000003")
	h := model.OriginHuman
	checkTurns(t, res, []wantTurn{
		{origin: h, text: "add a cache layer", final: "Cache layer added", cost: 0.0105, msgs: 1},
		{origin: h, text: "add cache expiry", final: "Expiry added", cost: 0.0014, msgs: 1},
	})
	near(t, "total", res.Cost.USD, 0.0119)
	if res.Counters.DuplicateUUIDs != 2 || len(res.Messages) != 2 {
		t.Errorf("duplicates = %d, messages = %d", res.Counters.DuplicateUUIDs, len(res.Messages))
	}
	for _, m := range res.Messages {
		if m.ID == "msg_cmpc_dup" {
			t.Error("the duplicate message was counted")
		}
	}
}

func TestRewind(t *testing.T) {
	res := build(t, "14141414-0000-4000-8000-000000000001")
	h := model.OriginHuman
	checkTurns(t, res, []wantTurn{
		{origin: h, text: "scaffold the app", final: "Scaffolded", cost: 0.0106, msgs: 1},
		{origin: h, text: "add a settings page", final: "Settings page added", cost: 0.0018, msgs: 1, abandoned: true},
		{origin: h, text: "add a profile page instead", final: "Profile page added", cost: 0.00184, msgs: 1},
		{origin: h, text: "add dark mode", abandoned: true}, // replaced before any response
		{origin: h, text: "add light mode", final: "Light mode added", cost: 0.0019, msgs: 1},
		// two parallel tool results are siblings, not a branch
		{origin: h, text: "rename both config files", final: "Both config files renamed", cost: 0.00244 + 0.00118, msgs: 2},
	})
	near(t, "total (abandoned cost still counts)", res.Cost.USD, 0.01976)
	if res.Turns[5].ToolCalls != 2 {
		t.Errorf("toolCalls = %d", res.Turns[5].ToolCalls)
	}
	if res.LastPromptLeaf == "" || res.LastPrompt != "rename both config files" {
		t.Errorf("last-prompt = %q %q", res.LastPrompt, res.LastPromptLeaf)
	}
}

func TestHostileInput(t *testing.T) {
	res := build(t, "17171717-0000-4000-8000-000000000001")
	h := model.OriginHuman
	checkTurns(t, res, []wantTurn{
		{origin: h, text: "add input validation", final: "Validation added", cost: 0.011 + 0.0019, msgs: 2},
		{origin: h, text: "now handle empty strings"}, // answered only by a synthetic API error
		{origin: h, text: "try again", final: "Empty strings handled", cost: 0.00104, msgs: 1},
	})
	near(t, "total", res.Cost.USD, 0.01394)
	if res.Diagnostics.BadLines != 1 {
		t.Errorf("badLines = %d, want 1 (the unterminated tail is not consumed)", res.Diagnostics.BadLines)
	}
	if got := res.Diagnostics.UnknownTypes; len(got) != 1 || got["hologram-state"] != 1 {
		t.Errorf("unknownTypes = %v", got)
	}
	if res.Counters.SyntheticMessages != 1 {
		t.Errorf("synthetic = %d", res.Counters.SyntheticMessages)
	}
	for _, m := range res.Messages {
		if m.ID == "msg_host_synth" {
			t.Error("synthetic message is in messages")
		}
	}
	if len(res.Diagnostics.UnpricedModels) != 0 {
		t.Errorf("synthetic must not be reported unpriced: %v", res.Diagnostics.UnpricedModels)
	}
}

func TestPricingEdges(t *testing.T) {
	res := build(t, "20202020-0000-4000-8000-000000000001")
	want := map[string]float64{"msg_px_01": 0.0132, "msg_px_02": 0.012, "msg_px_03": 0, "msg_px_04": 0.0015}
	if len(res.Messages) != 4 {
		t.Fatalf("messages = %d", len(res.Messages))
	}
	for _, m := range res.Messages {
		near(t, m.ID, m.USD, want[m.ID])
	}
	if got := res.Diagnostics.UnpricedModels; len(got) != 1 || got[0] != "claude-nova-9-9" {
		t.Errorf("unpricedModels = %v", got)
	}
	near(t, "total", res.Cost.USD, 0.0267)
	if mc := res.Cost.ByModel["claude-opus-5-5"]; mc.CacheWrite5m != 400 || mc.CacheWrite1h != 600 {
		t.Errorf("opus cost = %+v", mc)
	}
	if _, ok := res.Cost.ByModel["claude-nova-9-9"]; ok {
		t.Error("unpriced model must not appear in Cost.ByModel")
	}
	if res.Messages[2].Input != 1000 {
		t.Errorf("unpriced message keeps its tokens: %+v", res.Messages[2])
	}
}

func TestDayBoundary(t *testing.T) {
	res := build(t, "19191919-0000-4000-8000-000000000001")
	checkTurns(t, res, []wantTurn{
		{origin: model.OriginHuman, text: "add a footer", final: "Footer added", cost: 0.011, msgs: 1},
		{origin: model.OriginHuman, text: "add a header", final: "Header added", cost: 0.0026 + 0.00148, msgs: 2},
		{origin: model.OriginHuman, text: "add a sidebar", final: "Sidebar added", cost: 0.0016, msgs: 1},
	})
	// Messages carry their own UTC instants, so the catalog can bucket them by local day.
	wantAt := []string{"03:50:10", "03:59:50", "04:00:30", "04:05:20"}
	for i, m := range res.Messages {
		if got := m.At.Format("15:04:05"); got != wantAt[i] || m.At.Location() != time.UTC {
			t.Errorf("message %d at %v", i, m.At)
		}
	}
	if res.Turns[1].DurationMs != 62000 {
		t.Errorf("turn 2 duration = %d", res.Turns[1].DurationMs)
	}
}

func TestCwdChange(t *testing.T) {
	res := build(t, "18181818-0000-4000-8000-000000000001")
	wantCwd := []string{"/home/dev/acme/cwdchange", "/home/dev/acme/cwdchange-wt", "/home/dev/acme/cwdchange-moved"}
	if !equal(res.Cwds, wantCwd) {
		t.Errorf("cwds = %v", res.Cwds)
	}
	if !equal(res.GitBranches, []string{"main", "worktree-login"}) {
		t.Errorf("branches = %v (unique, first-appearance order)", res.GitBranches)
	}
	near(t, "total", res.Cost.USD, 0.01364)
}

func TestSDKOneShotAndCostState(t *testing.T) {
	res := build(t, "15151515-0000-4000-8000-000000000001")
	checkTurns(t, res, []wantTurn{{origin: model.OriginSDK, text: "summarize README.md",
		final: "README.md describes the Acme project.", cost: 0.0124, msgs: 2}})
	if !equal(res.Entrypoints, []string{"sdk-cli"}) {
		t.Errorf("entrypoints = %v", res.Entrypoints)
	}
	if len(res.CostStates) != 1 {
		t.Fatalf("cost states = %d", len(res.CostStates))
	}
	cs := res.CostStates[0]
	near(t, "reported total", cs.TotalCostUSD, 0.0124+0.0015)
	near(t, "reported sonnet", cs.ByModel["claude-sonnet-5-5"].USD, 0.0124)

	res = build(t, "16161616-0000-4000-8000-000000000001")
	if len(res.CostStates) != 2 {
		t.Fatalf("cost states = %d", len(res.CostStates))
	}
	if _, ok := res.CostStates[0].ByModel["claude-opus-5-5"]; !ok {
		t.Errorf("[1m] suffix must be stripped: %v", res.CostStates[0].ByModel)
	}
	near(t, "main-file cost (the haiku agent is a separate file)", res.Cost.USD, 0.1157-0.00475)
	near(t, "fable", res.Cost.ByModel["claude-fable-5-1"].USD, 0.05125)
	near(t, "reported #2", res.CostStates[1].TotalCostUSD, 0.1157+0.0015)
}

func TestAgentSpawnsAndResults(t *testing.T) {
	res := build(t, "07070707-0000-4000-8000-000000000001")
	if len(res.AgentSpawns) != 1 {
		t.Fatalf("spawns = %+v", res.AgentSpawns)
	}
	s := res.AgentSpawns[0]
	if s.ToolUseID != "toolu_bg_01" || s.MessageID != "msg_bg_01" || s.Turn != 0 || !s.RunInBackground ||
		s.Description != "Run audit" || s.Prompt != "Run the audit and report issues." || s.At.IsZero() {
		t.Errorf("spawn = %+v", s)
	}
	if len(res.SpawnResults) != 1 {
		t.Fatalf("results = %+v", res.SpawnResults)
	}
	r := res.SpawnResults[0]
	if r.ToolUseID != "toolu_bg_01" || r.Status != "async_launched" || r.AgentID != "a07e0c0de0000001" || !r.HasToolUseOwner || r.Turn != 0 {
		t.Errorf("result = %+v", r)
	}
	if len(res.Notifications) != 1 {
		t.Fatalf("notifications = %+v", res.Notifications)
	}
	n := res.Notifications[0]
	if n.TaskID != "a07e0c0de0000001" || n.Status != "completed" || n.Turn != 1 {
		t.Errorf("notification = %+v", n)
	}
	if res.Turns[1].Origin != model.OriginTaskNotification || res.Turns[1].Cost.USD < 0.00135 {
		t.Errorf("notification turn = %+v", res.Turns[1])
	}

	res = build(t, "09090909-0000-4000-8000-000000000001")
	s = res.AgentSpawns[0]
	r = res.SpawnResults[0]
	if s.Name != "reviewer" || s.SubagentType != "general-purpose" || r.Status != "teammate_spawned" || r.TeammateID != "reviewer@acme-team" || r.Name != "reviewer" {
		t.Errorf("teammate spawn %+v result %+v", s, r)
	}
}

func TestPartialCopyBoundaryAndInheritance(t *testing.T) {
	res := build(t, "13131313-0000-4000-8000-000000000008")
	if len(res.Compactions) != 1 || res.Compactions[0].Turn != -1 || res.Compactions[0].Trigger != model.TriggerAuto {
		t.Errorf("compactions = %+v", res.Compactions)
	}
	if !equal(res.InheritedFrom, []string{"13131313-0000-4000-8000-000000000007"}) {
		t.Errorf("inheritedFrom = %v", res.InheritedFrom)
	}
	// The copied head's parent is not in the file: nothing may be flagged abandoned.
	for _, tn := range res.Turns {
		if tn.Abandoned {
			t.Errorf("turn %d abandoned", tn.Index)
		}
	}
	res = build(t, "13131313-0000-4000-8000-000000000006")
	if res.ForkedFrom == nil || res.ForkedFrom.SessionID != "13131313-0000-4000-8000-000000000005" {
		t.Errorf("forkedFrom = %+v", res.ForkedFrom)
	}
	res = build(t, "13131313-0000-4000-8000-000000000010")
	if !equal(res.Entrypoints, []string{"cli", "sdk-cli"}) {
		t.Errorf("entrypoints = %v (mixed session is not scripted)", res.Entrypoints)
	}
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
