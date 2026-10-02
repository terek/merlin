package model

// SchemaVersion is the version of the digest layout defined in this package. Bump it when
// a field is removed, renamed or changes meaning (additive fields do not need a bump).
const SchemaVersion = 1

// SessionKind says how a session was driven.
type SessionKind string

const (
	// KindInteractive is a session a person drives.
	KindInteractive SessionKind = "interactive"
	// KindSDK is a scripted run (every record came from a programmatic client). A session
	// that mixes interactive and programmatic records is interactive, not sdk.
	KindSDK SessionKind = "sdk"
	// KindBackground is a session running detached from a terminal.
	KindBackground SessionKind = "background"
)

// TurnOrigin says who or what authored the prompt that started a turn.
type TurnOrigin string

const (
	OriginHuman            TurnOrigin = "human"
	OriginCommand          TurnOrigin = "command"           // slash command or local shell command
	OriginTaskNotification TurnOrigin = "task-notification" // a background agent finished
	OriginPeer             TurnOrigin = "peer"              // message from another agent
	OriginScheduled        TurnOrigin = "scheduled"         // injected by the harness on a schedule
	OriginSDK              TurnOrigin = "sdk"               // sent by a programmatic client
	OriginContinuation     TurnOrigin = "continuation"      // harness-issued "keep going"
)

// AgentKind says what sort of sub-agent an Agent is.
type AgentKind string

const (
	AgentSubagent AgentKind = "subagent"
	AgentTeammate AgentKind = "teammate"
	AgentFork     AgentKind = "fork"    // subagent that inherits its parent's context
	AgentCompact  AgentKind = "compact" // the call that wrote a compaction summary
)

// AgentStatus is how an agent's life ended, as far as the files show.
type AgentStatus string

const (
	StatusCompleted AgentStatus = "completed"
	StatusKilled    AgentStatus = "killed"
	// StatusOpen means no terminal marker was found in the files. Whether the agent is
	// actually still running is the catalog's call, not the digest's.
	StatusOpen AgentStatus = "open"
)

// Linkage records how an agent was tied to the tool call that spawned it. The values are
// the rungs of the linkage ladder, strongest first.
type Linkage string

const (
	LinkMeta       Linkage = "meta"        // agent metadata named the spawning tool call
	LinkToolResult Linkage = "tool-result" // the spawn's tool result named the agent id
	LinkName       Linkage = "name"        // matched by teammate name
	LinkPrompt     Linkage = "prompt"      // matched by identical first prompt
	LinkUnresolved Linkage = "unresolved"  // no link; attached to the session root
)

// EndState is how the last turn of a session ended.
type EndState string

const (
	EndClean       EndState = "clean"       // the agent finished its answer
	EndInterrupted EndState = "interrupted" // the user interrupted
	EndMidTurn     EndState = "mid-turn"    // the files stop in the middle of work
	EndUnknown     EndState = "unknown"
)

// CompactionTrigger says what started a compaction.
type CompactionTrigger string

const (
	TriggerAuto   CompactionTrigger = "auto"
	TriggerManual CompactionTrigger = "manual"
)
