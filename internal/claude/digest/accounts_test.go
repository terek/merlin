package digest

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/terek/merlin/internal/claude/discover"
	"github.com/terek/merlin/internal/model"
)

func TestSessionOwnerAccounts(t *testing.T) {
	owner := func(session, account, org string) string {
		return fmt.Sprintf(`{"type":"session-owner","sessionId":%q,"accountUuid":%q,"organizationUuid":%q}`, session, account, org)
	}
	for _, tc := range []struct {
		name, records string
		known         bool
	}{
		{"matching", owner("S", "account", "org"), true},
		{"repeat", owner("S", "account", "org") + "\n" + owner("S", "account", "org"), true},
		{"wrong session", owner("OTHER", "account", "org"), false},
		{"partial", owner("S", "account", ""), false},
		{"conflict", owner("S", "account", "org") + "\n" + owner("S", "other", "org"), false},
		{"bridge only", `{"type":"bridge-session","sessionId":"S","accountUuid":"account","organizationUuid":"org"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			main := filepath.Join(dir, "main.jsonl")
			agent := filepath.Join(dir, "agent.jsonl")
			if err := os.WriteFile(main, []byte(tc.records+"\n"+limitsMain), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(agent, []byte(limitsAgent), 0600); err != nil {
				t.Fatal(err)
			}
			d, err := BuildSession(discover.Source{ID: "S", Main: main, Agents: []discover.Agent{{ID: "ag1", Path: agent}}}, fixturePrices())
			if err != nil {
				t.Fatal(err)
			}
			want := ""
			if tc.known {
				want = model.AccountKey("account", "org")
			}
			if d.Account != want {
				t.Fatalf("account = %q, want %q", d.Account, want)
			}
			if len(d.Limits) != 2 {
				t.Fatalf("limits = %+v", d.Limits)
			}
			for _, l := range d.Limits {
				if l.Account != want {
					t.Errorf("reading account = %q, want %q", l.Account, want)
				}
			}
		})
	}
}

func TestSpendCapClassification(t *testing.T) {
	for _, tc := range []struct {
		name, limit, reason, nested string
		want                        bool
	}{
		{"cap", "overage", "org_spend_cap_reached", "", true},
		{"other overage", "overage", "other", "", false},
		{"window", "five_hour", "org_spend_cap_reached", "", false},
		{"nested only", "overage", "", `,"apiErrorParams":{"rate_limit_info":{"overageDisabledReason":"org_spend_cap_reached"}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			line := fmt.Sprintf(`{"type":"assistant","uuid":"e","sessionId":"S","quotaLimits":{"status":"rejected","rateLimitType":%q,"overageDisabledReason":%q,"resetsAt":1789774200}%s}`, tc.limit, tc.reason, tc.nested)
			p := filepath.Join(t.TempDir(), "S.jsonl")
			if err := os.WriteFile(p, []byte(strings.TrimSpace(line)+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			d := buildFile(t, p)
			if len(d.Limits) != 1 {
				t.Fatalf("limits = %+v", d.Limits)
			}
			l := d.Limits[0]
			if (l.Kind == "spend_cap") != tc.want || l.Limit != tc.limit || l.ResetsAt.Unix() != 1789774200 {
				t.Errorf("reading = %+v", l)
			}
			if tc.limit == "overage" && l.WindowMinutes != 0 {
				t.Errorf("invented window: %+v", l)
			}
		})
	}
}
