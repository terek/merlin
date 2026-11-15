package catalog

import (
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
	Windows  []LimitWindow  `json:"windows"`
	Refusals []LimitRefusal `json:"refusals"`
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
	WindowMinutes  int          `json:"windowMinutes,omitempty"`
	Plan           string       `json:"plan,omitempty"` // the last one named
	ResetsAt       time.Time    `json:"resetsAt"`       // the earliest reset time of the readings
	StartsAt       time.Time    `json:"startsAt,omitzero"`
	FirstSeenAt    time.Time    `json:"firstSeenAt"`
	LastSeenAt     time.Time    `json:"lastSeenAt"`
	FirstPercent   *float64     `json:"firstPercent,omitempty"`
	MaxPercent     *float64     `json:"maxPercent,omitempty"`
	Points         []LimitPoint `json:"points"`
	Refusals       int          `json:"refusals"`
	FirstRefusalAt time.Time    `json:"firstRefusalAt,omitzero"`
	// SeenUSD is the spend of this machine's recorded messages of the harness inside
	// [StartsAt, ResetsAt), each message once; nil when StartsAt is not known.
	SeenUSD      *float64 `json:"seenUSD,omitempty"`
	SeenSessions int      `json:"seenSessions,omitempty"`
}

// LimitRefusal is one call the harness refused because a limit was reached. A scripted run's
// refusal names no session (scripted runs are never listed one by one); Scripted says so.
type LimitRefusal struct {
	At            time.Time         `json:"at"`
	Harness       string            `json:"harness"`
	Session       *model.SessionKey `json:"session,omitempty"`
	Scripted      bool              `json:"scripted,omitempty"`
	key           model.SessionKey
	Limit         string    `json:"limit,omitempty"`
	WindowMinutes int       `json:"windowMinutes,omitempty"`
	ResetsAt      time.Time `json:"resetsAt,omitzero"`
}

// limitReading is a reading with the session it came from.
type limitReading struct {
	model.LimitReading
	s *sess
}

// spendPoint is one owned message, for the spend inside a window.
type spendPoint struct {
	at  time.Time
	usd float64
	s   *sess
}

// Limits builds the view from every digest. Windows are keyed by harness, limit and window
// length, then clustered by reset time. Spend counts the messages each session owns (never
// an inherited copy), once each.
func (c *Catalog) Limits() Limits {
	v := c.view()
	out := Limits{Windows: []LimitWindow{}, Refusals: []LimitRefusal{}}

	type gkey struct {
		harness, limit string
		window         int
	}
	groups := map[gkey][]limitReading{}
	var gkeys []gkey
	spend := map[string][]spendPoint{}
	for _, s := range v.sessions {
		for _, m := range s.own {
			if !m.At.IsZero() {
				spend[s.key.Harness] = append(spend[s.key.Harness], spendPoint{m.At, m.USD, s})
			}
		}
		for _, r := range s.d.Limits {
			if r.Rejected {
				ref := LimitRefusal{At: r.At, Harness: s.key.Harness, key: s.key,
					Limit: r.Limit, WindowMinutes: r.WindowMinutes, ResetsAt: r.ResetsAt}
				if s.d.Kind == model.KindSDK {
					ref.Scripted = true
				} else {
					k := s.key
					ref.Session = &k
				}
				out.Refusals = append(out.Refusals, ref)
			}
			if r.Limit == "" || r.ResetsAt.IsZero() || (!r.Rejected && r.UsedPercent == nil) {
				continue
			}
			k := gkey{s.key.Harness, r.Limit, r.WindowMinutes}
			if _, ok := groups[k]; !ok {
				gkeys = append(gkeys, k)
			}
			groups[k] = append(groups[k], limitReading{r, s})
		}
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
	for h := range spend {
		sp := spend[h]
		sort.SliceStable(sp, func(i, j int) bool { return sp[i].at.Before(sp[j].at) })
	}

	for _, k := range gkeys {
		rs := groups[k]
		sort.SliceStable(rs, func(i, j int) bool {
			if !rs[i].ResetsAt.Equal(rs[j].ResetsAt) {
				return rs[i].ResetsAt.Before(rs[j].ResetsAt)
			}
			return rs[i].At.Before(rs[j].At)
		})
		start := 0
		for i := 1; i <= len(rs); i++ {
			if i == len(rs) || rs[i].ResetsAt.Sub(rs[i-1].ResetsAt) > limitGap {
				out.Windows = append(out.Windows, limitWindow(k.harness, k.limit, k.window, rs[start:i], spend[k.harness]))
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
		if a.Limit != b.Limit {
			return a.Limit < b.Limit
		}
		return a.WindowMinutes < b.WindowMinutes
	})
	return out
}

// limitWindow builds one window from a cluster of readings sorted by reset time.
func limitWindow(harness, limit string, minutes int, rs []limitReading, spend []spendPoint) LimitWindow {
	w := LimitWindow{Harness: harness, Limit: limit, WindowMinutes: minutes, ResetsAt: rs[0].ResetsAt, Points: []LimitPoint{}}
	if minutes > 0 {
		w.StartsAt = w.ResetsAt.Add(-time.Duration(minutes) * time.Minute)
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
		if r.Plan != "" {
			w.Plan = r.Plan
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
	if !w.StartsAt.IsZero() {
		var usd float64
		seen := map[*sess]bool{}
		i := sort.Search(len(spend), func(i int) bool { return !spend[i].at.Before(w.StartsAt) })
		for ; i < len(spend) && spend[i].at.Before(w.ResetsAt); i++ {
			usd += spend[i].usd
			seen[spend[i].s] = true
		}
		w.SeenUSD, w.SeenSessions = &usd, len(seen)
	}
	return w
}
