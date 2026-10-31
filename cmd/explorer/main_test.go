package main

import "testing"

func TestDispatch(t *testing.T) {
	cases := []struct {
		args []string
		want int
	}{
		{nil, 2},
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

func TestPlannedCommandsRegistered(t *testing.T) {
	for _, n := range []string{"serve", "scan", "sessions", "show", "search", "cost", "hooks", "hook", "doctor", "version", "help"} {
		if _, ok := commands[n]; !ok {
			t.Errorf("command %q not registered", n)
		}
	}
}
