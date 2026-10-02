package digest

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

// Some prompts are not typed by anyone: Claude Code delivers them and wraps them in markup
// of its own (format notes §4a).
//
//   - A message from another agent of the session: an intro line, one or more
//     <teammate-message> elements, and a fixed paragraph telling the model how to treat peer
//     messages. The body of an element is text, or a JSON object when the harness itself
//     speaks (a teammate went idle, a task was assigned).
//   - A background task reporting: one <task-notification> element with child elements.
//
// delivered takes such a prompt apart so that nothing downstream has to know the markup.
const (
	peerIntro = "Another Claude session sent a message:"
	// peerTrailer is the stable beginning of the paragraph that closes every peer prompt;
	// the wording after it is not relied on.
	peerTrailer = "This came from another Claude session"
)

var (
	// A message element starts and ends on a line of its own, so a body that quotes the
	// markup in running text does not end the element early.
	reTeammateMsg     = regexp.MustCompile(`(?ms)^<teammate-message\b([^>]*)>$(.*?)^</teammate-message>$`)
	reCrossSessionMsg = regexp.MustCompile(`(?ms)^<cross-session-message\b([^>]*)>$(.*?)^</cross-session-message>$`)
	reTaskNote        = regexp.MustCompile(`(?s)^\s*<task-notification>(.*)</task-notification>\s*$`)
	reAttr            = regexp.MustCompile(`([a-z_]+)="([^"]*)"`)
	entities          = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&quot;", `"`, "&apos;", "'", "&amp;", "&")
)

// delivered parses a prompt a machine delivered. It returns the messages and what is left
// of the text once the messages and the harness's own framing are taken out (normally
// nothing). ok is false when the text has none of the known shapes; the text then stays as
// it is.
func delivered(text string, at time.Time) (msgs []model.InboxMessage, rest string, ok bool) {
	if m := reTaskNote.FindStringSubmatch(text); m != nil {
		if msg, ok := taskMessage(m[1], at); ok {
			return []model.InboxMessage{msg}, "", true
		}
		return nil, text, false
	}

	t := strings.TrimLeft(text, " \t\r\n")
	t = strings.TrimPrefix(t, peerIntro)
	for _, shape := range []struct {
		re   *regexp.Regexp
		from string // the attribute naming the sender
	}{{reTeammateMsg, "teammate_id"}, {reCrossSessionMsg, "from"}} {
		found := shape.re.FindAllStringSubmatchIndex(t, -1)
		if len(found) == 0 {
			continue
		}
		var left strings.Builder
		last := 0
		for _, f := range found {
			left.WriteString(t[last:f[0]])
			last = f[1]
			attrs := attributes(t[f[2]:f[3]])
			msgs = append(msgs, peerMessage(attrs[shape.from], attrs["summary"], strings.TrimSpace(t[f[4]:f[5]]), at))
		}
		left.WriteString(t[last:])
		return msgs, withoutTrailer(left.String()), true
	}
	return nil, text, false
}

// withoutTrailer drops the harness's closing paragraph from what is left of a peer prompt.
func withoutTrailer(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, peerTrailer) {
		return s
	}
	if i := strings.Index(s, "\n\n"); i >= 0 {
		return strings.TrimSpace(s[i:])
	}
	return ""
}

// attributes reads the attributes of an opening tag. Values are entity-escaped there.
func attributes(s string) map[string]string {
	out := map[string]string{}
	for _, m := range reAttr.FindAllStringSubmatch(s, -1) {
		out[m[1]] = strings.TrimSpace(entities.Replace(m[2]))
	}
	return out
}

// peerMessage builds the message of one element. A body that is a JSON object of a known
// type is the harness speaking for the sender; any other body is the sender's text, whole.
func peerMessage(from, summary, body string, at time.Time) model.InboxMessage {
	msg := model.InboxMessage{At: at, Kind: model.InboxMessageKind, From: from, Summary: summary, Text: body}
	if !strings.HasPrefix(body, "{") || !strings.HasSuffix(body, "}") {
		return msg
	}
	var v struct {
		Type          string `json:"type"`
		From          string `json:"from"`
		IdleReason    string `json:"idleReason"`
		Result        string `json:"result"`
		Summary       string `json:"summary"`
		FailureReason string `json:"failureReason"`
		TaskID        string `json:"taskId"`
		Subject       string `json:"subject"`
		Description   string `json:"description"`
		AssignedBy    string `json:"assignedBy"`
	}
	if json.Unmarshal([]byte(body), &v) != nil {
		return msg
	}
	switch v.Type {
	case "idle_notification":
		return model.InboxMessage{
			At: at, Kind: model.InboxIdle, From: firstNonEmpty(v.From, from), Status: v.IdleReason,
			Summary: firstNonEmpty(v.Summary, summary), Text: strings.TrimSpace(v.Result),
			Error: v.FailureReason,
		}
	case "task_assignment":
		return model.InboxMessage{
			At: at, Kind: model.InboxAssignment, From: firstNonEmpty(v.AssignedBy, from), TaskID: v.TaskID,
			Summary: firstNonEmpty(v.Subject, summary), Text: strings.TrimSpace(v.Description),
		}
	}
	return msg
}

var (
	reTaskResult = regexp.MustCompile(`(?s)<result>(.*)</result>`)
	reTaskEvent  = regexp.MustCompile(`(?s)<event>(.*)</event>`)
)

// taskMessage builds the message of a <task-notification>. "<", ">" and "&" are
// entity-escaped in its children. Text is the task's result, or the event a monitor saw.
func taskMessage(inner string, at time.Time) (model.InboxMessage, bool) {
	get := func(re *regexp.Regexp) string {
		if m := re.FindStringSubmatch(inner); m != nil {
			return strings.TrimSpace(entities.Replace(m[1]))
		}
		return ""
	}
	msg := model.InboxMessage{
		At: at, Kind: model.InboxTask, TaskID: get(reTaskID), Status: get(reStatus),
		Summary: get(reSummary), Text: firstNonEmpty(get(reTaskResult), get(reTaskEvent)),
	}
	if msg.TaskID == "" && msg.Status == "" && msg.Summary == "" && msg.Text == "" {
		return msg, false
	}
	return msg, true
}

// promptText is the text a turn was started with: what was typed, or the text of the
// message when the prompt was a single delivered message.
func promptText(t *model.Turn) string {
	if t.UserText == "" && len(t.Inbox) == 1 {
		return t.Inbox[0].Text
	}
	return t.UserText
}
