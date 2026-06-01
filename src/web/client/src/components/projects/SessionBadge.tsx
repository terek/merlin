import { GitFork, Loader2, Play, Trash2 } from 'lucide-react'
import { PpStatusIcon } from '@/components/PpStatusIcon'
import { cn, formatSize, relativeTime } from '@/lib/utils'
import type { Project, SessionSummary, SessionTask } from '@/types/model'

interface SessionBadgeProps {
  session: SessionSummary
  project: Project
  tasks?: SessionTask[]
  onProcess?: () => void
  onDelete?: () => void
  onNavigateSession?: (sessionId: string) => void
}

function sessionLedColor(session: SessionSummary, project: Project): string {
  if (project.activeSessionId === session.sessionId) {
    return 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]'
  }
  if (session.activePid != null) {
    return 'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.4)]'
  }
  const hasExternal = typeof project.owner === 'object' && project.owner.type === 'external'
  const hasIdentified = project.sessions.some((s) => s.activePid != null)
  if (hasExternal && !hasIdentified) {
    return 'bg-amber-500/60'
  }
  return 'bg-zinc-600'
}

export function SessionBadge({ session, project, tasks, onProcess, onDelete, onNavigateSession }: SessionBadgeProps) {
  const ledColor = sessionLedColor(session, project)
  const baseName = session.customTitle ?? session.sessionId.slice(0, 8)
  const name = session.nestedPath ? `${session.nestedPath}/${baseName}` : baseName
  const size = formatSize(session.sizeBytes)
  const time = relativeTime(session.lastTimestamp)
  const taskCount = tasks?.length ?? 0

  // Most recent task = the one with the highest turn index
  const latestTask = tasks?.reduce<SessionTask | undefined>((best, t) => {
    const lastTurn = t.turns[t.turns.length - 1] ?? -1
    const bestLast = best?.turns[best.turns.length - 1] ?? -1
    return lastTurn > bestLast ? t : best
  }, undefined)

  const isRunning = session.ppStatus === 'running'
  const isProcessed = session.ppStatus === 'processed'

  const parentSession = session.parentSessionId
    ? project.sessions.find((s) => s.sessionId === session.parentSessionId)
    : null
  const parentName = parentSession ? (parentSession.customTitle ?? parentSession.sessionId.slice(0, 8)) : null

  return (
    <div className="group/session flex items-center gap-2 py-0.5 text-sm min-w-0">
      <div className={cn('h-2 w-2 rounded-full shrink-0', ledColor)} />
      <PpStatusIcon
        status={session.ppStatus}
        error={session.ppError}
        turnsCovered={session.ppTurnsCovered}
        totalTurns={session.userTurnCount}
      />
      <span className="font-mono text-xs text-foreground/90 truncate max-w-[200px] shrink-0">{name}</span>
      {parentName && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onNavigateSession?.(session.parentSessionId!)
          }}
          className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors shrink-0"
          title={`Spawned from ${parentName}`}
        >
          <GitFork className="h-2.5 w-2.5" />
          {parentName}
        </button>
      )}
      <span className="text-xs text-muted-foreground shrink-0">
        {size} · {time}
        {taskCount > 1 && ` · ${taskCount} tasks`}
      </span>
      {latestTask && (
        <span className="text-xs text-muted-foreground/70 truncate min-w-0" title={latestTask.description}>
          · {latestTask.description}
        </span>
      )}

      {/* Process + Delete buttons on hover */}
      <div className="opacity-0 group-hover/session:opacity-100 transition-opacity ml-auto flex items-center gap-0.5 shrink-0">
        {onProcess && (
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onProcess()
            }}
            disabled={isRunning}
            title="Process session"
          >
            {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          </button>
        )}
        {onDelete && isProcessed && (
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-red-400 hover:bg-secondary/60 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            disabled={isRunning}
            title="Delete processed data"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  )
}
