// TypeScript mirror of the JSON the daemon serves: internal/server/types.go, the catalog
// types it embeds and the digest (docs/digest-schema.md). Keys are camelCase, times are RFC 3339
// strings, money is USD as a number. A field the Go side tags `omitempty` / `omitzero` is
// optional here. Lists the API always sends (`[]`, never null) are required.

// ---- keys and enums -------------------------------------------------------------------

export interface SessionKey {
  harness: string
  id: string
}

export type SessionKind = 'interactive' | 'sdk' | 'background'
export type EndState = 'clean' | 'interrupted' | 'mid-turn' | 'unknown'
/** Liveness: busy and idle are running; recent = not running, active in the last 10 minutes. */
export type State = 'busy' | 'idle' | 'recent' | 'ended'
export type CostFlag = 'exact' | 'partial' | 'estimated'
export type LinkKind = 'fork' | 'continuation'
export type TurnOrigin = 'human' | 'command' | 'task-notification' | 'peer' | 'scheduled' | 'sdk' | 'continuation'
export type AgentKind = 'subagent' | 'teammate' | 'fork' | 'compact'
export type AgentStatus = 'completed' | 'killed' | 'open'
export type Linkage = 'meta' | 'tool-result' | 'name' | 'prompt' | 'unresolved'
export type CompactionTrigger = 'auto' | 'manual'
export type SearchField = 'title' | 'prompt' | 'final' | 'compaction' | 'project' | 'cwd' | 'branch'

// ---- money ----------------------------------------------------------------------------

/** A dollar amount split by source. totalUSD = reportedUSD + attributedUSD. */
export interface Money {
  totalUSD: number
  reportedUSD: number
  attributedUSD: number
}

// ---- list shapes (internal/server) ----------------------------------------------------

export interface CostBrief {
  bestUSD: number
  flag: CostFlag
  reportedUSD: number
  uncoveredUSD: number
  overheadUSD: number
  inheritedUSD: number
}

export interface LineageBrief {
  parent?: SessionKey
  parentKind?: LinkKind
  children: number
  root: SessionKey
  /** No session continues from this one. */
  leaf: boolean
  /** Turns copied from the parent. */
  inheritedTurns: number
  /** Index of the first turn that is not inherited; -1 when every turn is. */
  firstOwnTurn: number
}

/** A preview (at most 300 characters) of the session's last human prompt. */
export interface LastPrompt {
  turn: number
  at: string
  text: string
  truncated: boolean
}

/** The harness's own "where things stand" note, as a preview. */
export interface RecapPreview {
  at: string
  text: string
  truncated: boolean
}

export interface SessionSummary {
  key: SessionKey
  project: string
  projectKey: string
  cwd?: string
  branch?: string
  title?: string
  name?: string
  kind: SessionKind
  startedAt?: string
  lastActivityAt?: string
  endState?: EndState
  sourceMissing?: boolean
  state: State
  turns: number
  /** Sub-agents and teammates; compaction calls are not counted. */
  agents: number
  cost: CostBrief
  lineage: LineageBrief
  // Added by the API bead merlin-t8s.18.2. Read them as optional: an older daemon omits them.
  /** Turns a human typed (`turns` also counts commands, notifications, ...). Use `promptCount()`. */
  humanTurns?: number
  lastPrompt?: LastPrompt
  recap?: RecapPreview
}

export interface ScriptedLine {
  project: string
  /** Local date, 2006-01-02. */
  day: string
  count: number
  totalUSD: number
  reportedUSD: number
  attributedUSD: number
}

export interface SessionList {
  sessions: SessionSummary[]
  /** All sessions matching the filters, over all pages. */
  total: number
  nextCursor?: string
  /** Aggregate lines of scripted runs; filled on the first page only. */
  scripted: ScriptedLine[]
}

export interface ProjectSummary {
  harness: string
  projectKey: string
  project: string
  sessions: number
  scriptedRuns: number
  lastActivityAt?: string
  cost: Money
}

export interface ProjectList {
  projects: ProjectSummary[]
}

// ---- session detail -------------------------------------------------------------------

export interface Link {
  parent: SessionKey
  child: SessionKey
  sharedMessages: number
  sharedTurns: number
  /** Index, in the parent, of the last turn the child copied; -1 if none. */
  atTurn: number
  explicit: boolean
  kind: LinkKind
}

export interface SessionLineage {
  parent?: Link
  children: Link[]
  root: SessionKey
  leaf: boolean
  /** Indexes of the turns copied from the parent, ascending. */
  inheritedTurns: number[]
  firstOwnTurn: number
}

export interface FamilyMember {
  key: SessionKey
  title?: string
  kind: SessionKind
  startedAt?: string
  lastActivityAt?: string
  state: State
  parent?: SessionKey
  leaf: boolean
  turns: number
  bestUSD: number
}

export interface SessionFamily {
  root: SessionKey
  /** In tree order: a parent before its children, siblings oldest first. */
  members: FamilyMember[]
  /** Members nobody continues from, newest first: the candidates to resume. */
  leaves: SessionKey[]
}

export interface ReportedModel {
  inputTokens?: number
  outputTokens?: number
  thinkingTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  webSearchRequests?: number
  usd: number
}

export interface ReportedWindow {
  from: string
  to: string
  totalUSD: number
  byModel?: Record<string, ReportedModel>
}

export interface Inherited {
  from: SessionKey
  usd: number
  messages: number
}

export interface SessionCost {
  /** reportedUSD + uncoveredUSD. The figure to show and to sum. */
  bestUSD: number
  flag: CostFlag
  reportedUSD: number
  /** Owned messages cut short in the transcript (their attributed cost is a lower bound). */
  truncatedMessages?: number
  windows?: ReportedWindow[]
  /** Attributed cost of the messages this session owns, agents included. */
  ownUSD: number
  coveredUSD: number
  uncoveredUSD: number
  /** reportedUSD - coveredUSD (>= 0): reported spend no transcript message explains. */
  overheadUSD: number
  inheritedUSD: number
  inheritedFrom?: Inherited[]
  ownMessages: number
  inheritedMessages: number
}

export interface SessionDetail {
  summary: SessionSummary
  cost: SessionCost
  lineage: SessionLineage
  family: SessionFamily
  messageCount: number
  digest: SessionDigest
}

// ---- digest (internal/model) ----------------------------------------------------------

export interface SourceFile {
  path: string
  size: number
  mtimeNs: number
}

export interface Recap {
  at: string
  text: string
}

export interface ForkRef {
  sessionId: string
  messageUuid: string
}

export interface DigestLineage {
  forkedFrom?: ForkRef
  inheritedFrom?: string[]
}

export interface Stats {
  humanTurns: number
  turns: number
  assistantMessages: number
  toolCalls: number
  toolsByName?: Record<string, number>
  linesAdded?: number
  linesRemoved?: number
}

/** Token counts by price class; all optional because zeros are omitted. */
export interface Tokens {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
}

export interface ModelCost extends Tokens {
  usd: number
}

/** An attributed cost: recomputed from token usage with the price table. */
export interface Cost {
  usd: number
  byModel?: Record<string, ModelCost>
  /** Messages cut short in the transcript: their output tokens are a partial count, so usd is a lower bound. */
  truncatedMessages?: number
}

export interface Reported {
  totalUSD: number
  byModel?: Record<string, ReportedModel>
  windows?: ReportedWindow[]
}

export interface Compaction {
  at: string
  /** Index of the last turn started before it; -1 if none. */
  turn: number
  trigger?: CompactionTrigger
  preTokens?: number
  postTokens?: number
  durationMs?: number
  summary?: string
  /** Byte ranges of the summary that are the harness's fixed wording (search skips them). */
  boilerplate?: { from: number; to: number }[]
}

export interface Turn {
  index: number
  epoch: number
  uuid?: string
  abandoned?: boolean
  startedAt?: string
  endedAt?: string
  durationMs?: number
  origin: TurnOrigin
  /**
   * The prompt as its author wrote it. For a prompt a machine delivered, only what was not
   * recognised as a message (normally nothing): the messages are in `inbox`.
   */
  userText: string
  /** The messages a machine delivered as this prompt. */
  inbox?: InboxMessage[]
  images?: number
  command?: string
  finalText?: string
  interrupted?: boolean
  assistantMessages: number
  toolCalls: number
  toolsByName?: Record<string, number>
  filesTouched?: string[]
  contextTokens?: number
  cost: Cost
  costWithAgents: number
  /** Ids of agents spawned in this turn. */
  spawned?: string[]
}

export type InboxKind = 'message' | 'idle' | 'task' | 'assignment'

/**
 * One message an agent received that nobody typed: a teammate's message, a teammate going idle, a
 * background task reporting, a task being assigned. The harness's markup is already taken off.
 */
export interface InboxMessage {
  at: string
  /** Absent in digests written before messages were parsed: read as 'message'. */
  kind?: InboxKind
  /** Sender's name as the harness gives it. */
  from?: string
  /** The agent of this session that sent the message, or that a task message is about. */
  agentId?: string
  taskId?: string
  /** idle: why the teammate stopped (available, failed); task: how it ended (completed, failed, killed). */
  status?: string
  summary?: string
  /** The message, whole. idle: the teammate's last answer; task: the result, or the event a monitor saw. */
  text?: string
  /** The failure the sender reported, when it stopped because of one. */
  error?: string
}

export interface Agent {
  id: string
  kind: AgentKind
  name?: string
  agentType?: string
  description?: string
  model?: string
  /** null = spawned by the main agent. */
  parentAgentId: string | null
  spawnToolUseId?: string
  spawnTurn?: number
  depth: number
  background?: boolean
  linkage: Linkage
  startedAt?: string
  endedAt?: string
  status: AgentStatus
  prompt?: string
  finalText?: string
  inbox?: InboxMessage[]
  assistantMessages: number
  toolCalls: number
  toolsByName?: Record<string, number>
  compactions?: Compaction[]
  cost: Cost
  /** Own dollars plus all descendants. */
  subtreeUSD: number
}

/** One billed API message; present only with `?messages=1`. */
export interface Message extends Tokens {
  id: string
  at: string
  model: string
  /** Omitted for the main agent. */
  agentId?: string
  turn?: number
  usd: number
  /** Written down before it finished: output tokens are a partial count. */
  truncated?: boolean
}

export interface Diagnostics {
  unknownTypes?: Record<string, number>
  badLines?: number
  unpricedModels?: string[]
  unresolvedAgents?: number
}

export interface SessionDigest {
  schemaVersion: number
  parserVersion: number
  source: SourceFile[]
  sourceMissing?: boolean
  error?: string
  harness: string
  id: string
  projectKey: string
  project: string
  cwd?: string
  cwds?: string[]
  gitBranches?: string[]
  harnessVersions?: string[]
  kind: SessionKind
  title?: string
  name?: string
  slug?: string
  startedAt?: string
  lastActivityAt?: string
  endState?: EndState
  recaps?: Recap[]
  lineage: DigestLineage
  stats: Stats
  cost: Cost
  reported?: Reported
  compactions?: Compaction[]
  turns?: Turn[]
  agents?: Agent[]
  messages?: Message[]
  diagnostics: Diagnostics
}

// ---- search ---------------------------------------------------------------------------

export interface Hit {
  session: SessionKey
  title?: string
  project: string
  at?: string
  field: SearchField
  /** Turn index (prompt, final) or compaction index (compaction); -1 for session-level fields. */
  turn: number
  abandoned?: boolean
  snippet: string
  /** Other sessions containing the same turn: the family's leaves first, then newest first. */
  continuedIn?: SessionKey[]
}

export interface SearchResult {
  query: string
  hits: Hit[]
  /** More hits exist than `limit` allowed. */
  truncated: boolean
}

// ---- cost -----------------------------------------------------------------------------

export type CostBy = 'project' | 'day' | 'model' | 'kind' | 'session'
export type CostSplit = 'project' | 'model' | 'kind'

/** One slice of a row when the table is requested with `split=`. */
export interface CostSplitEntry {
  key: string
  totalUSD: number
  reportedUSD: number
  attributedUSD: number
}

export interface CostRow extends Money {
  /** Project, local day, model, kind or session id. */
  key: string
  /** Names the key where it is not enough (a session's title). */
  label?: string
  sessions: number
  /** Set for by=session rows. */
  flag?: CostFlag
  /** by=session rows: the session's harness, project and last activity (a scripted row has only project). */
  harness?: string
  project?: string
  lastActivityAt?: string
  /** Present with `?split=`; the slices add up to the row. Read as optional. */
  split?: CostSplitEntry[]
}

export interface CostBacking {
  exact: number
  partial: number
  estimated: number
  scriptedRuns: number
}

export interface CostTable {
  by: CostBy
  project?: string
  since?: string
  until?: string
  rows: CostRow[]
  total: Money
  /** Sessions behind the total, scripted runs included. */
  sessions: number
  backing: CostBacking
  /** Rows were cut to `limit`; total still covers every row. */
  truncated?: boolean
}

// ---- errors ---------------------------------------------------------------------------

export type ErrorCode =
  | 'invalid_parameter'
  | 'forbidden_host'
  | 'not_found'
  | 'method_not_allowed'
  | 'ambiguous_id'
  | 'internal'
  | 'unavailable'

export interface Candidate {
  key: SessionKey
  title?: string
  project: string
  lastActivityAt?: string
}

export interface ErrorBody {
  error: { code: ErrorCode | string; message: string; candidates?: Candidate[] }
}

// ---- events (GET /api/events) ---------------------------------------------------------

export interface SessionUpdatedEvent {
  key: SessionKey
  session: SessionSummary
}

export interface SessionMissingEvent {
  key: SessionKey
}

/** Added by merlin-t8s.18.2: a session started or stopped running, or went busy / idle. */
export interface SessionStateEvent {
  key: SessionKey
  state: State
  previous: State
}

export interface ScanProgress {
  pending: number
  seen: number
  processed: number
  unchanged: number
  failed: number
  missing: number
}

export interface EventMap {
  'session-updated': SessionUpdatedEvent
  'session-missing': SessionMissingEvent
  'session-state': SessionStateEvent
  'scan-progress': ScanProgress
}

// ---- request parameters ---------------------------------------------------------------

/** Parameters of GET /api/sessions (and the shared ones of /api/search). Comma-separated lists. */
export interface SessionFilters {
  project?: string
  /** `running`, `recent`, `ended`, comma separated. */
  state?: string
  /** `interactive`, `background`, comma separated. Absent = both. */
  kind?: string
  since?: string
  until?: string
  limit?: number
}

export interface CostParams {
  by?: CostBy
  split?: CostSplit
  since?: string
  until?: string
  project?: string
  limit?: number
}
