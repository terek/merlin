package main

import (
	"strings"
	"testing"
)

func TestDispatch(t *testing.T) {
	cases := []struct {
		args []string
		want int
	}{
		{[]string{"nosuch"}, 2},
		{[]string{"version"}, 0},
		{[]string{"--help"}, 0},
	}
	for _, c := range cases {
		if got := dispatch(c.args); got != c.want {
			t.Errorf("dispatch(%v) = %d, want %d", c.args, got, c.want)
		}
	}
}

// Bare merlin, and flags without a command, run serve with the whole argv.
func TestDispatchDefaultsToServe(t *testing.T) {
	orig := commands["serve"]
	t.Cleanup(func() { commands["serve"] = orig })
	var got []string
	called := 0
	commands["serve"] = command{run: func(args []string) int {
		called++
		got = args
		return 7
	}}
	cases := []struct {
		args    []string
		serve   bool
		want    []string
		wantRet int
	}{
		{nil, true, nil, 7},
		{[]string{}, true, nil, 7},
		{[]string{"-port", "8080"}, true, []string{"-port", "8080"}, 7},
		{[]string{"--no-hooks"}, true, []string{"--no-hooks"}, 7},
		{[]string{"serve", "--no-hooks"}, true, []string{"--no-hooks"}, 7},
		{[]string{"-h"}, false, nil, 0},
		{[]string{"--help"}, false, nil, 0},
		{[]string{"-v"}, false, nil, 0},
		{[]string{"--version"}, false, nil, 0},
		{[]string{"help"}, false, nil, 0},
		{[]string{"nosuch"}, false, nil, 2},
	}
	for _, c := range cases {
		called, got = 0, nil
		ret := dispatch(c.args)
		if (called == 1) != c.serve {
			t.Errorf("dispatch(%v): serve called %d times, want %v", c.args, called, c.serve)
			continue
		}
		if ret != c.wantRet || strings.Join(got, " ") != strings.Join(c.want, " ") {
			t.Errorf("dispatch(%v) = %d with serve args %v, want %d with %v", c.args, ret, got, c.wantRet, c.want)
		}
	}
}

func TestPlannedCommandsRegistered(t *testing.T) {
	for _, n := range []string{"serve", "scan", "sessions", "show", "search", "cost", "hooks", "hook", "doctor", "version", "help"} {
		if _, ok := commands[n]; !ok {
			t.Errorf("command %q not registered", n)
		}
	}
}
