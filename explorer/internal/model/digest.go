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

	Compactions []Compaction  `json:"compactions,omitempty"`
	Turns       []Turn        `json:"turns,omitempty"`
	Agents      []Agent       `json:"agents,omitempty"`
	Workflows   []WorkflowRun `json:"workflows,omitempty"`
	Messages    []Message     `json:"messages,omitempty"`

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
	// Call is what the call that wrote the summary cost: an estimate, since the harness does
	// not record that call. Absent when the context size or the model's price is unknown.
	Call *CompactionCall `json:"call,omitempty"`
}

// CompactionCall is the estimated cost of a compaction's API call: the whole context as
// input, the summary as output. It is never part of a recomputed total. Cold means the
// main agent's previous call was older than the cache lifetime, so the context was read
// again at full price instead of from the cache.
type CompactionCall struct {
	Model string `json:"model"`
	// IdleMs is the time since the main agent's previous API call.
	IdleMs int64      `json:"idleMs"`
	Cache  CacheState `json:"cache"`
	// Billing is how the context was charged, which follows from Cache and the harness
	// version.
	Billing      CallBilling `json:"billing"`
	InputTokens  int64       `json:"inputTokens"`  // the context size before the compaction
	OutputTokens int64       `json:"outputTokens"` // from the summary's length
	USD          float64     `json:"usd"`
	// WarmUSD is what the same call would have cost had the cache been warm.
	WarmUSD float64 `json:"warmUSD"`
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

	// UserText is the prompt as its author wrote it. A prompt a machine delivered is taken
	// apart into Inbox, and UserText keeps only what was not recognised (normally nothing).
	UserText string `json:"userText"`
	// Inbox holds the messages a machine delivered as this prompt, in order.
	Inbox []InboxMessage `json:"inbox,omitempty"`
	// Queued holds the prompts that arrived while the turn was running, in order. They
	// start no turn of their own.
	Queued      []QueuedPrompt `json:"queued,omitempty"`
	Images      int            `json:"images,omitempty"`
	Command     string         `json:"command,omitempty"`
	FinalText   string         `json:"finalText,omitempty"`
	Interrupted bool           `json:"interrupted,omitempty"`

	AssistantMessages int64            `json:"assistantMessages"`
	ToolCalls         int64            `json:"toolCalls"`
	ToolsByName       map[string]int64 `json:"toolsByName,omitempty"`
	FilesTouched      []string         `json:"filesTouched,omitempty"`
	ContextTokens     int64            `json:"contextTokens,omitempty"`

	Cost           Cost     `json:"cost"`
	CostWithAgents float64  `json:"costWithAgents"`
	Spawned        []string `json:"spawned,omitempty"` // agent ids
}

// QueuedPrompt is a prompt that arrived while a turn was running: a message the user typed
// without waiting, or one a machine delivered. The agent reads it in the middle of the
// turn; it starts no turn.
type QueuedPrompt struct {
	At     time.Time  `json:"at"`
	Origin TurnOrigin `json:"origin"`
	// Text is the prompt as its author wrote it; for a delivered prompt, what was not
	// recognised as a message (normally nothing), as in Turn.UserText.
	Text  string         `json:"text,omitempty"`
	Inbox []InboxMessage `json:"inbox,omitempty"`
}

// InboxMessage is one message an agent received that nobody typed: a teammate's message, a
// teammate going idle, a background task reporting, a task being assigned. A turn started by
// such a delivery lists them in Turn.Inbox; an agent's later ones are in Agent.Inbox.
type InboxMessage struct {
	At   time.Time `json:"at"`
	Kind InboxKind `json:"kind"`
	// From is the sender's name as the harness gives it (a teammate's name, "team-lead").
	From string `json:"from,omitempty"`
	// AgentID is the agent of this session that sent the message or that it is about,
	// when one could be identified.
	AgentID string `json:"agentId,omitempty"`
	// TaskID is the harness's id of the task the message is about (kinds task, assignment).
	TaskID string `json:"taskId,omitempty"`
	// Status is the state reported: for idle why the teammate stopped (available, failed),
	// for task how it ended (completed, failed, killed). Empty when none was given.
	Status  string `json:"status,omitempty"`
	Summary string `json:"summary,omitempty"`
	Text    string `json:"text,omitempty"`
	// Error is the failure the sender reported, when it stopped because of one.
	Error string `json:"error,omitempty"`
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
	// RunID is the workflow run the agent belongs to (kind workflow), and Phase the phase of
	// the run its script put it in.
	RunID string `json:"runId,omitempty"`
	Phase string `json:"phase,omitempty"`

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

// WorkflowRun is one run of a workflow script, launched by one tool call. Its agents are
// in the agent list with RunID set; the run is what ties them to a turn.
type WorkflowRun struct {
	ID      string `json:"id"`
	Name    string `json:"name,omitempty"`
	Summary string `json:"summary,omitempty"`
	// TaskID is the id the run's task notification carries.
	TaskID    string `json:"taskId,omitempty"`
	ToolUseID string `json:"toolUseId,omitempty"`
	// Turn is the turn of the main agent the run was launched in; AgentID is set instead
	// when an agent launched it (Turn is then that agent's spawn turn).
	Turn      *int      `json:"turn,omitempty"`
	AgentID   string    `json:"agentId,omitempty"`
	StartedAt time.Time `json:"startedAt,omitzero"`
	EndedAt   time.Time `json:"endedAt,omitzero"`
	// Status is how the harness said the run ended (completed, failed, killed), or open
	// when the files hold no such notice.
	Status string  `json:"status"`
	Agents int     `json:"agents"`
	USD    float64 `json:"usd"` // its agents and everything below them
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
