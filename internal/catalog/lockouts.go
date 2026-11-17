package catalog

import (
	"sort"
	"strings"
	"time"

	"github.com/terek/merlin/internal/model"
)

// LimitLockout starts with a refusal. An observed call on the same account can end it
// before the scheduled reset. WorkResumedAt can precede that end if another call succeeds.
type LimitLockout struct {
	Harness       string    `json:"harness"`
	Account       string    `json:"account,omitempty"`
	AccountLabel  string    `json:"accountLabel,omitempty"`
	Limit         string    `json:"limit,omitempty"`
	Kind          string    `json:"kind,omitempty"`
	WindowMinutes int       `json:"windowMinutes,omitempty"`
	StartedAt     time.Time `json:"startedAt"`
	ResetsAt      time.Time `json:"resetsAt,omitzero"`
	EndedAt       time.Time `json:"endedAt,omitzero"`
	End           string    `json:"end"`
	WorkResumedAt time.Time `json:"workResumedAt,omitzero"`
}

type limitAccount struct{ harness, key string }

func messageAccount(s *sess, m *model.Message) string {
	if m.AccountKnown || m.Account != "" {
		return m.Account
	}
	return s.d.Account
}

func readingAccount(s *sess, r model.LimitReading) string {
	if r.AccountKnown || r.Account != "" {
		return r.Account
	}
	return s.d.Account
}

func accountMatches(filter, account string) bool {
	if filter == "unknown" {
		return account == ""
	}
	return filter == "" || filter == account
}

// Model-specific Claude limits only recover on the same family. The harness supplies
// published model IDs in the message, including release and context-size suffixes.
func limitModel(harness, limit string) string {
	if harness == "claude" {
		switch limit {
		case "seven_day_opus":
			return "claude-opus-"
		case "seven_day_sonnet":
			return "claude-sonnet-"
		}
	}
	return ""
}

type limitCallGroup struct {
	limitAccount
	modelPrefix string
}

func firstLater(calls []time.Time, at time.Time) time.Time {
	i := sort.Search(len(calls), func(i int) bool { return calls[i].After(at) })
	if i < len(calls) {
		return calls[i]
	}
	return time.Time{}
}

func (v *view) lockouts(refusals []LimitRefusal, now time.Time) []LimitLockout {
	out := []LimitLockout{}
	if len(refusals) == 0 {
		return out
	}
	successes := make(map[limitCallGroup][]time.Time)
	var all []time.Time
	for _, s := range v.sessions {
		for _, m := range s.own {
			if m.At.IsZero() || m.At.After(now) || m.Model == "" || m.Model == "<synthetic>" || m.Tokens == (model.Tokens{}) {
				continue
			}
			all = append(all, m.At)
			k := limitCallGroup{limitAccount: limitAccount{s.key.Harness, messageAccount(s, m)}}
			successes[k] = append(successes[k], m.At)
			if s.key.Harness == "claude" {
				for _, prefix := range []string{"claude-opus-", "claude-sonnet-"} {
					if strings.HasPrefix(m.Model, prefix) {
						k.modelPrefix = prefix
						successes[k] = append(successes[k], m.At)
						break
					}
				}
			}
		}
	}
	byTime := func(ts []time.Time) {
		sort.Slice(ts, func(i, j int) bool { return ts[i].Before(ts[j]) })
	}
	byTime(all)
	for _, ts := range successes {
		byTime(ts)
	}
	type key struct {
		limitAccount
		limit, kind string
		minutes     int
	}
	last := make(map[key]int)
	for _, r := range refusals {
		if r.At.IsZero() {
			continue
		}
		k := key{limitAccount{r.Harness, r.Account}, r.Limit, r.Kind, r.WindowMinutes}
		if i, ok := last[k]; ok && (out[i].EndedAt.IsZero() || r.At.Before(out[i].EndedAt)) {
			// A repeat refusal belongs to the existing episode. It may supply a reset
			// that the first refusal did not report.
			if out[i].ResetsAt.IsZero() && r.ResetsAt.After(r.At) {
				out[i].ResetsAt = r.ResetsAt
				finishLockout(&out[i], successes, all, now)
			}
			continue
		}
		lock := LimitLockout{Harness: r.Harness, Account: r.Account, AccountLabel: r.AccountLabel,
			Limit: r.Limit, Kind: r.Kind, WindowMinutes: r.WindowMinutes, StartedAt: r.At}
		if r.ResetsAt.After(r.At) {
			lock.ResetsAt = r.ResetsAt
		}
		finishLockout(&lock, successes, all, now)
		last[k] = len(out)
		out = append(out, lock)
	}
	return out
}

func finishLockout(lock *LimitLockout, successes map[limitCallGroup][]time.Time, all []time.Time, now time.Time) {
	k := limitCallGroup{limitAccount{lock.Harness, lock.Account}, limitModel(lock.Harness, lock.Limit)}
	resumed := firstLater(successes[k], lock.StartedAt)
	lock.End, lock.EndedAt = "open", time.Time{}
	switch {
	case !resumed.IsZero() && (lock.ResetsAt.IsZero() || resumed.Before(lock.ResetsAt)):
		lock.End, lock.EndedAt = "resumed", resumed
	case !lock.ResetsAt.IsZero() && !lock.ResetsAt.After(now):
		lock.End, lock.EndedAt = "reset", lock.ResetsAt
	}
	lock.WorkResumedAt = firstLater(all, lock.StartedAt)
	if !lock.EndedAt.IsZero() && lock.WorkResumedAt.After(lock.EndedAt) {
		lock.WorkResumedAt = time.Time{}
	}
}
