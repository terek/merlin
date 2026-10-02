package digest

import (
	"strings"
	"testing"

	"github.com/terek/merlin/explorer/internal/model"
)

func TestSummaryBoilerplate(t *testing.T) {
	lead := summaryLead + " that ran out of context. The summary below covers the earlier part.\n\nSummary:\n"
	body := "1. Primary request: add a login page.\n2. Files: auth.ts."
	pointer := "If you need specific details from before compaction (like exact snippets), read the full transcript at: /x/y.jsonl\n"
	resume := "Continue the conversation from where it left off. Resume directly.\n"

	cut := func(s string, spans []model.TextSpan) string {
		var rest []string
		prev := 0
		for _, sp := range spans {
			rest = append(rest, s[prev:sp.From])
			prev = sp.To
		}
		return strings.Join(append(rest, s[prev:]), "|")
	}
	for name, tc := range map[string]struct{ in, rest string }{
		"full":         {lead + body + "\n\n" + pointer + resume, body + "\n\n|"},
		"no tail":      {lead + body, body},
		"pointer only": {lead + body + "\n\n" + pointer, body + "\n\n|"},
		"resume only":  {lead + body + "\n" + resume, body + "\n|"},
		"no label":     {summaryLead + " x.\n\n" + body + "\n" + pointer, body + "\n|"},
		"unknown":      {"A summary in another shape: " + body, "A summary in another shape: " + body},
		"lead alone":   {summaryLead + " and nothing else", summaryLead + " and nothing else"},
	} {
		got := cut(tc.in, summaryBoilerplate(tc.in))
		got = strings.TrimPrefix(got, "|")
		if got != tc.rest {
			t.Errorf("%s: kept %q, want %q", name, got, tc.rest)
		}
	}
	// a quote of the pointer in the middle of the text is not the closing part
	mid := lead + "The user quoted: \"" + summaryPointer + "\" in a sentence.\nMore text."
	for _, sp := range summaryBoilerplate(mid) {
		if sp.From > 0 {
			t.Errorf("mid-line quote treated as boilerplate: %+v", sp)
		}
	}
}
