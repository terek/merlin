package moments

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOldModelRoutingEngagementIsTheOrchestrator(t *testing.T) {
	home := t.TempDir()
	t0 := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	old := `{"engaged":[{"moment":"model-routing","openedAt":"2026-10-01T09:00:00Z","copiedAt":"2026-10-02T09:00:00Z"},` +
		`{"moment":"orchestrator","openedAt":"2026-10-05T09:00:00Z","copiedAt":"2026-10-04T09:00:00Z"}]}`
	if err := os.WriteFile(filepath.Join(home, EngagedFile), []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	got := LoadEngaged(home)
	if len(got) != 1 || got[0].Moment != "orchestrator" || !got[0].OpenedAt.Equal(t0) || !got[0].CopiedAt.Equal(t0.AddDate(0, 0, 3)) {
		t.Fatalf("model-routing entries read as orchestrator, merged: %+v", got)
	}
}
