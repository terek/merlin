package moments

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

var updateMock = flag.Bool("update-mock", false, "rewrite web/dev/moments.json, the web mock's report")

// TestMockReport builds a report over ten weeks of synthetic sessions: the one the web mock
// serves. Regenerate it after changing the registry:
//
//	go test ./internal/moments -run TestMockReport -update-mock
func TestMockReport(t *testing.T) {
	now := time.Date(2026, 11, 1, 18, 0, 0, 0, time.UTC)
	ip := func(i int) *int { return &i }
	longText := strings.Repeat("word ", 130)
	var in []Input
	n := 0
	// 10 weeks of sessions, two a day on weekdays
	for day := 70; day >= 1; day-- {
		start := now.AddDate(0, 0, -day).Truncate(24 * time.Hour).Add(9 * time.Hour)
		if wd := start.Weekday(); wd == time.Saturday || wd == time.Sunday {
			continue
		}
		for k := 0; k < 2; k++ {
			n++
			s := start.Add(time.Duration(k) * 40 * time.Minute)
			mk := func(i int, min int, text string) model.Turn {
				return model.Turn{Index: i, Origin: model.OriginHuman, UserText: text, StartedAt: s.Add(time.Duration(min) * time.Minute), EndedAt: s.Add(time.Duration(min+50) * time.Minute)}
			}
			// the story unfolds: the first weeks hold short prompts; structured prompts with
			// criteria start in week 3, detailed one-shot specs in week 5
			text := "Refactor the store"
			if day <= 56 {
				text = "Refactor the store so that:\n- reads never block writes\n- tests must pass\n- do not change the API\n" + strings.Repeat("and keep the module layout as it is, ", 8)
			}
			if day <= 35 {
				text += longText
			}
			t0 := mk(0, 0, text)
			t0.ToolCalls, t0.ToolsByName = 24, map[string]int64{"Edit": 6, "Read": 10}
			// steering mid-turn stops after week 5: a habit that went quiet
			if day%3 == 0 && day >= 35 {
				t0.Queued = []model.QueuedPrompt{{At: t0.StartedAt.Add(5 * time.Minute), Origin: model.OriginHuman}}
			}
			t1 := mk(1, 60, "add a dark theme toggle")
			t1.ToolCalls, t1.ToolsByName = 12, map[string]int64{"Edit": 4}
			if day == 22 || day == 12 {
				t1.ToolsByName["EnterPlanMode"] = 1 // explored, not a habit
			}
			t2 := mk(2, 120, "")
			t2.Origin, t2.Command = model.OriginCommand, "/review-pr"
			// the money story of the last weeks (techniques): shell-heavy turns, a context that grows past
			// 250k from day 20 on (and past 500k now and then), and tool-heavy work on the premium model
			// instead of sub-agents
			opus := "claude-opus-5-5"
			ctx1 := int64(140_000)
			if day <= 20 {
				ctx1 = 320_000
				if day%5 == 0 {
					ctx1 = 560_000
				}
			}
			price := func(ctx int64) model.Cost {
				tok := model.Tokens{Input: 60_000, Output: 60_000, CacheRead: ctx * 30} // a turn is about 30 calls
				mc, _ := prices().Cost(opus, tok, false)
				return model.Cost{USD: mc.USD, ByModel: map[string]model.ModelCost{opus: mc}}
			}
			t0.ContextTokens, t0.AssistantMessages, t0.ShellOutputBytes, t0.Cost = 90_000, 30, 90_000, price(90_000)
			t0.ToolsByName["Bash"] = 2
			t1.ContextTokens, t1.AssistantMessages, t1.ShellOutputBytes, t1.Cost = ctx1, 30, 90_000, price(ctx1)
			t1.ToolsByName["Edit"], t1.ToolsByName["Bash"] = 8, 5
			// now and then, and since the orchestrator block was copied (day 10) mostly, the editing is delegated
			delegated := (day <= 9 && k%3 != 0) || (day <= 56 && day%6 == 0 && k == 1)
			if delegated {
				t1.ToolsByName["Edit"], t1.ToolsByName["Bash"] = 1, 1
				t1.Spawned = []string{"o"}
			}
			if day <= 30 && k == 0 {
				// rtk is on since day 30: the hook rewrites the shell calls of the first session of the day
				t0.ShellCompressed, t1.ShellCompressed = 2, 3
			}
			turns := []model.Turn{t0, t1, t2}
			if day == 47 || day == 33 {
				m := mk(3, 125, "")
				m.Origin, m.Command = model.OriginCommand, "/model sonnet"
				turns = append(turns, m)
			}
			// more typing as the weeks go by, and uneven from day to day
			for i := 0; i < (day*7+k*3)%6+(70-day)/20; i++ {
				turns = append(turns, mk(len(turns), 130+i*8, fmt.Sprintf("continue with part %d of the tests", i+1)))
			}
			for i := range turns {
				if turns[i].ShellOutputBytes == 0 {
					turns[i].ShellOutputBytes, turns[i].AssistantMessages = 160_000, 30
					turns[i].ToolsByName = map[string]int64{"Bash": 2}
				}
			}
			d := &model.SessionDigest{Harness: "claude", ID: fmt.Sprintf("synthetic-%03d", n), Kind: model.KindInteractive,
				StartedAt: s, LastActivityAt: s.Add(3 * time.Hour), Turns: turns,
				Project: fmt.Sprintf("/work/project-%d", (n*7)%9)}
			d.Messages = []model.Message{{ID: "m", Model: "claude-opus-5-5", At: s}}
			if day%2 == 0 {
				d.Compactions = []model.Compaction{{At: s.Add(110 * time.Minute), Turn: 1, Trigger: model.TriggerManual, PreTokens: 140000}}
			} else if day%7 == 1 {
				d.Compactions = []model.Compaction{{At: s.Add(110 * time.Minute), Turn: 1, Trigger: model.TriggerAuto, PreTokens: 190000,
					Call: &model.CompactionCall{Cache: model.CacheCold}}}
			}
			d.Agents = []model.Agent{{ID: "e", Kind: model.AgentSubagent, AgentType: "Explore", Model: "claude-opus-5-5", StartedAt: s.Add(2 * time.Minute), EndedAt: s.Add(9 * time.Minute), SpawnTurn: ip(0), ToolCalls: 14, ToolsByName: map[string]int64{"Read": 14}, Status: model.StatusCompleted}}
			if day == 40 || day == 31 || day == 9 || day == 3 {
				// a sub-agent on a cheaper model: model routing is seen, not a habit
				d.Agents = append(d.Agents, model.Agent{ID: "r", Kind: model.AgentSubagent, AgentType: "general-purpose", Model: "claude-sonnet-5-5",
					StartedAt: s.Add(70 * time.Minute), EndedAt: s.Add(80 * time.Minute), SpawnTurn: ip(1), Status: model.StatusCompleted,
					Cost: func() model.Cost {
						mc, _ := prices().Cost("claude-sonnet-5-5", model.Tokens{Input: 400_000, Output: 150_000, CacheRead: 6_000_000}, false)
						return model.Cost{USD: mc.USD, ByModel: map[string]model.ModelCost{"claude-sonnet-5-5": mc}}
					}()})
			}
			if delegated {
				d.Agents = append(d.Agents, model.Agent{ID: "o", Kind: model.AgentSubagent, AgentType: "general-purpose", Model: "claude-sonnet-5-5",
					StartedAt: s.Add(62 * time.Minute), EndedAt: s.Add(90 * time.Minute), SpawnTurn: ip(1), Status: model.StatusCompleted,
					ToolCalls: 10, ToolsByName: map[string]int64{"Edit": 6, "Bash": 4},
					Cost: func() model.Cost {
						mc, _ := prices().Cost("claude-sonnet-5-5", model.Tokens{Input: 300_000, Output: 100_000, CacheRead: 4_000_000}, false)
						return model.Cost{USD: mc.USD, ByModel: map[string]model.ModelCost{"claude-sonnet-5-5": mc}}
					}()})
			}
			if day < 20 && day%2 == 1 {
				for i := 0; i < 6; i++ {
					d.Agents = append(d.Agents, model.Agent{ID: fmt.Sprintf("t%d", i), Kind: model.AgentSubagent, Addressable: true, Background: true,
						StartedAt: s.Add(time.Duration(65+i) * time.Minute), EndedAt: s.Add(100 * time.Minute), SpawnTurn: ip(1), Status: model.StatusCompleted})
				}
			}
			if day < 14 && k == 0 {
				d.Beads = []model.BeadEvent{{At: s.Add(time.Minute), Op: model.BeadCreate, Outcome: model.BeadOK, Turn: ip(0)},
					{At: s.Add(2 * time.Minute), Op: model.BeadCreate, Outcome: model.BeadOK, Turn: ip(0)},
					{At: s.Add(3 * time.Minute), Op: model.BeadCreate, Outcome: model.BeadOK, Turn: ip(0), Parent: "x"},
					{At: s.Add(90 * time.Minute), Op: model.BeadClose, Outcome: model.BeadOK, Turn: ip(1)}}
			}
			if day == 9 {
				d.PRs = []model.PRLink{{At: s.Add(170 * time.Minute), Number: 42, URL: "https://example.invalid/pr/42"}}
			}
			in = append(in, Input{Digest: d})
		}
	}
	// one long session, in the last weeks: the symptom behind a suggestion
	long := now.AddDate(0, 0, -12).Truncate(24 * time.Hour).Add(14 * time.Hour)
	ld := &model.SessionDigest{Harness: "claude", ID: "synthetic-long", Kind: model.KindInteractive, StartedAt: long,
		LastActivityAt: long.Add(10 * time.Hour), Project: "/work/project-1"}
	for i := 0; i < 45; i++ {
		st := long.Add(time.Duration(i) * 12 * time.Minute)
		ld.Turns = append(ld.Turns, model.Turn{Index: i, Origin: model.OriginHuman, UserText: fmt.Sprintf("step %d of the migration", i), StartedAt: st, EndedAt: st.Add(8 * time.Minute)})
	}
	in = append(in, Input{Digest: ld})
	// the person copied the orchestrator block 10 days ago, and opened the heavy-context one
	copied := now.AddDate(0, 0, -10)
	cfg := Config{Engaged: []Engagement{
		{Moment: "orchestrator", OpenedAt: copied.Add(-2 * time.Hour), CopiedAt: copied},
		{Moment: "clean-slate", OpenedAt: now.AddDate(0, 0, -1)},
	}}
	r := BuildConfig(Registry(), in, now, time.UTC, cfg)
	got := map[Status]int{}
	fresh := 0
	for _, m := range r.Moments {
		got[m.Status]++
		if m.New {
			fresh++
		}
	}
	if got[StatusHabit] == 0 || got[StatusExplored] == 0 || got[StatusUnseen] == 0 || fresh == 0 || len(r.Suggestions) != 3 {
		t.Fatalf("the mock report should show every status: %v, %d new, %d suggestions", got, fresh, len(r.Suggestions))
	}
	tech := func(id string) *Technique {
		for _, s := range r.Suggestions {
			if s.Moment == id {
				return s.Technique
			}
		}
		return view(r, id).Technique
	}
	heavy, orch, rtk := tech("clean-slate"), tech("orchestrator"), tech("compressed-shell")
	if heavy == nil || !strings.Contains(heavy.Reason, "more than 500k") || heavy.Estimate == nil || heavy.Estimate.MonthlyUSD < 20 {
		t.Fatalf("heavy context should be red: %+v", heavy)
	}
	if rtk != nil || view(r, "compressed-shell").Status == StatusUnseen {
		t.Fatalf("rtk should be seen, and no longer a red gap: %+v", rtk)
	}
	if sv := view(r, "compressed-shell").Saved; sv == nil || sv.MonthlyUSD < 1 || !strings.Contains(view(r, "compressed-shell").Note, "rtk is on") {
		t.Fatalf("rtk should show a saving and the note: %+v %q", sv, view(r, "compressed-shell").Note)
	}
	if sv := view(r, "model-routing").Saved; sv == nil || sv.MonthlyUSD < 1 {
		t.Fatalf("model routing should show a saving: %+v", sv)
	}
	if orch == nil || orch.Engaged == nil || !orch.Engaged.Watching || orch.Engaged.FollowUp == "" || view(r, "orchestrator").Status == StatusUnseen || view(r, "orchestrator").Note == "" {
		t.Fatalf("the orchestrator should be a watched suggestion row, with a follow-up: %+v", orch)
	}
	t.Logf("heavy $%.0f, orchestrator $%.0f, rtk saved $%.0f a month; %s", heavy.Estimate.MonthlyUSD, orch.Estimate.MonthlyUSD, view(r, "compressed-shell").Saved.MonthlyUSD, orch.Engaged.FollowUp)
	if !*updateMock {
		return
	}
	// the web mock also shows a suggestion for a moment already seen ("try again"): an explored one
	for _, m := range r.Moments {
		if m.Status == StatusExplored && len(m.Examples) > 0 && m.Technique == nil {
			ex := m.Examples[0]
			r.Suggestions[2] = Suggestion{Moment: m.ID, Reason: "You tried this once and it has not come back since.", Example: &ex}
			break
		}
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("../../web/dev/moments.json", append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
