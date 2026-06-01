import { ChevronRight, FolderOpen, Home, MessageSquare, RefreshCw, Server } from 'lucide-react'
import { PpStatusIcon } from '@/components/PpStatusIcon'
import { Button } from '@/components/ui/button'
import { cn, shortenPath } from '@/lib/utils'
import { type NavigationFocus, useMerlinStore } from '@/stores/merlin-store'
import type { PreprocessingStatus } from '@/types/model'

export function Breadcrumb() {
  const focus = useMerlinStore((s) => s.focus)
  const model = useMerlinStore((s) => s.model)
  const connected = useMerlinStore((s) => s.connected)
  const daemonName = useMerlinStore((s) => s.daemonName)
  const navigate = useMerlinStore((s) => s.navigate)
  const sendCommand = useMerlinStore((s) => s.sendCommand)

  const hostName = daemonName ?? 'merlin'
  const version = model?.host.version

  // Build segments based on focus
  type Seg = {
    key: string
    icon: typeof Home
    label: string
    target: NavigationFocus
    active: boolean
    ppStatus?: PreprocessingStatus
    ppError?: string
    ppTurnsCovered?: number
    ppTotalTurns?: number
  }
  const segments: Seg[] = []

  // Root segment (always present)
  segments.push({
    key: 'root',
    icon: Home,
    label: 'merlin',
    target: { level: 'root' },
    active: focus.level === 'root',
  })

  // Host segment (present at host level and deeper)
  if (focus.level !== 'root') {
    segments.push({
      key: 'host',
      icon: Server,
      label: hostName,
      target: { level: 'host' },
      active: focus.level === 'host',
    })
  }

  // Project segment — show shortened full path + pp aggregate
  if (focus.level === 'project' || focus.level === 'session') {
    const project = model?.projects[focus.cwd]
    const pp = project?.preprocessing
    // Derive an aggregate status for the project breadcrumb
    let projectPpStatus: PreprocessingStatus | undefined
    if (pp && pp.total > 0) {
      if (pp.processing > 0) projectPpStatus = 'processing'
      else if (pp.error > 0) projectPpStatus = 'error'
      else if (pp.outdated > 0) projectPpStatus = 'outdated'
      else if (pp.pending > 0) projectPpStatus = 'pending'
      else if (pp.processed === pp.total) projectPpStatus = 'processed'
    }

    segments.push({
      key: 'project',
      icon: FolderOpen,
      label: shortenPath(focus.cwd),
      target: { level: 'project', cwd: focus.cwd },
      active: focus.level === 'project',
      ppStatus: projectPpStatus,
    })
  }

  // Session segment
  if (focus.level === 'session') {
    const project = model?.projects[focus.cwd]
    const session = project?.sessions.find((s) => s.sessionId === focus.sessionId)
    const baseName = session?.customTitle ?? session?.sessionId.slice(0, 8) ?? 'session'
    // If sessionCwd is nested inside the project, prepend the relative nested path
    const nestedPrefix =
      focus.sessionCwd && focus.sessionCwd !== focus.cwd ? `${focus.sessionCwd.slice(focus.cwd.length + 1)}/` : ''
    const sessionName = nestedPrefix + baseName
    segments.push({
      key: 'session',
      icon: MessageSquare,
      label: sessionName,
      target: focus,
      active: true,
      ppStatus: session?.ppStatus,
      ppError: session?.ppError,
      ppTurnsCovered: session?.ppTurnsCovered,
      ppTotalTurns: session?.userTurnCount,
    })
  }

  return (
    <div className="flex h-12 items-center justify-between border-b px-4 shrink-0">
      {/* Left: breadcrumb segments */}
      <nav className="flex items-center gap-1">
        {/* Connection LED */}
        <div
          className={cn(
            'h-2 w-2 rounded-full mr-2 shrink-0',
            connected
              ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]'
              : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.4)]',
          )}
          title={connected ? `Connected to ${hostName}` : 'Disconnected'}
        />

        {segments.map((seg, i) => (
          <div key={seg.key} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 mx-0.5" />}
            {seg.active ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-foreground/10 text-foreground">
                <seg.icon className="h-3.5 w-3.5" />
                <span className={cn('text-sm font-semibold', seg.key === 'project' && 'font-mono text-xs')}>
                  {seg.label}
                </span>
                <PpStatusIcon
                  status={seg.ppStatus}
                  error={seg.ppError}
                  turnsCovered={seg.ppTurnsCovered}
                  totalTurns={seg.ppTotalTurns}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => navigate(seg.target)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
              >
                <seg.icon className="h-3.5 w-3.5" />
                <span className={cn('text-sm', seg.key === 'project' && 'font-mono text-xs')}>{seg.label}</span>
                <PpStatusIcon
                  status={seg.ppStatus}
                  error={seg.ppError}
                  turnsCovered={seg.ppTurnsCovered}
                  totalTurns={seg.ppTotalTurns}
                />
              </button>
            )}
          </div>
        ))}
      </nav>

      {/* Right: version + refresh */}
      <div className="flex items-center gap-3">
        {version && <span className="text-[11px] text-muted-foreground/60 font-mono">v{version}</span>}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => sendCommand({ type: 'refresh_projects', force: true })}
          title="Refresh projects"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
