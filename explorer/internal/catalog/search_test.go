package catalog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/fixtures"
	"github.com/terek/merlin/explorer/internal/model"
)

func TestSearchNonAdjacentTerms(t *testing.T) {
	c := fixtureCatalog(t)
	// "style the search box" is turn 1 of the 13a pair; "STYLE" and "box" are not adjacent.
	hits := c.Search("STYLE box", SearchOptions{Filter: Filter{Project: "/home/dev/acme/s13e-sdk-pickup"}})
	if len(hits) != 1 {
		t.Fatalf("hits = %+v", hits)
	}
	h := hits[0]
	if h.Session != sid("13", "09") || h.Field != FieldPrompt || h.Turn != 1 {
		t.Errorf("hit = %+v", h)
	}
	if !strings.Contains(h.Snippet, "style the search box") {
		t.Errorf("snippet = %q", h.Snippet)
	}
	// terms in different fields do not combine: "style" is in a prompt, "database" is not
	if hits := c.Search("style database", SearchOptions{}); len(hits) != 0 {
		t.Errorf("cross-field match: %+v", hits)
	}
	if hits := c.Search("   ", SearchOptions{}); hits != nil {
		t.Errorf("blank query gave hits")
	}
}

func TestSearchCopiedPromptIsOneHitNamingTheChild(t *testing.T) {
	c := fixtureCatalog(t)
	hits := c.Search("style the search box", SearchOptions{Filter: Filter{Project: "/home/dev/acme/s13a-continuation"}})
	var prompts []Hit
	for _, h := range hits {
		if h.Field == FieldPrompt {
			prompts = append(prompts, h)
		}
	}
	if len(prompts) != 1 {
		t.Fatalf("prompt hits = %+v", prompts)
	}
	h := prompts[0]
	if h.Session != sid("13", "01") {
		t.Errorf("matched in %v, want the owner (the parent)", h.Session)
	}
	if len(h.ContinuedIn) != 1 || h.ContinuedIn[0] != sid("13", "02") {
		t.Errorf("continuedIn = %v", h.ContinuedIn)
	}
	// the child's own prompt is a hit in the child, with nobody continuing from it
	own := c.Search("clear button", SearchOptions{Filter: Filter{Project: "/home/dev/acme/s13a-continuation"}})
	if len(own) != 2 || own[0].Field != FieldPrompt || own[0].Session != sid("13", "02") || own[0].Turn != 2 || len(own[0].ContinuedIn) != 0 {
		t.Errorf("own = %+v", own)
	}
	// the final text of a copied turn is matched once as well
	fin := c.Search("search box", SearchOptions{Filter: Filter{Project: "/home/dev/acme/s13b-fork-unmarked"}})
	seen := map[string]int{}
	for _, h := range fin {
		seen[fmt.Sprintf("%v/%s/%d", h.Session, h.Field, h.Turn)]++
	}
	for k, n := range seen {
		if n != 1 {
			t.Errorf("%s matched %d times", k, n)
		}
	}
}

func TestSearchRanking(t *testing.T) {
	c := fixtureCatalog(t)
	// "seed data": prompt of turn 2, final text of turn 2, and the second compaction summary
	// of the same session, plus nothing else.
	hits := c.Search("seed data", SearchOptions{})
	var fields []Field
	for _, h := range hits {
		fields = append(fields, h.Field)
		if h.Session != sid("05", "01") {
			t.Errorf("unexpected session %v", h.Session)
		}
	}
	want := []Field{FieldPrompt, FieldFinal, FieldCompaction}
	if fmt.Sprint(fields) != fmt.Sprint(want) {
		t.Fatalf("fields = %v, want %v", fields, want)
	}
	if hits[2].Turn != 1 || !strings.Contains(hits[2].Snippet, "Seed data was added") {
		t.Errorf("compaction hit = %+v", hits[2])
	}

	// a term that occurs only in compaction summaries is found, labelled, and never a prompt
	hits = c.Search("ran out of context", SearchOptions{})
	if len(hits) < 3 {
		t.Fatalf("hits = %+v", hits)
	}
	for _, h := range hits {
		if h.Field != FieldCompaction {
			t.Errorf("field = %s", h.Field)
		}
	}
	// only one of the compaction texts says "added and styled"
	hits = c.Search("added and styled", SearchOptions{})
	if len(hits) != 1 || hits[0].Field != FieldCompaction || hits[0].Session != sid("13", "08") || hits[0].Turn != 0 {
		t.Errorf("styled = %+v", hits)
	}

	// prompts rank above final texts above compactions, whatever the date: "database"
	hits = c.Search("database", SearchOptions{})
	last := -1
	for _, h := range hits {
		if r := h.Field.rank(); r < last {
			t.Errorf("ranking broken at %+v", h)
		} else {
			last = r
		}
	}
	// within a rank, newest first
	hits = c.Search("add", SearchOptions{})
	prev := time.Time{}
	rank := 0
	for i, h := range hits {
		if h.Field.rank() != rank {
			rank, prev = h.Field.rank(), time.Time{}
		}
		if i > 0 && !prev.IsZero() && h.At.After(prev) {
			t.Errorf("hit %d is newer than the previous one in its rank", i)
		}
		prev = h.At
	}
	if len(c.Search("add", SearchOptions{Limit: 3})) != 3 {
		t.Errorf("limit ignored")
	}
}

func TestSearchSessionFields(t *testing.T) {
	c := fixtureCatalog(t)
	hits := c.Search("worktree-login", SearchOptions{})
	if len(hits) != 1 || hits[0].Field != FieldBranch || hits[0].Turn != -1 {
		t.Errorf("branch: %+v", hits)
	}
	hits = c.Search("acme cwdchange", SearchOptions{})
	for _, h := range hits {
		if h.Field != FieldCwd && h.Field != FieldProject {
			t.Errorf("field = %s", h.Field)
		}
	}
	if len(hits) == 0 {
		t.Errorf("no project/cwd hits")
	}
	hits = c.Search("my logout", SearchOptions{})
	if len(hits) == 0 || hits[0].Field != FieldTitle {
		t.Errorf("title: %+v", hits)
	}
}

func TestSearchNeverReturnsScriptedSessions(t *testing.T) {
	c := fixtureCatalog(t)
	for _, q := range []string{"summarize README", "sdk", "acme", "README.md", "a", "e"} {
		for _, h := range c.Search(q, SearchOptions{}) {
			if h.Session == sid("15", "01") {
				t.Errorf("query %q returned the scripted session: %+v", q, h)
			}
		}
	}
	if hits := c.Search("summarize readme", SearchOptions{}); len(hits) != 0 {
		t.Errorf("found scripted prompt: %+v", hits)
	}
}

func TestSearchCaseAndSnippet(t *testing.T) {
	long := strings.Repeat("lorem ipsum ", 30) + "NEEDLE here and ÄÖÜ after " + strings.Repeat("dolor sit ", 40)
	d := syn("claude", "s", "/p", 0, 1, []model.Turn{turn(0, "", long, 0)})
	c := New()
	c.Upsert(d)
	hits := c.Search("needle äöü", SearchOptions{})
	if len(hits) != 1 {
		t.Fatalf("hits = %+v", hits)
	}
	s := hits[0].Snippet
	if !strings.Contains(s, "NEEDLE here and ÄÖÜ after") || !strings.HasPrefix(s, "…") || !strings.HasSuffix(s, "…") {
		t.Errorf("snippet = %q", s)
	}
	if n := len([]rune(s)); n > snippetBefore+snippetAfter+4 {
		t.Errorf("snippet is %d runes", n)
	}
	// stored text is never truncated
	if got := c.view().sessions[0].d.Turns[0].UserText; got != long {
		t.Errorf("stored text changed")
	}
}

func TestSearchAbandonedTurnIsFlagged(t *testing.T) {
	c := fixtureCatalog(t)
	hits := c.Search("settings page", SearchOptions{})
	if len(hits) == 0 || !hits[0].Abandoned {
		t.Errorf("abandoned flag lost: %+v", hits)
	}
}

func TestLiveness(t *testing.T) {
	c := fixtureCatalog(t)
	reg, err := ReadRegistry("claude", filepath.Join(fixtures.ClaudeDir(), "sessions"), func(pid int) bool { return pid == 4242 })
	if err != nil {
		t.Fatal(err)
	}
	if len(reg) != 1 || reg[sid("01", "01")].Status != "busy" || reg[sid("01", "01")].PID != 4242 {
		t.Fatalf("registry = %+v", reg)
	}
	plain, _ := c.Session(sid("01", "01"))
	slash, _ := c.Session(sid("03", "01"))

	lv := Liveness{Registry: reg, Now: time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)}
	if st, _ := c.StateOf(plain.Key, lv); st != StateBusy || !st.Running() {
		t.Errorf("registered pid alive: %s", st)
	}
	if st, _ := c.StateOf(slash.Key, lv); st != StateEnded {
		t.Errorf("pid 4343 dead, old activity: %s", st)
	}
	lv.Now = slash.LastActivityAt.Add(9*time.Minute + 59*time.Second)
	if st, _ := c.StateOf(slash.Key, lv); st != StateRecent {
		t.Errorf("within 10 minutes: %s", st)
	}
	lv.Now = slash.LastActivityAt.Add(10*time.Minute + time.Second)
	if st, _ := c.StateOf(slash.Key, lv); st != StateEnded {
		t.Errorf("after 10 minutes: %s", st)
	}

	// both pids alive: idle for the second
	reg, _ = ReadRegistry("claude", filepath.Join(fixtures.ClaudeDir(), "sessions"), func(int) bool { return true })
	lv = Liveness{Registry: reg, Now: time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)}
	if st, _ := c.StateOf(slash.Key, lv); st != StateIdle {
		t.Errorf("idle: %s", st)
	}
	// filtering listings by state
	l := c.List(Filter{States: []State{StateBusy, StateIdle}}, lv)
	if len(l.Sessions) != 2 {
		t.Errorf("running sessions = %d", len(l.Sessions))
	}
	for _, s := range l.Sessions {
		if !s.State.Running() {
			t.Errorf("state %q listed as running", s.State)
		}
	}
	if st, _ := c.StateOf(key("nope"), lv); st != "" {
		t.Errorf("unknown session has state %q", st)
	}
	// missing registry directory is not an error
	if r, err := ReadRegistry("claude", filepath.Join(t.TempDir(), "none"), nil); err != nil || len(r) != 0 {
		t.Errorf("missing dir: %v %v", r, err)
	}
	// a dead pid, a malformed file and an unrelated file are skipped
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "1.json"), []byte(`{"pid":1,"sessionId":"x","status":"idle"}`), 0o644)
	os.WriteFile(filepath.Join(dir, "2.json"), []byte(`not json`), 0o644)
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte(`{}`), 0o644)
	if r, _ := ReadRegistry("claude", dir, func(int) bool { return false }); len(r) != 0 {
		t.Errorf("dead pid kept: %v", r)
	}
	if !ProcessAlive(os.Getpid()) || ProcessAlive(0) {
		t.Errorf("ProcessAlive")
	}
}

func TestConcurrentUpsertAndReaders(t *testing.T) {
	ds := goldens(t)
	c := New()
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for r := 0; r < 6; r++ {
		wg.Add(1)
		go func(r int) {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				switch r % 3 {
				case 0:
					c.List(Filter{}, Liveness{})
					c.Search("add", SearchOptions{})
				case 1:
					c.Rollup(Filter{}, ByDay, ByModel)
					c.Total(Filter{})
				default:
					c.Family(sid("13", "04"))
					c.Session(sid("13", "04"))
					c.ProjectFiles()
				}
			}
		}(r)
	}
	var w sync.WaitGroup
	w.Add(1)
	go func() {
		defer w.Done()
		for round := 0; round < 4; round++ {
			for _, d := range ds {
				c.Upsert(d)
			}
			c.MarkMissing(ds[0].Key())
			c.Remove(ds[1].Key())
		}
	}()
	w.Wait()
	close(stop)
	wg.Wait()
	if c.Len() != len(ds)-1 {
		t.Errorf("len = %d", c.Len())
	}
}

func TestShuffleDoesNotTouchInputDigests(t *testing.T) {
	// The catalog never modifies a digest it was given.
	ds := goldens(t)
	before := goldens(t)
	enc := func(d *model.SessionDigest) string { b, _ := json.Marshal(d); return string(b) }
	c := New()
	for _, d := range ds {
		c.Upsert(d)
	}
	snapshot(c)
	for i := range ds {
		if enc(ds[i]) != enc(before[i]) {
			t.Fatalf("digest %s was modified", ds[i].ID)
		}
	}
}

func TestSearchPartialCopyNamesChild(t *testing.T) {
	c := fixtureCatalog(t)
	hits := c.Search("reset button", SearchOptions{Filter: Filter{Project: "/home/dev/acme/s13d-partial-copy"}})
	var prompts []Hit
	for _, h := range hits {
		if h.Field == FieldPrompt {
			prompts = append(prompts, h)
		}
	}
	if len(prompts) != 1 || prompts[0].Session != sid("13", "07") || len(prompts[0].ContinuedIn) != 1 || prompts[0].ContinuedIn[0] != sid("13", "08") {
		t.Errorf("prompts = %+v", prompts)
	}
}

func BenchmarkRebuild(b *testing.B) {
	c := New()
	for i := 0; i < 3000; i++ {
		var msgs []msgSpec
		for j := 0; j < 37; j++ {
			msgs = append(msgs, msgSpec{fmt.Sprintf("m%d-%d", i, j), j, 0.01, 0})
		}
		d := syn("claude", fmt.Sprintf("s%05d", i), fmt.Sprintf("/p/%d", i%40), i, i+40, []model.Turn{turn(0, fmt.Sprintf("u%d", i), "do a thing", i)}, msgs...)
		if i > 0 && i%10 == 0 { // every tenth session continues the previous one
			prev := c.digests[key(fmt.Sprintf("s%05d", i-1))]
			d.Messages = append(append([]model.Message(nil), prev.Messages...), d.Messages...)
		}
		c.Upsert(d)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c.mu.Lock()
		c.dirty = true
		c.mu.Unlock()
		c.Total(Filter{})
	}
}
