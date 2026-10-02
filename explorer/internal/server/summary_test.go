package server

import (
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

func TestPreview(t *testing.T) {
	if got, cut := Preview("  fix\tthe \n\n  bug  \r\n now "); got != "fix the bug now" || cut {
		t.Errorf("whitespace: %q cut=%v", got, cut)
	}
	if got, cut := Preview(strings.Repeat("a", 300)); len(got) != 300 || cut {
		t.Errorf("exactly 300: len %d cut=%v", len(got), cut)
	}
	if got, cut := Preview(strings.Repeat("a", 301)); len(got) != 300 || !cut {
		t.Errorf("301: len %d cut=%v", len(got), cut)
	}
	// Multi-byte text is cut by runes, never inside one.
	in := strings.Repeat("é", 200) + strings.Repeat("日本", 100) // 400 runes, 800 bytes
	got, cut := Preview(in)
	if !cut || []rune(got)[299] != '本' || len([]rune(got)) != 300 || got != string([]rune(in)[:300]) {
		t.Errorf("multi-byte: %d runes, cut=%v", len([]rune(got)), cut)
	}
	// Whitespace is collapsed before counting.
	if got, cut := Preview(strings.Repeat("ab    \n", 100)); cut || len(got) != 100*3-1 {
		t.Errorf("collapse before count: len %d cut=%v", len(got), cut)
	}
	if got, cut := Preview("   \n "); got != "" || cut {
		t.Errorf("blank: %q", got)
	}
}

func turn(i int, origin model.TurnOrigin, abandoned bool, text string) model.Turn {
	return model.Turn{Index: i, Origin: origin, Abandoned: abandoned, UserText: text,
		StartedAt: time.Date(2026, 9, 1, 10, i, 0, 0, time.UTC)}
}

func TestLastPrompt(t *testing.T) {
	cases := []struct {
		name  string
		turns []model.Turn
		want  int // turn index, -1: none
	}{
		{"none", nil, -1},
		{"no human turn", []model.Turn{turn(0, model.OriginCommand, false, "x")}, -1},
		{"last human", []model.Turn{turn(0, model.OriginHuman, false, "a"), turn(1, model.OriginHuman, false, "b"),
			turn(2, model.OriginTaskNotification, false, "c")}, 1},
		{"skips abandoned", []model.Turn{turn(0, model.OriginHuman, false, "a"), turn(1, model.OriginHuman, true, "b")}, 0},
		{"all abandoned: the last", []model.Turn{turn(0, model.OriginHuman, true, "a"), turn(1, model.OriginCommand, false, "x"),
			turn(2, model.OriginHuman, true, "b")}, 2},
	}
	for _, c := range cases {
		d := &model.SessionDigest{Turns: c.turns}
		got := lastPrompt(d)
		switch {
		case c.want < 0 && got != nil:
			t.Errorf("%s: got %+v, want none", c.name, got)
		case c.want >= 0 && (got == nil || got.Turn != c.want || !got.At.Equal(c.turns[c.want].StartedAt)):
			t.Errorf("%s: got %+v, want turn %d", c.name, got, c.want)
		}
	}
	if lastRecap(&model.SessionDigest{}) != nil {
		t.Error("recap without recaps")
	}
	rc := lastRecap(&model.SessionDigest{Recaps: []model.Recap{{Text: "old"}, {At: time.Unix(5, 0).UTC(), Text: " new \n one "}}})
	if rc == nil || rc.Text != "new one" || rc.Truncated || !rc.At.Equal(time.Unix(5, 0)) {
		t.Errorf("recap %+v", rc)
	}
}

func TestSummaryFieldsServed(t *testing.T) {
	r := newRig(t)
	var l SessionList
	r.get("/api/sessions?limit=500", &l)
	prompts, recaps := 0, 0
	for _, s := range l.Sessions {
		d, _ := r.cat.Digest(s.Key)
		if s.HumanTurns != int(d.Stats.HumanTurns) {
			t.Errorf("%s: humanTurns %d, digest %d", s.Key.ID, s.HumanTurns, d.Stats.HumanTurns)
		}
		if s.LastPrompt != nil {
			prompts++
			if full := d.Turns[s.LastPrompt.Turn].UserText; len([]rune(full)) <= 300 && s.LastPrompt.Truncated {
				t.Errorf("%s: truncated a short prompt", s.Key.ID)
			}
		} else if s.HumanTurns > 0 {
			hasHuman := false
			for _, tn := range d.Turns {
				hasHuman = hasHuman || tn.Origin == model.OriginHuman
			}
			if hasHuman {
				t.Errorf("%s: no lastPrompt", s.Key.ID)
			}
		}
		if s.Recap != nil {
			recaps++
		}
	}
	if prompts == 0 {
		t.Error("no session has a lastPrompt")
	}

	// A digest with a long, multi-byte, abandoned-last prompt and a recap.
	key, _ := newestKey(r)
	d := r.digest(key.ID)
	long := strings.Repeat("日本語 ", 200)
	d.Turns = append([]model.Turn(nil), d.Turns...)
	d.Turns = append(d.Turns, turn(len(d.Turns), model.OriginHuman, false, long), turn(len(d.Turns)+1, model.OriginHuman, true, "abandoned"))
	d.Recaps = []model.Recap{{At: time.Unix(9, 0).UTC(), Text: long}}
	r.cat.Upsert(d)

	var detail SessionDetail
	r.get("/api/sessions/claude/"+key.ID, &detail)
	lp, rc := detail.Summary.LastPrompt, detail.Summary.Recap
	if lp == nil || lp.Turn != len(d.Turns)-2 || !lp.Truncated || len([]rune(lp.Text)) != 300 || strings.Contains(lp.Text, "  ") {
		t.Errorf("detail lastPrompt %+v", lp)
	}
	if rc == nil || !rc.Truncated || len([]rune(rc.Text)) != 300 {
		t.Errorf("detail recap %+v", rc)
	}
	if detail.Digest.Turns[lp.Turn].UserText != long {
		t.Error("the digest in the detail must keep the whole text")
	}
	var l2 SessionList
	r.get("/api/sessions?limit=1", &l2)
	if l2.Sessions[0].LastPrompt == nil || *l2.Sessions[0].LastPrompt != *lp || *l2.Sessions[0].Recap != *rc {
		t.Error("list row differs from the detail's summary")
	}

	// The fields are omitted when empty.
	d2 := r.digest(key.ID)
	d2.Turns, d2.Recaps = nil, nil
	r.cat.Upsert(d2)
	r.get("/api/sessions/claude/"+key.ID, &detail)
	if detail.Summary.LastPrompt != nil || detail.Summary.Recap != nil {
		t.Errorf("expected none: %+v %+v", detail.Summary.LastPrompt, detail.Summary.Recap)
	}
}

func TestSessionUpdatedCarriesSummaryFields(t *testing.T) {
	r := newRig(t)
	c := r.events()
	c.nextEvent(t, EventScanProgress)
	key, _ := newestKey(r)
	d := r.digest(key.ID)
	d.Turns = append(append([]model.Turn(nil), d.Turns...), turn(len(d.Turns), model.OriginHuman, false, "hello   there"))
	r.write(d)
	f := c.nextEvent(t, EventSessionUpdated)
	if !strings.Contains(f.data, `"lastPrompt":{"turn":`) || !strings.Contains(f.data, `"text":"hello there"`) || !strings.Contains(f.data, `"humanTurns":`) {
		t.Errorf("event data lacks the new fields: %s", f.data)
	}
}
