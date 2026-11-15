package daemon

import (
	"testing"

	"github.com/terek/merlin/internal/catalog"
	"github.com/terek/merlin/internal/engine"
	"github.com/terek/merlin/internal/model"
	"github.com/terek/merlin/internal/store"
)

// A source going missing under the old project key must not mark the live digest of the
// same session under the new one.
func TestOnWriteMissingKeepsLiveCopy(t *testing.T) {
	d := &Daemon{}
	cat := catalog.New()
	d.cat.Store(cat)
	live := &model.SessionDigest{Harness: "claude", ID: "s1", ProjectKey: "new"}
	cat.Upsert(live)
	d.onWrite(engine.Event{Kind: engine.SourceMissing, Ref: store.Ref{Harness: "claude", ProjectKey: "old", SessionID: "s1"}})
	got, _ := cat.Digest(live.Key())
	if got.SourceMissing {
		t.Error("the live digest was marked missing by the old ref")
	}
	d.onWrite(engine.Event{Kind: engine.SourceMissing, Ref: store.Ref{Harness: "claude", ProjectKey: "new", SessionID: "s1"}})
	if got, _ = cat.Digest(live.Key()); !got.SourceMissing {
		t.Error("the matching ref did not mark the digest missing")
	}
}
