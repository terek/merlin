// Command merlin (Merlin Explorer) indexes Claude Code sessions.
package main

import (
	"fmt"
	"os"
	"sort"
)

// A command runs a subcommand with its arguments (without the subcommand name)
// and returns the process exit code.
type command struct {
	usage   string // synopsis, e.g. "show <session-id>"
	summary string // one line for help output
	run     func(args []string) int
}

// commands is filled by register calls in each cmd_<name>.go init function.
var commands = map[string]command{}

func register(name string, c command) {
	if _, dup := commands[name]; dup {
		panic("merlin: duplicate command " + name)
	}
	commands[name] = c
}

func main() {
	os.Exit(dispatch(os.Args[1:]))
}

func dispatch(args []string) int {
	if len(args) == 0 {
		printUsage(os.Stderr)
		return 2
	}
	name := args[0]
	switch name {
	case "-h", "--help":
		name = "help"
	case "-v", "--version":
		name = "version"
	}
	c, ok := commands[name]
	if !ok {
		fmt.Fprintf(os.Stderr, "merlin: unknown command %q\n\n", args[0])
		printUsage(os.Stderr)
		return 2
	}
	return c.run(args[1:])
}

func printUsage(w *os.File) {
	fmt.Fprintln(w, "Usage: merlin <command> [arguments]")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Commands:")
	names := make([]string, 0, len(commands))
	for n := range commands {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Fprintf(w, "  %-34s %s\n", commands[n].usage, commands[n].summary)
	}
}

// notImplemented is the run function of a stubbed subcommand. A later task
// replaces the stub by editing only its own cmd_<name>.go.
func notImplemented(name string) func([]string) int {
	return func([]string) int {
		fmt.Fprintf(os.Stderr, "merlin %s: not implemented\n", name)
		return 2
	}
}
