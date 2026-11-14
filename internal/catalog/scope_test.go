package catalog

import (
	"encoding/json"
	"os"
	"testing"
)

// TestUnderPathCases reads the table the web's underPath test reads too (testdata/place-scope.json),
// so the two cannot drift.
func TestUnderPathCases(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/place-scope.json")
	if err != nil {
		t.Fatal(err)
	}
	var tab struct {
		Cases []struct {
			By   string `json:"by"`
			Key  string `json:"key"`
			In   string `json:"in"`
			Want bool   `json:"want"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &tab); err != nil {
		t.Fatal(err)
	}
	if len(tab.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range tab.Cases {
		if got := UnderPath(c.Key, c.In, c.By); got != c.Want {
			t.Errorf("UnderPath(%q, %q, %q) = %v, want %v", c.Key, c.In, c.By, got, c.Want)
		}
	}
}
