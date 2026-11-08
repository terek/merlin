package pricing

import (
	"os"
	"path/filepath"
	"testing"
)

func loadWith(t *testing.T, cfg string) *Table {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(p, []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	tb, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	return tb
}

func TestVersionStable(t *testing.T) {
	a, b := Default().Version(), Default().Version()
	if a != b || len(a) != 16 {
		t.Fatalf("Version %q vs %q", a, b)
	}
	if Default().Version() != loadWith(t, `{}`).Version() {
		t.Error("an empty config changed the version")
	}
}

func TestVersionChangesWithOverrides(t *testing.T) {
	base := Default().Version()
	one := loadWith(t, `{"prices":{"zz-new":{"input":1,"output":2,"cacheRead":0.1}}}`)
	two := loadWith(t, `{"prices":{"zz-new":{"input":1,"output":3,"cacheRead":0.1}}}`)
	if one.Version() == base || two.Version() == one.Version() {
		t.Errorf("versions: base %s, added %s, changed %s", base, one.Version(), two.Version())
	}
	fast := loadWith(t, `{"prices":{"zz-new":{"input":1,"output":2,"cacheRead":0.1,"fast":true}}}`)
	if fast.Version() == one.Version() {
		t.Error("fast flag did not change the version")
	}
	// informational fields do not decide a price
	note := loadWith(t, `{"prices":{"zz-new":{"input":1,"output":2,"cacheRead":0.1,"note":"x","status":"assumed"}}}`)
	if note.Version() != one.Version() {
		t.Error("a note changed the version")
	}
}

func TestVersionIgnoresOrdering(t *testing.T) {
	a := loadWith(t, `{"prices":{"zz-a":{"input":1,"output":2,"cacheRead":0.1,"aliases":["zz-x","zz-y"]},"zz-b":{"input":3,"output":4,"cacheRead":0.1}}}`)
	b := loadWith(t, `{"prices":{"zz-b":{"input":3,"output":4,"cacheRead":0.1},"zz-a":{"aliases":["zz-y","zz-x"],"input":1,"output":2,"cacheRead":0.1}}}`)
	if a.Version() != b.Version() {
		t.Errorf("%s != %s", a.Version(), b.Version())
	}
}
