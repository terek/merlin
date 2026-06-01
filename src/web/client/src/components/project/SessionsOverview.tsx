import { GitBranch, Layers, Loader2, Play, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { SearchInput } from '@/components/layout/SearchInput'
import { TabGroup } from '@/components/layout/TabGroup'
import { SessionBadge } from '@/components/projects/SessionBadge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn, formatSize } from '@/lib/utils'
import { useMerlinStore } from '@/stores/merlin-store'
import type { PreprocessingStats, ProcessedSession, Project, SessionSummary, SessionTask } from '@/types/model'
import { OrganizerView } from './OrganizerView'
import { TimelineView } from './TimelineView'

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MIN_CHARS = 2

interface SessionsOverviewProps {
  project: Project | null
  onSessionClick?: (sessionId: string) => void
}

export function SessionsOverview({ project, onSessionClick }: SessionsOverviewProps) {
  const tab = useMerlinStore((s) => s.projectTab)
  const setTab = useMerlinStore((s) => s.setProjectTab)
  const search = useMerlinStore((s) => (project ? s.projectSearch.get(project.cwd) : undefined) ?? '')
  const setSearch = useMerlinStore((s) => s.setProjectSearch)
  const segmentsByProject = useMerlinStore((s) => s.segmentsByProject)
  const segmentsLoading = useMerlinStore((s) => s.segmentsLoading)
  const requestSegments = useMerlinStore((s) => s.requestSegments)
  const tasksByProject = useMerlinStore((s) => s.tasksByProject)
  const tasksByProjectLoading = useMerlinStore((s) => s.tasksByProjectLoading)
  const requestProjectTasks = useMerlinStore((s) => s.requestProjectTasks)
  const processProject = useMerlinStore((s) => s.processProject)
  const deleteProcessing = useMerlinStore((s) => s.deleteProcessing)
  const reembedProject = useMerlinStore((s) => s.reembedProject)
  const taskSearch = useMerlinStore((s) => (project ? s.taskSearchByProject.get(project.cwd) : undefined))
  const searchProjectTasks = useMerlinStore((s) => s.searchProjectTasks)
  const clearProjectTaskSearch = useMerlinStore((s) => s.clearProjectTaskSearch)

  const cwd = project?.cwd
  const processedSessions = cwd ? segmentsByProject.get(cwd) : undefined
  const loading = cwd ? segmentsLoading.has(cwd) : false
  const projectTasks = cwd ? tasksByProject.get(cwd) : undefined
  const tasksLoading = cwd ? tasksByProjectLoading.has(cwd) : false
  const trimmedSearch = search.trim()
  const searchActive = trimmedSearch.length >= SEARCH_MIN_CHARS

  useEffect(() => {
    if (tab === 'timeline' && cwd && !processedSessions && !loading) {
      requestSegments(cwd)
    }
  }, [tab, cwd, processedSessions, loading, requestSegments])

  useEffect(() => {
    if (tab === 'sessions' && cwd && !projectTasks && !tasksLoading) {
      requestProjectTasks(cwd)
    }
  }, [tab, cwd, projectTasks, tasksLoading, requestProjectTasks])

  // Debounced semantic task search. Refires only when the user-typed query
  // changes; we deliberately read the latest taskSearch via the store inside
  // the timer to skip when the result already matches.
  // biome-ignore lint/correctness/useExhaustiveDependencies: store getters are stable
  useEffect(() => {
    if (!cwd) return
    if (!searchActive) {
      const existing = useMerlinStore.getState().taskSearchByProject.get(cwd)
      if (existing) clearProjectTaskSearch(cwd)
      return
    }
    const handle = setTimeout(() => {
      const latest = useMerlinStore.getState().taskSearchByProject.get(cwd)
      if (latest?.query === search && !latest.pending) return
      searchProjectTasks(cwd, search)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [cwd, search, searchActive])

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p className="text-sm">No project data.</p>
      </div>
    )
  }

  const liveSessions = project.sessions.filter((s) => !s.archived)
  const archivedSessions = project.sessions.filter((s) => s.archived)
  const totalTurns = project.sessions.reduce((sum, s) => sum + s.userTurnCount, 0)
  const totalSize = project.sessions.reduce((sum, s) => sum + s.sizeBytes, 0)
  const totalAgents = project.sessions.reduce((sum, s) => sum + s.subagentCount, 0)

  const pp = project.preprocessing
  const isRunning = pp ? pp.running > 0 : false
  const hasAnyPp = pp ? pp.total > 0 : false
  const allDone = hasAnyPp && pp!.processed === pp!.total

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        tabs={
          <TabGroup
            value={tab}
            onChange={setTab}
            items={[
              { key: 'sessions', label: 'Sessions', icon: Layers },
              { key: 'timeline', label: 'Timeline', icon: GitBranch, loading },
              { key: 'organizer', label: 'Organizer', icon: Wand2 },
            ]}
          />
        }
        search={
          <SearchInput value={search} onChange={(q) => setSearch(cwd, q)} placeholder="Search tasks (semantic)..." />
        }
        stats={
          searchActive ? (
            <SearchStats search={taskSearch} />
          ) : (
            <SessionsStats
              liveCount={liveSessions.length}
              archivedCount={archivedSessions.length}
              totalTurns={totalTurns}
              totalSize={totalSize}
              totalAgents={totalAgents}
              pp={hasAnyPp ? pp! : null}
              isRunning={isRunning}
              allDone={allDone}
            />
          )
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => cwd && processProject(cwd)}
              disabled={isRunning}
              title="Process project"
            >
              {isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            </Button>
            {hasAnyPp && pp!.processed > 0 && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => cwd && reembedProject(cwd)}
                disabled={isRunning}
                title="Re-embed all tasks (tuning)"
              >
                <Sparkles className="h-3.5 w-3.5" />
              </Button>
            )}
            {hasAnyPp && pp!.processed > 0 && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => cwd && deleteProcessing(cwd)}
                disabled={isRunning}
                title="Delete all processed data"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </>
        }
      />

      {/* Processing progress bar */}
      {hasAnyPp && pp!.processed < pp!.total && (
        <div className="h-0.5 w-full bg-secondary/30 shrink-0">
          <div
            className="h-full bg-emerald-500/60 transition-all duration-500"
            style={{ width: `${(pp!.processed / pp!.total) * 100}%` }}
          />
        </div>
      )}

      {/* Tab content */}
      {searchActive ? (
        <SearchResultsList project={project} search={taskSearch} query={search} onSessionClick={onSessionClick} />
      ) : tab === 'sessions' ? (
        <SessionsList
          project={project}
          liveSessions={liveSessions}
          archivedSessions={archivedSessions}
          tasksBySession={projectTasks}
          onSessionClick={onSessionClick}
          searchActive={false}
        />
      ) : tab === 'organizer' ? (
        <OrganizerView project={project} onSessionClick={onSessionClick} />
      ) : (
        <TimelineTab sessions={processedSessions} loading={loading} />
      )}
    </div>
  )
}

function SessionsList({
  project,
  liveSessions,
  archivedSessions,
  tasksBySession,
  onSessionClick,
  searchActive,
}: {
  project: Project
  liveSessions: Project['sessions']
  archivedSessions: Project['sessions']
  tasksBySession: Record<string, SessionTask[]> | undefined
  onSessionClick?: (sessionId: string) => void
  searchActive: boolean
}) {
  const processSession = useMerlinStore((s) => s.processSession)
  const deleteProcessing = useMerlinStore((s) => s.deleteProcessing)
  const cwd = project.cwd

  const renderSessionRow = (session: Project['sessions'][number]) => {
    const tasks = tasksBySession?.[session.sessionId]
    return (
      <div key={session.sessionId}>
        <div
          className="rounded-md px-3 py-2 hover:bg-secondary/50 transition-colors cursor-pointer"
          onClick={() => onSessionClick?.(session.sessionId)}
        >
          <SessionBadge
            session={session}
            project={project}
            onProcess={() => processSession(cwd, session.sessionId)}
            onDelete={() => deleteProcessing(cwd, session.sessionId)}
            onNavigateSession={onSessionClick}
          />
        </div>
        {tasks && tasks.length > 0 && <TaskRows tasks={tasks} onClick={() => onSessionClick?.(session.sessionId)} />}
      </div>
    )
  }

  const emptyAll = liveSessions.length === 0 && archivedSessions.length === 0

  return (
    <ScrollArea className="flex-1 p-4">
      {emptyAll ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground text-sm">
          {searchActive ? 'No sessions match your search.' : 'No active sessions.'}
        </div>
      ) : liveSessions.length === 0 ? null : (
        <div className="space-y-1">{liveSessions.map(renderSessionRow)}</div>
      )}

      {archivedSessions.length > 0 && (
        <>
          <div className="my-3 flex items-center gap-2">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">Archived</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="space-y-1 opacity-60">{archivedSessions.map(renderSessionRow)}</div>
        </>
      )}
    </ScrollArea>
  )
}

const DATE_FMT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
const TIME_FMT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false }
const FULL_FMT: Intl.DateTimeFormatOptions = { ...DATE_FMT, ...TIME_FMT }

function formatTaskTimeRange(startedAt?: number, endedAt?: number): { label: string; title: string } | null {
  if (!startedAt) return null
  const start = new Date(startedAt)
  const end = endedAt ? new Date(endedAt) : start
  const title = endedAt
    ? `${start.toLocaleString(undefined, FULL_FMT)} – ${end.toLocaleString(undefined, FULL_FMT)}`
    : start.toLocaleString(undefined, FULL_FMT)

  // Multi-day span — ignore clock time, show date range
  if (start.toDateString() !== end.toDateString()) {
    return {
      label: `${start.toLocaleDateString(undefined, DATE_FMT)} → ${end.toLocaleDateString(undefined, DATE_FMT)}`,
      title,
    }
  }

  const now = new Date()
  const diffMs = now.getTime() - end.getTime()
  const minutes = Math.max(0, Math.round(diffMs / 60_000))
  const hours = Math.round(diffMs / 3_600_000)
  const isToday = end.toDateString() === now.toDateString()
  const yesterday = new Date(now.getTime() - 86_400_000)
  const isYesterday = end.toDateString() === yesterday.toDateString()

  if (isToday) {
    if (minutes < 1) return { label: 'just now', title }
    if (minutes < 60) return { label: `${minutes} min ago`, title }
    return { label: `${hours}h ago`, title }
  }
  if (isYesterday) return { label: 'yesterday', title }

  // Older — compact span decides whether time survives
  const spanMs = end.getTime() - start.getTime()
  if (spanMs < 3_600_000) {
    return {
      label: `${start.toLocaleDateString(undefined, DATE_FMT)} ${start.getHours()}h`,
      title,
    }
  }
  return { label: start.toLocaleDateString(undefined, DATE_FMT), title }
}

function TaskRows({ tasks, onClick }: { tasks: SessionTask[]; onClick: () => void }) {
  // Most recent on top: prefer startedAt when available, fall back to first turn index
  const sorted = [...tasks].sort((a, b) => {
    if (a.startedAt != null && b.startedAt != null) return b.startedAt - a.startedAt
    return (b.turns[0] ?? 0) - (a.turns[0] ?? 0)
  })
  return (
    <div className="ml-6 border-l border-border/40 pl-3 py-0.5">
      {sorted.map((task) => {
        const timeRange = formatTaskTimeRange(task.startedAt, task.endedAt)
        return (
          <div
            key={task.id}
            onClick={(e) => {
              e.stopPropagation()
              onClick()
            }}
            className="group flex items-center gap-2 py-0.5 text-xs cursor-pointer hover:bg-secondary/30 rounded px-1 -mx-1 transition-colors"
          >
            <span className="font-mono text-[10px] text-muted-foreground/50 shrink-0">{task.id}</span>
            <span className="truncate text-foreground/70 group-hover:text-foreground transition-colors">
              {task.description}
            </span>
            {timeRange && (
              <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/40" title={timeRange.title}>
                {timeRange.label}
              </span>
            )}
            <span className={cn('shrink-0 text-[10px] text-muted-foreground/40', !timeRange && 'ml-auto')}>
              {task.turns.length} turn{task.turns.length !== 1 ? 's' : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Semantic search results ────────────────────────────────────────────────

type TaskSearchHit = { sessionId: string; taskId: string; score: number; task: SessionTask }
type TaskSearchState = {
  query: string
  requestId: string
  pending: boolean
  results: TaskSearchHit[]
  error?: string
}

function SearchResultsList({
  project,
  search,
  query,
  onSessionClick,
}: {
  project: Project
  search: TaskSearchState | undefined
  query: string
  onSessionClick?: (sessionId: string) => void
}) {
  // No request issued yet (still inside debounce)
  if (!search) {
    return <CenterMessage>Searching for "{query.trim()}"...</CenterMessage>
  }

  if (search.pending && search.results.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Searching...</span>
      </div>
    )
  }

  if (search.error && search.results.length === 0) {
    return <CenterMessage tone="error">{search.error}</CenterMessage>
  }

  if (search.results.length === 0) {
    return <CenterMessage>No tasks match "{search.query.trim()}".</CenterMessage>
  }

  // Group by session, keeping the order of first appearance (best score first).
  const sessionsById = new Map<string, SessionSummary>()
  for (const s of project.sessions) sessionsById.set(s.sessionId, s)

  const groups = new Map<string, TaskSearchHit[]>()
  for (const hit of search.results) {
    const list = groups.get(hit.sessionId)
    if (list) list.push(hit)
    else groups.set(hit.sessionId, [hit])
  }

  return (
    <ScrollArea className="flex-1 p-4">
      {search.pending && (
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Refining results…</span>
        </div>
      )}
      <div className="space-y-3">
        {Array.from(groups.entries()).map(([sessionId, hits]) => {
          const session = sessionsById.get(sessionId)
          const [primary, ...rest] = hits
          if (!primary) return null
          return (
            <div key={sessionId} className="space-y-1">
              <SearchResultRow
                hit={primary}
                session={session}
                showSession
                onClick={() => onSessionClick?.(sessionId)}
              />
              {rest.length > 0 && (
                <div className="ml-6 border-l border-border/40 pl-3 space-y-0.5">
                  {rest.map((hit) => (
                    <SearchResultRow
                      key={hit.taskId}
                      hit={hit}
                      session={session}
                      indented
                      onClick={() => onSessionClick?.(sessionId)}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function SearchResultRow({
  hit,
  session,
  showSession,
  indented,
  onClick,
}: {
  hit: TaskSearchHit
  session: SessionSummary | undefined
  showSession?: boolean
  indented?: boolean
  onClick: () => void
}) {
  const timeRange = formatTaskTimeRange(hit.task.startedAt, hit.task.endedAt)
  const sessionTitle = session?.customTitle || session?.nestedPath || hit.sessionId.slice(0, 8)
  const score = `${(hit.score * 100).toFixed(0)}%`
  return (
    <div
      onClick={onClick}
      className={cn(
        'group cursor-pointer rounded-md px-3 py-2 transition-colors hover:bg-secondary/50',
        indented && 'py-1',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'shrink-0 font-mono text-[10px] tabular-nums',
            hit.score >= 0.5 ? 'text-emerald-500/80' : 'text-muted-foreground/60',
          )}
          title={`cosine similarity: ${hit.score.toFixed(4)}`}
        >
          {score}
        </span>
        <span className={cn('truncate text-sm', indented ? 'text-foreground/75' : 'text-foreground')}>
          {hit.task.description}
        </span>
        {timeRange && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/50" title={timeRange.title}>
            {timeRange.label}
          </span>
        )}
      </div>
      {showSession && (
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground/70">
          <span className="truncate" title={sessionTitle}>
            {sessionTitle}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/40">{hit.sessionId.slice(0, 8)}</span>
          <span className="text-[10px] text-muted-foreground/40">
            · task {hit.task.id} · {hit.task.turns.length} turn{hit.task.turns.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}
    </div>
  )
}

function CenterMessage({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return (
    <div
      className={cn(
        'flex flex-1 items-center justify-center px-4 text-center text-sm',
        tone === 'error' ? 'text-red-400' : 'text-muted-foreground',
      )}
    >
      {children}
    </div>
  )
}

// ── Header stats ───────────────────────────────────────────────────────────

function StatDot() {
  return <span className="text-muted-foreground/40">·</span>
}

function StatDivider() {
  return <span className="h-3.5 w-px bg-border" aria-hidden />
}

function SessionsStats({
  liveCount,
  archivedCount,
  totalTurns,
  totalSize,
  totalAgents,
  pp,
  isRunning,
  allDone,
}: {
  liveCount: number
  archivedCount: number
  totalTurns: number
  totalSize: number
  totalAgents: number
  pp: PreprocessingStats | null
  isRunning: boolean
  allDone: boolean
}) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      {/* Scope — what set of sessions */}
      <div className="flex items-center gap-1.5">
        <span className="text-foreground/80">{liveCount} active</span>
        {archivedCount > 0 && (
          <>
            <StatDot />
            <span>{archivedCount} archived</span>
          </>
        )}
      </div>

      <StatDivider />

      {/* Volume — scale of content */}
      <div className="flex items-center gap-1.5">
        <span>{totalTurns} turns</span>
        <StatDot />
        <span>{formatSize(totalSize)}</span>
        {totalAgents > 0 && (
          <>
            <StatDot />
            <span>{totalAgents} subagents</span>
          </>
        )}
      </div>

      {pp && (
        <>
          <StatDivider />
          {/* Processing — progress & issues */}
          <div className="flex items-center gap-1.5">
            {isRunning && <Loader2 className="h-3 w-3 animate-spin text-blue-400" />}
            <span className={allDone ? 'text-emerald-500' : 'text-foreground/80'}>
              {pp.processed}/{pp.total}
            </span>
            {pp.outdated > 0 && (
              <>
                <StatDot />
                <span className="text-amber-400">{pp.outdated} stale</span>
              </>
            )}
            {pp.error > 0 && (
              <>
                <StatDot />
                <span className="text-red-400">{pp.error} err</span>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function SearchStats({ search }: { search: TaskSearchState | undefined }) {
  if (!search) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>waiting…</span>
      </div>
    )
  }
  if (search.error && search.results.length === 0) {
    return <div className="text-xs text-red-400">search unavailable</div>
  }
  const sessionCount = new Set(search.results.map((r) => r.sessionId)).size
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {search.pending && <Loader2 className="h-3 w-3 animate-spin text-blue-400" />}
      <span className="text-foreground/80">
        {search.results.length} task{search.results.length !== 1 ? 's' : ''}
      </span>
      {search.results.length > 0 && (
        <>
          <StatDot />
          <span>
            in {sessionCount} session{sessionCount !== 1 ? 's' : ''}
          </span>
        </>
      )}
    </div>
  )
}

function TimelineTab({ sessions, loading }: { sessions: unknown[] | undefined; loading: boolean }) {
  if (loading && !sessions) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading sessions...</span>
      </div>
    )
  }

  return <TimelineView sessions={(sessions as ProcessedSession[] | undefined) ?? []} />
}
