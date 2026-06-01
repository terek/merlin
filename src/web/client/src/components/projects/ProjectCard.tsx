import { Archive, ArchiveRestore, FolderOpen, Layers, Loader2, Play, Trash2, Ungroup } from 'lucide-react'
import { useEffect } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn, relativeTime } from '@/lib/utils'
import { useMerlinStore } from '@/stores/merlin-store'
import type { PreprocessingStats, Project } from '@/types/model'
import { SessionBadge } from './SessionBadge'

interface ProjectCardProps {
  project: Project
  onArchive: () => void
  onCollapse: () => void
  onChat: () => void
  onProcess: () => void
  onDelete: () => void
  archiveMode?: 'active' | 'archived'
}

function ownerBadge(project: Project) {
  if (project.activeSessionId) {
    return <Badge variant="success">active</Badge>
  }
  if (typeof project.owner === 'object' && project.owner.type === 'daemon') {
    return <Badge variant="success">daemon</Badge>
  }
  if (typeof project.owner === 'object' && project.owner.type === 'external') {
    return <Badge variant="warning">external</Badge>
  }
  return null
}

function PreprocessingBadge({
  pp,
  onProcess,
  onDelete,
}: {
  pp?: PreprocessingStats
  onProcess: () => void
  onDelete: () => void
}) {
  if (!pp || pp.total === 0) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => {
          e.stopPropagation()
          onProcess()
        }}
        title="Process this project"
      >
        <Play className="h-3 w-3 text-muted-foreground" />
      </Button>
    )
  }

  const allDone = pp.processed === pp.total
  const isRunning = pp.running > 0
  const hasErrors = pp.error > 0

  return (
    <div className="flex items-center gap-1">
      {isRunning && <Loader2 className="h-3 w-3 animate-spin text-blue-400" />}
      <Badge
        variant="outline"
        className={cn(
          'text-[10px] px-1.5 py-0',
          allDone
            ? 'text-emerald-500 border-emerald-500/30'
            : hasErrors
              ? 'text-red-400 border-red-400/30'
              : 'text-muted-foreground',
        )}
        title={`${pp.processed} processed, ${pp.error} error, ${pp.outdated} outdated, ${pp.missing} missing`}
      >
        {pp.processed}/{pp.total}
      </Badge>
      {!allDone && !isRunning && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={(e) => {
            e.stopPropagation()
            onProcess()
          }}
          title="Process project"
        >
          <Play className="h-3 w-3" />
        </Button>
      )}
      {allDone && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="Delete processed data"
        >
          <Trash2 className="h-3 w-3 text-muted-foreground hover:text-red-400" />
        </Button>
      )}
    </div>
  )
}

export function ProjectCard({
  project,
  onArchive,
  onCollapse,
  onChat,
  onProcess,
  onDelete,
  archiveMode = 'active',
}: ProjectCardProps) {
  const liveSessions = project.sessions.filter((s) => !s.archived)
  const archivedCount = project.sessions.filter((s) => s.archived).length
  const isActive = project.activeSessionId != null

  const tasksBySession = useMerlinStore((s) => s.tasksByProject.get(project.cwd))
  const tasksLoading = useMerlinStore((s) => s.tasksByProjectLoading.has(project.cwd))
  const requestProjectTasks = useMerlinStore((s) => s.requestProjectTasks)
  const connected = useMerlinStore((s) => s.connected)

  useEffect(() => {
    if (connected && !tasksBySession && !tasksLoading) {
      requestProjectTasks(project.cwd)
    }
  }, [connected, project.cwd, tasksBySession, tasksLoading, requestProjectTasks])

  return (
    <Card
      className={cn(
        'transition-colors hover:border-foreground/20 cursor-pointer group',
        isActive && 'border-emerald-500/30',
      )}
      onClick={onChat}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
            <CardTitle className="text-base truncate">{project.displayName}</CardTitle>
            {ownerBadge(project)}
            <PreprocessingBadge pp={project.preprocessing} onProcess={onProcess} onDelete={onDelete} />
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {archiveMode === 'active' && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation()
                  onCollapse()
                }}
                title={project.collapsed ? 'Uncollapse nested projects' : 'Collapse nested projects into this one'}
              >
                {project.collapsed ? <Ungroup className="h-3.5 w-3.5" /> : <Layers className="h-3.5 w-3.5" />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation()
                onArchive()
              }}
              title={archiveMode === 'active' ? 'Archive project' : 'Unarchive project'}
            >
              {archiveMode === 'active' ? (
                <Archive className="h-3.5 w-3.5" />
              ) : (
                <ArchiveRestore className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
        <CardDescription className="font-mono text-xs truncate">{project.cwd}</CardDescription>
      </CardHeader>

      <CardContent>
        <div className="space-y-0.5">
          {liveSessions.slice(0, 5).map((s) => (
            <SessionBadge key={s.sessionId} session={s} project={project} tasks={tasksBySession?.[s.sessionId]} />
          ))}
          {liveSessions.length > 5 && (
            <p className="text-xs text-muted-foreground pl-4">+{liveSessions.length - 5} more</p>
          )}
          {archivedCount > 0 && <p className="text-xs text-muted-foreground/60 pl-4">{archivedCount} archived</p>}
        </div>

        {project.preprocessing && project.preprocessing.total > 0 && (
          <PreprocessingProgress pp={project.preprocessing} />
        )}

        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>{relativeTime(project.lastTimestamp)}</span>
          <span>
            {liveSessions.length} session{liveSessions.length !== 1 ? 's' : ''}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function PreprocessingProgress({ pp }: { pp: PreprocessingStats }) {
  const pct = pp.total > 0 ? (pp.processed / pp.total) * 100 : 0
  const errPct = pp.total > 0 ? (pp.error / pp.total) * 100 : 0
  const allDone = pp.processed === pp.total && pp.error === 0

  if (allDone) return null

  return (
    <div className="mt-2">
      <div className="h-1 w-full rounded-full bg-secondary/50 overflow-hidden">
        <div className="h-full flex">
          <div className="h-full bg-emerald-500/70 transition-all duration-500" style={{ width: `${pct}%` }} />
          {errPct > 0 && (
            <div className="h-full bg-red-500/70 transition-all duration-500" style={{ width: `${errPct}%` }} />
          )}
        </div>
      </div>
    </div>
  )
}
