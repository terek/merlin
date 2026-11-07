package main

import (
	"strings"
	"testing"
)

func TestUnknownCostLineGrammar(t *testing.T) {
	if got := unknownCostLine(1); !strings.Contains(got, "1 session shows work") {
		t.Errorf("singular: %q", got)
	}
	if got := unknownCostLine(3); !strings.Contains(got, "3 sessions show work") {
		t.Errorf("plural: %q", got)
	}
}
