package catalog

import (
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

// OverheadModel is the model name of the rollup line that carries overhead: spend a
// harness reported inside its windows that no transcript message accounts for. It has no
// model of its own.
const OverheadModel = "(overhead)"

// coverSlack is how far outside a reported window a message may lie and still count as
// inside it.
const coverSlack = time.Second

// recentWindow is how long after its last activity a session is still "recent".
const recentWindow = 10 * time.Minute

// CostFlag says how far a session's best cost is backed by the harness's own figures.
type CostFlag string

const (
	// CostExact: the session has reported windows and nothing it owns lies outside them.
	CostExact CostFlag = "exact"
	// CostPartial: it has reported windows, and some owned spend lies outside them.
	CostPartial CostFlag = "partial"
	// CostEstimated: no reported windows at all; the cost is recomputed from tokens.
	CostEstimated CostFlag = "estimated"
)

// Money is a dollar amount split by where it comes from. TotalUSD = ReportedUSD +
// AttributedUSD. Reported is spend inside a harness-reported window (the window's total,
// overhead included); attributed is spend outside every window, recomputed from tokens.
type Money struct {
	TotalUSD      float64 `json:"totalUSD"`
	ReportedUSD   float64 `json:"reportedUSD"`
	AttributedUSD float64 `json:"attributedUSD"`
	// Compactions is the estimated cost of the compaction calls in the same scope; see
	// CompactionTally for how it relates to TotalUSD.
	Compactions CompactionTally `json:"compactions,omitzero"`
}

func (m *Money) add(reported, attributed float64) {
	m.ReportedUSD += reported
	m.AttributedUSD += attributed
	m.TotalUSD += reported + attributed
}

// CompactionTally sums the estimated cost of compaction calls (model.CompactionCall).
// A call inside a reported window is already part of ReportedUSD, as overhead; one
// outside every window (UncoveredUSD) is in no total at all, since the harness never
// wrote it down. WarmUSD is what the same calls would have cost had the cache been warm
// each time.
type CompactionTally struct {
	Calls        int     `json:"calls"`
	Cold         int     `json:"cold"`
	USD          float64 `json:"usd"`
	WarmUSD      float64 `json:"warmUSD"`
	UncoveredUSD float64 `json:"uncoveredUSD"`
}

func (t *CompactionTally) add(o CompactionTally) {
	t.Calls += o.Calls
	t.Cold += o.Cold
	t.USD += o.USD
	t.WarmUSD += o.WarmUSD
	t.UncoveredUSD += o.UncoveredUSD
}

// tally is the tally of one compaction call.
func tally(call *model.CompactionCall, covered bool) CompactionTally {
	t := CompactionTally{Calls: 1, USD: call.USD, WarmUSD: call.WarmUSD}
	if call.Cache == model.CacheCold {
		t.Cold = 1
	}
	if !covered {
		t.UncoveredUSD = call.USD
	}
	return t
}

// Inherited says how much of a session's history is billed to another session.
type Inherited struct {
	From     model.SessionKey `json:"from"`
	USD      float64          `json:"usd"`
	Messages int              `json:"messages"`
}

// SessionCost is every cost figure of one session. BestUSD is the one to show and to sum;
// the function that computes it is bestCost in build.go.
type SessionCost struct {
	// BestUSD = ReportedUSD + UncoveredUSD.
	BestUSD float64  `json:"bestUSD"`
	Flag    CostFlag `json:"flag"`

	// ReportedUSD is the sum of the session's reported windows (windows another session
	// owns are not included). Windows lists them.
	ReportedUSD float64                `json:"reportedUSD"`
	Windows     []model.ReportedWindow `json:"windows,omitempty"`

	// OwnUSD is the attributed cost of the messages this session owns, subagents
	// included. CoveredUSD of it lies inside a window, UncoveredUSD outside every window.
	OwnUSD       float64 `json:"ownUSD"`
	CoveredUSD   float64 `json:"coveredUSD"`
	UncoveredUSD float64 `json:"uncoveredUSD"`

	// OverheadUSD = ReportedUSD - CoveredUSD, clamped at 0: what the harness reported
	// that no transcript message explains. A session-level figure, never spread over
	// agents or turns.
	OverheadUSD float64 `json:"overheadUSD"`

	// InheritedUSD is the attributed cost of messages in this session's files that
	// another session owns, split by owner.
	InheritedUSD  float64     `json:"inheritedUSD"`
	InheritedFrom []Inherited `json:"inheritedFrom,omitempty"`

	OwnMessages       int `json:"ownMessages"`
	InheritedMessages int `json:"inheritedMessages"`
	// TruncatedMessages is how many of the owned messages the harness wrote down before
	// they finished (Message.Truncated): their output tokens are partial, so OwnUSD and
	// the part of the best cost recomputed from tokens are lower bounds when it is non-zero.
	TruncatedMessages int `json:"truncatedMessages,omitempty"`
	// Compactions is the estimated cost of the session's compaction calls, main agent and
	// sub-agents; see CompactionTally.
	Compactions CompactionTally `json:"compactions,omitzero"`
}

// LinkKind says whether a child session took over from its parent or branched off it.
type LinkKind string

const (
	// LinkFork: both sessions go on from the copy point (the copy carries a forkedFrom
	// marker, or the parent has turns of its own after it).
	LinkFork LinkKind = "fork"
	// LinkContinuation: the parent stops where the child's copy ends.
	LinkContinuation LinkKind = "continuation"
)

// Link joins a parent session to a child that starts with a copy of its history.
type Link struct {
	Parent         model.SessionKey `json:"parent"`
	Child          model.SessionKey `json:"child"`
	SharedMessages int              `json:"sharedMessages"`
	SharedTurns    int              `json:"sharedTurns"`
	// AtTurn is the index, in the parent, of the last turn the child copied; -1 if none.
	AtTurn int `json:"atTurn"`
	// Explicit: a marker in the child (forkedFrom, inheritedFrom) names the parent.
	Explicit bool     `json:"explicit"`
	Kind     LinkKind `json:"kind"`
}

// State is the liveness of a session.
type State string

const (
	StateBusy   State = "busy"   // running, working
	StateIdle   State = "idle"   // running, waiting for input
	StateRecent State = "recent" // not running, activity within the last 10 minutes
	StateEnded  State = "ended"
)

// Running reports whether the state is busy or idle.
func (s State) Running() bool { return s == StateBusy || s == StateIdle }

// SessionInfo is everything the catalog derives about one session, besides its digest
// (see Catalog.Digest). It is a value; the slices in it are shared and must not be
// modified.
type SessionInfo struct {
	Key        model.SessionKey  `json:"key"`
	Project    string            `json:"project"`
	ProjectKey string            `json:"projectKey"`
	Cwd        string            `json:"cwd,omitempty"`
	Branch     string            `json:"branch,omitempty"`
	Title      string            `json:"title,omitempty"`
	Name       string            `json:"name,omitempty"`
	Kind       model.SessionKind `json:"kind"`

	StartedAt      time.Time      `json:"startedAt,omitzero"`
	LastActivityAt time.Time      `json:"lastActivityAt,omitzero"`
	EndState       model.EndState `json:"endState,omitempty"`
	SourceMissing  bool           `json:"sourceMissing,omitempty"`

	Turns int         `json:"turns"`
	Cost  SessionCost `json:"cost"`

	// InheritedTurns are the indexes of turns copied from the parent (matched by prompt
	// uuid), ascending. FirstOwnTurn is the index of the first turn that is not
	// inherited, -1 when every turn is.
	InheritedTurns []int `json:"inheritedTurns,omitempty"`
	FirstOwnTurn   int   `json:"firstOwnTurn"`

	// Parent is the link to the session this one continues or forks from; Children are
	// the links to the sessions that copied from this one, oldest first.
	Parent   *Link  `json:"parent,omitempty"`
	Children []Link `json:"children,omitempty"`
	// Root is the root of the session's family (itself when it has no parent).
	Root model.SessionKey `json:"root"`
	// Leaf: no session continues from this one (it may still have fork children). The
	// leaves of a family are the candidates to resume.
	Leaf bool `json:"leaf"`

	// State is filled by List (and StateOf) when liveness is supplied.
	State State `json:"state,omitempty"`
}

// Family is a tree of linked sessions.
type Family struct {
	Root model.SessionKey
	// Members in tree order (a parent before its children, siblings oldest first).
	Members []model.SessionKey
	// Leaves are the members nobody continues from, newest first by last activity.
	Leaves []model.SessionKey
}

// Dim is a rollup dimension.
type Dim int

const (
	ByProject Dim = iota
	ByDay
	ByModel
	ByKind
)

// Row is one line of a rollup. Only the fields of the requested dimensions are set.
// Sessions counts the distinct sessions that contributed spend to the row.
type Row struct {
	Project  string `json:"project,omitempty"`
	Day      string `json:"day,omitempty"` // local date, 2006-01-02
	Model    string `json:"model,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Sessions int    `json:"sessions"`
	Money
}

// ScriptedLine is the aggregate that stands in for scripted (sdk) sessions in listings:
// one per project and local day. Count is the number of scripted sessions that started on
// that day; Money is the spend of that day, which can include a session that started the
// day before.
type ScriptedLine struct {
	Project string `json:"project"`
	Day     string `json:"day"`
	Count   int    `json:"count"`
	Money
}

// Listing is the result of List.
type Listing struct {
	Sessions []SessionInfo // never scripted sessions; last activity, newest first
	Scripted []ScriptedLine
}

// Tree is one family of linked sessions as the list shows it. A tree is selected when any
// of its members is; it then holds all of them.
type Tree struct {
	Root model.SessionKey
	// Open is the member to resume: the newest leaf.
	Open model.SessionKey
	// LastActivityAt is the newest last activity of any member.
	LastActivityAt time.Time
	// BestUSD is the sum of the members' best costs (each counts only what it owns).
	BestUSD float64
	// Members in tree order (a parent before its children, siblings oldest first), State
	// filled when liveness is known.
	Members []SessionInfo
}

// Filter selects sessions. The zero value selects everything.
type Filter struct {
	Harness string
	// Project is a project directory (or a harness storage key).
	Project string
	Kinds   []model.SessionKind
	// Since and Until bound the session's last activity: Since <= lastActivityAt < Until.
	Since, Until time.Time
	// States keeps sessions in one of these liveness states; it needs the Liveness
	// passed to List.
	States []State
	// DayFrom and DayTo (local dates, inclusive) restrict rollups and scripted lines to
	// spend on those days. They do not select sessions.
	DayFrom, DayTo string
}

// Field names the part of a session a search hit matched.
type Field string

const (
	FieldTitle      Field = "title"
	FieldPrompt     Field = "prompt"
	FieldFinal      Field = "final"
	FieldCompaction Field = "compaction"
	FieldProject    Field = "project"
	FieldCwd        Field = "cwd"
	FieldBranch     Field = "branch"
)

// rank orders fields: lower comes first in results.
func (f Field) rank() int {
	switch f {
	case FieldTitle, FieldPrompt:
		return 0
	case FieldFinal:
		return 1
	case FieldCompaction:
		return 2
	}
	return 3
}

// Hit is one search result.
type Hit struct {
	Session model.SessionKey `json:"session"`
	// Root is the root of the session's tree (the session itself when it has no parent).
	Root    model.SessionKey `json:"root"`
	Title   string           `json:"title,omitempty"`
	Project string           `json:"project"`
	At      time.Time        `json:"at,omitzero"`
	Field   Field            `json:"field"`
	// Turn is the turn index (prompt, final) or compaction index (compaction); -1 for
	// session-level fields.
	Turn      int    `json:"turn"`
	Abandoned bool   `json:"abandoned,omitempty"`
	Snippet   string `json:"snippet"`
	// ContinuedIn lists the other sessions that contain the same turn or compaction:
	// the family's leaves first, then the rest, newest first.
	ContinuedIn []model.SessionKey `json:"continuedIn,omitempty"`
}

// SearchOptions narrows a search. Limit <= 0 means no limit.
type SearchOptions struct {
	Filter Filter
	Limit  int
}

// Diagnostics summarises what the last rebuild saw.
type Diagnostics struct {
	Sessions         int // sessions in the catalog (stubs excluded)
	Stubs            int // error stubs, not indexed
	Scripted         int
	Messages         int // distinct message ids
	SharedMessages   int // message ids found in more than one session
	Links            int
	CycleBreaks      int     // parent links dropped because markers formed a cycle
	SharedWindows    int     // reported windows found in more than one session
	OverheadClamped  int     // sessions whose covered spend exceeded the reported total
	ReportedUSD      float64 // sum of owned windows
	CoveredUSD       float64 // attributed cost of owned messages inside windows
	BestUSD          float64 // sum of best costs
	SessionsUncover  int     // sessions with owned spend outside every window
	SessionsEstimate int     // sessions without reported windows
}
