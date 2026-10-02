package claude

import (
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/terek/merlin/explorer/internal/claude/digest"
	"github.com/terek/merlin/explorer/internal/claude/discover"
	"github.com/terek/merlin/explorer/internal/claude/transcript"
	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/model"
)

// Incremental reads for followed (live) sessions.
//
// A session the daemon follows keeps, per transcript file, the digest.Builder, the reader
// offset and guard, and the size and mtime the file had when it was last read. Build then
// reads only the bytes appended since, and feeds them to the kept Builder; Builder.Result
// finalises a copy, so the digest is the same as BuildSession's, byte for byte.
//
// Per file, Build falls back to a full re-read (new Builder, from byte 0) when:
//   - the file is new to the cache, or the state was made by another parser version;
//   - it shrank, or changed without growing (a same-size rewrite: the guard only hashes
//     the 256 bytes before the offset, so it cannot see edits further back);
//   - the guard does not match (OpenAt says no).
//
// A file whose size and mtime are as they were is not read at all. An unterminated last
// line is never consumed (transcript.Reader), so the offset stays before it until its
// newline arrives.
//
// What the guard cannot catch while a file keeps growing is an edit of earlier bytes that
// keeps the length. So a session that leaves the live set gets one full rebuild from
// scratch (Release tells the daemon when that is needed); every digest therefore ends up
// equal to a full read.
//
// Sessions nobody follows (merlin scan, the first scan, the rescan of idle sessions) never
// touch the cache.

// DefaultMaxHeldBytes caps the transcript bytes whose Builders are kept. Builders hold
// prompts, final texts and per-message records whole, so their size follows the source
// size (measured by BenchmarkLiveUpdate at roughly the source size or less). 256 MiB holds
// a handful of the largest sessions seen (52 MB) and is small next to the machine; going
// over it evicts the least recently built sessions, whose next build is simply a full one.
// Source bytes are used instead of a count because one session ranges from KBs to 50 MB.
const DefaultMaxHeldBytes = 256 << 20

// IncrementalStats counts how Build read the files of followed sessions, since the
// harness was created. It is also the test hook for "a full re-read happened".
type IncrementalStats struct {
	FullFiles   int64 // files read from byte 0 by a followed build
	AppendFiles int64 // files of which only the appended bytes were read
	ReusedFiles int64 // files not read at all (unchanged)
	BytesRead   int64 // transcript bytes read by followed builds
}

type incremental struct {
	mu       sync.Mutex
	followed map[string]bool          // session ids the daemon follows
	states   map[string]*sessionState // kept state, a subset of followed (plus busy leftovers)
	tainted  map[string]bool          // digest was built from appended reads since the last full build
	held     int64                    // sum of states' bytes
	clock    uint64
	maxHeld  int64

	full, appended, reused, bytesRead atomic.Int64
}

type sessionState struct {
	files    map[string]*fileState
	bytes    int64 // transcript bytes behind the Builders
	busy     bool  // a Build holds it
	released bool  // evicted while busy: the Build drops its result
	used     uint64
}

type fileState struct {
	b      *digest.Builder
	parser int
	offset int64
	guard  string
	size   int64 // size and mtime when the read began
	mtime  int64
}

func newIncremental() *incremental {
	return &incremental{
		followed: map[string]bool{},
		states:   map[string]*sessionState{},
		tainted:  map[string]bool{},
		maxHeld:  DefaultMaxHeldBytes,
	}
}

// Follow implements harness.Follower.
func (h *Harness) Follow(ref harness.SessionRef) {
	h.inc.mu.Lock()
	h.inc.followed[ref.ID] = true
	h.inc.mu.Unlock()
}

// Release implements harness.Follower: the kept state of the session is dropped. It
// reports true when the stored digest may have been built from appended reads (or a build
// is running that may do so), in which case the caller must have the session rebuilt from
// scratch; that build, as the session is no longer followed, reads every file whole.
func (h *Harness) Release(ref harness.SessionRef) (rebuild bool) {
	in := h.inc
	in.mu.Lock()
	defer in.mu.Unlock()
	delete(in.followed, ref.ID)
	rebuild = in.tainted[ref.ID]
	if st := in.states[ref.ID]; st != nil {
		in.drop(ref.ID, st)
		rebuild = rebuild || st.busy
	}
	return rebuild
}

// SetLogf implements harness.Follower.
func (h *Harness) SetLogf(logf func(format string, args ...any)) { h.logf = logf }

// IncrementalStats returns the counters of followed builds.
func (h *Harness) IncrementalStats() IncrementalStats {
	in := h.inc
	return IncrementalStats{in.full.Load(), in.appended.Load(), in.reused.Load(), in.bytesRead.Load()}
}

// drop removes a state from the cache; the caller holds mu.
func (in *incremental) drop(id string, st *sessionState) {
	delete(in.states, id)
	in.held -= st.bytes
	st.bytes = 0
	st.released = true
}

// begin returns the state a Build of a followed session works on, or nil when the session
// is not followed (it then gets a plain full build and leaves no state) or a build of it is
// already running (the engine does not do that; a plain build is the safe answer).
func (in *incremental) begin(id string) *sessionState {
	in.mu.Lock()
	defer in.mu.Unlock()
	if !in.followed[id] {
		delete(in.tainted, id) // this build reads everything whole
		return nil
	}
	st := in.states[id]
	if st == nil {
		st = &sessionState{files: map[string]*fileState{}}
		in.states[id] = st
	}
	if st.busy {
		return nil
	}
	st.busy = true
	in.clock++
	st.used = in.clock
	return st
}

// end gives the state back. keep is the set of files the build used (the others are
// forgotten), appended says whether any file was extended. After a failed build the state
// is dropped: it may be half-fed.
func (in *incremental) end(id string, st *sessionState, keep map[string]bool, appended bool, failed bool) {
	in.mu.Lock()
	defer in.mu.Unlock()
	st.busy = false
	if st.released {
		return
	}
	if failed {
		in.drop(id, st)
		return
	}
	var total int64
	for p, f := range st.files {
		if !keep[p] {
			delete(st.files, p)
			continue
		}
		total += f.offset
	}
	in.held += total - st.bytes
	st.bytes = total
	if appended {
		in.tainted[id] = true
	}
	// Evict least recently built sessions until under the cap; this one may go too.
	for in.held > in.maxHeld {
		var victimID string
		var victim *sessionState
		for vid, v := range in.states {
			if !v.busy && (victim == nil || v.used < victim.used) {
				victimID, victim = vid, v
			}
		}
		if victim == nil {
			break
		}
		in.drop(victimID, victim)
	}
}

// buildFollowed is Build for a followed session.
func (h *Harness) buildFollowed(src discover.Source, st *sessionState) (*model.SessionDigest, error) {
	start := time.Now()
	var c struct{ full, appended, reused, bytes int64 }
	keep := map[string]bool{}
	reduce := func(path string) (*digest.FileResult, error) {
		keep[path] = true
		return h.reduceFollowed(st, path, &c)
	}
	d, err := digest.BuildSessionFrom(src, reduce)
	h.inc.end(src.ID, st, keep, c.appended > 0, err != nil)
	h.inc.full.Add(c.full)
	h.inc.appended.Add(c.appended)
	h.inc.reused.Add(c.reused)
	h.inc.bytesRead.Add(c.bytes)
	if h.logf != nil {
		h.logf("claude: live build %s: %d files read whole, %d appended, %d unchanged, %d KB read, %d ms",
			shortID(src.ID), c.full, c.appended, c.reused, c.bytes>>10, time.Since(start).Milliseconds())
	}
	return d, err
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// reduceFollowed returns the FileResult of one file, reading as little as is safe.
func (h *Harness) reduceFollowed(st *sessionState, path string, c *struct{ full, appended, reused, bytes int64 }) (*digest.FileResult, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("digest: %w", err)
	}
	size, mtime := fi.Size(), fi.ModTime().UnixNano()
	fs := st.files[path]
	if fs != nil && fs.parser == h.parser() {
		switch {
		case size == fs.size && mtime == fs.mtime:
			c.reused++
			return fs.b.Result(), nil
		case size > fs.size:
			r, ok, err := transcript.OpenAt(path, fs.offset, fs.guard)
			if err != nil {
				delete(st.files, path)
				return nil, fmt.Errorf("digest: %w", err)
			}
			if ok {
				ferr := fs.b.Feed(r)
				read := r.Offset() - fs.offset
				fs.offset, fs.guard, fs.size, fs.mtime = r.Offset(), r.Guard(), size, mtime
				r.Close()
				if ferr != nil {
					delete(st.files, path)
					return nil, fmt.Errorf("digest: reading %s: %w", path, ferr)
				}
				c.appended++
				c.bytes += read
				return fs.b.Result(), nil
			}
		}
	}
	// New file, other parser version, shrunk, rewritten, or the guard failed.
	delete(st.files, path)
	r, err := transcript.Open(path)
	if err != nil {
		return nil, fmt.Errorf("digest: %w", err)
	}
	defer r.Close()
	b := digest.NewBuilder(h.pricer)
	if err := b.Feed(r); err != nil {
		return nil, fmt.Errorf("digest: reading %s: %w", path, err)
	}
	st.files[path] = &fileState{b: b, parser: h.parser(), offset: r.Offset(), guard: r.Guard(), size: size, mtime: mtime}
	c.full++
	c.bytes += r.Offset()
	return b.Result(), nil
}

func (h *Harness) parser() int {
	if h.parserVersion != 0 {
		return h.parserVersion
	}
	return digest.ParserVersion
}
