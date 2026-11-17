//go:build unix

package daemon

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// LockedError means another process holds the instance lock.
type LockedError struct {
	Path string
	PID  int // 0 if unknown
}

func (e *LockedError) Error() string {
	who := "another merlin serve is already running"
	if e.PID > 0 {
		who += fmt.Sprintf(" (pid %d)", e.PID)
	}
	return fmt.Sprintf("%s: lock %s is held", who, e.Path)
}

// acquireLock takes an exclusive flock on path. The OS drops it when the process dies, so
// a crashed daemon never blocks the next one. The returned file must stay open for as
// long as the lock is wanted.
func acquireLock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		defer f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			b := make([]byte, 32)
			n, _ := f.Read(b)
			first, _, _ := strings.Cut(string(b[:n]), "\n")
			pid, _ := strconv.Atoi(strings.TrimSpace(first))
			return nil, &LockedError{Path: path, PID: pid}
		}
		return nil, fmt.Errorf("lock %s: %w", path, err)
	}
	// The pid is informational only (it names the holder in the message above).
	if err := f.Truncate(0); err == nil {
		f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	}
	return f, nil
}

// writeLockPort rewrites the lock file as "<pid>\n<port>\n" once the daemon is bound.
func writeLockPort(f *os.File, port int) error {
	if err := f.Truncate(0); err != nil {
		return err
	}
	_, err := f.WriteAt([]byte(fmt.Sprintf("%d\n%d\n", os.Getpid(), port)), 0)
	return err
}

// RecordedPort is the port the daemon that last held <home>/merlin.lock was listening on
// (line 2 of the file). That daemon may have exited; then a request to the port simply
// fails, as it does when no daemon runs. It returns 0, false when the file is missing, has
// only a pid (a daemon that has locked but not yet bound) or line 2 is not a port. It never
// takes the flock: a reader's lock, however brief, could make a starting daemon fail with
// "already running".
func RecordedPort(home string) (int, bool) {
	b, err := os.ReadFile(filepath.Join(home, "merlin.lock"))
	if err != nil {
		return 0, false
	}
	lines := strings.Split(string(b), "\n")
	if len(lines) < 2 {
		return 0, false
	}
	p, err := strconv.Atoi(strings.TrimSpace(lines[1]))
	if err != nil || p < 1 || p > 65535 {
		return 0, false
	}
	return p, true
}
