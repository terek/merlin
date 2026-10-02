package catalog

import (
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/terek/merlin/explorer/internal/model"
)

const (
	snippetBefore = 40
	snippetAfter  = 100
)

// fold lowercases rune by rune, so the result has the same number of runes as s.
func fold(s string) string { return strings.Map(unicode.ToLower, s) }

// unmarked blanks out the spans of s that the harness marked as boilerplate, one space per
// rune, so a search does not match inside them and the offsets stay as they were. Spans
// that do not fit s are ignored.
func unmarked(s string, spans []model.TextSpan) string {
	if len(spans) == 0 {
		return s
	}
	var sb strings.Builder
	for i, r := range s {
		blank := false
		for _, sp := range spans {
			if i >= sp.From && i < sp.To {
				blank = true
				break
			}
		}
		if blank {
			sb.WriteByte(' ')
		} else {
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// match checks that every term occurs in text (already folded) and returns the byte
// offset of the earliest first occurrence.
func match(terms []string, text string) (int, bool) {
	first := -1
	for _, t := range terms {
		i := strings.Index(text, t)
		if i < 0 {
			return 0, false
		}
		if first < 0 || i < first {
			first = i
		}
	}
	return first, first >= 0
}

// snippet cuts a short stretch of text around the match at byte offset pos of the folded
// text, with whitespace collapsed.
func snippet(orig, folded string, pos int) string {
	runes := []rune(orig)
	at := utf8.RuneCountInString(folded[:pos])
	from, to := max(0, at-snippetBefore), min(len(runes), at+snippetAfter)
	s := strings.Join(strings.Fields(string(runes[from:to])), " ")
	if from > 0 {
		s = "…" + s
	}
	if to < len(runes) {
		s += "…"
	}
	return s
}

// Search finds text in titles, prompts, final texts, compaction summaries, project paths,
// working directories and branches. The match is case-insensitive and every term of the
// query must occur within one field. Scripted sessions are never searched.
//
// Hits rank title and prompt first, then final text, then compaction summaries, then the
// session-level project, cwd and branch fields; within a rank the newest comes first. A
// turn or compaction copied into several sessions is matched once, in the session that
// owns it, and the hit lists the other sessions that contain it (ContinuedIn).
func (c *Catalog) Search(query string, opt SearchOptions) []Hit {
	terms := strings.Fields(fold(query))
	if len(terms) == 0 {
		return nil
	}
	v := c.view()
	f := opt.Filter
	f.States = nil

	var hits []Hit
	for _, s := range v.sessions {
		if s.d.Kind == model.KindSDK || !f.selects(s, "") {
			continue
		}
		d := s.d
		add := func(field Field, idx int, at time.Time, orig string, abandoned bool, others []int32) {
			folded := fold(orig)
			pos, ok := match(terms, folded)
			if !ok {
				return
			}
			if at.IsZero() {
				at = d.LastActivityAt
			}
			h := Hit{Session: s.key, Title: d.Title, Project: s.project, At: at, Field: field,
				Turn: idx, Abandoned: abandoned, Snippet: snippet(orig, folded, pos)}
			if len(others) > 0 {
				var set []*sess
				for _, o := range others {
					if o != int32(s.idx) && v.sessions[o].d.Kind != model.KindSDK {
						set = append(set, v.sessions[o])
					}
				}
				h.ContinuedIn = v.leavesFirst(set)
			}
			hits = append(hits, h)
		}

		add(FieldTitle, -1, time.Time{}, d.Title, false, nil)
		for k := range d.Turns {
			t := &d.Turns[k]
			var others []int32
			if t.UUID != "" {
				if o, shared := v.turnOwner[t.UUID]; shared {
					if int(o) != s.idx {
						continue
					}
					others = v.turnHolders[t.UUID]
				}
			}
			add(FieldPrompt, t.Index, t.StartedAt, t.UserText, t.Abandoned, others)
			add(FieldFinal, t.Index, t.StartedAt, t.FinalText, t.Abandoned, others)
		}
		for k := range d.Compactions {
			cp := &d.Compactions[k]
			var others []int32
			if key := compactionKey(cp); key != "" {
				if o, shared := v.compOwner[key]; shared {
					if int(o) != s.idx {
						continue
					}
					others = v.compHolders[key]
				}
			}
			add(FieldCompaction, k, cp.At, unmarked(cp.Summary, cp.Boilerplate), false, others)
		}
		add(FieldProject, -1, time.Time{}, s.project, false, nil)
		for _, cwd := range d.Cwds {
			add(FieldCwd, -1, time.Time{}, cwd, false, nil)
		}
		if len(d.Cwds) == 0 {
			add(FieldCwd, -1, time.Time{}, d.Cwd, false, nil)
		}
		for _, b := range d.GitBranches {
			add(FieldBranch, -1, time.Time{}, b, false, nil)
		}
	}

	// A session-level field can match through several cwds or branches: keep one hit per
	// session and field.
	seen := make(map[[3]string]bool)
	kept := hits[:0]
	for _, h := range hits {
		if h.Turn < 0 {
			k := [3]string{h.Session.Harness, h.Session.ID, string(h.Field)}
			if seen[k] {
				continue
			}
			seen[k] = true
		}
		kept = append(kept, h)
	}
	hits = kept

	sort.SliceStable(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		if ra, rb := a.Field.rank(), b.Field.rank(); ra != rb {
			return ra < rb
		}
		if !a.At.Equal(b.At) {
			return a.At.After(b.At)
		}
		if a.Session != b.Session {
			if a.Session.Harness != b.Session.Harness {
				return a.Session.Harness < b.Session.Harness
			}
			return a.Session.ID < b.Session.ID
		}
		if a.Field != b.Field {
			return a.Field < b.Field
		}
		return a.Turn < b.Turn
	})
	if opt.Limit > 0 && len(hits) > opt.Limit {
		hits = hits[:opt.Limit]
	}
	return hits
}
