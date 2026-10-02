package digest

import (
	"strings"

	"github.com/terek/merlin/explorer/internal/model"
)

// Every compaction summary Claude Code writes is wrapped in the same sentences: a lead
// paragraph (and a "Summary:" label) in front of the text, and a pointer to the full
// transcript followed by an instruction to carry on behind it. They say nothing about the
// session, but a search for "transcript" or "summary" would otherwise find every compacted
// session. The markers are the stable beginnings of those sentences; their wording after
// the marker is not relied on.
const (
	summaryLead    = "This session is being continued from a previous conversation"
	summaryLabel   = "Summary:"
	summaryPointer = "If you need specific details from before compaction"
	summaryResume  = "Continue the conversation from where it left off"
)

// summaryBoilerplate returns the spans of a compaction summary that are Claude Code's fixed
// wording, in order and non-overlapping. Anything it does not recognise is left alone: a
// summary of a shape it does not know has no spans.
func summaryBoilerplate(s string) []model.TextSpan {
	var spans []model.TextSpan
	head := 0
	if strings.HasPrefix(s, summaryLead) {
		// The lead is the first paragraph; the "Summary:" label line may follow it.
		if i := strings.Index(s, "\n\n"); i >= 0 {
			head = i + 2
			if rest := s[head:]; strings.HasPrefix(rest, summaryLabel) {
				if j := strings.IndexByte(rest, '\n'); j >= 0 {
					head += j + 1
				} else {
					head = len(s)
				}
			}
			spans = append(spans, model.TextSpan{From: 0, To: head})
		}
	}
	// The closing part starts at the last line that opens with the pointer, or when the
	// pointer is missing, with the instruction, and runs to the end of the text.
	tail := -1
	for _, marker := range []string{summaryPointer, summaryResume} {
		if i := strings.LastIndex(s, "\n"+marker); i >= 0 && i+1 >= head {
			tail = i + 1
			break
		}
	}
	if tail >= 0 {
		spans = append(spans, model.TextSpan{From: tail, To: len(s)})
	}
	return spans
}
