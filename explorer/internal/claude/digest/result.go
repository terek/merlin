package digest

import (
	"encoding/json"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

// FileResult is what a Builder produces for ONE transcript file (a session's main file or
// one subagent file). It is internal to the digest package and is the contract with
// Assemble, which links the agent files of a session to the main file and rolls costs up.
//
// Everything is ordered by file position. Nothing in it depends on the wall clock or on
// map iteration order. Texts are whole.
type FileResult struct {
	// Turns are the file's turns in file order. Turn.Index is the slice index. When the
	// file has assistant activity before its first prompt, Turns[0] is a continuation turn
	// (origin "continuation", empty UserText, no UUID) and the first prompt is Turns[1].
	// Turn.CostWithAgents equals Turn.Cost.USD here; Assemble adds spawned agents and fills
	// Turn.Spawned.
	Turns []model.Turn
	// Messages has one entry per billed API message (not synthetic), in order of first
	// appearance. AgentID is empty: Assemble sets it. Turn is the turn the message's first
	// line fell in. A message whose model is not in the price table is included with
	// USD 0 and its model is listed in Diagnostics.UnpricedModels.
	Messages []model.Message
	// Compactions are the file's compaction boundaries in order, with whole summaries.
	Compactions []model.Compaction
	// Cost is the sum of the file's messages (own messages only, no agents).
	Cost model.Cost

	// AgentSpawns lists every Agent (or Task) tool_use seen, in order, one per tool_use id.
	AgentSpawns []AgentSpawn
	// SpawnResults lists the tool_results that answer an Agent tool_use or that carry a
	// spawn-style toolUseResult (completed, async_launched, teammate_spawned).
	SpawnResults []SpawnResult
	// Notifications lists the task-notification prompts (background agent finished).
	Notifications []TaskNotification
	// AgentsKilled lists system/agents_killed events.
	AgentsKilled []AgentsKilled

	// Titles and names. Empty when the file has none. Last record of each kind wins;
	// CustomTitle beats AITitle at the session level (Assemble's / session's call).
	AITitle     string
	CustomTitle string
	AgentName   string
	// LastPrompt / LastPromptLeaf are from the last last-prompt record.
	LastPrompt     string
	LastPromptLeaf string
	// Slugs is the set of envelope slugs, first appearance order.
	Slugs []string
	// CostStates are the cost-state records in file order (cumulative; the last is the
	// one that counts).
	CostStates []CostStateRecord
	// Recaps are Claude Code's away_summary records.
	Recaps []model.Recap

	// Cwds, GitBranches, Versions, Entrypoints and SessionKinds are the unique values of
	// the corresponding envelope fields over all records, in first-appearance order. A
	// relocated record contributes to Cwds. "Scripted" means Entrypoints == ["sdk-cli"].
	Cwds []string
	// LastCwd is the working directory at the end of the file.
	LastCwd      string
	GitBranches  []string
	Versions     []string
	Entrypoints  []string
	SessionKinds []string
	// SessionIDs are the unique envelope sessionId values (normally one).
	SessionIDs []string
	// AgentIDs are the unique envelope agentId values (one in an agent file).
	AgentIDs []string
	// ForkedFrom is the first forkedFrom marker seen (explicit fork), else nil.
	ForkedFrom *model.ForkRef
	// InheritedFrom lists the unique session_id values that differ from the record's
	// sessionId: records copied from those sessions. First-appearance order.
	InheritedFrom []string
	// ForkContextRefs are the fork-context-ref records (a fork agent's pointer to its
	// parent's context).
	ForkContextRefs []ForkContextRef

	// FirstTimestamp and LastTimestamp are the earliest and latest record timestamps
	// (zero when no record has one). away_summary records count.
	FirstTimestamp time.Time
	LastTimestamp  time.Time

	// EndState says how the file ends: clean (the last assistant message stopped with
	// end_turn and nothing conversational follows), interrupted (the last turn was
	// interrupted), mid-turn (it ends on a prompt, a tool_use or a tool_result), or
	// unknown (no conversation records).
	EndState model.EndState

	Counters    Counters
	Diagnostics model.Diagnostics
}

// Counters are per-file record counts.
type Counters struct {
	// Records is the number of records applied, including skipped duplicates.
	Records int64
	// DuplicateUUIDs is the number of records skipped because their uuid was already seen.
	DuplicateUUIDs int64
	// SyntheticMessages is the number of "<synthetic>" assistant messages (API errors,
	// interruptions): they cost nothing and are not counted as assistant messages.
	SyntheticMessages int64
	// MalformedRecords counts records whose message could not be decoded.
	MalformedRecords int64
	// UnattachedSummaries counts isCompactSummary records that did not follow a boundary.
	UnattachedSummaries int64
}

// AgentSpawn is one Agent tool_use block.
type AgentSpawn struct {
	ToolUseID string
	// MessageID is the id of the assistant message that holds the tool_use.
	MessageID string
	// Turn is the index of the turn it occurred in.
	Turn int
	// At is the timestamp of the assistant line that holds the tool_use.
	At time.Time

	Name            string // input.name (teammates)
	Description     string
	Prompt          string
	SubagentType    string
	Model           string
	RunInBackground bool
	Isolation       string
}

// SpawnResult is a tool_result that answers an Agent tool_use, or that carries a
// spawn-style toolUseResult.
type SpawnResult struct {
	ToolUseID string
	// Turn is the index of the turn it occurred in (-1 before any turn).
	Turn int
	At   time.Time
	// IsError is the tool_result block's is_error flag.
	IsError bool
	// Status is toolUseResult.status: "completed", "async_launched", "teammate_spawned",
	// or empty when the result carries no toolUseResult.
	Status string
	// AgentID is toolUseResult.agentId (completed, async_launched).
	AgentID string
	// TeammateID is toolUseResult.agent_id, "<name>@<team>" (teammate_spawned).
	TeammateID string
	Name       string // toolUseResult.name (teammate_spawned)
	TeamName   string
	OutputFile string
	// HasToolUseOwner is true when ToolUseID names an Agent tool_use seen earlier in this
	// file.
	HasToolUseOwner bool
}

// TaskNotification is a task-notification prompt: a background agent reported back.
type TaskNotification struct {
	Turn int // the turn the notification started
	At   time.Time
	// TaskID is the <task-id> element (an agent id for agent tasks).
	TaskID string
	// Status is the <status> element: completed, killed, failed, ...
	Status    string
	ToolUseID string // <tool-use-id>, when present
	Summary   string // <summary>, whole
}

// AgentsKilled is a system/agents_killed event.
type AgentsKilled struct {
	Turn int
	At   time.Time
	// AgentIDs are the agent ids found in the record (best effort: the record's shape is
	// not pinned down). Raw is the whole record for callers that know more.
	AgentIDs []string
	Raw      json.RawMessage
}

// CostStateRecord is one cost-state record (Claude Code's own running totals).
type CostStateRecord struct {
	TotalCostUSD float64
	StartTime    json.RawMessage
	// Start is StartTime as a time (epoch milliseconds); zero when it is absent or not a
	// number.
	Start time.Time
	// At is the latest record timestamp seen before this record (the record itself has
	// no timestamp); zero when no timestamped record precedes it.
	At           time.Time
	LinesAdded   int64
	LinesRemoved int64
	// ByModel is keyed by the model name with any "[1m]" suffix stripped.
	ByModel map[string]model.ReportedModel
}

// ForkContextRef is a fork-context-ref record.
type ForkContextRef struct {
	AgentID         string
	ParentSessionID string
	ParentLastUUID  string
	ContextLength   int64
}
