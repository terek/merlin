package moments

import (
	"os"
	"strings"
	"testing"
)

// Every moment in the registry has a row in docs/moments.md.
func TestCatalogDocumented(t *testing.T) {
	b, err := os.ReadFile("../../docs/moments.md")
	if err != nil {
		t.Fatal(err)
	}
	doc := string(b)
	for _, m := range Registry() {
		if !strings.Contains(doc, "| `"+m.ID+"` | "+m.Title+" |") {
			t.Errorf("docs/moments.md has no row for %s (%s)", m.ID, m.Title)
		}
	}
}
