package digest

import (
	"reflect"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/claude/transcript"
	"github.com/terek/merlin/explorer/internal/model"
)

const (
	sCompact = "05050505-0000-4000-8000-000000000004"
	sSync    = "06060606-0000-4000-8000-000000000001"
	sBG      = "07070707-0000-4000-8000-000000000001"
	sNest    = "08080808-0000-4000-8000-000000000001"
	sTeam    = "09090909-0000-4000-8000-000000000001"
	sFork    = "10101010-0000-4000-8000-000000000001"
	sLink    = "11111111-0000-4000-8000-000000000001"
	sOrphan  = "12121212-0000-4000-8000-000000000001"
	sCost    = "16161616-0000-4000-8000-000000000001"
)

// wantAgent is the expected shape of one agent; costs are hand-computed from
// testdata/README.md.
type wantAgent struct {
	id        string
	kind      model.AgentKind
	parent    string // "" = session root
	depth     int
	linkage   model.Linkage
	toolUse   string
	spawnTurn int // -1 = none
	bg        bool
	status    model.AgentStatus
	prompt    string
	final     string
	own, sub  float64
	model     string
}

func checkAgents(t *testing.T, a *Assembly, want []wantAgent) {
	t.Helper()
	if len(a.Agents) != len(want) {
		t.Fatalf("agents = %d, want %d", len(a.Agents), len(want))
	}
	for i, w := range want {
		g := a.Agents[i]
		if g.ID != w.id {
			t.Fatalf("agent %d: id = %q, want %q", i, g.ID, w.id)
		}
		p := ""
		if g.ParentAgentID != nil {
			p = *g.ParentAgentID
		}
		if g.Kind != w.kind || p != w.parent || g.Depth != w.depth || g.Linkage != w.linkage ||
			g.SpawnToolUseID != w.toolUse || g.Background != w.bg || g.Status != w.status ||
			g.Prompt != w.prompt || g.FinalText != w.final || g.Model != w.model {
			t.Errorf("agent %s:\n got  kind=%s parent=%q depth=%d link=%s tu=%q bg=%v status=%s prompt=%q final=%q model=%q\n want kind=%s parent=%q depth=%d link=%s tu=%q bg=%v status=%s prompt=%q final=%q model=%q",
				w.id, g.Kind, p, g.Depth, g.Linkage, g.SpawnToolUseID, g.Background, g.Status, g.Prompt, g.FinalText, g.Model,
				w.kind, w.parent, w.depth, w.linkage, w.toolUse, w.bg, w.status, w.prompt, w.final, w.model)
		}
		switch {
		case w.spawnTurn < 0 && g.SpawnTurn != nil:
			t.Errorf("agent %s: spawnTurn = %d, want none", w.id, *g.SpawnTurn)
		case w.spawnTurn >= 0 && (g.SpawnTurn == nil || *g.SpawnTurn != w.spawnTurn):
			t.Errorf("agent %s: spawnTurn = %v, want %d", w.id, g.SpawnTurn, w.spawnTurn)
		}
		near(t, w.id+" own cost", g.Cost.USD, w.own)
		near(t, w.id+" subtreeUSD", g.SubtreeUSD, w.sub)
	}
}

// checkSpawned asserts a main turn's own cost, spawned agents and costWithAgents.
func checkSpawned(t *testing.T, a *Assembly, turn int, own float64, spawned []string, with float64) {
	t.Helper()
	g := a.Turns[turn]
	near(t, "turn cost", g.Cost.USD, own)
	near(t, "turn costWithAgents", g.CostWithAgents, with)
	if !reflect.DeepEqual(g.Spawned, spawned) {
		t.Errorf("turn %d spawned = %v, want %v", turn, g.Spawned, spawned)
	}
}

// checkTotals asserts the session cost, that it equals the sum of the messages, and that
// every message id appears once.
func checkTotals(t *testing.T, a *Assembly, total float64, messages int) {
	t.Helper()
	near(t, "session cost", a.Cost.USD, total)
	if len(a.Messages) != messages {
		t.Errorf("messages = %d, want %d", len(a.Messages), messages)
	}
	var sum float64
	seen := map[string]bool{}
	for _, m := range a.Messages {
		sum += m.USD
		if seen[m.ID] {
			t.Errorf("message %s appears twice", m.ID)
		}
		seen[m.ID] = true
	}
	near(t, "sum of messages", sum, total)
}

func TestAssembleSubagentThatCompacts(t *testing.T) { // 05d
	a := assembleFixture(t, sCompact)
	checkAgents(t, a, []wantAgent{{
		id: "a05e0c0de0000001", kind: model.AgentSubagent, depth: 1, linkage: model.LinkMeta,
		toolUse: "toolu_cmpd_01", spawnTurn: 0, status: model.StatusCompleted,
		prompt: "Audit every module and summarise.", final: "Read the first module\n\nAll modules audited",
		own: 0.0051 + 0.00195 + 0.00305, sub: 0.0101, model: "sonnet",
	}})
	if c := a.Agents[0].Compactions; len(c) != 1 || c[0].PreTokens != 80000 || c[0].PostTokens != 9000 || c[0].Trigger != model.TriggerManual {
		t.Errorf("agent compactions = %+v", c)
	}
	checkSpawned(t, a, 0, 0.0108+0.0013, []string{"a05e0c0de0000001"}, 0.0108+0.0013+0.0101)
	checkTotals(t, a, 0.0222, 5)
}

func TestAssembleSync(t *testing.T) { // 06
	a := assembleFixture(t, sSync)
	checkAgents(t, a, []wantAgent{{
		id: "a06e0c0de0000001", kind: model.AgentSubagent, depth: 1, linkage: model.LinkMeta,
		toolUse: "toolu_sync_01", spawnTurn: 0, status: model.StatusCompleted,
		prompt: "Search the repo for login validation and report the file.",
		final:  "Login validation lives in src/auth.ts.",
		own:    0.0071 + 0.0021, sub: 0.0092, model: "sonnet",
	}})
	if a.Agents[0].AgentType != "Explore" {
		t.Errorf("agentType = %q", a.Agents[0].AgentType)
	}
	checkSpawned(t, a, 0, 0.0108+0.00132, []string{"a06e0c0de0000001"}, 0.02132)
	checkTotals(t, a, 0.02132, 4)
	for _, m := range a.Messages {
		if (m.AgentID != "") != (m.ID == "msg_sync_a1" || m.ID == "msg_sync_a2") {
			t.Errorf("message %s agentId = %q", m.ID, m.AgentID)
		}
	}
}

func TestAssembleBackground(t *testing.T) { // 07
	a := assembleFixture(t, sBG)
	checkAgents(t, a, []wantAgent{{
		id: "a07e0c0de0000001", kind: model.AgentSubagent, depth: 1, linkage: model.LinkMeta,
		toolUse: "toolu_bg_01", spawnTurn: 0, bg: true, status: model.StatusCompleted,
		prompt: "Run the audit and report issues.", final: "Audit complete: 2 issues.",
		own: 0.0092, sub: 0.0092, model: "sonnet",
	}})
	checkSpawned(t, a, 0, 0.0108+0.00132, []string{"a07e0c0de0000001"}, 0.02132)
	checkSpawned(t, a, 1, 0.00136, nil, 0.00136)
	checkSpawned(t, a, 2, 0.0014, nil, 0.0014)
	checkTotals(t, a, 0.02408, 6)
}

func TestAssembleNested(t *testing.T) { // 08
	a := assembleFixture(t, sNest)
	const A, B = "a08e0c0de0000001", "a08e0c0de0000002"
	checkAgents(t, a, []wantAgent{
		{id: A, kind: model.AgentSubagent, depth: 1, linkage: model.LinkMeta, toolUse: "toolu_nest_01",
			spawnTurn: 0, status: model.StatusCompleted, prompt: "Survey the repo; delegate the test survey.",
			final: "Repo surveyed: 4 test files.", own: 0.0071 + 0.0021, sub: 0.0092 + 0.00365 + 0.00125, model: "sonnet"},
		{id: B, kind: model.AgentSubagent, parent: A, depth: 2, linkage: model.LinkMeta, toolUse: "toolu_nest_02",
			spawnTurn: 0, status: model.StatusCompleted, prompt: "Count the test files.",
			final: "There are 4 test files.", own: 0.00365 + 0.00125, sub: 0.0049, model: "sonnet"},
	})
	// B is inside A's subtree: only A is spawned by the turn, and B is not counted twice.
	checkSpawned(t, a, 0, 0.0108+0.00132, []string{A}, 0.02622)
	checkTotals(t, a, 0.02622, 6)
}

func TestAssembleTeammate(t *testing.T) { // 09
	a := assembleFixture(t, sTeam)
	const R = "areviewer-09e0c0de00000001"
	checkAgents(t, a, []wantAgent{{
		id: R, kind: model.AgentTeammate, depth: 0, linkage: model.LinkName, toolUse: "toolu_team_01",
		spawnTurn: 0, status: model.StatusCompleted, prompt: "Review the diff in the login branch.",
		final: "Tests look fine.", own: 0.0071 + 0.0021 + 0.00185, sub: 0.01105, model: "sonnet",
	}})
	g := a.Agents[0]
	if g.Name != "reviewer" || g.AgentType != "reviewer" {
		t.Errorf("name/type = %q/%q", g.Name, g.AgentType)
	}
	want := []model.InboxMessage{{At: time.Date(2026, 9, 9, 10, 2, 5, 0, time.UTC), Kind: model.InboxMessageKind,
		From: "team-lead", Summary: "also check tests", Text: "Please also check the tests."}}
	if !reflect.DeepEqual(g.Inbox, want) {
		t.Errorf("inbox = %+v, want %+v", g.Inbox, want)
	}
	checkSpawned(t, a, 0, 0.0108+0.00132, []string{R}, 0.0108+0.00132+0.01105)
	checkSpawned(t, a, 1, 0.00166+0.00142, nil, 0.00308)
	checkTotals(t, a, 0.02625, 7)
}

func TestAssembleForks(t *testing.T) { // 10
	a := assembleFixture(t, sFork)
	const f1, f2, f3 = "a10e0c0de0000001", "a10e0c0de0000002", "a10e0c0de0000003"
	// msg_fork_ctx_01 (0.0037) is shared by f1 and f2 with the same timestamp: f1 owns it.
	checkAgents(t, a, []wantAgent{
		{id: f1, kind: model.AgentFork, depth: 1, linkage: model.LinkMeta, toolUse: "toolu_fork_01", spawnTurn: 0,
			status: model.StatusCompleted, prompt: "Evaluate sqlite.", final: "sqlite is simple and embedded.",
			own: 0.0037 + 0.00155, sub: 0.00525, model: "inherit"},
		{id: f2, kind: model.AgentFork, depth: 1, linkage: model.LinkMeta, toolUse: "toolu_fork_02", spawnTurn: 0,
			status: model.StatusCompleted, prompt: "Evaluate postgres.", final: "postgres scales and is heavier.",
			own: 0.00155, sub: 0.00155, model: "inherit"},
		{id: f3, kind: model.AgentFork, depth: 1, linkage: model.LinkMeta, toolUse: "toolu_fork_03", spawnTurn: 0,
			status: model.StatusCompleted, prompt: "Evaluate mysql.", final: "mysql is a middle ground.",
			own: 0.00155, sub: 0.00155, model: "inherit"},
	})
	for _, g := range a.Agents {
		if len(g.Inbox) != 0 {
			t.Errorf("agent %s inbox = %+v, want none", g.ID, g.Inbox)
		}
	}
	checkSpawned(t, a, 0, 0.0108+0.00186, []string{f1, f2, f3}, 0.02101)
	checkTotals(t, a, 0.02101, 6)
	owner := map[string]string{}
	for _, m := range a.Messages {
		owner[m.ID] = m.AgentID
	}
	if owner["msg_fork_ctx_01"] != f1 || owner["msg_fork_f2_01"] != f2 || owner["msg_fork_01"] != "" {
		t.Errorf("owners = %v", owner)
	}
}

func TestAssembleLinkageFallbacks(t *testing.T) { // 11
	a := assembleFixture(t, sLink)
	checkAgents(t, a, []wantAgent{
		{id: "a11e0c0de0000001", kind: model.AgentSubagent, depth: 1, linkage: model.LinkToolResult, toolUse: "toolu_link_01",
			spawnTurn: 0, status: model.StatusCompleted, prompt: "Context: the repo is small. Find the entry point.",
			final: "The entry point is main.ts.", own: 0.0043, sub: 0.0043, model: "sonnet"},
		{id: "a11e0c0de0000002", kind: model.AgentSubagent, depth: 1, linkage: model.LinkPrompt, toolUse: "toolu_link_02",
			spawnTurn: 0, status: model.StatusCompleted, prompt: "List the config files.",
			final: "Config files: tsconfig.json, package.json.", own: 0.0044, sub: 0.0044, model: "sonnet"},
		{id: "a11e0c0de0000003", kind: model.AgentSubagent, depth: 1, linkage: model.LinkUnresolved,
			spawnTurn: -1, status: model.StatusCompleted, prompt: "Unrelated housekeeping task nobody asked for.",
			final: "Housekeeping finished.", own: 0.0042, sub: 0.0042, model: "claude-sonnet-5-5"},
	})
	// The unresolved agent belongs to no turn: its cost is in the session total only.
	checkSpawned(t, a, 0, 0.0108+0.00186, []string{"a11e0c0de0000001", "a11e0c0de0000002"}, 0.0108+0.00186+0.0043+0.0044)
	checkTotals(t, a, 0.02556, 5)
	if a.Diagnostics.UnresolvedAgents != 1 {
		t.Errorf("unresolvedAgents = %d", a.Diagnostics.UnresolvedAgents)
	}
}

func TestAssembleOrphan(t *testing.T) { // 12
	a := assembleFixture(t, sOrphan)
	if a.Turns != nil {
		t.Errorf("turns = %v, want none", a.Turns)
	}
	checkAgents(t, a, []wantAgent{
		{id: "a12e0c0de0000001", kind: model.AgentSubagent, depth: 1, linkage: model.LinkUnresolved, spawnTurn: -1,
			status: model.StatusCompleted, prompt: "Scan the repo for TODO comments.", final: "Found 3 TODO comments.",
			own: 0.0043, sub: 0.0043, model: "sonnet"},
		{id: "a1b2c3d", kind: model.AgentSubagent, depth: 1, linkage: model.LinkUnresolved, spawnTurn: -1,
			status: model.StatusCompleted, prompt: "Count the markdown files.", final: "There are 5 markdown files.",
			own: 0.0042, sub: 0.0042, model: "claude-sonnet-5-5"},
		{id: "acompact-12e0c0de", kind: model.AgentCompact, depth: 1, linkage: model.LinkUnresolved, spawnTurn: -1,
			status: model.StatusCompleted, prompt: "Summarise the conversation so far.", final: "Summary: scanning and counting were done.",
			own: 0.0046, sub: 0.0046, model: "claude-sonnet-5-5"},
	})
	checkTotals(t, a, 0.0131, 3)
	if a.Diagnostics.UnresolvedAgents != 3 {
		t.Errorf("unresolvedAgents = %d", a.Diagnostics.UnresolvedAgents)
	}
}

func TestAssembleAgentOnOtherModel(t *testing.T) { // 16
	a := assembleFixture(t, sCost)
	checkAgents(t, a, []wantAgent{{
		id: "a16e0c0de0000001", kind: model.AgentSubagent, depth: 1, linkage: model.LinkMeta, toolUse: "toolu_cs_02",
		spawnTurn: 1, status: model.StatusCompleted, prompt: "List the tax rules in billing.ts.",
		final: "Tax rules: flat 10 percent.", own: 0.00475, sub: 0.00475, model: "haiku",
	}})
	checkSpawned(t, a, 0, 0.04+0.0116, nil, 0.0516)
	checkSpawned(t, a, 1, 0.006+0.0021, []string{"a16e0c0de0000001"}, 0.006+0.0021+0.00475)
	checkSpawned(t, a, 2, 0.05125, nil, 0.05125)
	checkTotals(t, a, 0.1157, 6)
	bm := a.Cost.ByModel
	near(t, "haiku in session cost", bm["claude-haiku-4-5-20251001"].USD, 0.00475)
	near(t, "opus in session cost", bm["claude-opus-5-5"].USD, 0.0516)
	if a.Agents[0].Cost.ByModel["claude-haiku-4-5-20251001"].Output != 100 {
		t.Errorf("agent byModel = %+v", a.Agents[0].Cost.ByModel)
	}
}

// ---- synthetic cases -------------------------------------------------------------

var t0 = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

func at(s int) time.Time { return t0.Add(time.Duration(s) * time.Second) }

// synthAgent is an agent file with one prompt turn and one message of usd dollars.
func synthAgent(id, prompt string, start int, msgID string, usd float64) AgentFile {
	r := &FileResult{
		FirstTimestamp: at(start), LastTimestamp: at(start + 5),
		Turns:    []model.Turn{{Origin: model.OriginHuman, UserText: prompt, StartedAt: at(start), FinalText: id + " done"}},
		Messages: []model.Message{{ID: msgID, At: at(start + 1), Model: "m", USD: usd}},
		Cost:     model.Cost{USD: usd},
	}
	return AgentFile{ID: id, Result: r}
}

func withMeta(f AgentFile, m transcript.AgentMeta) AgentFile { f.Meta = &m; return f }

func synthMain(spawns ...AgentSpawn) *FileResult {
	return &FileResult{
		FirstTimestamp: at(0), LastTimestamp: at(100),
		Turns:       []model.Turn{{Index: 0, UserText: "go", Origin: model.OriginHuman}, {Index: 1, UserText: "again", Origin: model.OriginHuman}},
		AgentSpawns: spawns,
	}
}

func byID(a *Assembly, id string) model.Agent {
	for _, g := range a.Agents {
		if g.ID == id {
			return g
		}
	}
	panic("no agent " + id)
}

func TestAssembleNameTakesEarliestUnclaimed(t *testing.T) {
	m := synthMain(
		AgentSpawn{ToolUseID: "tu1", Turn: 0, At: at(1), Name: "w"},
		AgentSpawn{ToolUseID: "tu2", Turn: 1, At: at(2), Name: "w"},
		AgentSpawn{ToolUseID: "tu3", Turn: 1, At: at(3), Prompt: "do it"},
	)
	a := Assemble(m, []AgentFile{
		withMeta(synthAgent("a1", "x", 10, "m1", 1), transcript.AgentMeta{Name: "w"}),
		withMeta(synthAgent("a2", "x", 20, "m2", 1), transcript.AgentMeta{Name: "w"}),
		synthAgent("a3", "do it", 30, "m3", 1),
		withMeta(synthAgent("a4", "x", 40, "m4", 1), transcript.AgentMeta{Name: "w"}), // no spawn left
	})
	for id, want := range map[string]struct {
		link model.Linkage
		tu   string
	}{
		"a1": {model.LinkName, "tu1"}, "a2": {model.LinkName, "tu2"},
		"a3": {model.LinkPrompt, "tu3"}, "a4": {model.LinkUnresolved, ""},
	} {
		g := byID(a, id)
		if g.Linkage != want.link || g.SpawnToolUseID != want.tu {
			t.Errorf("%s: linkage %s tu %q, want %s %q", id, g.Linkage, g.SpawnToolUseID, want.link, want.tu)
		}
	}
	if a.Agents[3].SpawnTurn != nil || *a.Agents[1].SpawnTurn != 1 {
		t.Errorf("spawn turns wrong")
	}
	// A weaker rung does not steal a tool_use a stronger rung gives to another agent.
	a = Assemble(synthMain(AgentSpawn{ToolUseID: "tu1", At: at(1), Name: "w", Prompt: "p"}), []AgentFile{
		synthAgent("a1", "p", 10, "m1", 1),
		withMeta(synthAgent("a2", "q", 20, "m2", 1), transcript.AgentMeta{ToolUseID: "tu1"}),
	})
	if g := byID(a, "a2"); g.Linkage != model.LinkMeta {
		t.Errorf("a2 linkage = %s", g.Linkage)
	}
	if g := byID(a, "a1"); g.Linkage != model.LinkUnresolved {
		t.Errorf("a1 linkage = %s, want unresolved (tool_use claimed once)", g.Linkage)
	}
}

func TestAssembleCyclesTerminate(t *testing.T) {
	// A's file spawns B and B's file spawns A (adversarial metas); also meta parent loops.
	a1 := synthAgent("a1", "x", 10, "m1", 1)
	a1.Result.AgentSpawns = []AgentSpawn{{ToolUseID: "tuB", At: at(11)}}
	a2 := synthAgent("a2", "y", 20, "m2", 2)
	a2.Result.AgentSpawns = []AgentSpawn{{ToolUseID: "tuA", At: at(21)}}
	a1 = withMeta(a1, transcript.AgentMeta{ToolUseID: "tuA"})
	a2 = withMeta(a2, transcript.AgentMeta{ToolUseID: "tuB"})
	a3 := withMeta(synthAgent("a3", "z", 30, "m3", 4), transcript.AgentMeta{ParentAgentID: "a4"})
	a4 := withMeta(synthAgent("a4", "w", 40, "m4", 8), transcript.AgentMeta{ParentAgentID: "a3"})
	a5 := withMeta(synthAgent("a5", "v", 50, "m5", 16), transcript.AgentMeta{ParentAgentID: "a5"})
	a := Assemble(synthMain(), []AgentFile{a1, a2, a3, a4, a5})
	near(t, "total", a.Cost.USD, 31)
	// Every chain ends at the root and subtree costs add up without double counting.
	var rootSum float64
	for _, g := range a.Agents {
		if g.ParentAgentID == nil {
			rootSum += g.SubtreeUSD
		}
	}
	near(t, "sum of root subtrees", rootSum, 31)
}

func TestAssembleDepthFromParentChain(t *testing.T) {
	m := synthMain(AgentSpawn{ToolUseID: "tu1", At: at(1), Turn: 1})
	a1 := synthAgent("a1", "x", 10, "m1", 1)
	a1.Result.AgentSpawns = []AgentSpawn{{ToolUseID: "tu2", At: at(11)}}
	a2 := synthAgent("a2", "y", 20, "m2", 2)
	a2.Result.AgentSpawns = []AgentSpawn{{ToolUseID: "tu3", At: at(21)}}
	a3 := synthAgent("a3", "z", 30, "m3", 4)
	a := Assemble(m, []AgentFile{
		withMeta(a1, transcript.AgentMeta{ToolUseID: "tu1"}),
		withMeta(a2, transcript.AgentMeta{ToolUseID: "tu2"}),
		withMeta(a3, transcript.AgentMeta{ToolUseID: "tu3"}),
	})
	for i, d := range []int{1, 2, 3} {
		g := a.Agents[i]
		if g.Depth != d || g.SpawnTurn == nil || *g.SpawnTurn != 1 {
			t.Errorf("%s depth %d spawnTurn %v", g.ID, g.Depth, g.SpawnTurn)
		}
	}
	near(t, "a1 subtree", a.Agents[0].SubtreeUSD, 7)
	near(t, "turn 1 costWithAgents", a.Turns[1].CostWithAgents, 7)
}

func TestAssembleStatus(t *testing.T) {
	m := synthMain(
		AgentSpawn{ToolUseID: "tu1", At: at(1)}, AgentSpawn{ToolUseID: "tu2", At: at(2)},
		AgentSpawn{ToolUseID: "tu3", At: at(3)}, AgentSpawn{ToolUseID: "tu4", At: at(4)},
	)
	m.SpawnResults = []SpawnResult{{ToolUseID: "tu1", Status: "completed", AgentID: "a1"}}
	m.Notifications = []TaskNotification{{TaskID: "a2", Status: "failed"}}
	m.AgentsKilled = []AgentsKilled{{At: at(500)}}
	mk := func(id string, start int, tu string) AgentFile {
		return withMeta(synthAgent(id, id, start, "m"+id, 1), transcript.AgentMeta{ToolUseID: tu})
	}
	a := Assemble(m, []AgentFile{mk("a1", 10, "tu1"), mk("a2", 20, "tu2"), mk("a3", 30, "tu3"), mk("a4", 600, "tu4")})
	for id, want := range map[string]model.AgentStatus{
		"a1": model.StatusCompleted, // tool_result completed
		"a2": model.StatusKilled,    // notification failed
		"a3": model.StatusKilled,    // agents_killed after its last activity, no id in the event
		"a4": model.StatusOpen,      // active after the kill event
	} {
		if g := byID(a, id); g.Status != want {
			t.Errorf("%s status = %s, want %s", id, g.Status, want)
		}
	}
	// A completion marker beats a later kill event; an event naming other agents is ignored.
	m.AgentsKilled = []AgentsKilled{{At: at(500), AgentIDs: []string{"a3"}}}
	a = Assemble(m, []AgentFile{mk("a1", 10, "tu1"), mk("a2", 20, "tu2"), mk("a3", 30, "tu3"), mk("a4", 40, "tu4")})
	if byID(a, "a1").Status != model.StatusCompleted || byID(a, "a4").Status != model.StatusOpen || byID(a, "a3").Status != model.StatusKilled {
		t.Errorf("statuses: %v %v %v", byID(a, "a1").Status, byID(a, "a3").Status, byID(a, "a4").Status)
	}
}

func TestAssembleSharedMessageTieBreak(t *testing.T) {
	// Same first timestamp: the smaller id owns the shared message.
	b := synthAgent("ab", "x", 10, "shared", 5)
	a := synthAgent("aa", "x", 10, "shared", 5)
	asm := Assemble(nil, []AgentFile{b, a})
	near(t, "total", asm.Cost.USD, 5)
	if byID(asm, "aa").Cost.USD != 5 || byID(asm, "ab").Cost.USD != 0 {
		t.Errorf("owner costs: aa=%v ab=%v", byID(asm, "aa").Cost.USD, byID(asm, "ab").Cost.USD)
	}
	// An earlier first timestamp beats a smaller id.
	b = synthAgent("zz", "x", 5, "s2", 3)
	a = synthAgent("aa", "x", 6, "s2", 3)
	asm = Assemble(nil, []AgentFile{a, b})
	if byID(asm, "zz").Cost.USD != 3 || byID(asm, "aa").Cost.USD != 0 {
		t.Errorf("owner costs: zz=%v aa=%v", byID(asm, "zz").Cost.USD, byID(asm, "aa").Cost.USD)
	}
}

func TestAssembleUnpricedMessagesCostNothing(t *testing.T) {
	f := synthAgent("a1", "x", 10, "m1", 0)
	f.Result.Diagnostics.UnpricedModels = []string{"m"}
	f.Result.Diagnostics.BadLines = 2
	asm := Assemble(nil, []AgentFile{f})
	if len(asm.Messages) != 1 || asm.Cost.USD != 0 || len(asm.Agents[0].Cost.ByModel) != 0 {
		t.Errorf("messages %d cost %+v", len(asm.Messages), asm.Agents[0].Cost)
	}
	if !reflect.DeepEqual(asm.Diagnostics.UnpricedModels, []string{"m"}) || asm.Diagnostics.BadLines != 2 {
		t.Errorf("diagnostics = %+v", asm.Diagnostics)
	}
}

func TestAssembleDeterministic(t *testing.T) {
	m := synthMain(AgentSpawn{ToolUseID: "tu1", At: at(1)}, AgentSpawn{ToolUseID: "tu2", At: at(2)})
	mk := func() []AgentFile {
		return []AgentFile{
			withMeta(synthAgent("a1", "x", 10, "m1", 1), transcript.AgentMeta{ToolUseID: "tu1"}),
			withMeta(synthAgent("a2", "y", 10, "m2", 2), transcript.AgentMeta{ToolUseID: "tu2"}),
			synthAgent("a3", "z", 3, "m3", 4),
		}
	}
	f1 := mk()
	f2 := mk()
	f2[0], f2[2] = f2[2], f2[0]
	if !reflect.DeepEqual(Assemble(m, f1), Assemble(m, f2)) {
		t.Error("output depends on input order")
	}
	if !reflect.DeepEqual(Assemble(m, f1), Assemble(m, f1)) {
		t.Error("not repeatable")
	}
	if a := Assemble(m, f1); a.Agents[0].ID != "a3" || a.Agents[1].ID != "a1" || a.Agents[2].ID != "a2" {
		t.Errorf("order = %s %s %s", a.Agents[0].ID, a.Agents[1].ID, a.Agents[2].ID)
	}
}

func TestAssembleForkLinkage(t *testing.T) {
	spawn := func(id string, s int) AgentSpawn { return AgentSpawn{ToolUseID: id, At: at(s), SubagentType: "fork"} }
	fork := func(id string, start int, meta transcript.AgentMeta, replay ...AgentSpawn) AgentFile {
		f := withMeta(synthAgent(id, "p"+id, start, "m"+id, 1), meta)
		f.Result.AgentSpawns = replay
		return f
	}

	// 1. Spawned by agent P; the tool_use is in P's file and replayed in the fork's own file.
	m := synthMain(AgentSpawn{ToolUseID: "tuP", Turn: 1, At: at(1)})
	p := withMeta(synthAgent("aP", "pp", 10, "mP", 2), transcript.AgentMeta{ToolUseID: "tuP"})
	p.Result.AgentSpawns = []AgentSpawn{spawn("tuF", 11)}
	f := fork("aF", 20, transcript.AgentMeta{ToolUseID: "tuF", ParentAgentID: "aP", IsFork: true}, spawn("tuF", 11))
	a := Assemble(m, []AgentFile{f, p})
	g := byID(a, "aF")
	if g.Linkage != model.LinkMeta || g.ParentAgentID == nil || *g.ParentAgentID != "aP" || g.Depth != 2 || g.Kind != model.AgentFork {
		t.Errorf("fork of agent: %+v", g)
	}
	if g.SpawnTurn == nil || *g.SpawnTurn != 1 {
		t.Errorf("spawnTurn = %v, want 1 (top-level ancestor's)", g.SpawnTurn)
	}
	near(t, "aP subtree", byID(a, "aP").SubtreeUSD, 3)

	// 2. Spawned by main; the fork's own file replays the tool_use and the main file has it.
	m = synthMain(AgentSpawn{ToolUseID: "tuF", Turn: 1, At: at(1), SubagentType: "fork"})
	f = fork("aF", 20, transcript.AgentMeta{ToolUseID: "tuF", IsFork: true}, spawn("tuF", 1))
	a = Assemble(m, []AgentFile{f})
	g = byID(a, "aF")
	if g.Linkage != model.LinkMeta || g.ParentAgentID != nil || g.SpawnTurn == nil || *g.SpawnTurn != 1 {
		t.Errorf("fork of main: %+v", g)
	}
	if a.Diagnostics.UnresolvedAgents != 0 || !reflect.DeepEqual(a.Turns[1].Spawned, []string{"aF"}) {
		t.Errorf("unresolved %d spawned %v", a.Diagnostics.UnresolvedAgents, a.Turns[1].Spawned)
	}

	// 3. The id is only in the fork's own file, but meta names an existing parent.
	f = fork("aF", 20, transcript.AgentMeta{ToolUseID: "tuF", ParentAgentID: "aP", IsFork: true}, spawn("tuF", 11))
	p = withMeta(synthAgent("aP", "pp", 10, "mP", 2), transcript.AgentMeta{})
	a = Assemble(synthMain(), []AgentFile{f, p})
	g = byID(a, "aF")
	if g.Linkage != model.LinkMeta || g.ParentAgentID == nil || *g.ParentAgentID != "aP" || g.SpawnToolUseID != "tuF" {
		t.Errorf("own-file only: %+v", g)
	}

	// 4. Only in its own file and no parent: not linked by meta, the file is never its own spawner.
	f = fork("aF", 20, transcript.AgentMeta{ToolUseID: "tuF", IsFork: true}, spawn("tuF", 11))
	a = Assemble(synthMain(), []AgentFile{f})
	if g = byID(a, "aF"); g.Linkage != model.LinkUnresolved || g.ParentAgentID != nil {
		t.Errorf("own file only, no parent: %+v", g)
	}

	// 5. Rungs 2-4 skip the own file too: a replayed tool_use with the agent's own prompt
	// does not link by prompt, while the main file's copy does.
	own := synthAgent("aF", "same prompt", 20, "mF", 1)
	own.Result.AgentSpawns = []AgentSpawn{{ToolUseID: "tuX", At: at(2), Prompt: "same prompt"}}
	a = Assemble(synthMain(), []AgentFile{own})
	if g = byID(a, "aF"); g.Linkage != model.LinkUnresolved {
		t.Errorf("prompt rung used own file: %+v", g)
	}
	a = Assemble(synthMain(AgentSpawn{ToolUseID: "tuX", At: at(2), Prompt: "same prompt"}), []AgentFile{own})
	if g = byID(a, "aF"); g.Linkage != model.LinkPrompt || g.ParentAgentID != nil {
		t.Errorf("prompt rung with main copy: %+v", g)
	}
}

func TestAssembleStatusFromCleanEnd(t *testing.T) {
	m := synthMain()
	m.AgentsKilled = []AgentsKilled{{At: at(500)}}
	clean := synthAgent("a1", "x", 10, "m1", 1)
	clean.Result.EndState = model.EndClean
	mid := synthAgent("a2", "x", 20, "m2", 1)
	mid.Result.EndState = model.EndMidTurn
	failed := synthAgent("a3", "x", 30, "m3", 1)
	failed.Result.EndState = model.EndClean
	m.Notifications = []TaskNotification{{TaskID: "a3", Status: "failed"}}
	a := Assemble(m, []AgentFile{clean, mid, failed})
	for id, want := range map[string]model.AgentStatus{
		"a1": model.StatusCompleted, // ends cleanly: the kill event does not apply
		"a2": model.StatusKilled,    // mid-turn when the kill event came
		"a3": model.StatusKilled,    // explicit failed notification
	} {
		if g := byID(a, id); g.Status != want {
			t.Errorf("%s status = %s, want %s", id, g.Status, want)
		}
	}
	m.AgentsKilled = nil
	if g := byID(Assemble(m, []AgentFile{mid}), "a2"); g.Status != model.StatusOpen {
		t.Errorf("mid-turn without kill event = %s, want open", g.Status)
	}
}
