package digest

import "testing"

func TestRecapTextDropsTheSettingsHint(t *testing.T) {
	for in, want := range map[string]string{
		"The parser is done. Next: the store. (disable recaps in /config)":   "The parser is done. Next: the store.",
		"The parser is done. Next: the store. (disable recaps in /config)\n": "The parser is done. Next: the store.",
		"The parser is done. Next: the store.":                               "The parser is done. Next: the store.",
		"Mentions (disable recaps in /config) in the middle. Then more.":     "Mentions (disable recaps in /config) in the middle. Then more.",
		"(disable recaps in /config)":                                        "",
		"":                                                                   "",
	} {
		if got := recapText(in); got != want {
			t.Errorf("recapText(%q) = %q, want %q", in, got, want)
		}
	}
}
