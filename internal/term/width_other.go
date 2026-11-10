//go:build !(darwin || linux)

package term

import "os"

// ttyWidth reports not-a-terminal on platforms without the ioctl.
func ttyWidth(f *os.File) (int, bool) { return 0, false }
