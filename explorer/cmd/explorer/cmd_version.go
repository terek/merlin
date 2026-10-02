package main

import "fmt"

// version is overridden at build time with -ldflags "-X main.version=...".
var version = "0.1.0-dev"

func init() {
	register("version", command{
		usage:   "version",
		summary: "print the version",
		run: func([]string) int {
			fmt.Println("explorer", version)
			return 0
		},
	})
}
