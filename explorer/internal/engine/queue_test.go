package engine

import (
	"context"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/model"
)

type nameOnly struct{ harness.Harness }

func (nameOnly) Name() string { return "h" }

func mk(id string, size int64) job {
	return job{h: nameOnly{}, s: harness.Session{
		Key: model.SessionKey{Harness: "h", ID: id}, ProjectKey: "p",
		Fingerprint: []model.SourceFile{{Path: id, Size: size}},
	}}
}

func TestQueueDedupAndPriority(t *testing.T) {
	q := newQueue()
	q.push(mk("a", 1), false)
	q.push(mk("b", 1), false)
	q.push(mk("a", 2), false) // deduped, newest description kept
	q.push(mk("c", 1), true)
	q.push(mk("b", 2), true) // upgraded to the live lane
	var order []string
	for range 3 {
		j, _ := q.pop()
		order = append(order, j.s.Key.ID)
		if j.s.Key.ID == "a" && j.s.Fingerprint[0].Size != 2 {
			t.Error("a not refreshed")
		}
		q.done(j)
	}
	if got := order[0] + order[1] + order[2]; got != "cba" {
		t.Fatalf("order %v, want [c b a]", order)
	}
	if q.pending != 0 || len(q.items) != 0 {
		t.Fatalf("leftovers: %d", q.pending)
	}
}

func TestQueueChangeWhileRunningRunsAgain(t *testing.T) {
	q := newQueue()
	q.push(mk("a", 1), false)
	j, _ := q.pop()
	q.push(mk("a", 1), false) // same files as the running build: nothing to do
	q.done(j)
	if q.pending != 0 {
		t.Fatal("identical push while running should not requeue")
	}

	q.push(mk("a", 1), false)
	j, _ = q.pop()
	q.push(mk("a", 5), false) // changed while running
	q.push(mk("a", 6), false)
	// Another worker must not get it while the first holds it.
	got := make(chan job, 1)
	go func() { j2, _ := q.pop(); got <- j2 }()
	select {
	case <-got:
		t.Fatal("session handed to a second worker")
	case <-time.After(50 * time.Millisecond):
	}
	q.done(j)
	j2 := <-got
	if j2.s.Fingerprint[0].Size != 6 {
		t.Fatalf("rerun uses %v", j2.s.Fingerprint)
	}
	q.done(j2)
	if err := q.waitIdle(context.Background()); err != nil {
		t.Fatal(err)
	}
}
