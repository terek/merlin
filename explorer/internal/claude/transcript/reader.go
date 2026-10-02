package transcript

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
)

// GuardSize is the number of bytes before a resume offset that the guard covers.
const GuardSize = 256

// Reader streams the records of one transcript file. Only lines terminated by '\n' are
// consumed: a trailing partial line is left unread and Offset stops before it, so a later
// OpenAt picks it up once it is complete. Memory use is bounded by the longest line.
type Reader struct {
	f      *os.File
	br     *bufio.Reader
	offset int64
	tail   []byte // last (up to GuardSize) consumed bytes, for the guard

	bad     int
	unknown int
	lines   int
}

// Open opens a transcript file for reading from the start.
func Open(path string) (*Reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return newReader(f, 0, nil), nil
}

// OpenAt resumes reading at offset, which must come from a previous Reader.Offset, with
// the guard reported by Reader.Guard at that offset. It resumes only if the GuardSize
// bytes before offset still hash to guard. When the file is shorter than offset or the
// guard no longer matches (the file was rewritten), it returns (nil, false, nil): the
// caller must do a full re-read with Open. A non-nil error is an I/O failure, including a
// missing file. An offset of 0 always resumes (it is a full read).
func OpenAt(path string, offset int64, guard string) (*Reader, bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	if offset <= 0 {
		return newReader(f, 0, nil), true, nil
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, false, err
	}
	if st.Size() < offset {
		f.Close()
		return nil, false, nil
	}
	start := max(offset-GuardSize, 0)
	tail := make([]byte, offset-start)
	if _, err := f.ReadAt(tail, start); err != nil {
		f.Close()
		if errors.Is(err, io.EOF) { // shrank between Stat and ReadAt
			return nil, false, nil
		}
		return nil, false, err
	}
	if guardOf(tail) != guard {
		f.Close()
		return nil, false, nil
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		f.Close()
		return nil, false, err
	}
	return newReader(f, offset, tail), true, nil
}

func newReader(f *os.File, offset int64, tail []byte) *Reader {
	return &Reader{f: f, br: bufio.NewReaderSize(f, 64<<10), offset: offset, tail: tail}
}

// guardOf hashes guard bytes; no bytes (offset 0) gives the empty guard.
func guardOf(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// Next returns the next record. Blank lines are skipped silently; a line that is not a
// JSON object is counted in BadLines and skipped. It returns io.EOF when no further
// complete line is available; a partial last line is not consumed, so calling Next again
// after the file has grown continues from there.
func (r *Reader) Next() (*Record, error) {
	for {
		line, err := r.br.ReadBytes('\n')
		if err != nil {
			if errors.Is(err, io.EOF) {
				// Partial line (or nothing): hand the bytes back by seeking to the
				// consumed offset so a later call re-reads them once complete.
				if len(line) > 0 {
					if serr := r.rewind(); serr != nil {
						return nil, serr
					}
				}
				return nil, io.EOF
			}
			return nil, err
		}
		r.consume(line)
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		rec, derr := Decode(line)
		if derr != nil {
			r.bad++
			continue
		}
		r.lines++
		if !rec.Known() {
			r.unknown++
		}
		return rec, nil
	}
}

// rewind repositions the underlying file at Offset and drops buffered data.
func (r *Reader) rewind() error {
	if _, err := r.f.Seek(r.offset, io.SeekStart); err != nil {
		return err
	}
	r.br.Reset(r.f)
	return nil
}

func (r *Reader) consume(line []byte) {
	r.offset += int64(len(line))
	if len(line) >= GuardSize {
		r.tail = append(r.tail[:0], line[len(line)-GuardSize:]...)
		return
	}
	r.tail = append(r.tail, line...)
	if over := len(r.tail) - GuardSize; over > 0 {
		r.tail = append(r.tail[:0], r.tail[over:]...)
	}
}

// Offset is the byte offset just after the last consumed line (including skipped bad and
// blank lines). It never points into a partial line.
func (r *Reader) Offset() int64 { return r.offset }

// Guard is the hash of up to GuardSize bytes before Offset. Store it with the offset and
// pass both to OpenAt.
func (r *Reader) Guard() string { return guardOf(r.tail) }

// BadLines counts complete lines that were not JSON objects and were skipped.
func (r *Reader) BadLines() int { return r.bad }

// UnknownRecords counts delivered records whose type this package does not know.
func (r *Reader) UnknownRecords() int { return r.unknown }

// Records counts delivered records.
func (r *Reader) Records() int { return r.lines }

// Close releases the file.
func (r *Reader) Close() error { return r.f.Close() }

// ReadAgentMeta reads an agent-<id>.meta.json file. A missing file is not an error: it
// returns the zero AgentMeta and found=false.
func ReadAgentMeta(path string) (meta AgentMeta, found bool, err error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return AgentMeta{}, false, nil
	}
	if err != nil {
		return AgentMeta{}, false, err
	}
	m, err := ParseAgentMeta(data)
	if err != nil {
		return AgentMeta{}, true, err
	}
	return m, true, nil
}
