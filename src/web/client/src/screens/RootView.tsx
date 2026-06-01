import { Archive, FolderOpen, Layers, Server } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useMerlinStore } from '@/stores/merlin-store'

export function RootView() {
  const model = useMerlinStore((s) => s.model)
  const connected = useMerlinStore((s) => s.connected)
  const daemonName = useMerlinStore((s) => s.daemonName)
  const navigate = useMerlinStore((s) => s.navigate)

  const hostName = daemonName ?? 'merlin'
  const version = model?.host.version
  const projects = model ? Object.values(model.projects) : []
  const activeProjects = projects.filter((p) => !p.archived)
  const archivedProjects = projects.filter((p) => p.archived)
  const totalSessions = projects.reduce((n, p) => n + p.sessions.length, 0)
  const activeSessions = projects.reduce((n, p) => n + p.sessions.filter((s) => s.activePid != null).length, 0)

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div className="w-full max-w-lg space-y-6">
        {/* Host card */}
        <Card
          className="cursor-pointer hover:border-foreground/20 transition-colors"
          onClick={() => navigate({ level: 'host' })}
        >
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg',
                  connected ? 'bg-emerald-500/10' : 'bg-red-500/10',
                )}
              >
                <Server className={cn('h-5 w-5', connected ? 'text-emerald-400' : 'text-red-400')} />
              </div>
              <div>
                <CardTitle className="text-lg">{hostName}</CardTitle>
                {version && <p className="text-xs text-muted-foreground font-mono">v{version}</p>}
              </div>
              <div
                className={cn(
                  'ml-auto h-2.5 w-2.5 rounded-full',
                  connected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500',
                )}
              />
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <Stat icon={FolderOpen} label="Projects" value={activeProjects.length} />
              <Stat icon={Layers} label="Sessions" value={`${activeSessions} / ${totalSessions}`} />
              <Stat icon={Archive} label="Archived" value={archivedProjects.length} />
            </div>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">Click to browse projects</p>
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, value }: { icon: typeof FolderOpen; label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md bg-secondary/30 px-3 py-2.5">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}
