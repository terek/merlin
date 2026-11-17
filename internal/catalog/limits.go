package catalog

import (
	"fmt"
	"sort"
	"time"

	"github.com/terek/merlin/internal/model"
)

// limitGap is the largest difference between the reset times of two readings of one window:
// Codex jitters resets_at by seconds between calls, and a window that resets later is a new
// one.
const limitGap = 10 * time.Minute

// Limits is the subscription usage-limit view: the windows the harnesses wrote about, merged
// across sessions, and every refused call.
type Limits struct {
	Windows         []LimitWindow         `json:"windows"`
	Refusals        []LimitRefusal        `json:"refusals"`
	Lockouts        []LimitLockout        `json:"lockouts"`
	SessionAccounts []LimitSessionAccount `json:"sessionAccounts,omitempty"`
}

type LimitSessionAccount struct {
	Session model.SessionKey `json:"session"`
	Account string           `json:"account"`
}

// LimitPoint is the share of a window used at one moment.
type LimitPoint struct {
	At          time.Time `json:"at"`
	UsedPercent float64   `json:"usedPercent"`
}

// LimitWindow is one usage window of one limit: the readings of every session of a harness
// whose reset times lie within limitGap of each other.
type LimitWindow struct {
	Harness        string       `json:"harness"`
	Limit          string       `json:"limit"`
	Kind           string       `json:"kind,omitempty"`
	Account        string       `json:"account,omitempty"`
	AccountLabel   string       `json:"accountLabel,omitempty"`
	WindowMinutes  int          `json:"windowMinutes,omitempty"`
	Plan           string       `json:"plan,omitempty"`
	PlanPeriod     string       `json:"planPeriod,omitempty"`
	ResetsAt       time.Time    `json:"resetsAt"` // the earliest reset time of the readings
	StartsAt       time.Time    `json:"startsAt,omitzero"`
	FirstSeenAt    time.Time    `json:"firstSeenAt"`
	LastSeenAt     time.Time    `json:"lastSeenAt"`
	FirstPercent   *float64     `json:"firstPercent,omitempty"`
	MaxPercent     *float64     `json:"maxPercent,omitempty"`
	Points         []LimitPoint `json:"points"`
	Refusals       int          `json:"refusals"`
	FirstRefusalAt time.Time    `json:"firstRefusalAt,omitzero"`
	// SeenUSD is the Cost total of the harness over [StartsAt, ResetsAt): what Total(Filter{Harness,
	// From: StartsAt, To: ResetsAt}) gives, scripted runs included; nil when StartsAt is not known.
	SeenUSD      *float64 `json:"seenUSD,omitempty"`
	SeenSessions int      `json:"seenSessions,omitempty"`
	// ScriptedUSD is the part of SeenUSD that scripted runs spent.
	ScriptedUSD float64 `json:"scriptedUSD,omitempty"`
	// TopSessions are up to three non-scripted sessions with the largest spend in the range.
	TopSessions []LimitSession `json:"topSessions"`
	// UsdPerPercent is the spend between the first and the last reading divided by the percentage
	// points they gained, when that is at least limitPercentMin points.
	UsdPerPercent *float64 `json:"usdPerPercent,omitempty"`
}

// LimitSession is one session's spend inside a window.
type LimitSession struct {
	Harness string  `json:"harness"`
	ID      string  `json:"id"`
	Name    string  `json:"name,omitempty"`
	Title   string  `json:"title,omitempty"`
	USD     float64 `json:"usd"`
}

// limitPercentMin is the fewest percentage points a window must gain for usdPerPercent.
const limitPercentMin = 10

// limitTop is how many sessions a window lists.
const limitTop = 3

// LimitRefusal is one call the harness refused because a limit was reached. A scripted run's
// refusal names no session (scripted runs are never listed one by one); Scripted says so.
type LimitRefusal struct {
	At            time.Time         `json:"at"`
	Harness       string            `json:"harness"`
	Session       *model.SessionKey `json:"session,omitempty"`
	Scripted      bool              `json:"scripted,omitempty"`
	key           model.SessionKey
	Limit         string    `json:"limit,omitempty"`
	Kind          string    `json:"kind,omitempty"`
	Account       string    `json:"account,omitempty"`
	AccountLabel  string    `json:"accountLabel,omitempty"`
	WindowMinutes int       `json:"windowMinutes,omitempty"`
	ResetsAt      time.Time `json:"resetsAt,omitzero"`
}

// limitReading is a reading with the session it came from.
type limitReading struct {
	model.LimitReading
}

type limitGroup struct {
	limitAccount
	limit, kind  string
	window       int
	plan, period string
}

// Limits builds the view from every digest. Windows are keyed by harness, limit and window
// length, then clustered by reset time. Spend counts the messages each session owns (never
// an inherited copy), once each.
func (c *Catalog) Limits() Limits {
	return c.LimitsAt(time.Now())
}

// LimitsAt evaluates reset times against the supplied clock.
func (c *Catalog) LimitsAt(now time.Time) Limits {
	v := c.view()
	out := Limits{Windows: []LimitWindow{}, Refusals: []LimitRefusal{}}
	firstSeen := map[limitAccount]time.Time{}
	recordAccount := func(account limitAccount, at time.Time) {
		if account.key == "" {
			return
		}
		seen, ok := firstSeen[account]
		if !ok || (!at.IsZero() && (seen.IsZero() || at.Before(seen))) {
			firstSeen[account] = at
		}
	}
	readings := map[limitAccount][]limitReading{}
	for _, s := range v.sessions {
		if s.d.Account != "" {
			recordAccount(limitAccount{s.key.Harness, s.d.Account}, s.d.StartedAt)
			if s.d.Kind != model.KindSDK {
				out.SessionAccounts = append(out.SessionAccounts, LimitSessionAccount{s.key, s.d.Account})
			}
		}
		for _, m := range s.own {
			if m.Account != "" && m.Account != s.d.Account {
				recordAccount(limitAccount{s.key.Harness, m.Account}, m.At)
			}
		}
		for _, r := range s.d.Limits {
			account := readingAccount(s, r)
			k := limitAccount{s.key.Harness, account}
			recordAccount(k, r.At)
			readings[k] = append(readings[k], limitReading{r})
			if r.Rejected {
				ref := LimitRefusal{At: r.At, Harness: s.key.Harness, key: s.key,
					Limit: r.Limit, Kind: r.Kind, Account: account, WindowMinutes: r.WindowMinutes, ResetsAt: r.ResetsAt}
				if s.d.Kind == model.KindSDK {
					ref.Scripted = true
				} else {
					k := s.key
					ref.Session = &k
				}
				out.Refusals = append(out.Refusals, ref)
			}
		}
	}
	labels := accountLabels(firstSeen)
	for i := range out.Refusals {
		r := &out.Refusals[i]
		r.AccountLabel = labels[limitAccount{r.Harness, r.Account}]
	}
	sort.SliceStable(out.Refusals, func(i, j int) bool {
		a, b := out.Refusals[i], out.Refusals[j]
		if !a.At.Equal(b.At) {
			return a.At.Before(b.At)
		}
		if a.key.Harness != b.key.Harness {
			return a.key.Harness < b.key.Harness
		}
		return a.key.ID < b.key.ID
	})

	periods := map[limitGroup]limitPlan{}
	groups := map[limitGroup][]limitReading{}
	for account, rs := range readings {
		sort.SliceStable(rs, func(i, j int) bool { return rs[i].At.Before(rs[j].At) })
		planPeriods := limitPlanPeriods(rs)
		p := 0
		for _, r := range rs {
			if r.Limit == "" || r.ResetsAt.IsZero() || (!r.Rejected && r.UsedPercent == nil) {
				continue
			}
			k := limitGroup{limitAccount: account, limit: r.Limit, kind: r.Kind, window: r.WindowMinutes, plan: r.Plan}
			if len(planPeriods) != 0 {
				for p+1 < len(planPeriods) && !r.At.Before(planPeriods[p].until) {
					p++
				}
				period := planPeriods[p]
				k.period = period.id
				periods[k] = period
			}
			groups[k] = append(groups[k], r)
		}
	}
	for k, rs := range groups {
		sort.SliceStable(rs, func(i, j int) bool {
			if !rs[i].ResetsAt.Equal(rs[j].ResetsAt) {
				return rs[i].ResetsAt.Before(rs[j].ResetsAt)
			}
			return rs[i].At.Before(rs[j].At)
		})
		start := 0
		for i := 1; i <= len(rs); i++ {
			if i == len(rs) || rs[i].ResetsAt.Sub(rs[i-1].ResetsAt) > limitGap {
				out.Windows = append(out.Windows, v.limitWindow(k, labels[k.limitAccount], periods[k], rs[start:i]))
				start = i
			}
		}
	}
	sort.SliceStable(out.Windows, func(i, j int) bool {
		a, b := out.Windows[i], out.Windows[j]
		ka, kb := a.StartsAt, b.StartsAt
		if ka.IsZero() {
			ka = a.ResetsAt
		}
		if kb.IsZero() {
			kb = b.ResetsAt
		}
		if !ka.Equal(kb) {
			return ka.Before(kb)
		}
		if a.Harness != b.Harness {
			return a.Harness < b.Harness
		}
		if a.Account != b.Account {
			return a.Account < b.Account
		}
		if a.Limit != b.Limit {
			return a.Limit < b.Limit
		}
		if a.WindowMinutes != b.WindowMinutes {
			return a.WindowMinutes < b.WindowMinutes
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.PlanPeriod != b.PlanPeriod {
			return a.PlanPeriod < b.PlanPeriod
		}
		return a.Plan < b.Plan
	})
	out.Lockouts = v.lockouts(out.Refusals, now)
	return out
}

func accountLabels(firstSeen map[limitAccount]time.Time) map[limitAccount]string {
	byHarness := map[string][]limitAccount{}
	for account := range firstSeen {
		byHarness[account.harness] = append(byHarness[account.harness], account)
	}
	out := map[limitAccount]string{}
	for harness, accounts := range byHarness {
		if len(accounts) < 2 {
			continue
		}
		sort.Slice(accounts, func(i, j int) bool {
			a, b := firstSeen[accounts[i]], firstSeen[accounts[j]]
			if a.Equal(b) {
				return accounts[i].key < accounts[j].key
			}
			return !a.IsZero() && (b.IsZero() || a.Before(b))
		})
		for i, account := range accounts {
			out[account] = fmt.Sprintf("Account %d", i+1)
		}
		out[limitAccount{harness, ""}] = "Unknown account"
	}
	return out
}

type limitPlan struct {
	plan, id    string
	from, until time.Time
}

// limitPlanPeriods names successive observed plan periods. The first reading of a different
// plan gives a comparison boundary; the time of the actual change is not recorded.
func limitPlanPeriods(rs []limitReading) []limitPlan {
	var out []limitPlan
	for _, r := range rs {
		if r.Plan == "" {
			continue
		}
		n := len(out)
		p := limitPlan{plan: r.Plan, id: r.At.Format(time.RFC3339Nano)}
		if n != 0 {
			if out[n-1].plan == r.Plan || !r.At.After(out[n-1].from) {
				continue
			}
			out[n-1].until = r.At
			p.from = r.At
		}
		out = append(out, p)
	}
	return out
}

// limitWindow builds one window from a cluster of readings sorted by reset time.
func (v *view) limitWindow(k limitGroup, label string, plan limitPlan, rs []limitReading) LimitWindow {
	w := LimitWindow{Harness: k.harness, Limit: k.limit, Kind: k.kind, Account: k.key, AccountLabel: label,
		WindowMinutes: k.window, ResetsAt: rs[0].ResetsAt, Plan: k.plan, PlanPeriod: k.period, Points: []LimitPoint{}}
	if k.window > 0 {
		w.StartsAt = w.ResetsAt.Add(-time.Duration(k.window) * time.Minute)
	}
	byTime := append([]limitReading(nil), rs...)
	sort.SliceStable(byTime, func(i, j int) bool { return byTime[i].At.Before(byTime[j].At) })
	for _, r := range byTime {
		if w.FirstSeenAt.IsZero() || r.At.Before(w.FirstSeenAt) {
			w.FirstSeenAt = r.At
		}
		if r.At.After(w.LastSeenAt) {
			w.LastSeenAt = r.At
		}
		if r.Rejected {
			w.Refusals++
			if w.FirstRefusalAt.IsZero() {
				w.FirstRefusalAt = r.At
			}
		}
		if r.UsedPercent == nil {
			continue
		}
		p := *r.UsedPercent
		if w.FirstPercent == nil {
			f := p
			w.FirstPercent = &f
		}
		if w.MaxPercent == nil || p > *w.MaxPercent {
			m := p
			w.MaxPercent = &m
		}
		if n := len(w.Points); n > 0 && w.Points[n-1].At.Equal(r.At) && w.Points[n-1].UsedPercent == p {
			continue
		}
		w.Points = append(w.Points, LimitPoint{At: r.At, UsedPercent: p})
	}
	w.TopSessions = []LimitSession{}
	f := Filter{Harness: k.harness, Account: k.key}
	if f.Account == "" {
		f.Account = "unknown"
	}
	if !w.StartsAt.IsZero() && !w.StartsAt.Before(plan.from) && (plan.until.IsZero() || !w.ResetsAt.After(plan.until)) {
		f.From, f.To = w.StartsAt, w.ResetsAt
		usd := v.total(f).TotalUSD
		w.SeenUSD = &usd
		w.SeenSessions, w.ScriptedUSD, w.TopSessions = v.spendIn(f)
	}
	if n := len(w.Points); n > 1 {
		first, last := w.Points[0], w.Points[n-1]
		if gained := last.UsedPercent - first.UsedPercent; gained >= limitPercentMin {
			f.From, f.To = first.At, last.At
			usd := v.total(f).TotalUSD / gained
			w.UsdPerPercent = &usd
		}
	}
	return w
}

// spendIn counts the sessions with spend in f, the spend of the scripted ones among it, and
// lists the non-scripted sessions that spent most (never more than limitTop, largest first, then
// harness and id).
func (v *view) spendIn(f Filter) (sessions int, scripted float64, top []LimitSession) {
	f.States = nil
	perSess := map[*sess]float64{}
	var order []*sess
	for _, x := range v.selected(f) {
		if _, ok := perSess[x.s]; !ok {
			order = append(order, x.s)
		}
		perSess[x.s] += x.reported + x.attributed + x.recorded
	}
	top = []LimitSession{}
	for _, s := range order {
		// A session counts when it spent something inside the range, as a Cost row's sessions do.
		if perSess[s] <= 0 {
			continue
		}
		sessions++
		if s.d.Kind == model.KindSDK {
			scripted += perSess[s]
			continue
		}
		top = append(top, LimitSession{Harness: s.key.Harness, ID: s.key.ID, Name: s.info.Name, Title: s.info.Title, USD: perSess[s]})
	}
	sort.SliceStable(top, func(i, j int) bool {
		a, b := top[i], top[j]
		if a.USD != b.USD {
			return a.USD > b.USD
		}
		if a.Harness != b.Harness {
			return a.Harness < b.Harness
		}
		return a.ID < b.ID
	})
	if len(top) > limitTop {
		top = top[:limitTop]
	}
	return
}
