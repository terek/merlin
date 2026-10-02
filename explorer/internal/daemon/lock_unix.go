//go:build unix

package daemon

import (
	"errors"
	"fmt"
	"os"
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
	who := "another explorer serve is already running"
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
			pid, _ := strconv.Atoi(strings.TrimSpace(string(b[:n])))
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
