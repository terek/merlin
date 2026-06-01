import { Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn, relativeTime } from '@/lib/utils'
import { useMerlinStore } from '@/stores/merlin-store'
import type { Project, SessionTask } from '@/types/model'

interface OrganizerViewProps {
  project: Project
  onSessionClick?: (sessionId: string) => void
}

interface ResolvedTask {
  compositeId: string
  sessionId: string
  localTaskId: string
  task: SessionTask
  rename?: { name: string; group?: string; note?: string }
  sortKey: number
}

export function OrganizerView({ project, onSessionClick }: OrganizerViewProps) {
  const organizer = useMerlinStore((s) => s.organizerByProject.get(project.cwd))
  const requestOrganizer = useMerlinStore((s) => s.requestOrganizer)
  const projectTasks = useMerlinStore((s) => s.tasksByProject.get(project.cwd))
  const requestProjectTasks = useMerlinStore((s) => s.requestProjectTasks)
  const tasksLoading = useMerlinStore((s) => s.tasksByProjectLoading.has(project.cwd))

  // Auto-load tasks so we have something to display alongside the renames.
  useEffect(() => {
    if (!projectTasks && !tasksLoading) requestProjectTasks(project.cwd)
  }, [project.cwd, projectTasks, tasksLoading, requestProjectTasks])

  // First visit to this tab: kick off generation.
  useEffect(() => {
    if (!organizer) requestOrganizer(project.cwd, false)
  }, [project.cwd, organizer, requestOrganizer])

  const renameById = useMemo(() => {
    const m = new Map<string, { name: string; group?: string; note?: string }>()
    for (const t of organizer?.tasks ?? []) {
      m.set(t.taskId, { name: t.name, group: t.group, note: t.note })
    }
    return m
  }, [organizer])

  // Flatten every task, attaching its rename. Sort chronologically.
  // Filter by the model's session list so .merlinignore-excluded sessions
  // don't leak in even if the daemon or a stale cache still exposes them.
  const allowedSessionIds = useMemo(() => new Set(project.sessions.map((s) => s.sessionId)), [project.sessions])
  const allTasks = useMemo(() => {
    if (!projectTasks) return []
    const out: ResolvedTask[] = []
    for (const [sessionId, tasks] of Object.entries(projectTasks)) {
      if (!allowedSessionIds.has(sessionId)) continue
      for (const task of tasks) {
        const compositeId = `${sessionId}/${task.id}`
        out.push({
          compositeId,
          sessionId,
          localTaskId: task.id,
          task,
          rename: renameById.get(compositeId),
          sortKey: task.startedAt ?? Number.MAX_SAFE_INTEGER,
        })
      }
    }
    out.sort((a, b) => a.sortKey - b.sortKey)
    return out
  }, [projectTasks, renameById, allowedSessionIds])

  // Group by LLM-assigned group label (fallback: "Ungrouped").
  // Within a group, keep chronological order; order groups by earliest task.
  const grouped = useMemo(() => {
    const groups = new Map<string, ResolvedTask[]>()
    const firstSeen = new Map<string, number>()
    for (const r of allTasks) {
      const key = r.rename?.group ?? 'Ungrouped'
      const arr = groups.get(key)
      if (arr) arr.push(r)
      else {
        groups.set(key, [r])
        firstSeen.set(key, r.sortKey)
      }
    }
    return Array.from(groups.entries()).sort(
      ([aKey], [bKey]) => (firstSeen.get(aKey) ?? 0) - (firstSeen.get(bKey) ?? 0),
    )
  }, [allTasks])

  const pending = organizer?.pending ?? !organizer
  const hasData = organizer && organizer.tasks.length > 0

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/40 bg-secondary/10 px-4 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-amber-400/80" />
          <span>Experimental: LLM-organized tasks across the whole project (chronological, grouped).</span>
        </div>
        <div className="flex items-center gap-3">
          {organizer?.generatedAt && (
            <span className="font-mono text-[10px] text-muted-foreground/60" title={organizer.generatedAt}>
              generated {relativeTime(new Date(organizer.generatedAt).getTime())}
            </span>
          )}
          <button
            type="button"
            onClick={() => requestOrganizer(project.cwd, true)}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-muted-foreground hover:bg-secondary/60 hover:text-foreground disabled:opacity-50"
            title="Regenerate"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            <span>{pending ? 'Generating...' : 'Regenerate'}</span>
          </button>
        </div>
      </div>

      {organizer?.error && (
        <div className="border-b border-red-500/30 bg-red-500/5 px-4 py-2 text-xs text-red-400">{organizer.error}</div>
      )}

      <ScrollArea className="flex-1 p-4">
        {!hasData && pending ? (
          <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Asking the LLM to organize...</span>
          </div>
        ) : !hasData ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            No organizer result yet.
          </div>
        ) : (
          <div className="space-y-5">
            {grouped.map(([groupName, tasks]) => (
              <div key={groupName}>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/80">
                    {groupName}
                  </span>
                  <div className="h-px flex-1 bg-border/50" />
                  <span className="text-[10px] text-muted-foreground/50">
                    {tasks.length} task{tasks.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="space-y-1">
                  {tasks.map((r) => (
                    <TaskRow key={r.compositeId} resolved={r} onClick={() => onSessionClick?.(r.sessionId)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function TaskRow({ resolved, onClick }: { resolved: ResolvedTask; onClick: () => void }) {
  const { task, rename, sessionId, localTaskId } = resolved
  const newName = rename?.name ?? task.description
  const renamed = !!rename && rename.name !== task.description
  const when = task.startedAt ? relativeTime(task.startedAt) : null

  return (
    <div
      onClick={onClick}
      className="group cursor-pointer rounded-md border border-border/30 bg-secondary/10 px-3 py-1.5 hover:bg-secondary/30 transition-colors"
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] text-muted-foreground/50 shrink-0">
          {sessionId.slice(0, 8)}/{localTaskId}
        </span>
        <span className={cn('truncate text-sm', renamed ? 'text-foreground' : 'text-foreground/70')}>{newName}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/50">
          {task.turns.length} turn{task.turns.length !== 1 ? 's' : ''}
          {when ? ` · ${when}` : ''}
        </span>
      </div>
      {renamed && (
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground/60" title={task.description}>
          was: <span className="italic">{task.description}</span>
        </div>
      )}
      {rename?.note && <div className="mt-0.5 text-[11px] text-muted-foreground/70">{rename.note}</div>}
    </div>
  )
}
