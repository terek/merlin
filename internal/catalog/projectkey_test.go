package catalog

import (
	"testing"
	"time"

	"github.com/terek/merlin/internal/model"
)

func dupDigest(project string, missing bool, hour int) *model.SessionDigest {
	return &model.SessionDigest{
		Harness: "claude", ID: "dup", ProjectKey: project, SourceMissing: missing,
		LastActivityAt: time.Date(2026, 1, 1, hour, 0, 0, 0, time.UTC),
	}
}

func heldProject(t *testing.T, c *Catalog) string {
	t.Helper()
	d, ok := c.Digest(model.SessionKey{Harness: "claude", ID: "dup"})
	if !ok {
		t.Fatal("session not held")
	}
	return d.ProjectKey
}

func TestUpsertKeepsLiveOverStaleCopy(t *testing.T) {
	stale := dupDigest("zz-old", true, 9)
	live := dupDigest("aa-new", false, 8)
	for name, order := range map[string][]*model.SessionDigest{"live first": {live, stale}, "stale first": {stale, live}} {
		c := New()
		for _, d := range order {
			c.Upsert(d)
		}
		if got := heldProject(t, c); got != "aa-new" {
			t.Errorf("%s: kept %q, want aa-new", name, got)
		}
	}
}

func TestUpsertTwoLiveKeepsLaterActivity(t *testing.T) {
	a, b := dupDigest("p-a", false, 10), dupDigest("p-b", false, 11)
	for name, order := range map[string][]*model.SessionDigest{"a,b": {a, b}, "b,a": {b, a}} {
		c := New()
		for _, d := range order {
			c.Upsert(d)
		}
		if got := heldProject(t, c); got != "p-b" {
			t.Errorf("%s: kept %q, want p-b", name, got)
		}
	}
}

func TestUpsertTieKeepsGreaterProjectKey(t *testing.T) {
	a, b := dupDigest("p-a", false, 10), dupDigest("p-b", false, 10)
	for _, order := range [][]*model.SessionDigest{{a, b}, {b, a}} {
		c := New()
		for _, d := range order {
			c.Upsert(d)
		}
		if got := heldProject(t, c); got != "p-b" {
			t.Errorf("kept %q, want p-b", got)
		}
	}
}

func TestUpsertSameProjectReplaces(t *testing.T) {
	c := New()
	c.Upsert(dupDigest("p", false, 11))
	c.Upsert(dupDigest("p", true, 9))
	d, _ := c.Digest(model.SessionKey{Harness: "claude", ID: "dup"})
	if !d.SourceMissing || d.LastActivityAt.Hour() != 9 {
		t.Errorf("same project was not replaced: %+v", d)
	}
}

func TestMarkMissingNeedsMatchingProjectKey(t *testing.T) {
	key := model.SessionKey{Harness: "claude", ID: "dup"}
	c := New()
	c.Upsert(dupDigest("p-live", false, 10))
	if c.MarkMissing(key, "p-old") {
		t.Error("MarkMissing under another project key reported a hit")
	}
	if d, _ := c.Digest(key); d.SourceMissing {
		t.Error("MarkMissing under another project key marked the live digest")
	}
	if !c.MarkMissing(key, "p-live") {
		t.Error("MarkMissing under the held project key reported no hit")
	}
	if d, _ := c.Digest(key); !d.SourceMissing {
		t.Error("MarkMissing under the held project key did not mark")
	}
}
