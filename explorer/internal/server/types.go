package server

import (
	"time"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/model"
)

// Every response body of the API is one of the types in this file (or a catalog or model
// type embedded in one). Keys are camelCase, times RFC 3339, USD float64.

// Error codes of ErrorBody.
const (
	CodeInvalidParameter = "invalid_parameter"  // 400
	CodeForbiddenHost    = "forbidden_host"     // 403
	CodeNotFound         = "not_found"          // 404
	CodeMethodNotAllowed = "method_not_allowed" // 405
	CodeAmbiguousID      = "ambiguous_id"       // 409
	CodeInternal         = "internal"           // 500
	CodeUnavailable      = "unavailable"        // 503
)

// ErrorBody is the body of every non-2xx response.
type ErrorBody struct {
	Error ErrorInfo `json:"error"`
}

// ErrorInfo says what went wrong. Candidates is set for CodeAmbiguousID.
type ErrorInfo struct {
	Code       string      `json:"code"`
	Message    string      `json:"message"`
	Candidates []Candidate `json:"candidates,omitempty"`
}

// Candidate is a session an ambiguous id prefix matches.
type Candidate struct {
	Key            model.SessionKey `json:"key"`
	Title          string           `json:"title,omitempty"`
	Project        string           `json:"project"`
	LastActivityAt time.Time        `json:"lastActivityAt,omitzero"`
}

// CostBrief is the cost of a session as the list shows it. BestUSD is the figure to show
// and to sum; Flag says how it is backed (exact, partial, estimated). The full breakdown
// is catalog.SessionCost in SessionDetail.
type CostBrief struct {
	BestUSD      float64          `json:"bestUSD"`
	Flag         catalog.CostFlag `json:"flag"`
	ReportedUSD  float64          `json:"reportedUSD"`
	UncoveredUSD float64          `json:"uncoveredUSD"`
	OverheadUSD  float64          `json:"overheadUSD"`
	InheritedUSD float64          `json:"inheritedUSD"`
}

// LineageBrief is the lineage of a session as the list shows it.
type LineageBrief struct {
	Parent     *model.SessionKey `json:"parent,omitempty"`
	ParentKind catalog.LinkKind  `json:"parentKind,omitempty"`
	Children   int               `json:"children"`
	Root       model.SessionKey  `json:"root"`
	// Leaf: no session continues from this one.
	Leaf bool `json:"leaf"`
	// InheritedTurns is how many turns were copied from the parent; FirstOwnTurn is the
	// index of the first turn that is not (-1 when every turn is).
	InheritedTurns int `json:"inheritedTurns"`
	FirstOwnTurn   int `json:"firstOwnTurn"`
}

// SessionSummary is a session without its turns and messages: one row of the session
// list, the payload of the session-updated event, and the head of SessionDetail.
type SessionSummary struct {
	Key            model.SessionKey  `json:"key"`
	Project        string            `json:"project"`
	ProjectKey     string            `json:"projectKey"`
	Cwd            string            `json:"cwd,omitempty"`
	Branch         string            `json:"branch,omitempty"`
	Title          string            `json:"title,omitempty"`
	Name           string            `json:"name,omitempty"`
	Kind           model.SessionKind `json:"kind"`
	StartedAt      time.Time         `json:"startedAt,omitzero"`
	LastActivityAt time.Time         `json:"lastActivityAt,omitzero"`
	EndState       model.EndState    `json:"endState,omitempty"`
	SourceMissing  bool              `json:"sourceMissing,omitempty"`
	// State: busy, idle (running), recent, ended.
	State   catalog.State `json:"state"`
	Turns   int           `json:"turns"`
	Agents  int           `json:"agents"` // sub-agents and teammates, compaction calls excluded
	Cost    CostBrief     `json:"cost"`
	Lineage LineageBrief  `json:"lineage"`
}

// SessionList is the body of GET /api/sessions.
type SessionList struct {
	Sessions []SessionSummary `json:"sessions"`
	// Total is the number of sessions matching the filters, over all pages.
	Total int `json:"total"`
	// NextCursor is set when more sessions follow; pass it as ?cursor=.
	NextCursor string `json:"nextCursor,omitempty"`
	// Scripted holds the aggregate lines of scripted runs (per project and day). It is
	// filled on the first page only (no cursor).
	Scripted []catalog.ScriptedLine `json:"scripted"`
}

// ProjectSummary is one project of GET /api/projects. Cost is the sum of the best costs of
// its sessions plus its scripted runs.
type ProjectSummary struct {
	Harness        string        `json:"harness"`
	ProjectKey     string        `json:"projectKey"`
	Project        string        `json:"project"`
	Sessions       int           `json:"sessions"`     // interactive and background
	ScriptedRuns   int           `json:"scriptedRuns"` // counted, never listed
	LastActivityAt time.Time     `json:"lastActivityAt,omitzero"`
	Cost           catalog.Money `json:"cost"`
}

// ProjectList is the body of GET /api/projects, most recently active first.
type ProjectList struct {
	Projects []ProjectSummary `json:"projects"`
}

// SessionLineage is the lineage facts of one session in full.
type SessionLineage struct {
	Parent   *catalog.Link    `json:"parent,omitempty"`
	Children []catalog.Link   `json:"children"`
	Root     model.SessionKey `json:"root"`
	Leaf     bool             `json:"leaf"`
	// InheritedTurns are the indexes of the turns copied from the parent, ascending.
	InheritedTurns []int `json:"inheritedTurns"`
	FirstOwnTurn   int   `json:"firstOwnTurn"`
}

// FamilyMember is one session of a family, in tree order.
type FamilyMember struct {
	Key            model.SessionKey  `json:"key"`
	Title          string            `json:"title,omitempty"`
	Kind           model.SessionKind `json:"kind"`
	StartedAt      time.Time         `json:"startedAt,omitzero"`
	LastActivityAt time.Time         `json:"lastActivityAt,omitzero"`
	State          catalog.State     `json:"state"`
	Parent         *model.SessionKey `json:"parent,omitempty"`
	Leaf           bool              `json:"leaf"`
	Turns          int               `json:"turns"`
	BestUSD        float64           `json:"bestUSD"`
}

// SessionFamily is the tree of linked sessions a session belongs to. Leaves are the
// members nobody continues from, newest first: the candidates to resume.
type SessionFamily struct {
	Root    model.SessionKey   `json:"root"`
	Members []FamilyMember     `json:"members"`
	Leaves  []model.SessionKey `json:"leaves"`
}

// SessionDetail is the body of GET /api/sessions/{harness}/{id}: the digest together with
// what the catalog derives from it. Digest.Messages is empty unless ?messages=1;
// MessageCount is always the real number.
type SessionDetail struct {
	Summary      SessionSummary       `json:"summary"`
	Cost         catalog.SessionCost  `json:"cost"`
	Lineage      SessionLineage       `json:"lineage"`
	Family       SessionFamily        `json:"family"`
	MessageCount int                  `json:"messageCount"`
	Digest       *model.SessionDigest `json:"digest"`
}

// SearchResult is the body of GET /api/search.
type SearchResult struct {
	Query string        `json:"query"`
	Hits  []catalog.Hit `json:"hits"`
	// Truncated: more hits exist than limit allowed.
	Truncated bool `json:"truncated"`
}

// CostRow is one line of a cost table. Key is the project, day (local date), model, kind
// or session id; Label names it where the key is not enough (a session's title). Flag is
// set for by=session rows.
type CostRow struct {
	Key      string           `json:"key"`
	Label    string           `json:"label,omitempty"`
	Sessions int              `json:"sessions"`
	Flag     catalog.CostFlag `json:"flag,omitempty"`
	catalog.Money
}

// CostBacking counts the sessions in a cost table by how their cost is backed.
type CostBacking struct {
	Exact        int `json:"exact"`
	Partial      int `json:"partial"`
	Estimated    int `json:"estimated"`
	ScriptedRuns int `json:"scriptedRuns"`
}

// CostTable is the body of GET /api/cost.
type CostTable struct {
	By      string        `json:"by"`
	Project string        `json:"project,omitempty"`
	Since   *time.Time    `json:"since,omitempty"`
	Until   *time.Time    `json:"until,omitempty"`
	Rows    []CostRow     `json:"rows"`
	Total   catalog.Money `json:"total"`
	// Sessions is the number of sessions behind Total (scripted runs included).
	Sessions int         `json:"sessions"`
	Backing  CostBacking `json:"backing"`
	// Truncated: Rows was cut to limit (Total still covers every row).
	Truncated bool `json:"truncated,omitempty"`
}

// SSE event names and payloads (GET /api/events).
const (
	EventSessionUpdated = "session-updated"
	EventSessionMissing = "session-missing"
	EventScanProgress   = "scan-progress"
)

// SessionUpdatedEvent is the data of a session-updated event.
type SessionUpdatedEvent struct {
	Key     model.SessionKey `json:"key"`
	Session SessionSummary   `json:"session"`
}

// SessionMissingEvent is the data of a session-missing event: the session's files are gone.
type SessionMissingEvent struct {
	Key model.SessionKey `json:"key"`
}

// ScanProgress is the data of a scan-progress event: how far indexing is. Pending is the
// number of sessions queued or being built; the other counters are those of the current
// scan.
type ScanProgress struct {
	Pending   int `json:"pending"`
	Seen      int `json:"seen"`
	Processed int `json:"processed"`
	Unchanged int `json:"unchanged"`
	Failed    int `json:"failed"`
	Missing   int `json:"missing"`
}
