//go:build darwin || linux

package term

import (
	"os"
	"syscall"
	"unsafe"
)

// ttyWidth reports the width of the terminal f is attached to; ok is false when f is not one.
func ttyWidth(f *os.File) (width int, ok bool) {
	if f == nil {
		return 0, false
	}
	var ws struct{ Row, Col, X, Y uint16 }
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), uintptr(syscall.TIOCGWINSZ), uintptr(unsafe.Pointer(&ws)))
	if errno != 0 {
		return 0, false
	}
	return int(ws.Col), true
}
