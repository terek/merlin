package engine

import (
	"context"
	"slices"
	"sync"

	"github.com/terek/merlin/explorer/internal/harness"
)

// job is one session to (re)build.
type job struct {
	h harness.Harness
	s harness.Session
}

func (j job) key() string { return j.h.Name() + "\x00" + j.s.Key.ID }

type item struct {
	job     job
	live    bool
	queued  bool // waiting for a worker
	running bool // a worker holds it
	rerun   bool // changed while running: queue again when the worker is done
}

// queue is the in-memory work queue. It exists only in memory: after a crash the
// reconciler derives the work again. A session is in it at most once, a worker holds it
// exclusively, and a session pushed while a worker holds it is built again afterwards.
type queue struct {
	mu      sync.Mutex
	cond    *sync.Cond
	items   map[string]*item
	prio    []string // keys, live lane, served first
	norm    []string
	pending int // items queued or running
	closed  bool
}

func newQueue() *queue {
	q := &queue{items: map[string]*item{}}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// push adds a session, or refreshes the one already there. live puts it in the priority
// lane (and keeps it there).
func (q *queue) push(j job, live bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	k := j.key()
	it := q.items[k]
	switch {
	case it == nil:
		q.items[k] = &item{job: j, live: live, queued: true}
		q.pending++
		q.lane(k, live)
		q.cond.Broadcast()
	case it.running:
		// The running build started from the same files: it will write what the new
		// request would have written.
		if !live && slices.Equal(it.job.s.Fingerprint, j.s.Fingerprint) {
			return
		}
		it.job, it.rerun, it.live = j, true, it.live || live
	default: // queued: keep the newest description
		it.job = j
		if live && !it.live {
			it.live = true
			q.lane(k, true)
		}
	}
}

func (q *queue) lane(k string, live bool) {
	if live {
		q.prio = append(q.prio, k)
	} else {
		q.norm = append(q.norm, k)
	}
}

// pop blocks for the next job, live lane first. It returns false once the queue is
// closed.
func (q *queue) pop() (job, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for {
		if q.closed {
			return job{}, false
		}
		for _, lane := range []*[]string{&q.prio, &q.norm} {
			for len(*lane) > 0 {
				k := (*lane)[0]
				*lane = (*lane)[1:]
				// An entry whose item was already served through its other lane is stale.
				if it := q.items[k]; it != nil && it.queued {
					it.queued, it.running = false, true
					return it.job, true
				}
			}
		}
		q.cond.Wait()
	}
}

// done releases a job returned by pop.
func (q *queue) done(j job) {
	q.mu.Lock()
	defer q.mu.Unlock()
	k := j.key()
	it := q.items[k]
	if it == nil {
		return
	}
	it.running = false
	if it.rerun {
		it.rerun, it.queued = false, true
		q.lane(k, it.live)
		q.cond.Broadcast()
		return
	}
	delete(q.items, k)
	q.pending--
	q.cond.Broadcast()
}

// open makes a closed queue usable again.
func (q *queue) open() {
	q.mu.Lock()
	q.closed = false
	q.mu.Unlock()
}

// close wakes every blocked pop with false.
func (q *queue) close() {
	q.mu.Lock()
	q.closed = true
	q.cond.Broadcast()
	q.mu.Unlock()
}

// waitIdle blocks until nothing is queued or running, or ctx is done.
func (q *queue) waitIdle(ctx context.Context) error {
	stop := context.AfterFunc(ctx, func() {
		q.mu.Lock()
		q.cond.Broadcast()
		q.mu.Unlock()
	})
	defer stop()
	q.mu.Lock()
	defer q.mu.Unlock()
	for q.pending > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		q.cond.Wait()
	}
	return nil
}

// depth returns the number of sessions queued or running.
func (q *queue) depth() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.pending
}
