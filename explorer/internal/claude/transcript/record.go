package transcript

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Record types. Metadata types have no uuid and no envelope (format notes §7).
const (
	TypeUser           = "user"
	TypeAssistant      = "assistant"
	TypeSystem         = "system"
	TypeAttachment     = "attachment"
	TypeProgress       = "progress"
	TypeAITitle        = "ai-title"
	TypeCustomTitle    = "custom-title"
	TypeAgentName      = "agent-name"
	TypeLastPrompt     = "last-prompt"
	TypeCostState      = "cost-state"
	TypeRelocated      = "relocated"
	TypeForkContextRef = "fork-context-ref"
)

// System record subtypes.
const (
	SubtypeCompactBoundary = "compact_boundary"
	SubtypeAwaySummary     = "away_summary"
	SubtypeTurnDuration    = "turn_duration"
	SubtypeAgentsKilled    = "agents_killed"
)

// knownIgnored are record types we recognise and deliberately skip; they must not be
// counted as unknown in diagnostics.
var knownIgnored = map[string]bool{
	"worktree-state": true, "queue-operation": true, "mode": true, "permission-mode": true,
	"atis-latch": true, "bridge-session": true, "frame-link": true, "agent-setting": true,
	"agent-color": true,
}

// IsKnownType reports whether t is a record type this package knows about, including
// types that are recognised only to be ignored (file-history-*, artifact-*, ...).
func IsKnownType(t string) bool {
	switch t {
	case TypeUser, TypeAssistant, TypeSystem, TypeAttachment, TypeProgress, TypeAITitle,
		TypeCustomTitle, TypeAgentName, TypeLastPrompt, TypeCostState, TypeRelocated,
		TypeForkContextRef:
		return true
	}
	return knownIgnored[t] || strings.HasPrefix(t, "file-history-") || strings.HasPrefix(t, "artifact-")
}

// ForkedFrom is the envelope marker on records copied in by an explicit fork.
type ForkedFrom struct {
	SessionID   string `json:"sessionId"`
	MessageUUID string `json:"messageUuid"`
}

// Origin is the envelope's origin object. Older versions omit it; some versions may write
// a bare string, which is taken as the Kind.
type Origin struct {
	Kind string `json:"kind"`
}

// UnmarshalJSON accepts an object or a string.
func (o *Origin) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		o.Kind = s
		return nil
	}
	var v struct {
		Kind string `json:"kind"`
	}
	_ = json.Unmarshal(b, &v) // wrong shapes leave Kind empty
	o.Kind = v.Kind
	return nil
}

// Envelope is the part of a record common to conversation records (format notes §2).
// Metadata records leave most of it empty.
type Envelope struct {
	Type              string `json:"type"`
	Subtype           string `json:"subtype,omitempty"`
	UUID              string `json:"uuid,omitempty"`
	ParentUUID        string `json:"parentUuid,omitempty"`
	LogicalParentUUID string `json:"logicalParentUuid,omitempty"` // compact boundaries only
	Timestamp         string `json:"timestamp,omitempty"`         // RFC 3339; see Record.Time
	SessionID         string `json:"sessionId,omitempty"`
	// OtherSessionID is the envelope's snake_case session_id. When it differs from
	// SessionID the record was inherited from that session.
	OtherSessionID string `json:"session_id,omitempty"`
	IsSidechain    bool   `json:"isSidechain,omitempty"`
	AgentID        string `json:"agentId,omitempty"`
	RequestID      string `json:"requestId,omitempty"`

	Cwd         string `json:"cwd,omitempty"`
	GitBranch   string `json:"gitBranch,omitempty"`
	Version     string `json:"version,omitempty"`
	Entrypoint  string `json:"entrypoint,omitempty"` // "cli", "sdk-cli", ...
	Slug        string `json:"slug,omitempty"`
	SessionKind string `json:"sessionKind,omitempty"` // "bg" for background sessions

	ForkedFrom *ForkedFrom `json:"forkedFrom,omitempty"`

	IsMeta            bool `json:"isMeta,omitempty"`
	IsCompactSummary  bool `json:"isCompactSummary,omitempty"`
	IsAPIErrorMessage bool `json:"isApiErrorMessage,omitempty"`

	Origin       *Origin `json:"origin,omitempty"`
	PromptSource string  `json:"promptSource,omitempty"`
	TurnOrigin   string  `json:"turnOrigin,omitempty"`

	// Message is the API message (assistant) or user message; decode with the accessors.
	Message json.RawMessage `json:"message,omitempty"`
	// RawToolUseResult is the envelope's toolUseResult: an object, a string or absent.
	RawToolUseResult json.RawMessage `json:"toolUseResult,omitempty"`
}

// Record is one decoded transcript line.
type Record struct {
	Envelope
	// Raw is a private copy of the complete line, used by the lazy accessors.
	Raw json.RawMessage `json:"-"`
}

// ErrNotObject is returned by Decode for a line that is not a JSON object.
var ErrNotObject = errors.New("transcript: line is not a JSON object")

// Decode decodes one transcript line. It returns an error only for lines that are not a
// JSON object (including invalid JSON); callers count those as bad lines. The line is
// copied, so the caller may reuse its buffer. A record of an unknown type has only Type
// and Raw set.
func Decode(line []byte) (*Record, error) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || line[0] != '{' {
		return nil, ErrNotObject
	}
	raw := make([]byte, len(line))
	copy(raw, line)
	var head struct {
		Type string `json:"type"`
	}
	if err := unmarshalTolerant(raw, &head); err != nil {
		return nil, err
	}
	r := &Record{Raw: raw}
	if !IsKnownType(head.Type) {
		r.Type = head.Type
		return r, nil
	}
	if err := unmarshalTolerant(raw, &r.Envelope); err != nil {
		return nil, err
	}
	if f := r.ForkedFrom; f != nil && *f == (ForkedFrom{}) {
		r.ForkedFrom = nil // a mistyped forkedFrom leaves an allocated empty struct
	}
	return r, nil
}

// unmarshalTolerant is json.Unmarshal that treats a field of the wrong JSON type as
// absent instead of failing: encoding/json keeps decoding the remaining fields after a
// type error, so only syntax errors are surfaced.
func unmarshalTolerant(data []byte, v any) error {
	err := json.Unmarshal(data, v)
	var te *json.UnmarshalTypeError
	if errors.As(err, &te) {
		return nil
	}
	return err
}

// Known reports whether the record's type is one this package knows about.
func (r *Record) Known() bool { return IsKnownType(r.Type) }

// Time parses the envelope timestamp as UTC. ok is false when it is absent or malformed.
func (r *Record) Time() (t time.Time, ok bool) {
	if r.Timestamp == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, r.Timestamp)
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}

// IsCompactBoundary reports whether the record is a system/compact_boundary.
func (r *Record) IsCompactBoundary() bool {
	return r.Type == TypeSystem && r.Subtype == SubtypeCompactBoundary
}

// decode decodes the whole line into v, tolerantly.
func (r *Record) decode(v any) bool {
	return len(r.Raw) > 0 && unmarshalTolerant(r.Raw, v) == nil
}
