package transcript

import (
	"regexp"
	"strings"

	"github.com/terek/merlin/explorer/internal/model"
)

// Interruption markers (format notes §4).
const (
	InterruptMarker        = "[Request interrupted by user]"
	InterruptMarkerForTool = "[Request interrupted by user for tool use]"
)

// IsToolResult reports whether the record is a user record carrying a tool result.
func (r *Record) IsToolResult() bool {
	if r.Type != TypeUser {
		return false
	}
	m, ok := r.UserMessage()
	return ok && m.Content.HasToolResult()
}

// IsPrompt reports whether the record is a user record that is a prompt or an injected
// message: not a tool result, not isMeta, not isCompactSummary, and not the echoed output
// of a local command (see IsLocalOutput). A bare interruption marker is still a prompt by
// this test; see SplitInterruption.
func (r *Record) IsPrompt() bool {
	if r.Type != TypeUser || r.IsMeta || r.IsCompactSummary || r.IsToolResult() {
		return false
	}
	return !IsLocalOutput(r.PromptText())
}

// IsLocalOutput reports whether text is the output of a local slash command or of a "!"
// shell command. The harness writes it as a user record, but nobody typed it and the
// model does not answer it, so it starts no turn.
func IsLocalOutput(text string) bool {
	t := strings.TrimLeft(text, " \t\r\n")
	return strings.HasPrefix(t, prefixLocalStdout) || strings.HasPrefix(t, prefixBashStdout)
}

// PromptText returns the text of a user record's content (text blocks joined by newline).
func (r *Record) PromptText() string {
	if m, ok := r.UserMessage(); ok {
		return m.Content.Text()
	}
	return ""
}

// PromptImages returns the number of image blocks in a user record.
func (r *Record) PromptImages() int {
	if m, ok := r.UserMessage(); ok {
		return m.Content.ImageCount()
	}
	return 0
}

// Text prefixes that classify a prompt when the envelope carries no origin.
const (
	prefixTaskNotification = "<task-notification>"
	prefixCommandName      = "<command-name>"
	prefixCommandMessage   = "<command-message>"
	prefixLocalStdout      = "<local-command-stdout>"
	prefixBashInput        = "<bash-input>"
	prefixBashStdout       = "<bash-stdout>"
	// Messages from other agents carry no origin marker at all in most versions; they are
	// recognisable only by how the harness wraps them (788 prompts in the surveyed corpus).
	prefixPeerIntro    = "Another Claude session sent a message:"
	prefixTeammateMsg  = "<teammate-message"
	prefixCrossSession = "<cross-session-message"
)

// PromptOrigin classifies who authored a prompt record.
//
// Order of evidence: (1) a non-human origin.kind (task-notification, peer,
// auto-continuation); (2) turnOrigin "scheduled"; (3) the text prefix, which identifies
// slash commands, "!" shell input and task notifications even when origin says "human";
// (4) promptSource: "sdk" -> sdk, "system" -> continuation (injected by the harness; in
// practice "system" always comes with origin task-notification and never reaches this
// step); (5) human. An unrecognised origin.kind falls through to the later steps. "!"
// shell input is reported as OriginCommand with no command name.
func (r *Record) PromptOrigin() model.TurnOrigin {
	kind := ""
	if r.Origin != nil {
		kind = r.Origin.Kind
	}
	switch kind {
	case "task-notification":
		return model.OriginTaskNotification
	case "peer":
		return model.OriginPeer
	case "auto-continuation":
		return model.OriginContinuation
	}
	if r.TurnOrigin == "scheduled" {
		return model.OriginScheduled
	}
	if o, ok := originFromPrefix(r.PromptText()); ok {
		return o
	}
	switch r.PromptSource {
	case "sdk":
		return model.OriginSDK
	case "system":
		return model.OriginContinuation
	}
	return model.OriginHuman
}

// originFromPrefix is the text-prefix fallback of format notes §4.
func originFromPrefix(text string) (model.TurnOrigin, bool) {
	t := strings.TrimLeft(text, " \t\r\n")
	switch {
	case strings.HasPrefix(t, prefixTaskNotification):
		return model.OriginTaskNotification, true
	case strings.HasPrefix(t, prefixPeerIntro), strings.HasPrefix(t, prefixTeammateMsg),
		strings.HasPrefix(t, prefixCrossSession):
		return model.OriginPeer, true
	case strings.HasPrefix(t, prefixCommandName), strings.HasPrefix(t, prefixCommandMessage),
		strings.HasPrefix(t, prefixLocalStdout), strings.HasPrefix(t, prefixBashInput),
		strings.HasPrefix(t, prefixBashStdout):
		return model.OriginCommand, true
	}
	return "", false
}

// PromptOriginFromText classifies by text prefix alone (no envelope): command,
// task-notification, otherwise human.
func PromptOriginFromText(text string) model.TurnOrigin {
	if o, ok := originFromPrefix(text); ok {
		return o
	}
	return model.OriginHuman
}

// SplitInterruption detects a leading interruption marker. found is true when text starts
// with one of the markers (after leading whitespace); rest is the remaining text with
// surrounding whitespace trimmed. A bare marker has rest == "".
func SplitInterruption(text string) (rest string, found bool) {
	t := strings.TrimSpace(text)
	// The longer marker is checked first: the shorter one is not a prefix of it
	// (it ends with "]"), but keep the order explicit.
	for _, m := range []string{InterruptMarkerForTool, InterruptMarker} {
		if strings.HasPrefix(t, m) {
			return strings.TrimSpace(t[len(m):]), true
		}
	}
	return text, false
}

var (
	reCommandName = regexp.MustCompile(`(?s)<command-name>(.*?)</command-name>`)
	reCommandArgs = regexp.MustCompile(`(?s)<command-args>(.*?)</command-args>`)
)

// SlashCommand extracts the command name and arguments from a slash-command prompt. The
// name is returned as written (normally with its leading slash), trimmed. ok is false
// when the text has no <command-name> element.
func SlashCommand(text string) (name, args string, ok bool) {
	m := reCommandName.FindStringSubmatch(text)
	if m == nil {
		return "", "", false
	}
	name = strings.TrimSpace(m[1])
	if a := reCommandArgs.FindStringSubmatch(text); a != nil {
		args = strings.TrimSpace(a[1])
	}
	return name, args, true
}
