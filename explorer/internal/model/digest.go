package model

import "time"

// SessionKey identifies a session across harnesses.
type SessionKey struct {
	Harness string `json:"harness"`
	ID      string `json:"id"`
}

// String returns "harness/id".
func (k SessionKey) String() string { return k.Harness + "/" + k.ID }

// SourceFile is one file a digest was built from. The set of SourceFiles is the
// fingerprint: if any file's size or mtime differs, the digest is stale.
type SourceFile struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	MtimeNs int64  `json:"mtimeNs"`
}

// SessionDigest is the stored summary of one session: one JSON file per session.
type SessionDigest struct {
	SchemaVersion int `json:"schemaVersion"`
	ParserVersion int `json:"parserVersion"`

	Source        []SourceFile `json:"source"`
	SourceMissing bool         `json:"sourceMissing,omitempty"`
	// Error is set on a stub written when building the digest failed. A stub carries
	// Source so the session is retried only when its files change.
	Error string `json:"error,omitempty"`

	Harness    string `json:"harness"`    // "claude" today
	ID         string `json:"id"`         // session id, unique within the harness
	ProjectKey string `json:"projectKey"` // the harness's storage key for the project
	Project    string `json:"project"`    // directory the session started in

	Cwd             string   `json:"cwd,omitempty"`
	Cwds            []string `json:"cwds,omitempty"`
	GitBranches     []string `json:"gitBranches,omitempty"`
	HarnessVersions []string `json:"harnessVersions,omitempty"`

	Kind           SessionKind `json:"kind"`
	Title          string      `json:"title,omitempty"`
	Name           string      `json:"name,omitempty"`
	Slug           string      `json:"slug,omitempty"`
	StartedAt      time.Time   `json:"startedAt,omitzero"`
	LastActivityAt time.Time   `json:"lastActivityAt,omitzero"`
	EndState       EndState    `json:"endState,omitempty"`

	Recaps   []Recap   `json:"recaps,omitempty"`
	Lineage  Lineage   `json:"lineage"`
	Stats    Stats     `json:"stats"`
	Cost     Cost      `json:"cost"`
	Reported *Reported `json:"reported,omitempty"`

	Compactions []Compaction `json:"compactions,omitempty"`
	Turns       []Turn       `json:"turns,omitempty"`
	Agents      []Agent      `json:"agents,omitempty"`
	Messages    []Message    `json:"messages,omitempty"`

	Diagnostics Diagnostics `json:"diagnostics"`
}

// Key returns the session's (harness, id) key.
func (d *SessionDigest) Key() SessionKey { return SessionKey{Harness: d.Harness, ID: d.ID} }

// Recap is a harness-written "where things stand" note.
type Recap struct {
	At   time.Time `json:"at"`
	Text string    `json:"text"`
}

// ForkRef names the point in another session that this session was forked from.
type ForkRef struct {
	SessionID   string `json:"sessionId"`
	MessageUUID string `json:"messageUuid"`
}

// Lineage holds explicit markers only. The full picture is worked out by the catalog.
type Lineage struct {
	ForkedFrom    *ForkRef `json:"forkedFrom,omitempty"`
	InheritedFrom []string `json:"inheritedFrom,omitempty"` // session ids that records were copied from
}

// Stats are whole-session counters.
type Stats struct {
	HumanTurns        int64            `json:"humanTurns"`
	Turns             int64            `json:"turns"`
	AssistantMessages int64            `json:"assistantMessages"`
	ToolCalls         int64            `json:"toolCalls"`
	ToolsByName       map[string]int64 `json:"toolsByName,omitempty"`
	LinesAdded        int64            `json:"linesAdded,omitempty"`
	LinesRemoved      int64            `json:"linesRemoved,omitempty"`
}

// ReportedModel is the harness's own per-model usage figure. CacheCreation is not split
// by lifetime because the harness does not split it.
type ReportedModel struct {
	InputTokens         int64   `json:"inputTokens,omitempty"`
	OutputTokens        int64   `json:"outputTokens,omitempty"`
	ThinkingTokens      int64   `json:"thinkingTokens,omitempty"`
	CacheReadTokens     int64   `json:"cacheReadTokens,omitempty"`
	CacheCreationTokens int64   `json:"cacheCreationTokens,omitempty"`
	WebSearchRequests   int64   `json:"webSearchRequests,omitempty"`
	USD                 float64 `json:"usd"`
}

// ReportedWindow is one stretch of the session that the harness reported a cost for. The
// harness keeps a running total per process run; a window is one such run, from the
// moment its counter started to the last time the counter was written down. Spending
// outside every window (before the first, between two, after the last) was not reported.
type ReportedWindow struct {
	From     time.Time                `json:"from"`
	To       time.Time                `json:"to"`
	TotalUSD float64                  `json:"totalUSD"`
	ByModel  map[string]ReportedModel `json:"byModel,omitempty"`
}

// Reported is the cost the harness itself reported. It is never blended with Cost: it
// covers only the Windows, and inside them it includes calls that leave no trace in the
// transcript. TotalUSD and ByModel are the sums over Windows.
type Reported struct {
	TotalUSD float64                  `json:"totalUSD"`
	ByModel  map[string]ReportedModel `json:"byModel,omitempty"`
	Windows  []ReportedWindow         `json:"windows,omitempty"`
}

// Compaction is one context compaction. PostTokens and DurationMs are zero when the
// harness did not record them.
type Compaction struct {
	At         time.Time         `json:"at"`
	Turn       int               `json:"turn"` // index of the last turn started before it; -1 if none
	Trigger    CompactionTrigger `json:"trigger,omitempty"`
	PreTokens  int64             `json:"preTokens,omitempty"`
	PostTokens int64             `json:"postTokens,omitempty"`
	DurationMs int64             `json:"durationMs,omitempty"`
	Summary    string            `json:"summary,omitempty"` // whole
	// Boilerplate marks the parts of Summary that the harness writes into every summary
	// (fixed sentences around the real text). Search skips them; the summary stays whole.
	Boilerplate []TextSpan `json:"boilerplate,omitempty"`
}

// TextSpan is a stretch of a text: UTF-8 byte offsets, From inclusive and To exclusive.
type TextSpan struct {
	From int `json:"from"`
	To   int `json:"to"`
}

// Turn is one prompt and everything the main agent did in answer to it.
type Turn struct {
	Index     int    `json:"index"`
	Epoch     int    `json:"epoch"` // compaction epoch: number of compactions before this turn
	UUID      string `json:"uuid,omitempty"`
	Abandoned bool   `json:"abandoned,omitempty"`

	StartedAt  time.Time  `json:"startedAt,omitzero"`
	EndedAt    time.Time  `json:"endedAt,omitzero"`
	DurationMs int64      `json:"durationMs,omitempty"`
	Origin     TurnOrigin `json:"origin"`

	UserText    string `json:"userText"`
	Images      int    `json:"images,omitempty"`
	Command     string `json:"command,omitempty"`
	FinalText   string `json:"finalText,omitempty"`
	Interrupted bool   `json:"interrupted,omitempty"`

	AssistantMessages int64            `json:"assistantMessages"`
	ToolCalls         int64            `json:"toolCalls"`
	ToolsByName       map[string]int64 `json:"toolsByName,omitempty"`
	FilesTouched      []string         `json:"filesTouched,omitempty"`
	ContextTokens     int64            `json:"contextTokens,omitempty"`

	Cost           Cost     `json:"cost"`
	CostWithAgents float64  `json:"costWithAgents"`
	Spawned        []string `json:"spawned,omitempty"` // agent ids
}

// InboxMessage is a later message an agent received (teammates).
type InboxMessage struct {
	At   time.Time `json:"at"`
	From string    `json:"from,omitempty"`
	Text string    `json:"text"`
}

// Agent is a sub-agent of the session. The list is flat; the tree is ParentAgentID.
type Agent struct {
	ID          string    `json:"id"`
	Kind        AgentKind `json:"kind"`
	Name        string    `json:"name,omitempty"`
	AgentType   string    `json:"agentType,omitempty"`
	Description string    `json:"description,omitempty"`
	Model       string    `json:"model,omitempty"`

	ParentAgentID  *string `json:"parentAgentId"` // null = spawned by the main agent
	SpawnToolUseID string  `json:"spawnToolUseId,omitempty"`
	SpawnTurn      *int    `json:"spawnTurn,omitempty"`
	Depth          int     `json:"depth"`
	Background     bool    `json:"background,omitempty"`
	Linkage        Linkage `json:"linkage"`

	StartedAt time.Time   `json:"startedAt,omitzero"`
	EndedAt   time.Time   `json:"endedAt,omitzero"`
	Status    AgentStatus `json:"status"`

	Prompt    string         `json:"prompt,omitempty"`
	FinalText string         `json:"finalText,omitempty"`
	Inbox     []InboxMessage `json:"inbox,omitempty"`

	AssistantMessages int64            `json:"assistantMessages"`
	ToolCalls         int64            `json:"toolCalls"`
	ToolsByName       map[string]int64 `json:"toolsByName,omitempty"`
	Compactions       []Compaction     `json:"compactions,omitempty"`

	Cost       Cost    `json:"cost"`
	SubtreeUSD float64 `json:"subtreeUSD"` // own + descendants
}

// Message is one billed API message. It exists so cross-session rules (a message id is
// billed once) can be applied without re-reading transcripts.
type Message struct {
	ID      string    `json:"id"`
	At      time.Time `json:"at"`
	Model   string    `json:"model"`
	AgentID string    `json:"agentId,omitempty"` // empty = main agent
	Turn    *int      `json:"turn,omitempty"`
	USD     float64   `json:"usd"`
	// Truncated marks a message the harness wrote down before it finished: its output
	// token count is partial, so USD is a lower bound.
	Truncated bool `json:"truncated,omitempty"`
	Tokens
}

// Diagnostics counts what the parser could not interpret. Nothing here is fatal.
type Diagnostics struct {
	UnknownTypes     map[string]int64 `json:"unknownTypes,omitempty"`
	BadLines         int64            `json:"badLines,omitempty"`
	UnpricedModels   []string         `json:"unpricedModels,omitempty"`
	UnresolvedAgents int64            `json:"unresolvedAgents,omitempty"`
}
