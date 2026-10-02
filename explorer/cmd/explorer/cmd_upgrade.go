package main

import (
	"fmt"
	"io"
	"os"
)

// installCommand is how merlin is installed, and so how it is upgraded.
const installCommand = "curl -fsSL https://merlin.dev/install.sh | bash"

func init() {
	register("upgrade", command{
		usage:   "upgrade",
		summary: "how to upgrade (prints the installer command)",
		run: func([]string) int {
			printUpgradeNotice(os.Stdout)
			return 0
		},
	})
}

// printUpgradeNotice says how to upgrade; merlin does not update itself. Arguments
// of the old program's upgrade (--check) are accepted and ignored.
func printUpgradeNotice(w io.Writer) {
	fmt.Fprintf(w, "merlin %s does not update itself. To upgrade, run the installer again:\n\n  %s\n", version, installCommand)
}
