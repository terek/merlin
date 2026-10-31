package model

// SchemaVersion is the version of the digest layout defined in this package. Bump it when
// a field is removed, renamed or changes meaning (additive fields do not need a bump).
//
// 2: Agent.Kind no longer has teammate and fork; those agents are subagents with
// Addressable and InheritsContext.
const SchemaVersion = 2

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
	// OriginSpawn is the task an agent was started with (AgentTurn only).
	OriginSpawn TurnOrigin = "spawn"
)

// InboxKind says what sort of machine-delivered message an InboxMessage is.
type InboxKind string

const (
	InboxMessageKind InboxKind = "message"    // text written by another agent
	InboxIdle        InboxKind = "idle"       // a teammate stopped and is waiting; Text is its last answer
	InboxTask        InboxKind = "task"       // a background task (agent, command, monitor) reported
	InboxAssignment  InboxKind = "assignment" // a task was assigned to the receiver
)

// AgentKind says what started an agent. Whether it inherits its parent's conversation or
// can be sent more work is in Agent.InheritsContext and Agent.Addressable. (Schema 1 had
// the kinds "teammate" and "fork" for those.)
type AgentKind string

const (
	// AgentSubagent is an agent another agent started with a tool call.
	AgentSubagent AgentKind = "subagent"
	AgentCompact  AgentKind = "compact" // the call that wrote a compaction summary
	// AgentWorkflow is an agent of a workflow run: started by the workflow's script, not by a
	// tool call of its own.
	AgentWorkflow AgentKind = "workflow"
	// AgentReview is a code review the harness ran on the user's request (Codex /review).
	AgentReview AgentKind = "review"
	// AgentApprovalReview is a call the harness made to judge whether an action needs the
	// user's approval (Codex's automatic approval reviewer).
	AgentApprovalReview AgentKind = "approval-review"
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
	LinkRun        Linkage = "run"         // its directory names the workflow run a tool call launched
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

// CacheState says whether a compaction call found its context in the prompt cache.
type CacheState string

const (
	CacheWarm CacheState = "warm"
	CacheCold CacheState = "cold"
)

// CallBilling says how a compaction call's context was charged.
type CallBilling string

const (
	BillingCacheRead    CallBilling = "cache-read"
	BillingInput        CallBilling = "input"
	BillingCacheWrite1h CallBilling = "cache-write-1h"
	BillingCacheWrite5m CallBilling = "cache-write-5m"
)

// CompactionTrigger says what started a compaction.
type CompactionTrigger string

const (
	TriggerAuto   CompactionTrigger = "auto"
	TriggerManual CompactionTrigger = "manual"
)

// BeadOp is what a bd (beads issue tracker) call did to the beads it names.
type BeadOp string

const (
	BeadCreate  BeadOp = "create"
	BeadClaim   BeadOp = "claim" // update --claim: assigned to the caller and in progress
	BeadUpdate  BeadOp = "update"
	BeadClose   BeadOp = "close" // close, or update --status closed
	BeadReopen  BeadOp = "reopen"
	BeadComment BeadOp = "comment" // a comment or note added
	BeadDep     BeadOp = "dep"     // dep add: Ids[0] depends on Ids[1]
	BeadShow    BeadOp = "show"    // read only: a weak link between the session and the bead
)

// BeadOutcome says whether a bd call is known to have worked.
type BeadOutcome string

const (
	BeadOK      BeadOutcome = "ok"      // the output confirms it
	BeadFailed  BeadOutcome = "failed"  // the output reports an error for it, or the call failed unconfirmed
	BeadUnknown BeadOutcome = "unknown" // no output yet, or the output does not say
)
