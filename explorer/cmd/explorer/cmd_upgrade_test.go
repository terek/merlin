package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestUpgradeNotice(t *testing.T) {
	if _, ok := commands["upgrade"]; !ok {
		t.Fatal("upgrade is not registered")
	}
	var b bytes.Buffer
	printUpgradeNotice(&b)
	if !strings.Contains(b.String(), installCommand) || !strings.Contains(b.String(), version) {
		t.Errorf("notice = %q", b.String())
	}
	// The old program's `upgrade --check` must not fail either.
	if got := commands["upgrade"].run([]string{"--check"}); got != 0 {
		t.Errorf("upgrade --check exit = %d, want 0", got)
	}
}
