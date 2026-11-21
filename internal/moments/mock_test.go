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
	r := Build(in, now, time.UTC)
	got := map[Status]int{}
	fresh := 0
	for _, m := range r.Moments {
		got[m.Status]++
		if m.New {
			fresh++
		}
	}
	if got[StatusHabit] == 0 || got[StatusExplored] == 0 || got[StatusUnseen] == 0 || fresh == 0 || len(r.Suggestions) == 0 {
		t.Fatalf("the mock report should show every status: %v, %d new, %d suggestions", got, fresh, len(r.Suggestions))
	}
	withExample := 0
	for _, s := range r.Suggestions {
		if s.Example != nil {
			withExample++
		}
	}
	if withExample != 2 || len(r.Suggestions) != 3 || r.Suggestions[2].Reason != "" {
		t.Fatalf("want 3 suggestions, 2 with a symptom and an example, 1 without: %+v", r.Suggestions)
	}
	if !*updateMock {
		return
	}
	// the web mock also shows a suggestion for a moment already seen ("try again"): an explored one
	for _, m := range r.Moments {
		if m.Status == StatusExplored && len(m.Examples) > 0 {
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
