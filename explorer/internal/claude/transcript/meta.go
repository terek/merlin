package transcript

import "encoding/json"

// PreservedSegment points at earlier records kept across a compaction. The uuids may not
// be present in the file.
type PreservedSegment struct {
	HeadUUID   string `json:"headUuid"`
	AnchorUUID string `json:"anchorUuid"`
	TailUUID   string `json:"tailUuid"`
}

// CompactMetadata is the compactMetadata of a system/compact_boundary record. Pointer
// fields are nil when an older version did not write them.
type CompactMetadata struct {
	Trigger                 string            `json:"trigger"` // "auto" | "manual"
	PreTokens               int64             `json:"preTokens"`
	PostTokens              *int64            `json:"postTokens,omitempty"`
	DurationMs              *int64            `json:"durationMs,omitempty"`
	CumulativeDroppedTokens *int64            `json:"cumulativeDroppedTokens,omitempty"`
	PreservedSegment        *PreservedSegment `json:"preservedSegment,omitempty"`
}

// CompactMetadata decodes the metadata of a compact boundary.
func (r *Record) CompactMetadata() (*CompactMetadata, bool) {
	if !r.IsCompactBoundary() {
		return nil, false
	}
	var v struct {
		M CompactMetadata `json:"compactMetadata"`
	}
	if !r.decode(&v) {
		return nil, false
	}
	return &v.M, true
}

// ModelUsage is one entry of cost-state.modelUsage. The key may carry a "[1m]" suffix.
type ModelUsage struct {
	InputTokens              int64   `json:"inputTokens"`
	OutputTokens             int64   `json:"outputTokens"`
	ThinkingTokens           int64   `json:"thinkingTokens"`
	CacheReadInputTokens     int64   `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64   `json:"cacheCreationInputTokens"`
	WebSearchRequests        int64   `json:"webSearchRequests"`
	CostUSD                  float64 `json:"costUSD"`
}

// CostState is Claude Code's own running totals, written when the process exits.
type CostState struct {
	TotalCostUSD      float64               `json:"totalCostUSD"`
	StartTime         json.RawMessage       `json:"startTime,omitempty"` // format not pinned down
	TotalAPIDuration  float64               `json:"totalAPIDuration"`
	TotalLinesAdded   int64                 `json:"totalLinesAdded"`
	TotalLinesRemoved int64                 `json:"totalLinesRemoved"`
	ModelUsage        map[string]ModelUsage `json:"modelUsage,omitempty"`
}

// CostState decodes a cost-state record.
func (r *Record) CostState() (*CostState, bool) {
	if r.Type != TypeCostState {
		return nil, false
	}
	var c CostState
	if !r.decode(&c) {
		return nil, false
	}
	return &c, true
}

// stringField decodes a record of the given type and returns one top-level string field.
func (r *Record) stringField(typ, key string) string {
	if r.Type != typ {
		return ""
	}
	var m map[string]json.RawMessage
	if !r.decode(&m) {
		return ""
	}
	var s string
	_ = json.Unmarshal(m[key], &s)
	return s
}

// AITitle returns the title of an ai-title record, else "".
func (r *Record) AITitle() string { return r.stringField(TypeAITitle, "aiTitle") }

// CustomTitle returns the title of a custom-title record, else "".
func (r *Record) CustomTitle() string { return r.stringField(TypeCustomTitle, "customTitle") }

// AgentName returns the name of an agent-name record, else "".
func (r *Record) AgentName() string { return r.stringField(TypeAgentName, "agentName") }

// RelocatedCwd returns the new cwd of a relocated record, else "".
func (r *Record) RelocatedCwd() string { return r.stringField(TypeRelocated, "relocatedCwd") }

// LastPrompt returns the fields of a last-prompt record.
func (r *Record) LastPrompt() (prompt, leafUUID string, ok bool) {
	if r.Type != TypeLastPrompt {
		return "", "", false
	}
	var v struct {
		LastPrompt string `json:"lastPrompt"`
		LeafUUID   string `json:"leafUuid"`
	}
	if !r.decode(&v) {
		return "", "", false
	}
	return v.LastPrompt, v.LeafUUID, true
}

// AwaySummary returns the recap text of a system/away_summary record.
func (r *Record) AwaySummary() (text string, ok bool) {
	if r.Type != TypeSystem || r.Subtype != SubtypeAwaySummary {
		return "", false
	}
	var v struct {
		Content string `json:"content"`
	}
	if !r.decode(&v) {
		return "", false
	}
	return v.Content, true
}

// TurnDuration returns the fields of a system/turn_duration record.
func (r *Record) TurnDuration() (durationMs, messageCount int64, ok bool) {
	if r.Type != TypeSystem || r.Subtype != SubtypeTurnDuration {
		return 0, 0, false
	}
	var v struct {
		DurationMs   int64 `json:"durationMs"`
		MessageCount int64 `json:"messageCount"`
	}
	if !r.decode(&v) {
		return 0, 0, false
	}
	return v.DurationMs, v.MessageCount, true
}

// ForkContextRef is a fork subagent's pointer to its parent's context.
type ForkContextRef struct {
	AgentID         string `json:"agentId"`
	ParentSessionID string `json:"parentSessionId"`
	ParentLastUUID  string `json:"parentLastUuid"`
	ContextLength   int64  `json:"contextLength"`
}

// ForkContextRef decodes a fork-context-ref record.
func (r *Record) ForkContextRef() (*ForkContextRef, bool) {
	if r.Type != TypeForkContextRef {
		return nil, false
	}
	var f ForkContextRef
	if !r.decode(&f) {
		return nil, false
	}
	return &f, true
}

// AgentMeta is the content of agent-<id>.meta.json. Pointer fields distinguish absent
// from zero (a teammate's spawnDepth of 0 is meaningful).
type AgentMeta struct {
	AgentType     string `json:"agentType,omitempty"` // general-purpose, Explore, fork, custom, or a teammate's name
	Description   string `json:"description,omitempty"`
	ToolUseID     string `json:"toolUseId,omitempty"`
	SpawnDepth    *int   `json:"spawnDepth,omitempty"`
	ParentAgentID string `json:"parentAgentId,omitempty"`
	Model         string `json:"model,omitempty"`
	Name          string `json:"name,omitempty"`
	TeamName      string `json:"teamName,omitempty"`
	TaskKind      string `json:"taskKind,omitempty"` // "in_process_teammate"
	Color         string `json:"color,omitempty"`
	IsFork        bool   `json:"isFork,omitempty"`
	WorkflowPhase string `json:"workflowPhase,omitempty"` // agents of a workflow run
}

// ParseAgentMeta decodes a meta.json file. Unknown and mistyped fields are ignored; only
// invalid JSON is an error.
func ParseAgentMeta(data []byte) (AgentMeta, error) {
	var aux struct {
		AgentMeta
		SpawnDepth json.RawMessage `json:"spawnDepth"` // shadows the typed field
	}
	if err := unmarshalTolerant(data, &aux); err != nil {
		return AgentMeta{}, err
	}
	m := aux.AgentMeta
	var d int
	if json.Unmarshal(aux.SpawnDepth, &d) == nil {
		m.SpawnDepth = &d
	}
	return m, nil
}
