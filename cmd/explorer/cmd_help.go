package main

import "os"

func init() {
	register("help", command{
		usage:   "help",
		summary: "show this help",
		run: func([]string) int {
			printUsage(os.Stdout)
			return 0
		},
	})
}
