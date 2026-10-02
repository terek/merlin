package daemon

import (
	"sync"

	"github.com/terek/merlin/explorer/internal/engine"
)

// Bus fans engine write events out to in-process subscribers (the API exposes it as SSE).
// Publishing never blocks: a subscriber whose buffer is full misses the event, and must
// re-read the catalog if it needs to be sure.
type Bus struct {
	mu   sync.Mutex
	next int
	subs map[int]chan engine.Event
}

// Subscribe returns a channel of events and a function that unsubscribes and closes the
// channel. The unsubscribe function may be called more than once.
func (b *Bus) Subscribe(buffer int) (<-chan engine.Event, func()) {
	if buffer < 1 {
		buffer = 1
	}
	ch := make(chan engine.Event, buffer)
	b.mu.Lock()
	if b.subs == nil {
		b.subs = map[int]chan engine.Event{}
	}
	id := b.next
	b.next++
	b.subs[id] = ch
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if c, ok := b.subs[id]; ok {
			delete(b.subs, id)
			close(c)
		}
	}
}

// Publish delivers ev to every subscriber that has room for it.
func (b *Bus) Publish(ev engine.Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, ch := range b.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// Subscribers returns the number of subscribers.
func (b *Bus) Subscribers() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}
