import { BookOpen, GitFork, Layers, ListCollapse, Loader2, Play, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { SearchInput } from '@/components/layout/SearchInput'
import { TabGroup } from '@/components/layout/TabGroup'
import { Markdown } from '@/components/Markdown'
import { PpStatusIcon } from '@/components/PpStatusIcon'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { type NavigationFocus, useMerlinStore } from '@/stores/merlin-store'
import type { LeanTurn, RawTurn, SessionTask } from '@/types/model'

function rawTurnMatches(turn: RawTurn, q: string): boolean {
  if (!q) return true
  return turn.text.toLowerCase().includes(q.toLowerCase())
}

function asTextForSearch(v: unknown): string {
  if (Array.isArray(v)) return v.join(' ')
  if (typeof v === 'string') return v
  return ''
}

function leanTurnMatches(turn: LeanTurn, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  const fields = [turn.userText, turn.userSummary, turn.agentText, turn.agentSummary]
  for (const f of fields) {
    if (asTextForSearch(f).toLowerCase().includes(needle)) return true
  }
  for (const sa of turn.subagents) {
    const saFields = [sa.userText, sa.userSummary, sa.agentText, sa.agentSummary]
    for (const f of saFields) {
      if (asTextForSearch(f).toLowerCase().includes(needle)) return true
    }
  }
  return false
}

function taskMatches(task: SessionTask, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  if (task.description.toLowerCase().includes(needle)) return true
  if (task.id.toLowerCase().includes(needle)) return true
  for (const c of task.concepts?.items ?? []) {
    if (c.concept.toLowerCase().includes(needle)) return true
    if (c.description.toLowerCase().includes(needle)) return true
  }
  return false
}

export function SessionView({ focus }: { focus: Extract<NavigationFocus, { level: 'session' }> }) {
  const tab = useMerlinStore((s) => s.sessionTab)
  const setTab = useMerlinStore((s) => s.setSessionTab)
  const search = useMerlinStore((s) => s.sessionSearch.get(focus.cwd) ?? '')
  const setSearch = useMerlinStore((s) => s.setSessionSearch)
  const connected = useMerlinStore((s) => s.connected)
  const model = useMerlinStore((s) => s.model)

  // Raw turns
  const rawTurnsBySession = useMerlinStore((s) => s.rawTurnsBySession)
  const rawTurnsLoading = useMerlinStore((s) => s.rawTurnsLoading)
  const requestRawTurns = useMerlinStore((s) => s.requestRawTurns)

  // Lean turns (from processor)
  const leanTurnsBySession = useMerlinStore((s) => s.leanTurnsBySession)
  const leanTurnsLoading = useMerlinStore((s) => s.leanTurnsLoading)
  const requestLeanTurns = useMerlinStore((s) => s.requestLeanTurns)

  const processSession = useMerlinStore((s) => s.processSession)
  const deleteProcessing = useMerlinStore((s) => s.deleteProcessing)

  const rawData = rawTurnsBySession.get(focus.sessionId)
  const rawLoading = rawTurnsLoading.has(focus.sessionId)

  const leanData = leanTurnsBySession.get(focus.sessionId)
  const leanLoading = leanTurnsLoading.has(focus.sessionId)

  // Use sessionCwd (original folder cwd) for data fetches, fall back to project cwd
  const fetchCwd = focus.sessionCwd ?? focus.cwd

  // Don't send requests until cwd is resolved from ~/work/ shorthand
  const cwdResolved = !fetchCwd.startsWith('~/')

  // Request raw turns on mount
  useEffect(() => {
    if (connected && cwdResolved && !rawData && !rawLoading) {
      requestRawTurns(fetchCwd, focus.sessionId)
    }
  }, [connected, cwdResolved, fetchCwd, focus.sessionId, rawData, rawLoading, requestRawTurns])

  // Request lean turns when switching to lean or segments tab
  useEffect(() => {
    if (connected && cwdResolved && (tab === 'lean' || tab === 'tasks') && !leanData && !leanLoading) {
      requestLeanTurns(fetchCwd, focus.sessionId)
    }
  }, [connected, cwdResolved, tab, fetchCwd, focus.sessionId, leanData, leanLoading, requestLeanTurns])

  const navigate = useMerlinStore((s) => s.navigate)
  const project = model?.projects[focus.cwd]
  const sessionMeta = project?.sessions.find((s) => s.sessionId === focus.sessionId)

  // Resolve parent session
  const parentSession = sessionMeta?.parentSessionId
    ? project?.sessions.find((s) => s.sessionId === sessionMeta.parentSessionId)
    : null
  const parentName = parentSession ? (parentSession.customTitle ?? parentSession.sessionId.slice(0, 8)) : null

  const searchPlaceholder =
    tab === 'tasks' ? 'Search tasks...' : tab === 'lean' ? 'Search summaries...' : 'Search turns...'

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        tabs={
          <TabGroup
            value={tab}
            onChange={setTab}
            items={[
              { key: 'raw', label: 'Raw', icon: Layers, loading: rawLoading },
              { key: 'lean', label: 'Lean', icon: ListCollapse, loading: leanLoading },
              { key: 'tasks', label: 'Tasks', icon: BookOpen, loading: leanLoading },
            ]}
          />
        }
        search={
          <SearchInput value={search} onChange={(q) => setSearch(focus.cwd, q)} placeholder={searchPlaceholder} />
        }
        stats={
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {parentName && (
              <button
                type="button"
                onClick={() => navigate({ level: 'session', cwd: focus.cwd, sessionId: sessionMeta!.parentSessionId! })}
                className="inline-flex items-center gap-1 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                title={`Spawned from ${parentName}`}
              >
                <GitFork className="h-3 w-3" />
                <span>{parentName}</span>
              </button>
            )}
            {sessionMeta && (
              <>
                <span>{sessionMeta.userTurnCount} turns</span>
                {sessionMeta.subagentCount > 0 && <span>{sessionMeta.subagentCount} subagents</span>}
              </>
            )}
            {sessionMeta && (
              <div className="flex items-center gap-1.5">
                <PpStatusIcon
                  status={sessionMeta.ppStatus}
                  error={sessionMeta.ppError}
                  turnsCovered={sessionMeta.ppTurnsCovered}
                  totalTurns={sessionMeta.userTurnCount}
                />
                <span>
                  {sessionMeta.ppStatus === 'processed'
                    ? 'processed'
                    : sessionMeta.ppStatus === 'running'
                      ? 'running...'
                      : sessionMeta.ppStatus === 'error'
                        ? 'error'
                        : sessionMeta.ppStatus === 'outdated'
                          ? 'outdated'
                          : ''}
                </span>
              </div>
            )}
          </div>
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => processSession(fetchCwd, focus.sessionId)}
              disabled={sessionMeta?.ppStatus === 'running'}
              title="Process session"
            >
              {sessionMeta?.ppStatus === 'running' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </Button>
            {sessionMeta?.ppStatus === 'processed' && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => deleteProcessing(fetchCwd, focus.sessionId)}
                title="Delete processed data"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </>
        }
      />

      {tab === 'raw' && (
        <RawView
          turns={rawData?.turns}
          total={rawData?.total}
          title={rawData?.title}
          loading={rawLoading}
          search={search}
        />
      )}
      {tab === 'lean' && (
        <LeanView turns={leanData?.turns} title={leanData?.title} loading={leanLoading} search={search} />
      )}
      {tab === 'tasks' && (
        <TasksView turns={leanData?.turns} tasks={leanData?.tasks} loading={leanLoading} search={search} />
      )}
    </div>
  )
}

// -- Shared -------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// -- Raw turns view -----------------------------------------------------------

function RawView({
  turns,
  total,
  title,
  loading,
  search,
}: {
  turns?: RawTurn[]
  total?: number
  title?: string | null
  loading: boolean
  search: string
}) {
  if (loading && !turns) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading turns...</span>
      </div>
    )
  }

  if (!turns || turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p className="text-sm">No conversation data.</p>
      </div>
    )
  }

  const filtered = search ? turns.filter((t) => rawTurnMatches(t, search)) : turns

  if (filtered.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p className="text-sm">No turns match your search.</p>
      </div>
    )
  }

  let lastDate = ''

  return (
    <ScrollArea className="flex-1">
      <div className="p-6 max-w-3xl space-y-1">
        {title && <h2 className="text-base font-semibold text-foreground mb-1">{title}</h2>}
        {total != null && (
          <p className="text-xs text-muted-foreground mb-4">
            {search ? `${filtered.length} of ${total} turns` : `${total} turns`}
          </p>
        )}

        {filtered.map((turn) => {
          const date = formatDate(turn.timestamp)
          const showDate = date !== lastDate
          lastDate = date

          return (
            <div key={turn.index}>
              {showDate && (
                <div className="flex items-center gap-2 my-4 first:mt-0">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-[11px] text-muted-foreground">{date}</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              )}
              <RawTurnBubble turn={turn} />
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function RawTurnBubble({ turn }: { turn: RawTurn }) {
  const isUser = turn.role === 'user'

  return (
    <div className={cn('flex gap-3 py-2', isUser ? 'flex-row-reverse' : '')}>
      <span className="text-[10px] text-muted-foreground/50 font-mono shrink-0 pt-1 w-10 text-right">
        {formatTimestamp(turn.timestamp)}
      </span>
      <div
        className={cn(
          'rounded-lg px-4 py-2.5 text-sm leading-relaxed break-words min-w-0',
          isUser ? 'bg-cyan-500/10 border border-cyan-500/20 ml-12' : 'bg-secondary mr-12',
        )}
      >
        <Markdown>{turn.text}</Markdown>
      </div>
    </div>
  )
}

// -- Lean view (from processor LeanTurns) ------------------------------------

function LeanView({
  turns,
  title,
  loading,
  search,
}: {
  turns?: LeanTurn[]
  title?: string | null
  loading: boolean
  search: string
}) {
  if (loading && !turns) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading...</span>
      </div>
    )
  }

  if (!turns || turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p className="text-sm">No processed data available. Run the processor first.</p>
      </div>
    )
  }

  const filtered = search ? turns.filter((t) => leanTurnMatches(t, search)) : turns

  if (filtered.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p className="text-sm">No exchanges match your search.</p>
      </div>
    )
  }

  let lastDate = ''

  return (
    <ScrollArea className="flex-1">
      <div className="p-6 max-w-3xl">
        {title && <h2 className="text-base font-semibold text-foreground mb-1">{title}</h2>}
        <p className="text-xs text-muted-foreground mb-4">
          {search ? `${filtered.length} of ${turns.length} exchanges` : `${turns.length} exchanges`}
        </p>

        <div className="space-y-1">
          {filtered.map((turn) => {
            const date = formatDate(turn.userTimestamp)
            const showDate = date !== lastDate
            lastDate = date

            return (
              <div key={turn.id}>
                {showDate && (
                  <div className="flex items-center gap-2 my-4 first:mt-0">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[11px] text-muted-foreground">{date}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                <LeanTurnPair turn={turn} />
              </div>
            )
          })}
        </div>
      </div>
    </ScrollArea>
  )
}

/** Coerce a value that may be string or string[] into a single markdown string. */
function asText(v: unknown): string {
  if (Array.isArray(v)) return v.join('\n')
  if (typeof v === 'string') return v
  return String(v ?? '')
}

interface ContextTask {
  id: string
  description: string
  turns: number[]
}

interface ContextRecent {
  turn: number
  gist: string
}

interface ContextData {
  tasks?: ContextTask[]
  recent?: ContextRecent[]
  turn_index?: number
}

function ContextBlock({ context }: { context: unknown }) {
  const ctx = context as ContextData

  return (
    <div className="ml-6 mt-1 space-y-1">
      {ctx.tasks?.map((task) => (
        <div key={task.id} className="text-[11px] leading-snug">
          <span className="text-yellow-300/70">{task.description}</span>{' '}
          <span className="text-yellow-400/40 font-mono">{task.turns.map((t) => `(${t})`).join(' ')}</span>
        </div>
      ))}
      {ctx.recent?.map((r) => (
        <div key={r.turn} className="text-[10px] text-muted-foreground/40 leading-snug">
          {r.gist} <span className="font-mono text-muted-foreground/30">[{r.turn}]</span>
        </div>
      ))}
    </div>
  )
}

function LeanTurnPair({ turn }: { turn: LeanTurn }) {
  return (
    <div className="space-y-0.5 py-2">
      {/* User prompt — left-aligned, timestamp right */}
      <div className="flex items-start gap-2 rounded-lg px-3 py-2 bg-cyan-500/10 border-l-2 border-cyan-500/30">
        <div className="text-sm leading-relaxed break-words min-w-0 flex-1">
          <Markdown>
            {asText(turn.userSummary && turn.userSummary !== turn.userText ? turn.userSummary : turn.userText)}
          </Markdown>
        </div>
        <span className="text-[10px] text-muted-foreground/50 font-mono shrink-0 pt-1">
          {formatTimestamp(turn.userTimestamp)}
        </span>
      </div>

      {/* Subagents — indented */}
      {turn.subagents.map((sa) => (
        <div key={sa.agentId} className="ml-6 my-1">
          <div className="rounded px-3 py-1.5 text-xs leading-relaxed break-words min-w-0 bg-purple-500/10 border-l-2 border-purple-500/30">
            <span className="text-[10px] text-purple-400/60 font-mono">{sa.agentType ?? 'agent'}</span>
            <div className="text-purple-300/80 mt-0.5">
              <Markdown>{asText(sa.userSummary ?? sa.userText)}</Markdown>
            </div>
            <div className="text-muted-foreground mt-0.5">
              <Markdown>{asText(sa.agentSummary ?? sa.agentText)}</Markdown>
            </div>
          </div>
        </div>
      ))}

      {/* Agent response — indented */}
      <div className="flex items-start gap-2 ml-6 rounded-lg px-3 py-2 bg-secondary border-l-2 border-border">
        <div className="text-sm leading-relaxed break-words min-w-0 flex-1 text-muted-foreground">
          <Markdown>
            {asText(turn.agentSummary && turn.agentSummary !== turn.agentText ? turn.agentSummary : turn.agentText)}
          </Markdown>
        </div>
        <span className="text-[10px] text-muted-foreground/50 font-mono shrink-0 pt-1">
          {formatTimestamp(turn.agentTimestamp)}
        </span>
      </div>

      {/* Meta line: token usage */}
      {turn.usage && (
        <div className="flex items-center gap-1.5 ml-6 text-[10px] text-muted-foreground/40">
          <span>{formatTokens(turn.usage.outputTokens)} out</span>
          {turn.usage.cacheReadTokens > 0 && <span>· {formatTokens(turn.usage.cacheReadTokens)} cache</span>}
          {turn.rawMessageCount > 1 && <span>· {turn.rawMessageCount} msgs</span>}
        </div>
      )}

      {/* Debug: rolling context snapshot */}
      {turn._context && <ContextBlock context={turn._context} />}
    </div>
  )
}

// -- Tasks view (from last lean turn _context) --------------------------------

const CONCEPT_PILL_CLASS = 'bg-pink-500/10 text-pink-400/80'

function TasksView({
  turns,
  tasks,
  loading,
  search,
}: {
  turns?: LeanTurn[]
  tasks?: SessionTask[]
  loading: boolean
  search: string
}) {
  if (loading && !turns) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading...</span>
      </div>
    )
  }

  if (!tasks || tasks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p className="text-sm">No tasks found. Process the session first.</p>
      </div>
    )
  }

  // Build a lookup: 0-based turn index → lean turn
  const turnMap = new Map<number, LeanTurn>()
  if (turns) {
    for (const t of turns) turnMap.set(t.index, t)
  }

  const filtered = search ? tasks.filter((t) => taskMatches(t, search)) : tasks

  if (filtered.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p className="text-sm">No tasks match your search.</p>
      </div>
    )
  }

  // Sort tasks by first turn index (chronological)
  const sorted = [...filtered].sort((a, b) => (a.turns[0] ?? 0) - (b.turns[0] ?? 0))

  return (
    <ScrollArea className="flex-1">
      <div className="p-6 space-y-4 max-w-3xl">
        <div className="text-xs text-muted-foreground">
          {search
            ? `${filtered.length} of ${tasks.length} tasks`
            : `${tasks.length} task${tasks.length !== 1 ? 's' : ''} · ${turns?.length ?? 0} turns`}
        </div>

        <div className="space-y-3">
          {sorted.map((task) => (
            <TaskCard key={task.id} task={task} turnMap={turnMap} />
          ))}
        </div>
      </div>
    </ScrollArea>
  )
}

function TaskCard({ task, turnMap }: { task: SessionTask; turnMap: Map<number, LeanTurn> }) {
  const [expanded, setExpanded] = useState(false)

  const concepts = task.concepts?.items ?? []

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
      >
        <span className="text-[10px] text-muted-foreground/50 font-mono shrink-0 pt-0.5">{task.id}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{task.description}</p>
          {concepts.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {concepts.map((c) => (
                <div key={c.concept} className="text-[11px] leading-snug">
                  <span className="font-mono text-foreground/70">{c.concept}:</span>{' '}
                  <span className="text-muted-foreground">{c.description}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0 pt-0.5">
          {task.turns.length} turn{task.turns.length !== 1 ? 's' : ''}
        </span>
      </button>

      {expanded && (
        <div className="border-t px-4 py-2 space-y-1 bg-secondary/10">
          {task.turns.map((turnIdx) => {
            const turn = turnMap.get(turnIdx - 1) // tasks use 1-based, LeanTurn.index is 0-based
            if (!turn)
              return (
                <div key={turnIdx} className="text-[11px] text-muted-foreground/40 font-mono">
                  ({turnIdx}) —
                </div>
              )
            const userText = asText(
              turn.userSummary && turn.userSummary !== turn.userText ? turn.userSummary : turn.userText,
            )
            const agentText = asText(
              turn.agentSummary && turn.agentSummary !== turn.agentText ? turn.agentSummary : turn.agentText,
            )
            return (
              <div key={turnIdx} className="flex gap-2 text-[11px] leading-snug py-0.5">
                <span className="text-muted-foreground/50 font-mono shrink-0">({turnIdx})</span>
                <div className="min-w-0">
                  <p className="text-foreground/80 line-clamp-1">{userText}</p>
                  <p className="text-muted-foreground/60 line-clamp-1">{agentText}</p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
